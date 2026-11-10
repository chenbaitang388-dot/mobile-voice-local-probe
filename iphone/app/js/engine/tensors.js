/* 纯数据操作：只处理 Float32Array 与几何参数，不依赖 ONNX、DOM 或随机数。
   布局约定：所有三维张量都是 [1, 通道/频带, 帧] 的行主序，索引 = channel * frames + frame。 */

import { GEOMETRY, chainError, productOf } from './contract.js';

export function zeros(dims) {
  return new Float32Array(productOf(dims));
}

export function copyFloat32(data) {
  return Float32Array.from(data);
}

/**
 * 把每个通道的前 referenceFrames 帧清零（原地）。
 * 图的参考区在这里被显式清零：不是再归一化一次，也不是再切一次。
 */
export function zeroReferenceFrames(state, options = {}) {
  const bins = options.bins ?? GEOMETRY.melBins;
  const totalFrames = options.totalFrames ?? GEOMETRY.totalFrames;
  const referenceFrames = options.referenceFrames ?? GEOMETRY.referenceFrames;
  if (state.length !== bins * totalFrames) {
    throw chainError('bad-length', `状态长度应为 ${bins * totalFrames}`);
  }
  for (let channel = 0; channel < bins; channel += 1) {
    const start = channel * totalFrames;
    state.fill(0, start, start + referenceFrames);
  }
  return state;
}

/**
 * 沿帧轴拼接两段条件特征：[1, F1, D] + [1, F2, D] → [1, F1+F2, D]。
 * 帧是主序，所以可以直接首尾相接。
 */
export function concatFrames(first, second, options = {}) {
  const frames1 = options.frames1 ?? GEOMETRY.referenceFrames;
  const frames2 = options.frames2 ?? GEOMETRY.targetFrames;
  const dim = options.dim ?? GEOMETRY.conditionDim;
  const expected1 = frames1 * dim;
  const expected2 = frames2 * dim;
  if (first.length !== expected1 || second.length !== expected2) {
    throw chainError('bad-length', `条件特征长度应为 ${expected1} + ${expected2}`);
  }
  const out = new Float32Array(expected1 + expected2);
  out.set(first, 0);
  out.set(second, expected1);
  return out;
}

/** 取出目标区（参考区之后的 67 帧），保持 NCT 布局。 */
export function extractTargetFrames(state, options = {}) {
  const bins = options.bins ?? GEOMETRY.melBins;
  const totalFrames = options.totalFrames ?? GEOMETRY.totalFrames;
  const referenceFrames = options.referenceFrames ?? GEOMETRY.referenceFrames;
  const targetFrames = options.targetFrames ?? GEOMETRY.targetFrames;
  if (state.length !== bins * totalFrames) {
    throw chainError('bad-length', `状态长度应为 ${bins * totalFrames}`);
  }
  const out = new Float32Array(bins * targetFrames);
  for (let channel = 0; channel < bins; channel += 1) {
    const from = channel * totalFrames + referenceFrames;
    const to = channel * targetFrames;
    out.set(state.subarray(from, from + targetFrames), to);
  }
  return out;
}

/**
 * 逐个谐波沿最后一维做累加和。
 * 累加器使用 JS Number（double），**每次加法之后不 fround**；只在写入 Float32Array 时转 f32。
 * 这正是图里 CumSum 之后被显式接管的语义。
 */
export function cumulativeSumRows(values, options = {}) {
  const rows = options.rows ?? GEOMETRY.harmonics;
  const length = options.length ?? GEOMETRY.hiftFrames;
  if (values.length !== rows * length) {
    throw chainError('bad-length', `分数张量长度应为 ${rows * length}`);
  }
  const out = new Float32Array(rows * length);
  for (let row = 0; row < rows; row += 1) {
    const base = row * length;
    let acc = 0;
    for (let i = 0; i < length; i += 1) {
      acc += values[base + i];
      out[base + i] = acc;
    }
  }
  return out;
}

/**
 * 一步 Euler：state += dt * velocity，按 FP32 的阶段逐步取整。
 * 乘积与求和都在 double 里算完再 fround，模拟 fp32 乘加的结果。
 */
export function eulerUpdate(state, velocity, dt) {
  if (state.length !== velocity.length) {
    throw chainError('bad-length', '状态与速度长度必须一致');
  }
  const step = Math.fround(dt);
  const out = new Float32Array(state.length);
  for (let i = 0; i < state.length; i += 1) {
    out[i] = Math.fround(state[i] + Math.fround(step * velocity[i]));
  }
  return out;
}

/** 固定的输出裁剪：wave[10978:16711] → 5733 个采样。 */
export function cropFixedWindow(wave, options = {}) {
  const start = options.start ?? GEOMETRY.cropStart;
  const end = options.end ?? GEOMETRY.cropEnd;
  if (wave.length < end) {
    throw chainError('bad-length', `波形长度 ${wave.length} 小于裁剪终点 ${end}`);
  }
  const out = wave.slice(start, end);
  if (out.length !== GEOMETRY.outputSamples) {
    throw chainError('bad-length', `裁剪结果应为 ${GEOMETRY.outputSamples} 个采样`);
  }
  return out;
}
