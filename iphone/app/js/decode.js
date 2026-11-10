/* 用浏览器自带的解码器解码成 PCM，并混合成单声道。
   decodeAudioData 会把音频重采样到 AudioContext 的采样率，所以：
   1) 若能先读到文件自己声明的采样率（WAV 头），就用它创建 context，尽量不重采样；
   2) 无论哪种情况，都把「文件声明采样率」和「实际处理采样率」分开记录，
      重采样发生时明确标注，不假装原始采样率被保留。 */

import { mixToMono, durationOf } from './pcm.js';
import { parseWavInfo } from './wav.js';

export class DecodeError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'DecodeError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

function decodeArrayBuffer(context, arrayBuffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (buffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const failed = (error) => {
      if (settled) return;
      settled = true;
      reject(new DecodeError('decode-failed', '浏览器无法解码这段音频。', error));
    };
    let returned;
    try {
      // 老式回调写法（Safari）与 Promise 写法（Chrome/Firefox）都要支持。
      returned = context.decodeAudioData(arrayBuffer, done, failed);
    } catch (error) {
      failed(error);
      return;
    }
    if (returned && typeof returned.then === 'function') returned.then(done, failed);
  });
}

function createContext(AudioContextImpl, desiredRate) {
  const attempts = [];
  if (Number.isFinite(desiredRate) && desiredRate > 0) attempts.push({ sampleRate: desiredRate });
  attempts.push(undefined);
  let lastError;
  for (const options of attempts) {
    try {
      return options ? new AudioContextImpl(options) : new AudioContextImpl();
    } catch (error) {
      lastError = error;
    }
  }
  throw new DecodeError('decode-unsupported', '当前浏览器无法创建音频解码环境。', lastError);
}

/**
 * @param {{AudioContextImpl: Function, arrayBuffer: ArrayBuffer, sampleRateHint?: number|null}} input
 * @returns {Promise<{
 *   samples: Float32Array, sampleRate: number,
 *   declaredSampleRate: number|null, originalSampleRate: number, originalSampleRateKnown: boolean,
 *   decodedChannels: number, originalChannels: number, originalChannelsKnown: boolean,
 *   durationSeconds: number, resampled: boolean
 * }>}
 */
export async function decodeToMono({ AudioContextImpl, arrayBuffer, sampleRateHint = null }) {
  if (typeof AudioContextImpl !== 'function') {
    throw new DecodeError('decode-unsupported', '当前浏览器不支持音频解码（缺少 AudioContext）。');
  }
  if (!arrayBuffer || typeof arrayBuffer.byteLength !== 'number') {
    throw new DecodeError('decode-invalid', '没有可解码的音频数据。');
  }

  // 解码前先读容器头，尽量拿到文件自己的采样率。
  const wavInfo = parseWavInfo(arrayBuffer);
  const declaredSampleRate = wavInfo && wavInfo.sampleRate > 0 ? wavInfo.sampleRate : null;
  const declaredChannels = wavInfo && wavInfo.channels > 0 ? wavInfo.channels : null;
  const desiredRate = Number.isFinite(sampleRateHint) && sampleRateHint > 0 ? sampleRateHint : declaredSampleRate;

  const context = createContext(AudioContextImpl, desiredRate);
  try {
    // iOS 上新建的 AudioContext 可能是 suspended；解码本身不需要播声音，
    // 但尝试恢复一次更稳。不 await，避免在没有用户手势时把流程挂住。
    if (typeof context.resume === 'function' && context.state === 'suspended') {
      try {
        void context.resume();
      } catch {
        /* 允许失败：解码不依赖它 */
      }
    }
    // decodeAudioData 会分离（detach）传入的 ArrayBuffer，用副本保护调用方数据。
    const buffer = await decodeArrayBuffer(context, arrayBuffer.slice(0));
    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i += 1) channels.push(buffer.getChannelData(i));
    const samples = mixToMono(channels, buffer.length);
    const sampleRate = buffer.sampleRate;
    const originalSampleRateKnown = declaredSampleRate !== null;
    return {
      samples,
      sampleRate,
      declaredSampleRate,
      originalSampleRate: declaredSampleRate ?? sampleRate,
      originalSampleRateKnown,
      decodedChannels: buffer.numberOfChannels,
      originalChannels: declaredChannels ?? buffer.numberOfChannels,
      originalChannelsKnown: declaredChannels !== null,
      durationSeconds: Number.isFinite(buffer.duration) ? buffer.duration : durationOf(samples, sampleRate),
      resampled: declaredSampleRate !== null && declaredSampleRate !== sampleRate,
    };
  } finally {
    // 手机 Safari 对同时打开的 AudioContext 数量有限制，用完就关。
    if (typeof context.close === 'function') {
      try {
        await context.close();
      } catch {
        /* 关闭失败不影响解码结果 */
      }
    }
  }
}

/** 给控制器注入的解码器门面。 */
export function createDecoder({ AudioContextImpl }) {
  return {
    decode: (arrayBuffer, options = {}) => decodeToMono({ AudioContextImpl, arrayBuffer, ...options }),
  };
}
