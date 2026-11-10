/* 本机有界随机数：只用于固定窗口里的初始噪声、HiFT 相位和标准噪声。
 *
 * - 默认用一条自带的 32 位 PRNG（mulberry32），种子显式给出，可复现。
 * - 高斯用 Box–Muller，并把对数参数夹到 >= 1e-12，所以 |z| 有确定上界（约 7.44），
 *   不会出现 Infinity/NaN。
 * - 相位是 [-π, π] 上的均匀分布，第 0 个谐波固定为 0。
 * - 也支持**直接注入数组**：跨运行时的对比测试可以用同一份数组喂进来。
 *
 * 注意：这不保证与 Torch 的 randn / NumPy 的 RandomState 产生同样的序列，
 * 也不打算做这种承诺；两边的一致性只能靠注入同一份数组来验证。 */

import { GEOMETRY, chainError } from './contract.js';

const TWO_PI = Math.PI * 2;
const LOG_FLOOR = 1e-12;

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assertInjected(values, expectedLength, label) {
  if (!values || typeof values.length !== 'number') {
    throw chainError('bad-random', `${label} 注入值必须是数组`);
  }
  if (values.length !== expectedLength) {
    throw chainError('bad-random', `${label} 注入长度应为 ${expectedLength}，实际 ${values.length}`);
  }
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) {
      throw chainError('bad-random', `${label} 第 ${i} 个注入值不是有限数`);
    }
  }
}

/**
 * @param {object} [options]
 * @param {number} [options.seed] 默认 0x51ed270b
 * @param {Float32Array|number[]|null} [options.initialState] [1,80,583] 的显式高斯噪声
 * @param {Float32Array|number[]|null} [options.phase] [1,9,1] 的显式相位
 * @param {Float32Array|number[]|null} [options.standardNoise] [1,9,17152] 的显式标准噪声
 */
export function createRandomSource(options = {}) {
  const { seed = 0x51ed270b, initialState = null, phase = null, standardNoise = null } = options;
  const next = mulberry32(seed);
  let spare = null;

  /** Box–Muller，一次生成两个数，返回其中一个并把另一个留作下次。 */
  function gaussian() {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const u1 = Math.max(next(), LOG_FLOOR);
    const u2 = next();
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = TWO_PI * u2;
    spare = Math.fround(radius * Math.sin(angle));
    return Math.fround(radius * Math.cos(angle));
  }

  function fillGaussian(length) {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) out[i] = gaussian();
    return out;
  }

  function initialStateFor(dims) {
    const length = dims.reduce((total, dim) => total * dim, 1);
    if (initialState) {
      assertInjected(initialState, length, '初始噪声');
      return Float32Array.from(initialState);
    }
    return fillGaussian(length);
  }

  function phaseFor() {
    const length = GEOMETRY.harmonics;
    if (phase) {
      assertInjected(phase, length, 'HiFT 相位');
      const injected = Float32Array.from(phase);
      injected[0] = 0; // 第 0 个谐波固定为 0，注入值也不允许改写这条约束
      return injected;
    }
    const out = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = i === 0 ? 0 : Math.fround((next() * 2 - 1) * Math.PI);
    }
    return out;
  }

  function standardNoiseFor(dims) {
    const length = dims.reduce((total, dim) => total * dim, 1);
    if (standardNoise) {
      assertInjected(standardNoise, length, 'HiFT 标准噪声');
      return Float32Array.from(standardNoise);
    }
    return fillGaussian(length);
  }

  return {
    seed,
    initialStateFor,
    phaseFor,
    standardNoiseFor,
    /** 只暴露给测试：再取一个高斯值。 */
    nextGaussian: gaussian,
  };
}
