/* 单声道重采样：把任意采样率的 PCM 显式转到固定窗口需要的 16 kHz。
 *
 * 要求：**保留时长**（out.length ≈ in.length × toRate / fromRate），不做任何裁剪；
 * 降采样时用窗函数 sinc 做抗混叠，升采样时同样插值。纯函数、可单元测试。 */

import { chainError } from './engine/contract.js';

function sinc(x) {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/** Blackman 窗，够平滑，且不引入额外依赖。 */
function blackman(t, halfWidth) {
  const x = (t + halfWidth) / (2 * halfWidth);
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
}

/**
 * @param {Float32Array} input 单声道 PCM
 * @param {number} fromRate
 * @param {number} toRate
 * @param {{taps?:number}} [options] 每侧抽头数（默认 8 → 每点 16 个抽头）
 * @returns {Float32Array}
 */
export function resampleMono(input, fromRate, toRate, options = {}) {
  const taps = Number.isInteger(options.taps) && options.taps > 0 ? options.taps : 8;
  if (!input || typeof input.length !== 'number') {
    throw chainError('resample-input', '没有可重采样的采样');
  }
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) {
    throw chainError('resample-rate', '采样率必须是正数');
  }
  if (fromRate === toRate) return Float32Array.from(input);
  if (input.length === 0) return new Float32Array(0);

  // 以「时长」为准计算输出长度，避免累积误差导致时长漂移。
  const seconds = input.length / fromRate;
  const outputLength = Math.max(1, Math.round(seconds * toRate));
  const ratio = toRate / fromRate;
  const cutoff = Math.min(1, ratio); // 降采样时压缩带宽，抑制混叠
  const halfWidth = taps;
  const out = new Float32Array(outputLength);

  for (let j = 0; j < outputLength; j += 1) {
    const center = j / ratio; // 源信号坐标
    const base = Math.floor(center);
    let sum = 0;
    let weightSum = 0;
    for (let k = base - halfWidth + 1; k <= base + halfWidth; k += 1) {
      if (k < 0 || k >= input.length) continue;
      const distance = center - k;
      const weight = cutoff * sinc(cutoff * distance) * blackman(distance, halfWidth);
      sum += input[k] * weight;
      weightSum += weight;
    }
    // 归一化，避免边界与抽头截断造成的电平变化。
    out[j] = weightSum !== 0 ? Math.fround(sum / weightSum) : 0;
  }
  return out;
}

/** 固定窗口需要的确切采样数（16 kHz 下 2.78 秒）。 */
export const WINDOW_SAMPLES = 44480;
export const WINDOW_RATE = 16000;
