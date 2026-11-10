/* 固定窗口 Seed 链的契约：几何常量、五个图角色的输入/输出规格、错误类型与校验。
 *
 * 这一层只描述「链路长什么样」，不碰 ONNX、不碰 DOM、不碰随机数。
 * 数值纪律：所有张量都是 float32、行主序（row-major）。
 */

export const CHAIN_VERSION = 'seed-chain/v1';

/**
 * 一个窗口的固定几何。这些数字来自已经验证过的导出图，不能改：
 * 44,480 个 16 kHz 单声道采样 → 38 帧编码特征 → 67 帧目标 → 5,733 个 22.05 kHz 采样。
 */
export const GEOMETRY = Object.freeze({
  inputSampleRate: 16000,
  inputSamples: 44480,
  encoderFrames: 38,
  encoderDim: 1024,
  targetFrames: 67,
  conditionDim: 384,
  melBins: 80,
  referenceFrames: 516,
  totalFrames: 583,
  styleDim: 192,
  harmonics: 9,
  hiftFrames: 17152,
  outputSampleRate: 22050,
  cropStart: 10978,
  cropEnd: 16711,
  outputSamples: 5733,
  steps: 10,
  cfg: 0.7,
});

export function productOf(dims) {
  let total = 1;
  for (const dim of dims) total *= dim;
  return total;
}

/** 链路自身的错误：带稳定的 code，消息里只放形状/长度，不放任何音频或参考数值。 */
export class ChainError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'ChainError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export function chainError(code, message, cause) {
  return new ChainError(code, message, cause);
}

export function isChainError(error) {
  return error instanceof ChainError;
}

/** 中止检查：链路里每个 await 前后都要过一遍。 */
export function throwIfAborted(signal, stage) {
  if (signal && signal.aborted) {
    const error = new Error(`已取消（${stage || 'chain'}）`);
    error.name = 'AbortError';
    throw error;
  }
}

/** 五个图角色的文件名、输入名与输出规格。
 *  输出名由本机真实图核对得到（ORT Web 1.22.0 + 供应方权重）；
 *  名字为 null 表示「只要求恰好一个输出、不限定名字」。 */
export const ROLE_SPECS = Object.freeze({
  xlsr: Object.freeze({
    id: 'xlsr',
    title: 'XLSR 编码器',
    basename: 'xlsr12-fixed-44480-fp32.onnx',
    family: 'xlsr',
    inputs: Object.freeze([{ name: 'wave_float32', dims: [1, 44480] }]),
    output: Object.freeze({ name: 'content_float32', dims: [1, 38, 1024] }),
  }),
  lr: Object.freeze({
    id: 'lr',
    title: '长度调节器',
    basename: 'length-regulator-fixed-38x67.onnx',
    family: 'length-regulator',
    inputs: Object.freeze([{ name: 'features', dims: [1, 38, 1024] }]),
    output: Object.freeze({ name: 'condition', dims: [1, 67, 384] }),
  }),
  dit: Object.freeze({
    id: 'dit',
    title: '扩散模型（含 CFG）',
    basename: 'dit-ref516-target67-cfg-input.onnx',
    family: 'dit',
    inputs: Object.freeze([
      { name: 'state', dims: [1, 80, 583] },
      { name: 'reference_mel', dims: [1, 80, 516] },
      { name: 'style', dims: [1, 192] },
      { name: 'condition', dims: [1, 583, 384] },
      { name: 'time', dims: [1] },
      { name: 'cfg', dims: [1] },
    ]),
    output: Object.freeze({ name: 'guided_velocity', dims: [1, 80, 583] }),
  }),
  hiftFractions: Object.freeze({
    id: 'hiftFractions',
    title: 'HiFT 分数',
    basename: 'hift67-fractions.onnx',
    family: 'hift67-fractions',
    inputs: Object.freeze([{ name: 'mel', dims: [1, 80, 67] }]),
    output: Object.freeze({ name: '/Div_output_0', dims: [1, 9, 17152] }),
  }),
  hiftDecoder: Object.freeze({
    id: 'hiftDecoder',
    title: 'HiFT 解码器',
    basename: 'hift67-explicit-sums.onnx',
    family: 'hift67-explicit-sums',
    inputs: Object.freeze([
      { name: 'mel', dims: [1, 80, 67] },
      { name: 'phase', dims: [1, 9, 1] },
      { name: 'standard_noise', dims: [1, 9, 17152] },
      { name: '/CumSum_output_0', dims: [1, 9, 17152] },
    ]),
    output: Object.freeze({ name: 'wave', dims: [1, 17152] }),
  }),
});

