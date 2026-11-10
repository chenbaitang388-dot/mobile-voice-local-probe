/* 固定窗口的 Euler 求解器。
 * 它只负责「10 步、FP32 取整、每步之后清零参考区」这套流程；
 * 每一步的速度由外部传入（真实链路里是 DiT 图，测试里是一个受控函数）。 */

import { chainError, throwIfAborted } from './contract.js';
import { eulerUpdate, extractTargetFrames, zeroReferenceFrames } from './tensors.js';
import { TIME_STEPS } from './timegrid.js';

/** 让出一次宏任务：否则整条链路只排微任务，点击/定时器都得不到执行，取消会失效。 */
export function defaultYieldToHost() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {object} options
 * @param {Float32Array} options.state 初始状态 [1,80,583]（显式高斯噪声）
 * @param {(ctx:{state:Float32Array,time:number,dt:number,step:number}) => Promise<Float32Array>} options.velocityFn
 * @param {{index:number,time:number,dt:number}[]} [options.steps]
 * @param {AbortSignal|null} [options.signal]
 * @param {() => Promise<void>} [options.yieldToHost]
 * @returns {Promise<{state:Float32Array,target:Float32Array,trace:object[]}>}
 */
export async function runEulerSteps(options = {}) {
  const { state, velocityFn, steps = TIME_STEPS, signal = null, yieldToHost = defaultYieldToHost } = options;
  if (typeof velocityFn !== 'function') {
    throw chainError('bad-velocity', 'Euler 需要 velocityFn');
  }
  if (!state || typeof state.length !== 'number') {
    throw chainError('bad-state', 'Euler 需要初始状态');
  }

  // 拷贝一份再改，避免修改调用方传进来的数组。
  let current = zeroReferenceFrames(Float32Array.from(state));
  const trace = [];

  for (const step of steps) {
    throwIfAborted(signal, 'euler');
    // 每一步开始前让出事件循环：既让取消/进度可见，也避免长时间独占主线程。
    await yieldToHost();
    throwIfAborted(signal, 'euler');
    const velocity = await velocityFn({
      state: current,
      time: step.time,
      dt: step.dt,
      step: step.index,
    });
    throwIfAborted(signal, 'euler');
    if (!velocity || velocity.length !== current.length) {
      throw chainError('bad-velocity', `第 ${step.index} 步速度长度应为 ${current.length}`);
    }
    current = zeroReferenceFrames(eulerUpdate(current, velocity, step.dt));
    trace.push({ index: step.index, time: step.time, dt: step.dt });
  }

  return { state: current, target: extractTargetFrames(current), trace };
}
