/* 固定窗口 Seed 链：五个图角色 + 10 步 Euler + 分数累加 + 裁剪。
 *
 * 顺序与契约（全部 float32、行主序）：
 *   wave[1,44480] --XLSR--> [1,38,1024] --LR--> [1,67,384]
 *   条件 = referenceCondition[1,516,384] ++ LR 目标[1,67,384] → [1,583,384]
 *   state 噪声[1,80,583] 每步清零参考区 516 帧，DiT（图内做 CFG，cfg=0.7）×10 步
 *   → 目标 mel[1,80,67] --HiFT fractions--> [1,9,17152] --JS 累加和--> [1,9,17152]
 *   --HiFT 解码--> wave[1,17152] @22050 → 裁剪 slice(10978,16711) = 5,733 个采样
 *
 * 图内部已经完成的归一化、切片和 CFG 一律不再做第二遍。 */

import {
  GEOMETRY,
  ROLE_SPECS,
  assertDims,
  assertFiniteData,
  assertOutputTensor,
  chainError,
  disposeOutputs,
  isChainError,
  productOf,
  throwIfAborted,
  wantedOutputName,
} from './contract.js';
import { concatFrames, cropFixedWindow, cumulativeSumRows } from './tensors.js';
import { defaultYieldToHost, runEulerSteps } from './solver.js';
import { buildTimeSteps } from './timegrid.js';

function normalizeStageError(error, spec) {
  if (error && error.name === 'AbortError') return error;
  if (isChainError(error)) return error;
  const detail = error && error.message ? String(error.message) : '未知错误';
  return chainError('stage-failed', `${spec.title} 执行失败：${detail}`, error);
}

function selectSingleOutput(outputs, spec) {
  const keys = outputs && typeof outputs === 'object' ? Object.keys(outputs) : [];
  if (keys.length !== 1) {
    throw chainError('bad-outputs', `${spec.title} 应只返回一个输出，实际 ${keys.length} 个`);
  }
  if (spec.output.name && keys[0] !== spec.output.name) {
    throw chainError('bad-output', `${spec.title} 输出名应为 ${spec.output.name}，实际 ${keys[0]}`);
  }
  return outputs[keys[0]];
}

async function runStage(options) {
  const { runtime, session, spec, feeds, signal, stage } = options;
  throwIfAborted(signal, stage);

  const inputTensors = {};
  for (const input of spec.inputs) {
    const feed = feeds[input.name];
    if (!feed) throw chainError('missing-feed', `${spec.title} 缺少入参 ${input.name}`);
    assertDims(feed.dims, input.dims, `${spec.title}.${input.name}`);
    if (feed.data.length !== productOf(input.dims)) {
      throw chainError('bad-length', `${spec.title}.${input.name} 长度应为 ${productOf(input.dims)}`);
    }
    assertFiniteData(feed.data, `${spec.title}.${input.name}`);
    inputTensors[input.name] = new runtime.Tensor('float32', feed.data, feed.dims);
  }

  let outputs = null;
  try {
    throwIfAborted(signal, stage);
    const wanted = wantedOutputName(session, spec);
    outputs = wanted ? await session.run(inputTensors, wanted) : await session.run(inputTensors);
    // 单次推理不可中断：跑完立刻再看一次取消，作废的结果不往下传。
    throwIfAborted(signal, stage);
    const data = assertOutputTensor(selectSingleOutput(outputs, spec), spec.output, spec.title);
    return { data, dims: spec.output.dims };
  } catch (error) {
    throw normalizeStageError(error, spec);
  } finally {
    disposeOutputs(inputTensors);
    disposeOutputs(outputs);
  }
}

function assertReference(reference) {
  const expected = [
    ['referenceMel', GEOMETRY.melBins * GEOMETRY.referenceFrames],
    ['style', GEOMETRY.styleDim],
    ['referenceCondition', GEOMETRY.referenceFrames * GEOMETRY.conditionDim],
  ];
  for (const [key, length] of expected) {
    const value = reference && reference[key];
    if (!value || typeof value.length !== 'number' || value.length !== length) {
      throw chainError('bad-reference', `参考包 ${key} 长度应为 ${length}`);
    }
    assertFiniteData(value, `参考包 ${key}`);
  }
}

/**
 * @param {object} options
 * @param {{Tensor:Function}} options.runtime 提供 float32 张量构造器的运行时
 * @param {Object<string, {run:Function}>} options.sessions 五个角色的会话
 * @param {{referenceMel:Float32Array,style:Float32Array,referenceCondition:Float32Array}} options.reference
 * @param {object} options.randoms createRandomSource() 的产物
 * @param {Float32Array} options.samples 44,480 个 16 kHz 单声道采样
 * @param {AbortSignal|null} [options.signal]
 * @param {(stage:string)=>void} [options.onStage] 阶段开始回调（进度展示用）
 * @param {(info:{stage:string,length:number,min:number,max:number,mean:number})=>void} [options.onDiagnostic]
 *        阶段数值范围（诊断；不含原始数组）
 * @param {() => Promise<void>} [options.yieldToHost] 让出事件循环，保证取消/进度可见
 * @returns {Promise<{samples:Float32Array,sampleRate:number,meta:object}>}
 */
