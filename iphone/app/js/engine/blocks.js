/* 实验性：把长音频切成多个固定窗口再拼回来。
 *
 * 正式拼接门禁保持关闭（BLOCKS_ENABLED === false）。本机回环页可显式开启桌面实验。
 * 原因：真正可用的多块拼接依赖「上下文几何」——每个窗口需要多少前置采样、
 * 窗口之间用什么重叠/对齐、以及模型对截断边界的真实行为。
 * runWholeUtterance 根据固定图的尾部裁剪实现离线原型，仍需真实录音验证接缝。
 * runBlockSchedule 是独立的通用调度器，由调用方显式提供几何参数。
 *
 * 本批新增（都有实测依据，见 PERF_REPORT.md）：
 *  - `analyzeBlockGeometry()`：把「时长/边界/对齐」约束显式算出来，而不是猜；
 *  - `assertConcatenationAllowed()`：整句拼接的执行门禁，缺证据就抛错；
 *  - 内存修正：不再 O(n) 堆积所有窗口副本；去掉第三块全长缓冲；
 *  - `previousOutputTail` 语义修正：原来给的是「上一块输入窗口」的尾段，
 *    名字与单位都错；现在由调用方显式给 `outputContextSamples`，给不出就是空数组。
 *
 * 本模块只做确定性的切块、重叠相加与取消，模型调用由注入的 processWindow 完成。 */

import { GEOMETRY, chainError, throwIfAborted } from './contract.js';

export const BLOCKS_ENABLED = false;

// The upstream Seed-VC inference crop takes return_length × sr / 50 samples
// immediately before skip_tail × sr / 50. The exported 5733 + 441 samples
// therefore correspond to 13 output ticks and one input lookahead tick.
const INPUT_TICK = GEOMETRY.inputSampleRate / 50;
const OUTPUT_TICK = GEOMETRY.outputSampleRate / 50;
const LOOKAHEAD_TICKS = (GEOMETRY.hiftFrames - GEOMETRY.cropEnd) / OUTPUT_TICK;
const RETURN_TICKS = GEOMETRY.outputSamples / OUTPUT_TICK;
const OVERLAP = OUTPUT_TICK;
const SEARCH = OUTPUT_TICK;
const HOP_IN = (RETURN_TICKS - 2) * INPUT_TICK;
const HOP_OUT = (RETURN_TICKS - 2) * OUTPUT_TICK;
const LEFT_CONTEXT = GEOMETRY.inputSamples - (RETURN_TICKS + LOOKAHEAD_TICKS) * INPUT_TICK;

function findOverlapOffset(previous, next) {
  let previousEnergy = 0;
  for (const sample of previous) previousEnergy += sample * sample;
  if (previousEnergy <= 1e-12) return 0;

  let bestOffset = 0;
  let bestCorrelation = 0.2;
  for (let offset = 0; offset <= SEARCH; offset += 1) {
    let dot = 0;
    let nextEnergy = 0;
    for (let i = 0; i < OVERLAP; i += 1) {
      const sample = next[offset + i];
      dot += previous[i] * sample;
      nextEnergy += sample * sample;
    }
    if (nextEnergy <= 1e-12) continue;
    const correlation = dot / Math.sqrt(previousEnergy * nextEnergy);
    if (correlation > bestCorrelation + 1e-9) {
      bestCorrelation = correlation;
      bestOffset = offset;
    }
  }
  return bestOffset;
}

/**
 * Offline prototype. The 16 kHz input timeline advances by 220 ms per call.
 * The model's 260 ms crop provides one tick each for crossfade and SOLA
 * search. Edge context is zero-padded and only the requested length is kept.
 */
