/* 本地推理适配器接口（v1）。
 *
 * 这一版只定义接口与「未接入」实现，界面据此禁用变声，绝不伪造结果。
 * 后续接入完整 ONNX 链（前后处理 + 特征模型 + 参考音色 + 声码器）时，
 * 新增一个实现同一接口的适配器即可，控制器与界面不用改。
 *
 * 状态必须把两件事分开：
 *   installed —— 引擎实现是否存在（「装了没有」）。只有 installed 才能 prepare。
 *   prepared  —— 模型是否已准备就绪（「能不能直接变声」）。只有 prepared 才能 convert。
 * 一个已安装但还没加载模型的引擎必须报告 installed:true / prepared:false，
 * 不得为了「看起来能用」而谎报 prepared。
 *
 * 接口（全部异步方法都应支持 AbortSignal 取消）：
 *
 *   status(): EngineStatus
 *     同步返回当前状态，界面每次渲染都会读它，不能有副作用。
 *
 *   prepare({ modelFiles, referenceFile, signal }): Promise<EngineStatus>
 *     读取用户显式选择的模型/参考文件。实现方自行解码模型，但：
 *     - 只能读这里拿到的 File，不能读取用户没选的文件；
 *     - 文件只能驻留内存，不能写入任何持久化存储；
 *     - 识别不出模型时返回 installed 保持 true、prepared:false，不得声称已就绪。
 *     signal 被 abort 时应尽快结束，拒绝时抛 name === 'AbortError'。
 *
 *   convert({ samples, sampleRate, signal, onProgress }): Promise<ConvertResult>
 *     samples 是单声道 Float32（-1..1），sampleRate 为处理采样率。
 *     返回 { samples: Float32Array, sampleRate: number, meta?: object }。
 *     取消时必须抛 name === 'AbortError'；
 *     不允许返回输入副本、变调或模拟数据来冒充音色转换。
 *     外壳会在 await 之后再次校验操作身份，所以忽略 signal 也不会污染状态，
 *     但实现方仍应尽快响应 abort。
 *
 *   cancel(): void
 *     尽力中止当前 prepare / convert。
 *
 *   dispose(): Promise<void>
 *     释放模型会话、Worker、显存等资源；之后应报告 prepared:false。
 *
 *   subscribeProgress?(fn): () => void      （可选）
 *     订阅阶段进度：fn(stage, {step, total})，返回退订函数。只用于界面展示。
 *
 * EngineStatus = {
 *   installed: boolean,    // 引擎实现存在，可以尝试 prepare
 *   prepared: boolean,     // 已准备，可以 convert
 *   code: string,          // 'engine-missing' | 'engine-not-prepared' | 'ready' | ...
 *   message: string,       // 面向用户的中文说明
 *   engineId: string,
 *   apiVersion: number,    // 必须是 ENGINE_API_VERSION
 *   models?: number,
 *   detail?: string | null,
 *   window?: { inputSampleRate: number, inputSamples: number,
 *              outputSampleRate?: number, outputSamples?: number } | null
 *     引擎只能处理固定窗口时填这里；界面会用「精确命中 / 用户显式截取」来满足它，
 *     不会自动裁剪或补零。
 * }
 */

export const ENGINE_API_VERSION = 1;

export class EngineUnavailableError extends Error {
  constructor(message, code = 'engine-unavailable') {
    super(message);
    this.name = 'EngineUnavailableError';
    this.code = code;
  }
}

export const ENGINE_METHODS = Object.freeze(['status', 'prepare', 'convert', 'cancel', 'dispose']);

/**
 * 检查一个适配器是否满足接口形状。缺方法直接抛错，避免把半个实现当成引擎。
 * @param {any} engine
 */
export function assertEngineContract(engine) {
  if (!engine || typeof engine !== 'object') throw new TypeError('适配器必须是对象');
  for (const method of ENGINE_METHODS) {
    if (typeof engine[method] !== 'function') throw new TypeError(`适配器缺少方法：${method}`);
  }
  if (engine.apiVersion !== ENGINE_API_VERSION) {
    throw new TypeError(`适配器 apiVersion 必须是 ${ENGINE_API_VERSION}`);
  }
  return true;
}

/** 把适配器返回的原始状态收敛成界面可用的形状。 */
export function normalizeEngineStatus(raw, fallbackMessage) {
  if (!raw || typeof raw !== 'object') {
    return {
      installed: false,
      prepared: false,
      code: 'engine-invalid',
      message: fallbackMessage,
      engineId: 'invalid',
      apiVersion: ENGINE_API_VERSION,
      models: 0,
      detail: null,
      window: null,
    };
  }
  const installed = raw.installed === true;
  return {
    installed,
    // 没安装就不可能是准备好的。
    prepared: installed && raw.prepared === true,
    code: typeof raw.code === 'string' ? raw.code : 'unknown',
    message: typeof raw.message === 'string' && raw.message ? raw.message : fallbackMessage,
    engineId: typeof raw.engineId === 'string' ? raw.engineId : 'unknown',
    apiVersion: raw.apiVersion === ENGINE_API_VERSION ? ENGINE_API_VERSION : 0,
    models: Number.isInteger(raw.models) ? raw.models : 0,
    detail: typeof raw.detail === 'string' ? raw.detail : null,
    // 可选：引擎对输入的硬性窗口要求（采样率 + 采样数），界面据此提示「固定窗口」。
    window: normalizeWindow(raw.window),
  };
}

function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const inputSampleRate = raw.inputSampleRate;
  const inputSamples = raw.inputSamples;
  if (!Number.isFinite(inputSampleRate) || !Number.isInteger(inputSamples)) return null;
  if (inputSampleRate <= 0 || inputSamples <= 0) return null;
  return {
    inputSampleRate,
    inputSamples,
    outputSampleRate: Number.isFinite(raw.outputSampleRate) ? raw.outputSampleRate : null,
    outputSamples: Number.isInteger(raw.outputSamples) ? raw.outputSamples : null,
  };
}

/** 把任意异常收敛成界面能显示的状态，避免把 stack 或内部错误抛到界面。 */
export function toEngineStatus(engine, fallbackMessage) {
  try {
    return normalizeEngineStatus(engine.status(), fallbackMessage);
  } catch (error) {
    return {
      installed: false,
      prepared: false,
      code: 'engine-error',
      message: fallbackMessage,
      engineId: 'unknown',
      apiVersion: 0,
      models: 0,
      detail: null,
      window: null,
    };
  }
}