export const ROLE_ORDER = Object.freeze(['xlsr', 'lr', 'dit', 'hiftFractions', 'hiftDecoder']);

/** 自检：几何必须自洽（516 + 67 = 583，裁剪长度 = 5733）。 */
export function assertGeometry() {
  const g = GEOMETRY;
  if (g.referenceFrames + g.targetFrames !== g.totalFrames) {
    throw chainError('geometry', '参考帧 + 目标帧 必须等于总帧数');
  }
  if (g.cropEnd - g.cropStart !== g.outputSamples) {
    throw chainError('geometry', '裁剪区间必须等于输出采样数');
  }
  if (g.cropEnd > g.hiftFrames) {
    throw chainError('geometry', '裁剪终点不能超过解码器输出的采样数');
  }
  if (g.inputSamples <= 0) {
    throw chainError('geometry', '输入采样数必须为正');
  }
  return true;
}

export function assertDims(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    throw chainError('bad-dims', `${label} 维度不匹配：期望 [${expected.join(', ')}]`);
  }
  for (let i = 0; i < expected.length; i += 1) {
    if (actual[i] !== expected[i]) {
      throw chainError(
        'bad-dims',
        `${label} 维度不匹配：期望 [${expected.join(', ')}]，实际 [${actual.join(', ')}]`,
      );
    }
  }
  return true;
}

export function assertFiniteData(data, label) {
  if (!data || typeof data.length !== 'number') {
    throw chainError('bad-data', `${label} 没有采样数据`);
  }
  for (let i = 0; i < data.length; i += 1) {
    if (!Number.isFinite(data[i])) {
      throw chainError('non-finite', `${label} 第 ${i} 个值不是有限数`);
    }
  }
  return true;
}

/**
 * 校验一个输出张量：类型、维度、长度、有限性。返回**复制后**的 Float32Array，
 * 这样调用方释放 ORT 张量之后仍然可用。
 */
export function assertOutputTensor(tensor, outputSpec, label) {
  if (!tensor || typeof tensor !== 'object') {
    throw chainError('missing-output', `${label} 没有返回张量`);
  }
  if (tensor.type !== undefined && tensor.type !== 'float32') {
    throw chainError('bad-type', `${label} 张量类型应为 float32`);
  }
  assertDims(tensor.dims, outputSpec.dims, `${label} 输出`);
  const expectedLength = productOf(outputSpec.dims);
  const data = tensor.data;
  if (!data || typeof data.length !== 'number' || data.length !== expectedLength) {
    throw chainError(
      'bad-length',
      `${label} 输出长度应为 ${expectedLength}，实际 ${data && data.length}`,
    );
  }
  assertFiniteData(data, `${label} 输出`);
  return Float32Array.from(data);
}

/** 取回之后立刻释放，避免 ORT 张量占着内存。 */
export function disposeOutputs(outputs) {
  if (!outputs || typeof outputs !== 'object') return;
  for (const key of Object.keys(outputs)) {
    const tensor = outputs[key];
    if (tensor && typeof tensor.dispose === 'function') {
      try {
        tensor.dispose();
      } catch {
        /* 释放失败不该影响结果 */
      }
    }
  }
}

/**
 * 用 session 暴露的元数据（ORT 的 inputNames / outputNames）核对图是否接对了。
 * 元数据不存在时跳过，由输出张量的形状与有限性兜底。
 */
export function assertSessionContract(session, spec) {
  const inputNames = Array.isArray(session && session.inputNames) ? session.inputNames : null;
  if (inputNames) {
    for (const input of spec.inputs) {
      if (!inputNames.includes(input.name)) {
        throw chainError('session-inputs', `${spec.title} 缺少输入 ${input.name}`);
      }
    }
  }
  const outputNames = Array.isArray(session && session.outputNames) ? session.outputNames : null;
  if (outputNames) {
    if (spec.output.name) {
      if (!outputNames.includes(spec.output.name)) {
        throw chainError('session-outputs', `${spec.title} 缺少输出 ${spec.output.name}`);
      }
    } else if (outputNames.length !== 1) {
      throw chainError('session-outputs', `${spec.title} 应该只有一个输出`);
    }
  }
  return true;
}

/** 需要向 ORT 明确索取的那个输出名；拿不到就请求全部，再按「必须只有一个输出」校验。 */
export function wantedOutputName(session, spec) {
  if (spec.output.name) return [spec.output.name];
  if (Array.isArray(session && session.outputNames) && session.outputNames.length === 1) {
    return [session.outputNames[0]];
  }
  return null;
}
