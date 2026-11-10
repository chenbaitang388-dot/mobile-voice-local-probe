/* 单声道与采样统计。整个处理链只处理单声道 Float32。 */

/**
 * 把多声道数据混合成单声道（简单平均，可预测、无相位处理）。
 * 单声道输入返回拷贝，避免别名 AudioBuffer 的内部数组。
 */
export function mixToMono(channels, length) {
  if (!Array.isArray(channels) || channels.length === 0) return new Float32Array(0);
  const frames = Number.isInteger(length) ? length : channels[0].length;
  const out = new Float32Array(frames);
  if (channels.length === 1) {
    const source = channels[0] || [];
    for (let i = 0; i < frames; i += 1) {
      out[i] = Number.isFinite(source[i]) ? source[i] : 0;
    }
    return out;
  }
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels.length; c += 1) {
      const data = channels[c];
      sum += data && i < data.length ? data[i] : 0;
    }
    out[i] = sum / channels.length;
  }
  return out;
}

export function durationOf(samples, sampleRate) {
  if (!samples || !Number.isFinite(sampleRate) || sampleRate <= 0) return 0;
  return samples.length / sampleRate;
}

/** 峰值、均方根、是否静音；用于界面提示，不用于任何「效果」判断。 */
export function summarize(samples, silenceThreshold = 1e-4) {
  if (!samples || samples.length === 0) {
    return { peak: 0, rms: 0, silent: true, finite: true };
  }
  let peak = 0;
  let sumSquares = 0;
  let finite = true;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    if (!Number.isFinite(value)) {
      finite = false;
      continue;
    }
    const abs = Math.abs(value);
    if (abs > peak) peak = abs;
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return { peak, rms, silent: peak <= silenceThreshold, finite };
}

/** 只保留 -1..1 的浮点采样，去掉 NaN。 */
export function sanitizeSamples(samples) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i];
    out[i] = Number.isFinite(value) ? (value > 1 ? 1 : value < -1 ? -1 : value) : 0;
  }
  return out;
}