export async function runFixedWindowChain(options) {
  const {
    runtime,
    sessions,
    reference,
    randoms,
    samples,
    signal = null,
    onStage = () => {},
    onDiagnostic = null,
    yieldToHost = defaultYieldToHost,
  } = options;

  if (!sessions || !sessions.xlsr || !sessions.lr || !sessions.dit || !sessions.hiftFractions || !sessions.hiftDecoder) {
    throw chainError('bad-sessions', '链路需要五个角色的会话');
  }
  if (!samples || samples.length !== GEOMETRY.inputSamples) {
    throw chainError('unsupported-window', `需要 ${GEOMETRY.inputSamples} 个采样`);
  }
  assertFiniteData(samples, '输入音频');
  assertReference(reference);

  const report = (stage, data) => {
    if (!onDiagnostic) return;
    let min = Infinity;
    let max = -Infinity;
    let mean = 0;
    for (const value of data) {
      if (value < min) min = value;
      if (value > max) max = value;
      mean += value;
    }
    onDiagnostic({ stage, length: data.length, min, max, mean: mean / (data.length || 1) });
  };

  // 1) XLSR：图里已经做了整窗归一化与编码后的切片，这里原样送进去。
  onStage('xlsr');
  const encoded = await runStage({
    runtime,
    session: sessions.xlsr,
    spec: ROLE_SPECS.xlsr,
    feeds: { wave_float32: { dims: [1, GEOMETRY.inputSamples], data: Float32Array.from(samples) } },
    signal,
    stage: 'xlsr',
  });
  report('xlsr', encoded.data);

  // 2) 长度调节器：38 帧 → 67 帧目标条件。
  await yieldToHost();
  onStage('lr');
  const targetCondition = await runStage({
    runtime,
    session: sessions.lr,
    spec: ROLE_SPECS.lr,
    feeds: { features: { dims: [1, GEOMETRY.encoderFrames, GEOMETRY.encoderDim], data: encoded.data } },
    signal,
    stage: 'lr',
  });
  report('lr', targetCondition.data);

  // 3) DiT：参考条件 + 目标条件拼接；图内做 CFG，cfg=0.7 只送一次。
  const condition = concatFrames(reference.referenceCondition, targetCondition.data);
  const style = Float32Array.from(reference.style);
  const referenceMel = Float32Array.from(reference.referenceMel);
  const cfgTensor = Float32Array.of(Math.fround(GEOMETRY.cfg));

  onStage('dit');
  const initialState = randoms.initialStateFor([1, GEOMETRY.melBins, GEOMETRY.totalFrames]);
  const steps = buildTimeSteps();
  let ditStep = 0;

  const solved = await runEulerSteps({
    state: initialState,
    steps,
    signal,
    yieldToHost,
    velocityFn: async ({ state, time }) => {
      onStage('dit', { step: ditStep, total: steps.length });
      ditStep += 1;
      const stage = await runStage({
        runtime,
        session: sessions.dit,
        spec: ROLE_SPECS.dit,
        feeds: {
          state: { dims: [1, GEOMETRY.melBins, GEOMETRY.totalFrames], data: state },
          reference_mel: { dims: [1, GEOMETRY.melBins, GEOMETRY.referenceFrames], data: referenceMel },
          style: { dims: [1, GEOMETRY.styleDim], data: style },
          condition: { dims: [1, GEOMETRY.totalFrames, GEOMETRY.conditionDim], data: condition },
          time: { dims: [1], data: Float32Array.of(time) },
          cfg: { dims: [1], data: cfgTensor },
        },
        signal,
        stage: 'dit',
      });
      return stage.data;
    },
  });

  // 4) HiFT 分数：mel[1,80,67] → [1,9,17152]，然后在 JS 里做逐谐波 double 累加。
  report('mel', solved.target);
  await yieldToHost();
  onStage('hiftFractions');
  const mel = { dims: [1, GEOMETRY.melBins, GEOMETRY.targetFrames], data: solved.target };
  const fractions = await runStage({
    runtime,
    session: sessions.hiftFractions,
    spec: ROLE_SPECS.hiftFractions,
    feeds: { mel },
    signal,
    stage: 'hiftFractions',
  });
  report('fractions', fractions.data);
  const cumsum = cumulativeSumRows(fractions.data);

  // 5) HiFT 解码：显式相位与标准噪声由本机有界随机提供（也可注入）。
  await yieldToHost();
  onStage('hiftDecoder');
  const phase = randoms.phaseFor();
  const standardNoise = randoms.standardNoiseFor([1, GEOMETRY.harmonics, GEOMETRY.hiftFrames]);
  throwIfAborted(signal, 'hiftDecoder');
  const decoded = await runStage({
    runtime,
    session: sessions.hiftDecoder,
    spec: ROLE_SPECS.hiftDecoder,
    feeds: {
      mel,
      phase: { dims: [1, GEOMETRY.harmonics, 1], data: phase },
      standard_noise: { dims: [1, GEOMETRY.harmonics, GEOMETRY.hiftFrames], data: standardNoise },
      '/CumSum_output_0': { dims: [1, GEOMETRY.harmonics, GEOMETRY.hiftFrames], data: cumsum },
    },
    signal,
    stage: 'hiftDecoder',
  });
  report('wave', decoded.data);

  throwIfAborted(signal, 'publish');
  const cropped = cropFixedWindow(decoded.data);

  return {
    samples: cropped,
    sampleRate: GEOMETRY.outputSampleRate,
    meta: {
      chainVersion: 'seed-chain/v1',
      steps: solved.trace.length,
      cfg: GEOMETRY.cfg,
      crop: { start: GEOMETRY.cropStart, end: GEOMETRY.cropEnd },
      inputSamples: GEOMETRY.inputSamples,
      inputSampleRate: GEOMETRY.inputSampleRate,
    },
  };
}