export async function runWholeUtterance({
  samples,
  processWindow,
  signal = null,
  onProgress = null,
  yieldToHost = () => Promise.resolve(),
} = {}) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    throw chainError('blocks-input', '整段转换需要非空的 16 kHz 单声道 Float32Array');
  }
  if (typeof processWindow !== 'function') throw chainError('blocks-handler', '缺少 processWindow');
  throwIfAborted(signal, 'whole-utterance');

  const sampleRate = GEOMETRY.outputSampleRate;
  const totalOut = Math.round(samples.length * sampleRate / GEOMETRY.inputSampleRate);
  const output = new Float32Array(totalOut);
  const total = Math.ceil(totalOut / HOP_OUT);
  const window = new Float32Array(GEOMETRY.inputSamples);
  const previous = new Float32Array(OVERLAP);
  const offsets = [];

  for (let index = 0; index < total; index += 1) {
    await yieldToHost();
    throwIfAborted(signal, `block:${index}`);
    const start = index * HOP_IN;
    const end = Math.min(start + HOP_IN, samples.length);
    const windowStart = start - LEFT_CONTEXT;
    const windowEnd = windowStart + window.length;
    const copyStart = Math.max(0, windowStart);
    const copyEnd = Math.min(samples.length, windowEnd);
    window.fill(0);
    window.set(samples.subarray(copyStart, copyEnd), copyStart - windowStart);

    const block = await processWindow(window, { index, start, end, signal });
    throwIfAborted(signal, `block:${index}`);
    if (!(block instanceof Float32Array) || block.length !== GEOMETRY.outputSamples) {
      throw chainError('blocks-output', `第 ${index + 1} 块输出必须是 ${GEOMETRY.outputSamples} 个采样`);
    }
    const offset = index === 0 ? 0 : findOverlapOffset(previous, block);
    const outStart = index * HOP_OUT;
    const count = Math.min(HOP_OUT, totalOut - outStart);
    output.set(block.subarray(offset, offset + count), outStart);
    if (index > 0) {
      for (let i = 0; i < Math.min(OVERLAP, count); i += 1) {
        const incoming = Math.sin(Math.PI * i / (2 * (OVERLAP - 1))) ** 2;
        output[outStart + i] = previous[i] * (1 - incoming) + output[outStart + i] * incoming;
      }
    }
    previous.set(block.subarray(offset + HOP_OUT, offset + HOP_OUT + OVERLAP));
    offsets.push(offset);
    onProgress?.({ done: index + 1, total, index });
    throwIfAborted(signal, `block:${index}`);
  }

  return { samples: output, sampleRate, diagnostics: { blockCount: total, offsets } };
}

export const BLOCKS_NOTICE =
  '实验性多块调度：尚未验证重叠对齐与上下文长度，界面不启用，也不代表已支持整段录音。';

/** 整句拼接要开放，必须逐项有真实验证证据；这里只登记，不代替验证。 */
export const REQUIRED_CONCAT_EVIDENCE = Object.freeze([
  'outputGeometry',      // 每块输出的真实长度与裁剪区间（导出端对齐）
  'durationMapping',     // 输入窗口 → 输出片段的时间映射
  'boundaryFrames',      // 真实多块音频下边界帧是否可信
  'overlapAlignment',    // 相邻块输出的特征域 / 相位对齐
  'contextSamples',      // 每块所需前置上下文长度（实测，不是猜）
  'listeningTest',       // 端到端自然语音试听与接缝检查
]);

/** 缺任一项证据就拒绝开放；不因为「合成测试通过」而放行。 */
export function assertConcatenationAllowed(evidence = {}) {
  const missing = REQUIRED_CONCAT_EVIDENCE.filter((key) => evidence[key] !== true);
  if (missing.length) {
    throw chainError('blocks-not-verified', `整句拼接未开放：缺少 ${missing.join('、')} 的真实验证证据`);
  }
  return true;
}

/**
 * 规划每个窗口的起点。
 * @param {{totalSamples:number, windowSamples:number, hopSamples:number}} options
 * @returns {{index:number,start:number,end:number}[]}
 */
export function planBlocks({ totalSamples, windowSamples, hopSamples }) {
  if (!Number.isInteger(totalSamples) || totalSamples <= 0) {
    throw chainError('blocks-input', '总采样数必须是正整数');
  }
  if (!Number.isInteger(windowSamples) || windowSamples <= 0) {
    throw chainError('blocks-window', '窗口长度必须是正整数');
  }
  if (!Number.isInteger(hopSamples) || hopSamples <= 0 || hopSamples > windowSamples) {
    throw chainError('blocks-hop', '步长必须是 1..窗口长度 之间的整数');
  }
  if (totalSamples < windowSamples) {
    throw chainError('blocks-short', '音频比一个窗口还短，不能切块');
  }

  const starts = [];
  for (let start = 0; start + windowSamples <= totalSamples; start += hopSamples) starts.push(start);
  const lastStart = starts[starts.length - 1];
  if (lastStart + windowSamples < totalSamples) starts.push(totalSamples - windowSamples);

  return starts.map((start, index) => ({ index, start, end: start + windowSamples }));
}

