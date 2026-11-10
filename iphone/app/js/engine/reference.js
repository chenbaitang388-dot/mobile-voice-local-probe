/* 本地参考包（schema: seed-reference/v1）。
 *
 * 参考包里是**私人音色特征**：只读用户显式选择的那个文件，只留在内存里。
 * 校验失败时消息里只出现长度与第几个值，绝不回显参考数值本身。
 *
 * JSON 形状（全部 float32 行主序的普通数字数组）：
 * {
 *   "schema": "seed-reference/v1",
 *   "geometry": { "sampleRate": 16000, "melBins": 80, "referenceFrames": 516,
 *                 "styleDim": 192, "conditionDim": 384 },
 *   "referenceMel":       [80*516 = 41,280 个数],
 *   "style":              [192 个数],
 *   "referenceCondition": [516*384 = 198,144 个数]
 * }
 */

import { GEOMETRY, chainError } from './contract.js';

export const REFERENCE_SCHEMA = 'seed-reference/v1';
export const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;

const GEOMETRY_KEYS = Object.freeze({
  sampleRate: GEOMETRY.inputSampleRate,
  melBins: GEOMETRY.melBins,
  referenceFrames: GEOMETRY.referenceFrames,
  styleDim: GEOMETRY.styleDim,
  conditionDim: GEOMETRY.conditionDim,
});

function toFloat32(values, expectedLength, label) {
  const isArrayLike = Boolean(values) && typeof values.length === 'number';
  if (!isArrayLike || (!Array.isArray(values) && !ArrayBuffer.isView(values))) {
    throw chainError('reference-array', `${label} 必须是数字数组`);
  }
  if (values.length !== expectedLength) {
    throw chainError('reference-array', `${label} 长度应为 ${expectedLength}，实际 ${values.length}`);
  }
  const out = new Float32Array(expectedLength);
  for (let i = 0; i < expectedLength; i += 1) {
    const value = values[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw chainError('reference-array', `${label} 第 ${i} 个值不是有限数`);
    }
    out[i] = value;
  }
  return out;
}

/**
 * @param {any} raw 已 JSON.parse 的对象
 * @returns {{referenceMel:Float32Array, style:Float32Array, referenceCondition:Float32Array, geometry:object, schema:string}}
 */
export function validateReferenceDocument(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw chainError('reference-schema', '参考包必须是一个 JSON 对象');
  }
  if (raw.schema !== REFERENCE_SCHEMA) {
    throw chainError('reference-schema', `参考包 schema 必须是 ${REFERENCE_SCHEMA}`);
  }
  const geometry = raw.geometry;
  if (!geometry || typeof geometry !== 'object') {
    throw chainError('reference-geometry', '参考包缺少 geometry');
  }
  for (const [key, expected] of Object.entries(GEOMETRY_KEYS)) {
    if (geometry[key] !== expected) {
      throw chainError('reference-geometry', `参考包 geometry.${key} 必须是 ${expected}`);
    }
  }
  return {
    schema: REFERENCE_SCHEMA,
    geometry: { ...GEOMETRY_KEYS },
    referenceMel: toFloat32(
      raw.referenceMel,
      GEOMETRY.melBins * GEOMETRY.referenceFrames,
      'referenceMel',
    ),
    style: toFloat32(raw.style, GEOMETRY.styleDim, 'style'),
    referenceCondition: toFloat32(
      raw.referenceCondition,
      GEOMETRY.referenceFrames * GEOMETRY.conditionDim,
      'referenceCondition',
    ),
  };
}

export function parseReferenceJson(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw chainError('reference-json', '参考文件是空的');
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw chainError('reference-json', '参考文件不是合法 JSON');
  }
  return validateReferenceDocument(raw);
}

/**
 * 只读用户选择的那一个参考文件；不枚举文件系统。
 * @param {{size?:number, text?:Function}} file
 */
export async function readReferenceFile(file) {
  if (!file || typeof file.text !== 'function') {
    throw chainError('reference-file', '没有选择参考文件');
  }
  if (typeof file.size === 'number' && file.size > MAX_REFERENCE_BYTES) {
    throw chainError('reference-too-large', `参考文件超过 ${MAX_REFERENCE_BYTES} 字节`);
  }
  const text = await file.text();
  if (typeof text === 'string' && text.length > MAX_REFERENCE_BYTES) {
    throw chainError('reference-too-large', `参考文件超过 ${MAX_REFERENCE_BYTES} 字节`);
  }
  return parseReferenceJson(text);
}

/** 只用于日志/报表的安全摘要：不含任何特征值。 */
export function referenceSummary(reference) {
  return {
    schema: REFERENCE_SCHEMA,
    sampleRate: GEOMETRY.inputSampleRate,
    melBins: GEOMETRY.melBins,
    referenceFrames: GEOMETRY.referenceFrames,
    styleDim: GEOMETRY.styleDim,
    conditionDim: GEOMETRY.conditionDim,
    loaded: Boolean(reference),
  };
}
