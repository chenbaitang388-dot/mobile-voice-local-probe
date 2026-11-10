/* 录音控制器：没有点击就不会调用 getUserMedia。
   每次 start() 建立一个独立会话（session token）；权限回调、MediaRecorder 事件、
   异步收尾都必须通过会话校验，避免「取消后重启却被旧权限启动」这类竞态。 */

import { RECORD_MIME_CANDIDATES, AUDIO_CONSTRAINTS } from './config.js';

export const RECORDER_STATUS = Object.freeze({
  idle: 'idle',
  requesting: 'requesting',
  recording: 'recording',
  stopping: 'stopping',
  ready: 'ready',
  error: 'error',
  cancelled: 'cancelled',
});

export const BUSY_STATUSES = Object.freeze([
  RECORDER_STATUS.requesting,
  RECORDER_STATUS.recording,
  RECORDER_STATUS.stopping,
]);

/**
 * 逐个检查候选 MIME；都不支持时交给浏览器自选，并标记来源为 browser。
 * 绝不假设 WebM 可用。
 */
export function pickMimeType(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return { mimeType: '', source: 'browser' };
  for (const candidate of RECORD_MIME_CANDIDATES) {
    let supported = false;
    try {
      supported = isTypeSupported(candidate) === true;
    } catch {
      supported = false;
    }
    if (supported) return { mimeType: candidate, source: 'supported' };
  }
  return { mimeType: '', source: 'browser' };
}