/**
 * 纯计算：把切块几何里的时长 / 边界 / 对齐约束算成可核对的数值。
 * 不猜测任何生产参数；`blockOutputSamples` 由调用方给出时才做一致性判断。
 */
export function analyzeBlockGeometry({
  totalSamples,
  windowSamples,
  hopSamples,
  inputSampleRate,
  outputSampleRate,
  blockOutputSamples = null,
  contextSamples = 0,
}) {
  const blocks = planBlocks({ totalSamples, windowSamples, hopSamples });
  const ratio = outputSampleRate / inputSampleRate;
  const assumedBlockOut = Math.max(1, Math.round(windowSamples * ratio));
  const totalOut = Math.max(1, Math.round(totalSamples * ratio));
  const nominalOverlapIn = windowSamples - hopSamples;
  const nominalOverlapOut = Math.max(0, Math.round(nominalOverlapIn * ratio));

  const actualOverlapsIn = [];
  for (let i = 1; i < blocks.length; i += 1) {
    actualOverlapsIn.push(blocks[i - 1].end - blocks[i].start);
  }
  const irregularOverlap = actualOverlapsIn.some((value) => value !== nominalOverlapIn);

  const declared = Number.isInteger(blockOutputSamples) && blockOutputSamples > 0 ? blockOutputSamples : null;
  const mismatchFactor = declared ? assumedBlockOut / declared : null;

  return {
    blockCount: blocks.length,
    ratio,
    assumedBlockOut,
    declaredBlockOut: declared,
    totalOut,
    nominalOverlapIn,
    nominalOverlapOut,
    actualOverlapsIn,
    irregularOverlap,
    contextSamples,
    // 只有当调用方给出真实每块输出长度时才判断；缺省不作断言。
    durationPreserved: declared === null ? null : Math.abs(declared - assumedBlockOut) <= 1,
    mismatchFactor,
    // 固定窗口真实几何（来自 contract.js，不是猜的）：用于说明为何不能按采样率比例拼接。
    fixedWindow: {
      inputSamples: GEOMETRY.inputSamples,
      inputSampleRate: GEOMETRY.inputSampleRate,
      inputSeconds: GEOMETRY.inputSamples / GEOMETRY.inputSampleRate,
      outputSamples: GEOMETRY.outputSamples,
      outputSampleRate: GEOMETRY.outputSampleRate,
      outputSeconds: GEOMETRY.outputSamples / GEOMETRY.outputSampleRate,
      crop: [GEOMETRY.cropStart, GEOMETRY.cropEnd],
    },
    // 需要真实验证才能填的项，全部保持「未验证」。
    unverified: [...REQUIRED_CONCAT_EVIDENCE],
  };
}

/**
 * 依次处理每个窗口并拼接。
 *
 * @param {object} options
 * @param {Float32Array} options.samples 单声道输入（输入采样率）
 * @param {number} options.inputSampleRate
 * @param {number} options.windowSamples 每个窗口的输入采样数（必须显式给出）
 * @param {number} options.hopSamples 相邻窗口的步长（必须显式给出）
 * @param {number} options.outputSampleRate
 * @param {number} [options.contextSamples] 额外前置输入上下文（显式；默认 0）
 * @param {number} [options.outputContextSamples] 传给下一块的「上一块输出尾段」长度（输出采样率域；默认 0）
 * @param {(window:Float32Array, info:object) => Promise<Float32Array>} options.processWindow
 * @param {AbortSignal|null} [options.signal]
 * @param {(info:{done:number,total:number,index:number})=>void} [options.onProgress]
 * @param {() => Promise<void>} [options.yieldToHost]
 * @returns {Promise<{samples:Float32Array,blocks:object[],overlapSamples:number,ratio:number,geometry:object,memory:object}>}
 */
