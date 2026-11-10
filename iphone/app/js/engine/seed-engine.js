/* 真实的本地固定窗口链路适配器（实现 engine/adapter.js 的契约）。
 *
 * 它做四件事：
 *   1. prepare：把用户选择的五个模型文件映射成图角色，逐个读成 ArrayBuffer、建会话、
 *      校验会话契约，再读参考包；任何一步失败都释放已经建好的会话。
 *   2. convert：校验「恰好一个窗口」（44,480 个采样 @16 kHz），跑五图链路，返回 5,733 个
 *      22.05 kHz 采样。其它长度/采样率一律明确拒绝，不裁剪、不补零。
 *   3. cancel / dispose：可中断、可重复调用；dispose 会等准备和推理结束并释放会话。
 *   4. status：installed（代码在）与 prepared（模型+参考已加载）分开报告。
 *
 * 运行时（ort）与会话工厂都是注入的：生产用真实 InferenceSession.run，测试注入受控替身。
 */

import { ENGINE_API_VERSION } from './adapter.js';
import {
  GEOMETRY,
  ROLE_ORDER,
  ROLE_SPECS,
  assertGeometry,
  assertSessionContract,
  chainError,
  throwIfAborted,
} from './contract.js';
import { basenameOf } from './roles.js';
import { mapModelFiles } from './roles.js';
import { readReferenceFile } from './reference.js';
import { createRandomSource } from './random.js';
import { createSessionFactory, SESSION_BACKENDS } from './session-factory.js';
import { runFixedWindowChain } from './seed-chain.js';

export const SEED_ENGINE_ID = 'seed-onnx-fixed-window';

async function readModelBuffer(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw chainError('model-file', `模型文件不可读：${basenameOf(file && file.name) || '未知'}`);
  }
  const buffer = await file.arrayBuffer();
  if (!buffer || typeof buffer.byteLength !== 'number' || buffer.byteLength === 0) {
    throw chainError('model-file', `模型文件是空的：${basenameOf(file.name)}`);
  }
  return buffer;
}