function errorCode(error) {
  const name = error && error.name ? String(error.name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission-denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-microphone';
  if (name === 'NotReadableError' || name === 'AbortError') return 'microphone-busy';
  return 'permission-failed';
}

function errorMessage(code) {
  switch (code) {
    case 'permission-denied':
      return '麦克风权限被拒绝。你可以在浏览器设置里允许后重试，或直接选择本地文件。';
    case 'no-microphone':
      return '没有找到可用的麦克风。可以直接选择本地音频文件。';
    case 'microphone-busy':
      return '麦克风被其它应用占用，暂时无法录音。';
    default:
      return '无法开始录音，请稍后重试，或直接选择本地文件。';
  }
}

function describeError(error) {
  if (!error) return '未知错误';
  if (typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

async function chunkToBytes(chunk) {
  if (chunk === null || chunk === undefined) return new Uint8Array(0);
  if (typeof chunk.arrayBuffer === 'function') return new Uint8Array(await chunk.arrayBuffer());
  if (typeof ArrayBuffer !== 'undefined' && chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
  }
  if (Array.isArray(chunk)) return Uint8Array.from(chunk);
  if (Array.isArray(chunk.bytes)) return Uint8Array.from(chunk.bytes);
  return new Uint8Array(0);
}

function concatBytes(parts, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * @param {object} options
 * @param {(constraints:object)=>Promise<any>} options.getUserMedia
 * @param {Function} [options.MediaRecorder] 构造函数；缺失时录音不可用
 * @param {(mime:string)=>boolean} [options.isTypeSupported]
 * @param {number} [options.maxSeconds]
 * @param {(state:object)=>void} [options.onChange]
 * @param {(result:object)=>void} [options.onResult]
 * @param {(error:object)=>void} [options.onError]
 */
export function createRecorder(options = {}) {
  const {
    getUserMedia,
    MediaRecorder: MediaRecorderImpl,
    isTypeSupported,
    maxSeconds = 30,
    timesliceMs = 500,
    now = () => Date.now(),
    setTimeout: setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimeout: clearTimer = (handle) => clearTimeout(handle),
    onChange = () => {},
    onResult = () => {},
    onError = () => {},
  } = options;

  const state = {
    status: RECORDER_STATUS.idle,
    mimeType: '',
    mimeSource: 'browser',
    seconds: 0,
    bytes: 0,
    code: null,
    message: '',
    reason: null,
  };

  let sessionCounter = 0;
  let currentSession = null;
  let disposed = false;

  const snapshot = () => ({ ...state });

  function emit() {
    onChange(snapshot());
  }

  function set(patch) {
    Object.assign(state, patch);
    emit();
  }

  /** 只有当前会话且未释放时才算有效；返回值即「会话 token 校验」。 */
  function isCurrent(candidate) {
    return !disposed && candidate !== null && candidate === currentSession && candidate.token === currentSession.token;
  }

  function clearTimers(target) {
    if (!target) return;
    if (target.limitTimer !== null) {
      clearTimer(target.limitTimer);
      target.limitTimer = null;
    }
    if (target.tickTimer !== null) {
      clearTimer(target.tickTimer);
      target.tickTimer = null;
    }
  }

  function stopTracks(target) {
    if (!target || typeof target.getTracks !== 'function') return 0;
    let stopped = 0;
    let tracks = [];
    try {
      tracks = target.getTracks() || [];
    } catch {
      tracks = [];
    }
    for (const track of tracks) {
      if (!track || typeof track.stop !== 'function') continue;
      if (track.readyState === 'ended') continue;
      try {
        track.stop();
        stopped += 1;
      } catch {
        /* 单条轨道取消失败不应影响其它轨道 */
      }
    }
    return stopped;
  }

  function detachTrackListeners(session) {
    if (session && typeof session.detachTracks === 'function') {
      session.detachTracks();
      session.detachTracks = null;
    }
  }

  function attachTrackEnded(session) {
    const tracks = session.stream && typeof session.stream.getTracks === 'function' ? session.stream.getTracks() || [] : [];
    const removers = [];
    for (const track of tracks) {
      if (!track || typeof track.addEventListener !== 'function') continue;
      const handler = () => {
        if (isCurrent(session) && state.status === RECORDER_STATUS.recording) stop('track-ended');
      };
      try {
        track.addEventListener('ended', handler);
        removers.push(() => {
          try {
            track.removeEventListener('ended', handler);
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* ignore */
      }
    }
    session.detachTracks = removers.length ? () => removers.forEach((fn) => fn()) : null;
  }

  function releaseStream(session) {
    if (!session) return;
    stopTracks(session.stream);
    session.stream = null;
    detachTrackListeners(session);
  }

  function detachRecorder(recorder) {
    if (!recorder) return;
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      /* 忽略：收尾路径必须走完 */
    }
  }

  function fail(session, code, text) {
    if (session) {
      clearTimers(session);
      detachTrackListeners(session);
      const active = session.recorder;
      session.recorder = null;
      detachRecorder(active);
      releaseStream(session);
      session.chunks = [];
    }
    set({ status: RECORDER_STATUS.error, code, message: text, bytes: 0 });
    onError({ code, message: text });
  }

  function elapsed(session) {
    if (!session || !session.startedAt) return 0;
    return Math.max(0, (now() - session.startedAt) / 1000);
  }

  async function finish(session) {
    if (!isCurrent(session) || session.finishing) return;
    session.finishing = true;
    clearTimers(session);
    detachTrackListeners(session);

    const active = session.recorder;
    session.recorder = null;
    const collected = session.chunks;
    session.chunks = [];
    const chosenMime = state.mimeType;
    const recordedMime = (active && typeof active.mimeType === 'string' && active.mimeType) || chosenMime || '';
    const seconds = elapsed(session);

    // 先放掉麦克风轨道，再慢慢处理分片。
    releaseStream(session);

    if (session.cancelRequested) {
      set({ status: RECORDER_STATUS.cancelled, code: 'cancelled', message: '已取消录音，没有保存任何内容。', bytes: 0 });
      return;
    }

    const parts = [];
    for (const chunk of collected) {
      let bytes = null;
      try {
        bytes = await chunkToBytes(chunk);
      } catch {
        bytes = null;
      }
      // 处理分片期间可能被取消/重置/新一轮录音取代：此时丢弃，不写任何状态。
      if (!isCurrent(session)) return;
      if (bytes && bytes.byteLength) parts.push(bytes);
    }

    if (!isCurrent(session)) return;

    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    if (total === 0) {
      fail(session, 'empty-recording', '这段录音是空的，请重试。');
      return;
    }

    const bytes = concatBytes(parts, total);
    set({
      status: RECORDER_STATUS.ready,
      mimeType: recordedMime,
      seconds,
      bytes: total,
      code: null,
      message: '',
    });
    onResult({ bytes, mimeType: recordedMime, durationSeconds: seconds });
  }

  function armTimers(session) {
    if (Number.isFinite(maxSeconds) && maxSeconds > 0) {
      session.limitTimer = setTimer(() => {
        if (isCurrent(session)) stop('max-duration');
      }, maxSeconds * 1000);
    }
    const tick = () => {
      if (!isCurrent(session) || state.status !== RECORDER_STATUS.recording) return;
      set({ seconds: elapsed(session) });
      session.tickTimer = setTimer(tick, 250);
    };
    session.tickTimer = setTimer(tick, 250);
  }

  function handleGranted(session, stream) {
    // 过期会话（已取消/已重置/已被新一轮取代）：立刻释放轨道，绝不开始录音。
    if (!isCurrent(session) || session.cancelRequested || state.status !== RECORDER_STATUS.requesting) {
      stopTracks(stream);
      return;
    }
    session.stream = stream;
    const choice = pickMimeType(isTypeSupported);
    let instance = null;
    try {
      instance = choice.mimeType
        ? new MediaRecorderImpl(stream, { mimeType: choice.mimeType })
        : new MediaRecorderImpl(stream);
    } catch {
      // 指定 MIME 被拒绝时退回浏览器自选，而不是假设某个容器一定可用。
      try {
        instance = new MediaRecorderImpl(stream);
      } catch (secondError) {
        fail(session, 'recorder-failed', `无法开始录音：${describeError(secondError)}`);
        return;
      }
    }

    session.recorder = instance;
    session.chunks = [];
    session.finishing = false;

    instance.ondataavailable = (event) => {
      if (!isCurrent(session)) return;
      if (event && event.data) session.chunks.push(event.data);
    };
    instance.onstop = () => {
      void finish(session);
    };
    instance.onerror = (event) => {
      if (!isCurrent(session)) return;
      const error = event && event.error ? event.error : event;
      fail(session, 'recorder-error', `录音过程中出错：${describeError(error)}`);
    };

    session.startedAt = now();
    attachTrackEnded(session);

    try {
      instance.start(timesliceMs);
    } catch (error) {
      fail(session, 'recorder-failed', `无法开始录音：${describeError(error)}`);
      return;
    }

    set({
      status: RECORDER_STATUS.recording,
      seconds: 0,
      bytes: 0,
      code: null,
      message: '',
      mimeType: (typeof instance.mimeType === 'string' && instance.mimeType) || choice.mimeType || '',
      mimeSource: choice.source,
    });

    armTimers(session);
  }

  function handleDenied(session, error) {
    // 过期的拒绝（旧一轮权限）不能影响当前这一轮。
    if (!isCurrent(session) || session.cancelRequested) return;
    const code = errorCode(error);
    fail(session, code, errorMessage(code));
  }

  function start() {
    if (disposed) return { ok: false, code: 'disposed' };
    if (BUSY_STATUSES.includes(state.status)) return { ok: false, code: 'busy' };
    if (typeof getUserMedia !== 'function' || typeof MediaRecorderImpl !== 'function') {
      fail(null, 'unsupported', '当前浏览器不支持录音。');
      return { ok: false, code: 'unsupported' };
    }

    // 让任何仍在等待权限的旧会话失效。
    currentSession = null;

    const session = {
      token: (sessionCounter += 1),
      stream: null,
      recorder: null,
      chunks: [],
      startedAt: 0,
      cancelRequested: false,
      finishing: false,
      limitTimer: null,
      tickTimer: null,
      detachTracks: null,
    };
    currentSession = session;

    set({
      status: RECORDER_STATUS.requesting,
      code: null,
      message: '等待麦克风权限…',
      seconds: 0,
      bytes: 0,
      reason: null,
      mimeType: '',
      mimeSource: 'browser',
    });

    let pending;
    try {
      pending = getUserMedia(AUDIO_CONSTRAINTS);
    } catch (error) {
      handleDenied(session, error);
      return { ok: false, code: 'permission-failed' };
    }
    Promise.resolve(pending).then(
      (stream) => handleGranted(session, stream),
      (error) => handleDenied(session, error),
    );
    return { ok: true, token: session.token };
  }

  function stop(reason = 'user') {
    if (disposed) return { ok: false, code: 'disposed' };
    if (state.status === RECORDER_STATUS.requesting) {
      // 权限还没到就点了停止：等同于取消，不会保存任何内容。
      cancel(reason);
      return { ok: true, code: 'cancelled-before-start' };
    }
    if (state.status !== RECORDER_STATUS.recording) return { ok: false, code: 'not-recording' };
    const session = currentSession;
    if (!session) return { ok: false, code: 'not-recording' };

    state.reason = reason;
    clearTimers(session);
    set({ status: RECORDER_STATUS.stopping, code: null, message: '正在结束录音…' });

    const active = session.recorder;
    if (!active) {
      void finish(session);
      return { ok: true };
    }
    try {
      if (active.state !== 'inactive') active.stop();
      else void finish(session);
    } catch {
      void finish(session);
    }
    return { ok: true };
  }

  function cancel(reason = 'user') {
    const session = currentSession;
    // 先把当前会话摘掉：所有旧回调（权限、onstop、异步收尾）立刻失效。
    currentSession = null;

    if (session) {
      session.cancelRequested = true;
      clearTimers(session);
      detachTrackListeners(session);
      const active = session.recorder;
      session.recorder = null;
      detachRecorder(active);
      releaseStream(session);
      session.chunks = [];
    }

    set({
      status: RECORDER_STATUS.cancelled,
      code: 'cancelled',
      message: '已取消录音，麦克风已关闭。',
      bytes: 0,
      seconds: 0,
      reason,
    });
    return { ok: true };
  }

  function dispose() {
    disposed = true;
    cancel('dispose');
    return { ok: true };
  }

  function reset() {
    cancel('reset');
    if (disposed) return { ok: true };
    set({
      status: RECORDER_STATUS.idle,
      code: null,
      message: '',
      bytes: 0,
      seconds: 0,
      mimeType: '',
      mimeSource: 'browser',
      reason: null,
    });
    return { ok: true };
  }

  return {
    start,
    stop,
    cancel,
    dispose,
    reset,
    getState: snapshot,
    /** 是否正在占用麦克风（含等待权限）。 */
    isActive: () => BUSY_STATUSES.includes(state.status),
    /** 仅用于诊断：当前会话 token（没有会话时为 null）。 */
    currentToken: () => (currentSession ? currentSession.token : null),
  };
}
