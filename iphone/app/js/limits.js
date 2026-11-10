/* 输入准入检查。返回结构化结果，界面据此显示中文原因，不抛异常。 */

import { AUDIO_MIME_ALLOWLIST } from './config.js';
import { formatBytes, formatSeconds } from './format.js';

function fail(code, message) {
  return { ok: false, code, message };
}

/**
 * @param {{name?:string,size?:number,type?:string}} file
 * @param {{maxInputBytes:number, maxInputSeconds:number, minInputSeconds:number}} limits 见 config.js 的 LIMITS
 */
export function validateFile(file, limits) {
  if (!file || typeof file.size !== 'number') return fail('no-file', '没有选择文件。');
  if (file.size === 0) return fail('file-empty', '这个文件是空的，换一个试试。');
  if (file.size > limits.maxInputBytes) {
    return fail(
      'file-too-large',
      `文件 ${formatBytes(file.size)} 超过上限 ${formatBytes(limits.maxInputBytes)}，请先剪短或压缩。`,
    );
  }
  const type = typeof file.type === 'string' ? file.type.toLowerCase() : '';
  if (type && !type.startsWith('audio/') && !AUDIO_MIME_ALLOWLIST.includes(type)) {
    return fail('unsupported-type', `这个文件的类型是 ${type}，看起来不是音频。`);
  }
  return { ok: true };
}

/**
 * 解码后的时长/采样率检查。
 * @param {{samples: Float32Array, sampleRate: number}} decoded
 */
export function validateDecoded(decoded, limits) {
  const samples = decoded?.samples;
  const sampleRate = decoded?.sampleRate;
  if (!samples || typeof samples.length !== 'number' || samples.length === 0) {
    return fail('no-samples', '解码后没有采样数据，可能是空文件或格式不受支持。');
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    return fail('bad-sample-rate', '解码结果的采样率无效。');
  }
  const seconds = samples.length / sampleRate;
  if (seconds < limits.minInputSeconds) {
    return fail('audio-too-short', `音频只有 ${formatSeconds(seconds)}，太短了（至少 ${limits.minInputSeconds} 秒）。`);
  }
  if (seconds > limits.maxInputSeconds) {
    return fail(
      'audio-too-long',
      `音频长 ${formatSeconds(seconds)}，超过上限 ${limits.maxInputSeconds} 秒，请先剪短。`,
    );
  }
  return { ok: true, durationSeconds: seconds };
}

/** 参考文件等辅助文件只做大小检查，不读取内容。 */
export function validateAuxFile(file, maxBytes, label) {
  if (!file || typeof file.size !== 'number') return fail('no-file', `没有选择${label}。`);
  if (file.size === 0) return fail('file-empty', `${label}是空文件。`);
  if (file.size > maxBytes) {
    return fail('file-too-large', `${label} ${formatBytes(file.size)} 超过上限 ${formatBytes(maxBytes)}。`);
  }
  return { ok: true };
}

/**
 * 模型文件准入：只看元数据（name/size），不读内容、不分配与文件大小成比例的缓冲。
 * 每个文件有单独上限，所有文件还有合计上限；两者比音频/参考文件的 24 MB 宽松得多。
 *
 * @param {Iterable<{name?:string,size?:number,type?:string}>} files
 * @param {{maxModelFiles:number,maxModelFileBytes:number,maxModelTotalBytes:number}} limits
 * @returns {{ok:boolean, accepted:any[], rejected:Array<{name:string,code:string,message:string}>, totalBytes:number}}
 */
export function validateModelFiles(files, limits) {
  const list = Array.from(files || []).filter(Boolean);
  const accepted = [];
  const rejected = [];
  let totalBytes = 0;

  for (let index = 0; index < list.length; index += 1) {
    const file = list[index];
    const name = (file && file.name) || `第 ${index + 1} 个文件`;

    if (index >= limits.maxModelFiles) {
      rejected.push({
        name,
        code: 'too-many-files',
        message: `最多同时选择 ${limits.maxModelFiles} 个模型文件，这个已忽略。`,
      });
      continue;
    }
    if (typeof file.size !== 'number') {
      rejected.push({ name, code: 'no-file', message: '读不到文件大小，已忽略。' });
      continue;
    }
    if (file.size === 0) {
      rejected.push({ name, code: 'file-empty', message: '是空文件，已忽略。' });
      continue;
    }
    if (file.size > limits.maxModelFileBytes) {
      rejected.push({
        name,
        code: 'model-too-large',
        message: `单个模型 ${formatBytes(file.size)} 超过上限 ${formatBytes(limits.maxModelFileBytes)}。`,
      });
      continue;
    }
    if (totalBytes + file.size > limits.maxModelTotalBytes) {
      rejected.push({
        name,
        code: 'models-total-too-large',
        message: `模型合计会超过 ${formatBytes(limits.maxModelTotalBytes)}。`,
      });
      continue;
    }
    accepted.push(file);
    totalBytes += file.size;
  }

  return { ok: rejected.length === 0, accepted, rejected, totalBytes };
}