export function createSeedEngine(options = {}) {
  const {
    runtime,
    sessionFactory = null,
    backend = SESSION_BACKENDS.WEBGPU,
    randomOptions = {},
    randomFactory = createRandomSource,
    onStage = null,
    onDiagnostic = null,
  } = options;

  if (!runtime || typeof runtime.Tensor !== 'function') {
    throw new TypeError('本地链路需要一个提供 Tensor 构造器的 ONNX 运行时');
  }
  const factory = sessionFactory || createSessionFactory({ runtime });
  assertGeometry();

  let sessions = null;
  let reference = null;
  let activePreparation = null;
  let preparationAbort = null;
  let activeRun = null;
  let activeAbort = null;
  let releasing = null;
  const progressListeners = new Set();

  function emitProgress(stage, info) {
    for (const listener of progressListeners) {
      try {
        listener(stage, info || null);
      } catch {
        /* 进度订阅者出错不应打断推理 */
      }
    }
  }

  function subscribeProgress(listener) {
    if (typeof listener !== 'function') return () => {};
    progressListeners.add(listener);
    return () => progressListeners.delete(listener);
  }

  function status() {
    const ready = sessions !== null;
    const backendLabel = backend === SESSION_BACKENDS.WEBGPU ? 'GPU 优先' : '纯 CPU（WASM 单线程）';
    return {
      installed: true,
      prepared: ready,
      code: ready ? 'ready' : 'engine-not-prepared',
      message: ready
        ? `本地固定窗口链路已就绪（${backendLabel}）`
        : `本地链路已安装（${backendLabel}），等待五个模型文件与参考包`,
      engineId: SEED_ENGINE_ID,
      apiVersion: ENGINE_API_VERSION,
      models: ready ? ROLE_ORDER.length : 0,
      detail: backend,
      // 引擎对输入的硬要求：界面据此判断「是否需要用户显式截取」。
      window: {
        inputSampleRate: GEOMETRY.inputSampleRate,
        inputSamples: GEOMETRY.inputSamples,
        outputSampleRate: GEOMETRY.outputSampleRate,
        outputSamples: GEOMETRY.outputSamples,
      },
    };
  }

  async function releaseSessions(map) {
    if (!map) return;
    for (const id of ROLE_ORDER) {
      const session = map[id];
      if (!session) continue;
      map[id] = null;
      try {
        if (typeof session.release === 'function') await session.release();
      } catch {
        /* 单个会话释放失败不影响其它会话 */
      }
    }
  }

  /** 让进行中的推理先停下来再继续：推理本身不可中断，所以要等它落地。 */
  async function settleActiveRun() {
    const run = activeRun;
    if (!run) return;
    if (activeAbort) {
      try {
        activeAbort.abort();
      } catch {
        /* ignore */
      }
    }
    try {
      await run;
    } catch {
      /* 取消导致的失败在这里被吞掉 */
    }
  }

  async function prepare({ modelFiles = [], referenceFile = null, signal = null } = {}) {
    if (activePreparation) throw chainError('busy', '已经在准备本地链路');
    const controller = new AbortController();
    preparationAbort = controller;
    const previousRelease = releasing;
    const task = Promise.resolve().then(async () => {
      if (previousRelease) await previousRelease;
      await settleActiveRun();
      return prepareSessions(modelFiles, referenceFile, (stage) => {
        throwIfAborted(signal, stage);
        throwIfAborted(controller.signal, stage);
      });
    });
    activePreparation = task;
    try {
      return await task;
    } finally {
      activePreparation = null;
      preparationAbort = null;
    }
  }

  async function prepareSessions(modelFiles, referenceFile, checkAborted) {
    checkAborted('prepare');
    const previous = sessions;
    sessions = null;
    reference = null;
    // 替换时先释放旧会话，避免同时持有两套模型。
    await releaseSessions(previous);
    checkAborted('prepare');
    let created = null;
    try {
      const mapping = mapModelFiles(modelFiles);
      if (!mapping.ok) {
        throw chainError(
          'model-roles',
          `模型文件不匹配：${mapping.errors.map((item) => item.message).join('；')}`,
        );
      }

      const nextReference = await readReferenceFile(referenceFile);
      checkAborted('prepare');

      created = Object.create(null);
      for (const id of ROLE_ORDER) {
        const stage = `prepare:${id}`;
        checkAborted(stage);
        const file = mapping.roles[id];
        let buffer = await readModelBuffer(file);
        try {
          checkAborted(stage);
          const { session } = await factory.create(buffer, { backend });
          // 先登记再检查：这样后续的取消/契约失败也会把它释放掉，不会漏一个会话。
          created[id] = session;
        } finally {
          // 建完会话（或创建失败）就不再持有模型字节，避免与运行时各留一份。
          // 可选的 releaseModelBytes 让调用方清掉自己那份引用（浏览器 File 没有这个方法，跳过即可）。
          buffer = null;
          if (file && typeof file.releaseModelBytes === 'function') {
            try {
              file.releaseModelBytes();
            } catch {
              /* 释放引用失败不影响会话创建结果 */
            }
          }
        }
        checkAborted(stage);
        assertSessionContract(created[id], ROLE_SPECS[id]);
      }

      checkAborted('prepare');
      sessions = created;
      reference = nextReference;
      return status();
    } catch (error) {
      if (created) await releaseSessions(created);
      throw error;
    }
  }

  async function convert({ samples, sampleRate = null, signal = null } = {}) {
    if (activePreparation) throw chainError('busy', '正在准备本地链路，暂时不能推理');
    if (!sessions) throw chainError('engine-not-prepared', '五个模型与参考包还没准备好');
    if (activeRun) throw chainError('busy', '已有一次固定窗口推理在进行');

    const rate = Number(sampleRate);
    if (rate !== GEOMETRY.inputSampleRate) {
      throw chainError('unsupported-window', `这个版本只支持 16000 Hz 的固定窗口，收到 ${rate}`);
    }
    if (!samples || typeof samples.length !== 'number') {
      throw chainError('unsupported-window', '没有输入采样');
    }
    if (samples.length !== GEOMETRY.inputSamples) {
      throw chainError(
        'unsupported-window',
        `这个版本只支持 ${GEOMETRY.inputSamples} 个采样（约 2.78 秒）的单个窗口，收到 ${samples.length} 个；不做裁剪或补零`,
      );
    }

    const localSessions = sessions;
    const localReference = reference;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onOuterAbort, { once: true });
    }
    activeAbort = controller;

    const run = (async () => {
      const result = await runFixedWindowChain({
        runtime,
        sessions: localSessions,
        reference: localReference,
        randoms: randomFactory(randomOptions),
        samples: Float32Array.from(samples),
        signal: controller.signal,
        onStage: (stage, info) => {
          emitProgress(stage, info);
          if (onStage) onStage(stage, info);
        },
        onDiagnostic: onDiagnostic || undefined,
      });
      throwIfAborted(controller.signal, 'publish');
      return result;
    })();

    activeRun = run;
    try {
      return await run;
    } finally {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onOuterAbort);
      }
      if (activeRun === run) {
        activeRun = null;
        activeAbort = null;
      }
    }
  }

  function cancel() {
    preparationAbort?.abort();
    if (activeAbort) {
      try {
        activeAbort.abort();
      } catch {
        /* ignore */
      }
    }
  }

  function dispose() {
    cancel();
    if (releasing) return releasing;
    const run = activeRun;
    const preparation = activePreparation;
    const old = sessions;
    sessions = null;
    reference = null;
    releasing = (async () => {
      await Promise.allSettled([run, preparation]);
      await releaseSessions(old);
      return status();
    })().finally(() => {
      releasing = null;
    });
    return releasing;
  }

  return {
    apiVersion: ENGINE_API_VERSION,
    engineId: SEED_ENGINE_ID,
    status,
    prepare,
    convert,
    cancel,
    dispose,
    subscribeProgress,
    /** 仅测试/诊断：当前是否真的持有五个会话。 */
    sessionCount: () => (sessions ? ROLE_ORDER.filter((id) => sessions[id]).length : 0),
  };
}