export async function runBlockSchedule(options = {}) {
  const {
    samples,
    inputSampleRate,
    windowSamples,
    hopSamples,
    outputSampleRate,
    contextSamples = 0,
    outputContextSamples = 0,
    processWindow,
    signal = null,
    onProgress = null,
    yieldToHost = () => Promise.resolve(),
  } = options;

  if (typeof processWindow !== 'function') throw chainError('blocks-handler', '缺少 processWindow');
  if (!samples || typeof samples.length !== 'number') throw chainError('blocks-input', '缺少输入采样');
  if (!Number.isFinite(inputSampleRate) || !Number.isFinite(outputSampleRate)) {
    throw chainError('blocks-rate', '采样率必须是数字');
  }
  if (!Number.isInteger(contextSamples) || contextSamples < 0 || contextSamples >= windowSamples) {
    throw chainError('blocks-context', '上下文长度必须是 0..窗口长度 之间的整数');
  }

  const blocks = planBlocks({ totalSamples: samples.length, windowSamples, hopSamples });
  const ratio = outputSampleRate / inputSampleRate;
  const blockOut = Math.max(1, Math.round(windowSamples * ratio));
  const overlapIn = windowSamples - hopSamples;
  const overlapOut = Math.max(0, Math.round(overlapIn * ratio));
  const totalOut = Math.max(1, Math.round(samples.length * ratio));

  if (!Number.isInteger(outputContextSamples) || outputContextSamples < 0 || outputContextSamples > blockOut) {
    throw chainError('blocks-output-context', '输出上下文长度必须是 0..每块输出长度 之间的整数');
  }

  const sum = new Float32Array(totalOut);
  const weight = new Float32Array(totalOut);
  const doneBlocks = [];
  // 只保留「上一块的输入窗口尾」与「上一块输出尾」，不再堆积全部窗口副本。
  let previousInputTail = new Float32Array(0);
  let previousOutputTail = new Float32Array(0);

  for (const block of blocks) {
    throwIfAborted(signal, `block:${block.index}`);
    await yieldToHost();
    throwIfAborted(signal, `block:${block.index}`);

    const start = block.start;
    const windowData = Float32Array.from(samples.subarray(start, block.end));
    const historyData = contextSamples > 0
      ? Float32Array.from(samples.subarray(Math.max(0, start - contextSamples), start))
      : new Float32Array(0);

    const produced = await processWindow(windowData, {
      index: block.index,
      start,
      end: block.end,
      inputSampleRate,
      outputSampleRate,
      history: historyData,
      previousInputTail,
      previousOutputTail,
    });
    throwIfAborted(signal, `block:${block.index}`);

    if (!produced || produced.length !== blockOut) {
      throw chainError('blocks-output', `第 ${block.index} 块输出长度应为 ${blockOut}，实际 ${produced && produced.length}`);
    }

    const outStart = Math.round(start * ratio);
    const fadeIn = block.index === 0 ? 0 : overlapOut;
    const fadeOut = block.index === blocks.length - 1 ? 0 : overlapOut;

    for (let k = 0; k < blockOut; k += 1) {
      const target = outStart + k;
      if (target < 0 || target >= totalOut) continue;
      let w = 1;
      if (fadeIn > 0 && k < fadeIn) w = Math.min(w, k / fadeIn);
      if (fadeOut > 0 && k >= blockOut - fadeOut) w = Math.min(w, (blockOut - 1 - k) / fadeOut);
      if (w <= 0) continue;
      sum[target] += produced[k] * w;
      weight[target] += w;
    }

    // 只留下有界尾段，避免 O(块数 × 窗口) 的内存增长。
    previousInputTail = contextSamples > 0
      ? Float32Array.from(windowData.subarray(Math.max(0, windowData.length - contextSamples)))
      : new Float32Array(0);
    previousOutputTail = outputContextSamples > 0
      ? Float32Array.from(produced.subarray(produced.length - outputContextSamples))
      : new Float32Array(0);

    doneBlocks.push({ index: block.index, start: block.start, end: block.end, outStart });
    if (onProgress) onProgress({ done: doneBlocks.length, total: blocks.length, index: block.index });
  }

  // 原地归一化，不再分配第三块全长缓冲。
  for (let i = 0; i < totalOut; i += 1) {
    sum[i] = weight[i] > 0 ? Math.fround(sum[i] / weight[i]) : 0;
  }

  const geometry = analyzeBlockGeometry({
    totalSamples: samples.length,
    windowSamples,
    hopSamples,
    inputSampleRate,
    outputSampleRate,
    blockOutputSamples: blockOut,
    contextSamples,
  });

  const memory = {
    retainedBuffers: 2,                       // sum + weight（原来还有一个 out）
    fullLengthBuffersBytes: totalOut * 4 * 2, // 原来 ×3
    retainedWindowBytes: (previousInputTail.length + previousOutputTail.length) * 4,
    keptAllWindowCopies: false,               // 原来为 true，内存随块数线性增长
  };

  return { samples: sum, blocks: doneBlocks, overlapSamples: overlapIn, ratio, geometry, memory };
}
