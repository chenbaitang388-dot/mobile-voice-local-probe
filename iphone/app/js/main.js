/* 浏览器入口：只做环境探测与事件绑定。
   这里不主动调用 getUserMedia、不播放、不发请求——一切都要用户点击。 */

import { createController } from './controller.js';
import { LIMITS } from './config.js';
import { createDecoder } from './decode.js';
import { createMissingEngine } from './engine/missing-engine.js';
import { runWholeUtterance } from './engine/blocks.js';
import { GEOMETRY } from './engine/contract.js';
import { createSeedEngine } from './engine/seed-engine.js';
import { installOfflineFrontend, offlineFrontendReady } from './offline.js';
import { createRecorder } from './recorder.js';
import { resampleMono } from './resample.js';
import { render, ELEMENT_IDS } from './ui.js';

const els = Object.create(null);
for (const id of ELEMENT_IDS) els[id] = document.getElementById(id);
const params = new URLSearchParams(window.location?.search);
const mobileExperiment = params.get('mobile') === '1';
const wholeExperiment = mobileExperiment || (window.location?.hostname === '127.0.0.1' && params.get('experiment') === 'whole');
const experimentLimitSeconds = 5;
const mobileRecordSeconds = 3;

if (wholeExperiment) {
  for (const element of document.querySelectorAll('[data-fixed-window-copy]')) element.hidden = true;
  const notice = document.getElementById('whole-experiment');
  notice.hidden = false;
  notice.textContent = `${mobileExperiment ? 'iPhone 候选' : '桌面实验'} · 整段录音最多 ${experimentLimitSeconds} 秒。每 0.22 秒音频运行一次模型，可能需要数分钟。接缝和听感待验证。`;
  els['convert-start'].textContent = '转换整段（实验）';
}

function on(element, type, handler) {
  if (element && typeof element.addEventListener === 'function') element.addEventListener(type, handler);
}

if (mobileExperiment) {
  document.title = '白棠 v1 · iPhone 离线试用';
  document.getElementById('mobile-offline').hidden = false;
  document.getElementById('record-limit').textContent = `录音上限 ${mobileRecordSeconds} 秒，到点自动停止。首次录音需要授予麦克风权限。`;
  els['model-input'].removeAttribute('accept');
  const button = document.getElementById('offline-install');
  const status = document.getElementById('offline-status');
  const showReady = () => {
    status.dataset.ready = 'true';
    status.textContent = '离线页面已保存。模型与参考包仍由你从「我的 iPhone」导入。';
    button.disabled = true;
  };
  void offlineFrontendReady().then((ready) => {
    if (ready) showReady();
  }).catch(() => {});
  on(button, 'click', async () => {
    button.disabled = true;
    status.textContent = '正在保存离线页面与运行库…';
    try {
      await installOfflineFrontend();
      showReady();
    } catch (error) {
      status.textContent = `保存失败：${error.message}`;
      button.disabled = false;
    }
  });
}

/**
 * 只配置本地随包的运行时：单线程（页面没有 cross-origin isolation）、关闭 proxy、
 * wasm 从同源 vendor 目录加载。任何异常都不影响页面退回「未接入」实现。
 */
function configureRuntime(runtime) {
  try {
    if (runtime.env && runtime.env.wasm) {
      runtime.env.wasm.numThreads = 1;
      runtime.env.wasm.proxy = false;
      runtime.env.wasm.wasmPaths = new URL('../vendor/', location.href).href;
    }
  } catch {
    /* 配置失败时由会话创建阶段报错，界面会显示为「未接入」 */
  }
}

/**
 * 只有本机已经装了真实运行时（全局 ort）才装配固定窗口链路；
 * 没有运行时、或运行时形状不对，就退回「未接入」实现。页面加载时不做任何推理。
 */
/**
 * 有 WebGPU 适配器就请求 GPU（图里不兼容的节点仍可由本机 CPU 处理）；
 * 没有就明确用纯 CPU。这个判断发生在建任何会话之前，不是「会话失败后偷偷退回 CPU」。
 */
async function pickBackend() {
  if (wholeExperiment || params.get('backend') === 'wasm') return 'wasm';
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch {
    /* 探测失败按 CPU 处理 */
  }
  return 'wasm';
}

function resolveEngine(backend) {
  const runtime = typeof window.ort === 'object' && window.ort ? window.ort : null;
  if (!runtime) return createMissingEngine();
  configureRuntime(runtime);
  try {
    const engine = createSeedEngine({ runtime, backend });
    if (!wholeExperiment) return engine;
    const withoutWindow = (status) => ({
      ...status,
      window: null,
      message: status.prepared ? '整段实验已就绪（WASM 单线程）' : status.message,
    });
    return {
      ...engine,
      status: () => withoutWindow(engine.status()),
      prepare: async (options) => withoutWindow(await engine.prepare(options)),
      subscribeProgress: undefined,
      async convert({ samples, sampleRate, signal, onProgress }) {
        if (samples.length / sampleRate > experimentLimitSeconds) {
          throw new Error(`每次最多处理 ${experimentLimitSeconds} 秒。请选择较短的录音。`);
        }
        const inputRate = GEOMETRY.inputSampleRate;
        return runWholeUtterance({
          samples: resampleMono(samples, sampleRate, inputRate),
          signal,
          onProgress: ({ done, total }) => onProgress({ done, total }),
          async processWindow(windowSamples) {
            const result = await engine.convert({ samples: windowSamples, sampleRate: inputRate, signal });
            return result.samples;
          },
        });
      },
    };
  } catch {
    return createMissingEngine({ detail: '本地运行时存在，但无法初始化固定窗口链路' });
  }
}

