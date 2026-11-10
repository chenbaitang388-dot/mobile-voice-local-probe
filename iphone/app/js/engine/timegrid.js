/* 时间网格：与 float32 linspace(0, 1, 11) 对齐。
 * 网格值、dt 的减法、时间累加都按 FP32 阶段取整，好让 JS 轨迹和导出图的阶段一致。 */

import { GEOMETRY } from './contract.js';

export function linspaceF32(start, stop, count) {
  if (!Number.isInteger(count) || count < 2) throw new RangeError('linspace 至少需要 2 个点');
  const out = new Float32Array(count);
  const span = stop - start;
  for (let i = 0; i < count; i += 1) {
    out[i] = Math.fround(start + (span * i) / (count - 1));
  }
  out[0] = Math.fround(start);
  out[count - 1] = Math.fround(stop);
  return out;
}

/** 10 步：t 从 grid[0] 开始，每步 dt = fround(grid[i+1] - grid[i])，然后累加。 */
export function buildTimeSteps(grid = TIME_GRID) {
  const steps = [];
  let time = grid[0];
  for (let index = 0; index < grid.length - 1; index += 1) {
    const dt = Math.fround(grid[index + 1] - grid[index]);
    steps.push({ index, time, dt });
    time = Math.fround(time + dt);
  }
  return steps;
}

export const TIME_GRID = linspaceF32(0, 1, GEOMETRY.steps + 1);
export const TIME_STEPS = buildTimeSteps(TIME_GRID);
