/* 应用控制器：把「输入 → 解码 → 单声道 → WAV → 适配器」串起来，
   并且自己不碰 DOM。界面只负责把 snapshot 渲染出来。
   所有外部能力（解码器、录音器、适配器、object URL、Blob）都是注入的，
   所以同一份代码能在浏览器里跑，也能在 Node 测试里跑。

   并发模型：
   - inputGen：每一次新的选择/录音都会 +1；解码这类异步工作在每个 await 之后
     都要重新确认自己仍然是最新一代，否则直接丢弃（不留 URL、不留采样）。
   - opGen：准备引擎与变声共用一个「引擎操作」代号；reset / 页面离开 / dispose /
     模型或参考变化都会让旧操作作废，旧操作的 finally 也不会去清空新操作的状态。 */

import { LIMITS, ENGINE_MISSING_MESSAGE } from './config.js';
import { validateFile, validateDecoded, validateModelFiles, validateAuxFile } from './limits.js';
import { summarize, durationOf } from './pcm.js';
import { encodeWav16Mono } from './wav.js';
import { createObjectUrlRegistry } from './object-url.js';
import { toEngineStatus, normalizeEngineStatus } from './engine/adapter.js';
import { BUSY_STATUSES, RECORDER_STATUS } from './recorder.js';
import { formatBytes, formatSeconds, formatHz } from './format.js';
import { resampleMono } from './resample.js';

/* 固定窗口的进度文案：只讲用户能理解的话，不出现张量术语。 */
const STAGE_LABELS = Object.freeze({
  xlsr: '正在分析声音',
  lr: '正在对齐节奏',
  dit: '正在生成音色',
  hiftFractions: '正在合成谐波',
  hiftDecoder: '正在还原波形',
});

const STAGE_BASE = Object.freeze({
  xlsr: 0,
  lr: 12,
  dit: 22,
  hiftFractions: 88,
  hiftDecoder: 94,
  publish: 99,
});

export const URL_KEYS = Object.freeze({
  input: 'input-preview',
  inputWav: 'input-wav',
  output: 'output-preview',
  outputWav: 'output-wav',
});

const IDLE_RECORDING = Object.freeze({
  status: RECORDER_STATUS.idle,
  mimeType: '',
  mimeSource: 'browser',
  seconds: 0,
  bytes: 0,
  code: null,
  message: '',
  reason: null,
});

const MAX_MESSAGES = 12;

/**
 * @param {object} deps
 * @param {{decode:(buffer:ArrayBuffer, options?:object)=>Promise<any>}} deps.decoder
 * @param {object} deps.engine 本地推理适配器（见 engine/adapter.js）
 * @param {Function} [deps.createRecorder] 录音器工厂
 * @param {{createObjectURL:Function, revokeObjectURL:Function}} deps.urlImpl
 * @param {(parts:any[], opts:object)=>any} [deps.makeBlob]
 */