const AudioContextImpl = window.AudioContext || window.webkitAudioContext || null;
const MediaRecorderImpl = typeof window.MediaRecorder === 'function' ? window.MediaRecorder : null;
const mediaDevices = navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'
  ? navigator.mediaDevices
  : null;

function buildController(backend) {
  return createController({
    decoder: createDecoder({ AudioContextImpl }),
    limits: mobileExperiment ? {
      ...LIMITS,
      maxInputSeconds: experimentLimitSeconds,
      maxRecordSeconds: mobileRecordSeconds,
      maxModelFileBytes: 256 * 1024 * 1024,
      maxModelTotalBytes: 512 * 1024 * 1024,
    } : LIMITS,
    // 没有真实运行时 / 模型 / 参考包时，适配器永远报未准备，界面据此禁用变声。
    engine: resolveEngine(backend),
    createRecorder: (options) =>
      createRecorder({
        ...options,
        maxSeconds: options.limits.maxRecordSeconds,
        getUserMedia: mediaDevices ? (constraints) => mediaDevices.getUserMedia(constraints) : null,
        MediaRecorder: MediaRecorderImpl,
        isTypeSupported:
          MediaRecorderImpl && typeof MediaRecorderImpl.isTypeSupported === 'function'
            ? (mime) => MediaRecorderImpl.isTypeSupported(mime)
            : null,
      }),
    urlImpl: {
      createObjectURL: (blob) => URL.createObjectURL(blob),
      revokeObjectURL: (url) => URL.revokeObjectURL(url),
    },
  });
}

let controller = null;

/* 设备内存只用于给出提示（navigator.deviceMemory 在部分浏览器缺失）。 */
const deviceMemoryGb = typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null;

function renderWithDevice(state) {
  render(els, { ...state, deviceMemoryGb });
}

try {
  const backend = await pickBackend();
  controller = buildController(backend);
  controller.subscribe((state) => renderWithDevice(state));
  renderWithDevice(controller.getState());
  void controller.init();
} catch (error) {
  render(els, {
    phase: 'error',
    recording: { status: 'idle', seconds: 0 },
    models: [],
    reference: null,
    engine: { available: false, message: '页面初始化失败。', engineId: 'unknown', apiVersion: 0 },
    conversion: null,
    converting: false,
    canConvert: false,
    canRecord: false,
    messages: [{ id: 1, level: 'error', text: `页面初始化失败：${(error && error.message) || '未知错误'}` }],
    previews: {},
  });
}

on(els['file-input'], 'change', (event) => {
  const target = event.target;
  const file = target && target.files ? target.files[0] : null;
  if (target) target.value = '';
  if (file && controller) void controller.selectFile(file);
});

on(els['record-start'], 'click', () => {
  if (controller) controller.startRecording();
});

on(els['record-stop'], 'click', () => {
  if (controller) controller.stopRecording();
});

on(els['record-cancel'], 'click', () => {
  if (controller) controller.cancelRecording();
});

on(els['model-input'], 'change', (event) => {
  const target = event.target;
  const files = target && target.files ? Array.from(target.files) : [];
  if (target) target.value = '';
  if (controller) controller.setModels(files);
});

on(els['reference-input'], 'change', (event) => {
  const target = event.target;
  const file = target && target.files ? target.files[0] : null;
  if (target) target.value = '';
  if (controller) controller.setReference(file || null);
});

on(els['engine-prepare'], 'click', () => {
  if (controller) void controller.prepareEngine();
});

on(els['use-excerpt'], 'click', () => {
  if (controller) controller.useFixedWindowExcerpt();
});

on(els['convert-start'], 'click', () => {
  if (controller) void controller.convert();
});

on(els['convert-cancel'], 'click', () => {
  if (controller) controller.cancelConvert();
});

on(els['reset-all'], 'click', () => {
  if (controller) controller.reset();
});

window.addEventListener('pagehide', () => {
  if (controller) void controller.handlePageLeave('pagehide');
});

window.addEventListener('beforeunload', () => {
  if (controller) void controller.handlePageLeave('beforeunload');
});

// BFCache 回来时，之前的一切都已释放：明确告知需要重新开始。首次加载会被控制器忽略。
window.addEventListener('pageshow', () => {
  if (controller) controller.handlePageShow();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && controller) controller.handleVisibilityHidden();
});
