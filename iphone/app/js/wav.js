/* WAV（RIFF/WAVE，16 位单声道 PCM）写出与头部解析。
   写出与解析互为正反，测试用同一对函数验证字节头、采样数与单声道。 */

export const WAV_HEADER_BYTES = 44;

/** 浮点采样 → 16 位整数，带截断保护；NaN/Infinity 写 0。 */
export function floatToInt16(value) {
  if (!Number.isFinite(value)) return 0;
  const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

/** 16 位整数 → 浮点采样（-1..1），与 floatToInt16 可往返。 */
export function int16ToFloat(value) {
  return value < 0 ? value / 0x8000 : value / 0x7fff;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(view, offset, length) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/**
 * 把单声道 Float32 采样编码成 16 位 PCM 的 WAV ArrayBuffer。
 * @param {Float32Array} samples
 * @param {number} sampleRate 采样率，必须原样保留
 * @returns {ArrayBuffer}
 */
export function encodeWav16Mono(samples, sampleRate) {
  if (!(samples instanceof Float32Array)) throw new TypeError('samples 必须是 Float32Array');
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) {
    throw new RangeError(`采样率超出范围：${sampleRate}`);
  }
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byteRate = sampleRate * blockAlign
  view.setUint16(32, 2, true); // blockAlign = 声道 * 位深 / 8
  view.setUint16(34, 16, true); // 位深
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(WAV_HEADER_BYTES + i * 2, floatToInt16(samples[i]), true);
  }
  return buffer;
}

/**
 * 解析 WAV 头部。不是 RIFF/WAVE 或头部损坏时返回 null（不会抛错）。
 * 用于「保留原采样率信息」：解码前就能读到文件自己声明的采样率与声道数。
 * @param {ArrayBuffer} arrayBuffer
 */
export function parseWavInfo(arrayBuffer) {
  if (!arrayBuffer || typeof arrayBuffer.byteLength !== 'number' || arrayBuffer.byteLength < 12) return null;
  const view = new DataView(arrayBuffer);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') return null;

  let offset = 12;
  let fmt = null;
  let dataBytes = null;
  let dataOffset = null;

  while (offset + 8 <= arrayBuffer.byteLength) {
    const id = readAscii(view, offset, 4);
    const declaredSize = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= arrayBuffer.byteLength) {
      fmt = {
        audioFormat: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        byteRate: view.getUint32(body + 8, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      const available = arrayBuffer.byteLength - body;
      // 部分录音实现会写 0xFFFFFFFF 表示「到文件结尾」。
      const size = declaredSize === 0xffffffff || declaredSize > available ? available : declaredSize;
      dataBytes = size;
      dataOffset = body;
    }
    if (fmt && dataBytes !== null) break;
    if (declaredSize === 0xffffffff) break;
    const next = body + declaredSize + (declaredSize % 2);
    if (next <= offset) break;
    offset = next;
  }

  if (!fmt || dataBytes === null) return null;
  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameBytes = bytesPerSample * fmt.channels;
  const sampleFrames = frameBytes > 0 ? Math.floor(dataBytes / frameBytes) : 0;
  const format = fmt.audioFormat === 1 ? 'pcm' : fmt.audioFormat === 3 ? 'float' : 'other';
  return {
    format,
    audioFormat: fmt.audioFormat,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    byteRate: fmt.byteRate,
    blockAlign: fmt.blockAlign,
    dataOffset,
    dataBytes,
    sampleFrames,
    durationSeconds: fmt.sampleRate > 0 ? sampleFrames / fmt.sampleRate : null,
  };
}

/** 从 WAV 字节里取出单声道 16 位 PCM 的浮点采样（仅用于自检与测试）。 */
export function decodeWav16Mono(arrayBuffer) {
  const info = parseWavInfo(arrayBuffer);
  if (!info || info.format !== 'pcm' || info.channels !== 1 || info.bitsPerSample !== 16) {
    throw new Error('不是 16 位单声道 PCM WAV');
  }
  const view = new DataView(arrayBuffer);
  const out = new Float32Array(info.sampleFrames);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = int16ToFloat(view.getInt16(info.dataOffset + i * 2, true));
  }
  return out;
}