export function createController(deps) {
  const {
    decoder,
    engine,
    createRecorder: createRecorderFactory = null,
    urlImpl,
    makeBlob = (parts, options) => new Blob(parts, options),
    limits = LIMITS,
    now = () => Date.now(),
    onState = () => {},
    createAbortController = () => new AbortController(),
  } = deps || {};

  if (!decoder || typeof decoder.decode !== 'function') throw new TypeError('控制器需要 decoder.decode');
  if (!engine) throw new TypeError('控制器需要 engine 适配器');

  const urls = createObjectUrlRegistry(urlImpl);
  const listeners = new Set();

  const state = {
    phase: 'idle',
    input: null,
    models: [],
    modelFiles: [],
    modelTotalBytes: 0,
    reference: null,
    referenceFile: null,
    engine: null,
    conversion: null,
    converting: false,
    preparing: false,
    messages: [],
  };

  let disposed = false;
  let leftPage = false;
  let engineReady = false;
let unsubscribeProgress = null;
  let releasePromise = null;
  let lifecycleBusy = false;
  let inputGen = 0;
  let opGen = 0;
  let engineAbort = null;
  let messageId = 0;
  let recorder = null;

  /* ---------------- 状态与通知 ---------------- */

  function pushMessage(level, text) {
    if (!text) return;
    messageId += 1;
    state.messages.push({ id: messageId, level, text });
    if (state.messages.length > MAX_MESSAGES) state.messages.splice(0, state.messages.length - MAX_MESSAGES);
  }

  /** 每次读适配器状态都重新归一化；prepared 还要叠加上「本页是否认为它已准备」。 */
  function refreshEngine() {
    const base = toEngineStatus(engine, ENGINE_MISSING_MESSAGE);
    state.engine = { ...base, prepared: base.prepared === true && engineReady === true };
    return state.engine;
  }

  function dropEngineReadiness() {
    engineReady = false;
    refreshEngine();
  }

  function discardPreparedEngine() {
    const hadResources = engineReady || state.preparing || state.converting;
    invalidateEngineOps();
    dropEngineReadiness();
    if (hadResources) void releaseEngineResources();
  }

  /** 让进行中的 prepare/convert 作废：不再提交结果，也不再清理「新」操作的状态。 */
  function invalidateEngineOps() {
    opGen += 1;
    const abort = engineAbort;
    engineAbort = null;
    if (abort) {
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
    }
    state.preparing = false;
    state.converting = false;
    try {
      engine.cancel();
    } catch {
      /* 适配器 cancel 失败不影响壳的状态 */
    }
  }

  /** 输入换了：只丢弃正在进行的变声（模型仍然可以算已准备）。 */
  function abandonConversion() {
    if (!state.converting) return false;
    opGen += 1;
    const abort = engineAbort;
    engineAbort = null;
    if (abort) {
      try {
        abort.abort();
      } catch {
        /* ignore */
      }
    }
    state.converting = false;
    try {
      engine.cancel();
    } catch {
      /* ignore */
    }
    return true;
  }

  function canPrepare() {
    return !disposed && state.engine !== null && state.engine.installed === true && !state.preparing && !state.converting;
  }

  function canConvert() {
    return (
      !disposed &&
      Boolean(state.input) &&
      state.engine !== null &&
      state.engine.prepared === true &&
      !state.converting &&
      !state.preparing &&
      // 引擎声明了固定窗口时，必须已经得到一个长度正确的窗口（精确命中或用户显式截取）。
      (!state.engine.window || (state.input.window && state.input.window.ready === true))
    );
  }

  function canRecord() {
    return !disposed && Boolean(recorder);
  }

  function snapshot() {
    const input = state.input;
    return {
      phase: state.phase,
      disposed,
      input: input
        ? {
            sourceKind: input.sourceKind,
            sourceName: input.sourceName,
            sourceMime: input.sourceMime,
            sampleRate: input.sampleRate,
            originalSampleRate: input.originalSampleRate,
            originalSampleRateKnown: input.originalSampleRateKnown,
            sourceChannels: input.sourceChannels,
            sourceChannelsKnown: input.sourceChannelsKnown,
            resampled: input.resampled,
            channels: 1,
            durationSeconds: input.durationSeconds,
            sampleCount: input.samples.length,
            peak: input.peak,
            silent: input.silent,
            window: input.window
              ? {
                  ready: input.window.ready === true,
                  code: input.window.code || null,
                  source: input.window.source || null,
                  available: input.window.available,
                  needed: input.window.needed,
                  chainSeconds: input.window.chainSeconds,
                  neededSeconds: input.window.neededSeconds,
                  chainSampleRate: input.chainSampleRate || null,
                }
              : null,
          }
        : null,
      recording: recorder ? recorder.getState() : { ...IDLE_RECORDING },
      models: state.models.map((item) => ({ ...item })),
      modelTotalBytes: state.modelTotalBytes,
      reference: state.reference ? { ...state.reference } : null,
      engine: { ...state.engine },
      progress: state.progress ? { ...state.progress } : null,
      conversion: state.conversion ? { ...state.conversion } : null,
      converting: state.converting,
      preparing: state.preparing,
      canConvert: canConvert(),
      canPrepare: canPrepare(),
      canRecord: canRecord(),
      canUseExcerpt: Boolean(input && input.window && input.window.code === 'needs-excerpt'),
      messages: state.messages.map((item) => ({ ...item })),
      previews: {
        inputAudio: urls.get(URL_KEYS.input),
        inputWav: urls.get(URL_KEYS.inputWav),
        outputAudio: urls.get(URL_KEYS.output),
        outputWav: urls.get(URL_KEYS.outputWav),
      },
    };
  }

  function notify() {
    const snap = snapshot();
    try {
      onState(snap);
    } catch {
      /* 渲染失败不应打断控制器 */
    }
    for (const listener of listeners) {
      try {
        listener(snap);
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------- 输入与结果 ---------------- */

  function clearConversion(reason) {
    const had = state.conversion !== null || urls.has(URL_KEYS.output) || urls.has(URL_KEYS.outputWav);
    urls.release(URL_KEYS.output);
    urls.release(URL_KEYS.outputWav);
    state.conversion = null;
    if (had && reason === 'input-changed') pushMessage('info', '输入变了，旧的变声结果已丢弃。');
    if (had && reason === 'model-changed') pushMessage('info', '模型或参考文件变了，旧的变声结果已丢弃。');
    return had;
  }

  function clearInput() {
    urls.release(URL_KEYS.input);
    urls.release(URL_KEYS.inputWav);
    state.input = null;
  }

  function rejectInput(gen, check) {
    if (gen !== inputGen || disposed) return { ok: false, code: 'superseded' };
    pushMessage('error', check.message || '这个输入无法使用。');
    state.phase = state.input ? 'ready' : 'error';
    notify();
    return { ok: false, code: check.code, message: check.message };
  }

  /** 引擎声明了固定窗口时，把当前输入显式重采样到它的输入采样率并判断长度。 */
  function fixedWindowSpec() {
    const win = state.engine && state.engine.window;
    if (!win) return null;
    if (!Number.isFinite(win.inputSampleRate) || !Number.isInteger(win.inputSamples)) return null;
    return win;
  }

  function applyFixedWindow() {
    const spec = fixedWindowSpec();
    const input = state.input;
    if (!input) return;
    if (!spec) {
      input.chainSamples = null;
      input.chainSampleRate = null;
      input.window = null;
      return;
    }
    const chain = resampleMono(input.samples, input.sampleRate, spec.inputSampleRate);
    const available = chain.length;
    const needed = spec.inputSamples;
    const base = {
      available,
      needed,
      chainSeconds: available / spec.inputSampleRate,
      neededSeconds: needed / spec.inputSampleRate,
      samples: null,
      source: null,
      ready: false,
      code: null,
    };
    if (available === needed) {
      input.window = { ...base, ready: true, source: 'exact', samples: chain };
    } else if (available > needed) {
      input.window = { ...base, code: 'needs-excerpt' };
      pushMessage(
        'warn',
        `这段音频重采样后约 ${formatSeconds(base.chainSeconds)}，比固定窗口（约 ${base.neededSeconds.toFixed(2)} 秒）长。` +
          '可以点「使用开头 2.78 秒」明确截取；程序不会自动裁剪，也不会补零。',
      );
    } else {
      input.window = { ...base, code: 'too-short' };
      pushMessage(
        'warn',
        `这段音频重采样后只有约 ${formatSeconds(base.chainSeconds)}，比固定窗口（约 ${base.neededSeconds.toFixed(2)} 秒）短。` +
          '这一版不补零，请换一段更长的音频。',
      );
    }
    input.chainSamples = chain;
    input.chainSampleRate = spec.inputSampleRate;
  }

  /** 用户显式点击「使用开头 2.78 秒」才截取；从不自动发生。 */
  function useFixedWindowExcerpt() {
    if (disposed) return { ok: false, code: 'disposed' };
    const spec = fixedWindowSpec();
    const input = state.input;
    if (!spec || !input || !input.chainSamples) {
      return { ok: false, code: 'no-window', message: '当前输入没有可截取的窗口。' };
    }
    if (input.chainSamples.length < spec.inputSamples) {
      pushMessage('warn', '这段音频比固定窗口短，不能靠截取解决。');
      notify();
      return { ok: false, code: 'too-short' };
    }
    input.window = {
      ...(input.window || {}),
      ready: true,
      source: 'excerpt',
      code: null,
      samples: input.chainSamples.slice(0, spec.inputSamples),
      available: input.chainSamples.length,
      needed: spec.inputSamples,
      chainSeconds: input.chainSamples.length / spec.inputSampleRate,
      neededSeconds: spec.inputSamples / spec.inputSampleRate,
    };
    clearConversion('window-changed');
    pushMessage('info', '已按你的选择，只使用开头约 2.78 秒作为本次输入。');
    notify();
    return { ok: true };
  }

  function commitInput(decoded, meta, gen) {
    // 最后一道闸：提交前再确认还是最新一代，否则一个字节都不写。
    if (gen !== inputGen || disposed) return { ok: false, code: 'superseded' };

    const samples = decoded.samples;
    const sampleRate = decoded.sampleRate;
    const stats = summarize(samples);
    const wavBytes = encodeWav16Mono(samples, sampleRate);

    urls.set(URL_KEYS.input, makeBlob([wavBytes], { type: 'audio/wav' }));
    urls.set(URL_KEYS.inputWav, makeBlob([wavBytes], { type: 'audio/wav' }));

    state.input = {
      samples,
      sampleRate,
      originalSampleRate: decoded.originalSampleRate,
      originalSampleRateKnown: decoded.originalSampleRateKnown === true,
      sourceChannels: decoded.originalChannels,
      sourceChannelsKnown: decoded.originalChannelsKnown === true,
      resampled: decoded.resampled === true,
      durationSeconds: durationOf(samples, sampleRate),
      peak: stats.peak,
      silent: stats.silent,
      sourceKind: meta.sourceKind,
      sourceName: meta.sourceName,
      sourceMime: meta.mimeType || '',
    };
    state.phase = 'ready';

    applyFixedWindow();

    clearConversion('input-changed');
    pushMessage(
      'info',
      `已载入${meta.sourceName}：单声道 WAV，${formatSeconds(state.input.durationSeconds)}，处理采样率 ${formatHz(sampleRate)}。`,
    );
    if (stats.silent) pushMessage('warn', '这段音频几乎全静音，处理后可能也听不到声音。');
    notify();
    return { ok: true };
  }

  async function ingestArrayBuffer(arrayBuffer, meta, gen) {
    if (gen !== inputGen || disposed) return { ok: false, code: 'superseded' };
    state.phase = 'decoding';
    notify();

    let decoded;
    try {
      decoded = await decoder.decode(arrayBuffer);
    } catch (error) {
      return rejectInput(gen, {
        ok: false,
        code: (error && error.code) || 'decode-failed',
        message: (error && error.message) || '这段音频解码失败。',
      });
    }
    // 解码期间可能被 reset / 页面离开 / 新的选择取代。
    if (gen !== inputGen || disposed) return { ok: false, code: 'superseded' };

    const check = validateDecoded(decoded, limits);
    if (!check.ok) return rejectInput(gen, check);
    return commitInput(decoded, meta, gen);
  }

  async function selectFile(file) {
    if (disposed) return { ok: false, code: 'disposed' };
    const gen = (inputGen += 1);
    // 新输入让进行中的变声立刻作废（旧结果不再有意义）。
    abandonConversion();

    const check = validateFile(file, limits);
    if (!check.ok) {
      if (gen !== inputGen) return { ok: false, code: 'superseded' };
      pushMessage('error', check.message);
      state.phase = state.input ? 'ready' : 'error';
      notify();
      return check;
    }

    let buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch {
      return rejectInput(gen, { ok: false, code: 'read-failed', message: '读不出这个文件，请重试。' });
    }
    if (gen !== inputGen || disposed) return { ok: false, code: 'superseded' };

    return ingestArrayBuffer(
      buffer,
      { sourceKind: 'file', sourceName: file.name || '本地文件', mimeType: file.type || '' },
      gen,
    );
  }

  function handleRecordingResult(result) {
    if (disposed) return { ok: false, code: 'disposed' };
    const gen = (inputGen += 1);
    abandonConversion();
    const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes);
    pushMessage(
      'info',
      `录音结束（${formatBytes(bytes.byteLength)}，${result.mimeType || '浏览器默认格式'}），正在解码。`,
    );
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return ingestArrayBuffer(
      copy,
      { sourceKind: 'recording', sourceName: '麦克风录音', mimeType: result.mimeType || '' },
      gen,
    );
  }

  if (typeof createRecorderFactory === 'function') {
    recorder = createRecorderFactory({
      now,
      limits,
      onChange: () => notify(),
      onResult: (result) => {
        void handleRecordingResult(result);
      },
      onError: (error) => {
        pushMessage('error', (error && error.message) || '录音失败。');
        notify();
      },
    });
  }

  /* ---------------- 录音控制 ---------------- */

  function startRecording() {
    if (disposed) return { ok: false, code: 'disposed' };
    if (!recorder) {
      pushMessage('error', '当前环境不支持录音。');
      notify();
      return { ok: false, code: 'unsupported' };
    }
    const result = recorder.start();
    if (result && result.ok === false) pushMessage('error', '无法开始录音。');
    return result;
  }

  function stopRecording() {
    if (!recorder) return { ok: false, code: 'unsupported' };
    return recorder.stop('user');
  }

  function cancelRecording() {
    if (!recorder) return { ok: false, code: 'unsupported' };
    return recorder.cancel('user');
  }

  function isRecordingBusy() {
    return Boolean(recorder) && BUSY_STATUSES.includes(recorder.getState().status);
  }

  /* ---------------- 模型与参考 ---------------- */

  function setModels(fileList) {
    if (disposed) return { ok: false, code: 'disposed' };
    const list = Array.from(fileList || []).filter(Boolean);
    const result = validateModelFiles(list, limits);

    for (const item of result.rejected) pushMessage('warn', `${item.name}：${item.message}`);
    if (result.rejected.length) {
      pushMessage(
        'warn',
        `已接受 ${result.accepted.length} 个模型文件（合计 ${formatBytes(result.totalBytes)}），忽略 ${result.rejected.length} 个。`,
      );
    }

    state.modelFiles = result.accepted;
    state.models = result.accepted.map((file) => ({ name: file.name || '未命名', size: file.size, type: file.type || '' }));
    state.modelTotalBytes = result.totalBytes;

    // 只记名字和大小：这里不读取文件内容。
    pushMessage('info', '模型文件只保留在内存里；本页不读取未选择的文件，也不声称已识别模型格式。');

    // 模型换了：进行中的操作作废、旧结果作废、需要重新准备。
    discardPreparedEngine();
    clearConversion('model-changed');
    notify();
    return { ok: result.ok, count: result.accepted.length, totalBytes: result.totalBytes, rejected: result.rejected };
  }

  function setReference(file) {
    if (disposed) return { ok: false, code: 'disposed' };
    if (!file) {
      const had = state.referenceFile !== null;
      state.reference = null;
      state.referenceFile = null;
      if (had) {
        discardPreparedEngine();
        clearConversion('model-changed');
        pushMessage('info', '已清除参考文件。');
      }
      notify();
      return { ok: true, cleared: true };
    }

    const check = validateAuxFile(file, limits.maxReferenceBytes, '参考文件');
    if (!check.ok) {
      pushMessage('error', check.message);
      notify();
      return { ok: false, code: check.code, message: check.message };
    }

    state.referenceFile = file;
    state.reference = { name: file.name || '未命名', size: file.size, type: file.type || '' };
    pushMessage('info', '参考文件只保留在内存里，不会上传。');
    discardPreparedEngine();
    clearConversion('model-changed');
    notify();
    return { ok: true };
  }

  /* ---------------- 引擎：准备与变声 ---------------- */

  /**
   * 准备与「引擎释放」互斥：页面离开开始释放时，快速恢复（BFCache）触发的重新准备
   * 必须先等释放真正结束，不能和仍在等待的 dispose 交叉。
   */
  async function prepareEngine() {
    if (disposed) return { ok: false, code: 'disposed' };
    if (lifecycleBusy || state.preparing || state.converting) return { ok: false, code: 'busy' };
    lifecycleBusy = true;
    try {
      if (releasePromise) {
        await releasePromise;
        if (disposed) return { ok: false, code: 'disposed' };
        if (state.preparing || state.converting) return { ok: false, code: 'busy' };
      }
      return await prepareEngineInner();
    } finally {
      lifecycleBusy = false;
    }
  }

  async function prepareEngineInner() {
    const status = refreshEngine();
    if (!status.installed) {
      pushMessage('warn', status.message);
      notify();
      return { ok: false, code: 'engine-missing', message: status.message };
    }

    const token = (opGen += 1);
    const abort = createAbortController();
    engineAbort = abort;
    state.preparing = true;
    notify();

    let result;
    try {
      const raw = await engine.prepare({
        modelFiles: state.modelFiles.slice(),
        referenceFile: state.referenceFile,
        signal: abort.signal,
      });
      if (token !== opGen || disposed) return { ok: false, code: 'superseded' };

      const next = normalizeEngineStatus(raw, status.message);
      engineReady = next.prepared === true;
      state.engine = { ...next, prepared: engineReady };
      pushMessage('info', engineReady ? '本地引擎已准备。' : next.message || '本地引擎还没准备就绪。');
      result = { ok: engineReady, code: next.code };
    } catch (error) {
      // 作废的操作不许往界面写任何东西，也不许改引擎状态。
      if (token !== opGen || disposed) return { ok: false, code: 'superseded' };
      if ((error && error.name === 'AbortError') || abort.signal.aborted) {
        pushMessage('warn', '已取消准备引擎。');
        return { ok: false, code: 'aborted' };
      }
      pushMessage('error', `引擎准备失败：${(error && error.message) || '未知错误'}`);
      dropEngineReadiness();
      result = { ok: false, code: (error && error.code) || 'prepare-failed' };
    } finally {
      // 只有「当前操作」才允许清空状态，否则会把新操作按下去。
      if (token === opGen) {
        state.preparing = false;
        engineAbort = null;
        notify();
      }
    }
    return result;
  }

  async function convert() {
    if (disposed) return { ok: false, code: 'disposed' };
    if (!state.input) {
      pushMessage('error', '请先选择或录制一段音频。');
      notify();
      return { ok: false, code: 'no-input', message: '还没有可转换的输入。' };
    }
    if (state.converting || state.preparing) return { ok: false, code: 'busy' };

    const status = refreshEngine();
    if (!status.installed) {
      // 关键：引擎缺失时绝不调用 convert，也绝不生成任何「结果」。
      pushMessage('warn', ENGINE_MISSING_MESSAGE);
      notify();
      return { ok: false, code: 'engine-missing', message: ENGINE_MISSING_MESSAGE };
    }
    if (!status.prepared) {
      pushMessage('warn', '本地引擎还没有准备模型，暂时不能变声。');
      notify();
      return { ok: false, code: 'engine-not-prepared', message: '本地引擎还没有准备模型。' };
    }

    const token = (opGen += 1);
    const abort = createAbortController();
    engineAbort = abort;
    state.converting = true;

    // 引擎声明了固定窗口时，只送窗口内的采样；否则照旧送整段输入。
    const spec = fixedWindowSpec();
    const windowReady = spec ? Boolean(state.input.window && state.input.window.ready) : true;
    if (spec && !windowReady) {
      state.converting = false;
      const message =
        state.input.window && state.input.window.code === 'too-short'
          ? '这段音频比固定窗口短。这一版不补零，请换一段更长的音频。'
          : '这段音频比固定窗口长。请先点「使用开头 2.78 秒」明确截取。';
      pushMessage('warn', message);
      notify();
      return { ok: false, code: 'window-not-ready', message };
    }
    const engineSamples = spec ? state.input.window.samples : state.input.samples;
    const engineRate = spec ? state.input.chainSampleRate : state.input.sampleRate;
    state.progress = { stage: 'prepare', label: '正在准备本地推理', percent: 0 };
    notify();

    let result;
    try {
      const output = await engine.convert({
        samples: engineSamples,
        sampleRate: engineRate,
        signal: abort.signal,
        models: state.models.map((item) => ({ ...item })),
        modelFiles: state.modelFiles.slice(),
        referenceFile: state.referenceFile,
        onProgress: ({ done, total } = {}) => {
          if (token !== opGen || abort.signal.aborted || !Number.isInteger(done) || !Number.isInteger(total) || total <= 0) return;
          state.progress = { stage: 'blocks', label: `已转换 ${done} / ${total} 段`, percent: Math.round(100 * done / total) };
          notify();
        },
      });

      // await 之后重新确认：操作没被作废、没有被取消、页面还在。
      if (token !== opGen || disposed) return { ok: false, code: 'superseded' };
      if (abort.signal.aborted) {
        pushMessage('warn', '已取消变声。');
        return { ok: false, code: 'aborted' };
      }

      const samples = output && output.samples;
      if (!(samples instanceof Float32Array) || samples.length === 0) {
        throw Object.assign(new Error('适配器没有返回可用的音频数据。'), { code: 'engine-bad-result' });
      }
      const sampleRate =
        Number.isFinite(output.sampleRate) && output.sampleRate > 0
          ? output.sampleRate
          : (spec && spec.outputSampleRate) || state.input.sampleRate;
      const wavBytes = encodeWav16Mono(samples, sampleRate);
      urls.set(URL_KEYS.output, makeBlob([wavBytes], { type: 'audio/wav' }));
      urls.set(URL_KEYS.outputWav, makeBlob([wavBytes], { type: 'audio/wav' }));
      state.conversion = {
        sampleRate,
        durationSeconds: durationOf(samples, sampleRate),
        sampleCount: samples.length,
        engineId: status.engineId,
        createdAt: now(),
      };
      const duration = formatSeconds(state.conversion.durationSeconds);
      pushMessage('info', spec
        ? `本地引擎返回约 ${duration} 的固定窗口片段，音色效果待试听。`
        : `本地引擎已生成约 ${duration} 的音频，音色效果待试听。`);
      result = { ok: true };
    } catch (error) {
      if (token !== opGen || disposed) return { ok: false, code: 'superseded' };
      if ((error && error.name === 'AbortError') || abort.signal.aborted) {
        pushMessage('warn', '已取消变声。');
        return { ok: false, code: 'aborted' };
      }
      pushMessage('error', `变声失败：${(error && error.message) || '未知错误'}`);
      result = { ok: false, code: (error && error.code) || 'convert-failed' };
    } finally {
      if (token === opGen) {
        state.converting = false;
        state.progress = null;
        engineAbort = null;
        notify();
      }
    }
    return result;
  }

  function cancelConvert() {
    // prepare 与 convert 共用一个 abort；两者都能取消。
    if (!engineAbort) return { ok: false, code: 'not-converting' };
    try {
      engineAbort.abort();
    } catch {
      return { ok: false, code: 'abort-failed' };
    }
    pushMessage('warn', state.preparing ? '已请求取消准备。' : '已请求取消变声。');
    notify();
    return { ok: true };
  }

  /* ---------------- 生命周期 ---------------- */

  /**
   * 释放引擎资源。同一个释放过程只跑一次：并发的调用共享同一个 promise，
   * 这样「页面离开开始释放 → 立刻从 BFCache 回来重新准备」不会踩到半释放状态。
   */
  function releaseEngineResources() {
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      try {
        await engine.dispose();
      } catch {
        /* 释放失败不影响关闭流程 */
      }
      refreshEngine();
      notify();
    })().finally(() => {
      releasePromise = null;
    });
    return releasePromise;
  }

  /** 页面切到后台：停止麦克风，但不丢弃已处理好的输入。 */
  function handleVisibilityHidden() {
    if (isRecordingBusy()) {
      recorder.cancel('hidden');
      pushMessage('warn', '页面切到后台，已停止录音并关闭麦克风。');
      notify();
    }
  }

  /**
   * 页面离开（pagehide / beforeunload）：停止轨道、取消进行中的操作、
   * 释放所有 object URL，并释放引擎资源（推理会话 / 显存）。
   */
  async function handlePageLeave(reason = 'page-left') {
    leftPage = true;
    const wasRecording = isRecordingBusy();
    if (recorder) recorder.cancel(reason);

    invalidateEngineOps();
    inputGen += 1;
    urls.releaseAll();
    clearInput();
    state.conversion = null;
    state.converting = false;
    state.preparing = false;
    state.phase = 'idle';
    state.modelFiles = [];
    state.models = [];
    state.modelTotalBytes = 0;
    state.reference = null;
    state.referenceFile = null;
    dropEngineReadiness();

    if (wasRecording) pushMessage('warn', '页面已离开，麦克风轨道已停止，录音没有保存。');
    notify();

    await releaseEngineResources();
    return { ok: true };
  }

  /** 从 BFCache 恢复：之前的一切都已释放，不能假装还接着用。 */
  function handlePageShow() {
    if (!leftPage) return { ok: false, code: 'not-left' };
    leftPage = false;
    refreshEngine();
    pushMessage('warn', '页面已恢复：之前的音频、模型和引擎资源都已释放，需要重新选择并重新准备。');
    notify();
    return { ok: true };
  }

  function reset() {
    if (recorder) {
      recorder.cancel('reset');
      recorder.reset();
    }
    discardPreparedEngine();
    inputGen += 1;
    urls.releaseAll();
    clearInput();
    state.conversion = null;
    state.phase = 'idle';
    state.modelFiles = [];
    state.models = [];
    state.modelTotalBytes = 0;
    state.reference = null;
    state.referenceFile = null;
    pushMessage('info', '已清除本页内存里的音频与文件引用。');
    notify();
    return { ok: true };
  }

  async function init() {
    const base = toEngineStatus(engine, ENGINE_MISSING_MESSAGE);
    engineReady = base.prepared === true;
    refreshEngine();
    if (!state.engine.installed) pushMessage('warn', state.engine.message);

    // 可选：订阅推理阶段进度（只影响展示，不影响结果）。
    if (typeof engine.subscribeProgress === 'function') {
      try {
        unsubscribeProgress = engine.subscribeProgress((stage, info) => {
          if (disposed || !state.converting) return;
          const label = STAGE_LABELS[stage] || '正在本地推理';
          const basePercent = STAGE_BASE[stage] || 0;
          const span = stage === 'dit' ? 66 : 6;
          const ratio = info && info.total ? Math.min(1, info.step / info.total) : 0;
          state.progress = {
            stage,
            label,
            percent: Math.round(basePercent + span * ratio),
            step: info && Number.isInteger(info.step) ? info.step : null,
            total: info && Number.isInteger(info.total) ? info.total : null,
          };
          notify();
        });
      } catch {
        unsubscribeProgress = null;
      }
    }

    notify();
    return snapshot();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('subscribe 需要函数');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    if (unsubscribeProgress) {
      try {
        unsubscribeProgress();
      } catch {
        /* ignore */
      }
      unsubscribeProgress = null;
    }
    await handlePageLeave('dispose');
    if (recorder && typeof recorder.dispose === 'function') recorder.dispose();
    listeners.clear();
  }

  // 构造时就按适配器状态定初值，避免第一帧出现「可用」的错觉。
  engineReady = toEngineStatus(engine, ENGINE_MISSING_MESSAGE).prepared === true;
  refreshEngine();

  return {
    init,
    getState: snapshot,
    subscribe,
    selectFile,
    startRecording,
    stopRecording,
    cancelRecording,
    handleVisibilityHidden,
    handlePageLeave,
    handlePageShow,
    setModels,
    setReference,
    prepareEngine,
    convert,
    cancelConvert,
    useFixedWindowExcerpt,
    reset,
    dispose,
    isRecordingBusy,
  };
}
