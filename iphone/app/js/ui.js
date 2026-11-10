/* 纯渲染函数：输入 state 快照，输出到 DOM。不读取 DOM、不发请求、不播放。
   元素表由 main.js 传入，测试里可以传假元素。 */

import { ENGINE_MISSING_MESSAGE } from './config.js';
import { formatBytes, formatSeconds, formatHz, formatCount, formatChannels } from './format.js';

/** 界面需要的元素 id 列表；index.html 必须全部提供（测试会核对）。 */
export const ELEMENT_IDS = Object.freeze([
  'file-input',
  'record-start',
  'record-stop',
  'record-cancel',
  'record-status',
  'input-status',
  'input-info',
  'input-audio',
  'input-wav',
  'model-input',
  'reference-input',
  'files-info',
  'engine-status',
  'engine-prepare',
  'window-note',
  'use-excerpt',
  'progress',
  'progress-label',
  'progress-bar',
  'memory-note',
  'convert-start',
  'convert-cancel',
  'convert-status',
  'output-section',
  'output-empty',
  'output-audio',
  'output-wav',
  'messages',
  'reset-all',
]);

export const INPUT_AUDIO_LABEL = '输入试听（解码后的单声道 WAV）';
export const OUTPUT_AUDIO_LABEL = '变声结果试听（本机生成）';

function setText(el, text) {
  if (el) el.textContent = text;
}

function setHidden(el, hidden) {
  if (el) el.hidden = Boolean(hidden);
}

function setDisabled(el, disabled) {
  if (el) el.disabled = Boolean(disabled);
}

/** 写属性；值没变就不写，避免无谓地打断媒体加载或触发重排。 */
function setAttribute(el, name, value) {
  if (!el) return;
  const text = String(value);
  const current = typeof el.getAttribute === 'function' ? el.getAttribute(name) : el[name];
  if (current === text) return;
  if (typeof el.setAttribute === 'function') el.setAttribute(name, text);
  else el[name] = text;
}

function removeAttribute(el, name) {
  if (!el) return;
  if (typeof el.removeAttribute === 'function') el.removeAttribute(name);
  else delete el[name];
}

/**
 * 只在值变化时写 src / href。
 * 每帧都重新赋值会让浏览器重新加载媒体、打断正在进行的试听。
 */
function setUrlAttribute(el, name, url) {
  if (!el) return;
  const current = typeof el.getAttribute === 'function' ? el.getAttribute(name) : el[name] || null;
  const next = url || null;
  if (current === next) return;
  if (next) setAttribute(el, name, next);
  else removeAttribute(el, name);
}

const BUSY = ['requesting', 'recording', 'stopping'];

function recordStatusText(recording) {
  const status = recording && recording.status ? recording.status : 'idle';
  const seconds = recording && Number.isFinite(recording.seconds) ? recording.seconds : 0;
  switch (status) {
    case 'requesting':
      return '正在等待麦克风权限…（还没开始录音）';
    case 'recording':
      return `录音中… ${formatSeconds(seconds)}（到 30 秒会自动停止）`;
    case 'stopping':
      return '正在结束录音…';
    case 'ready':
      return `录音完成：${formatBytes(recording.bytes)}，格式 ${recording.mimeType || '浏览器默认'}`;
    case 'error':
      return recording.message || '录音失败。';
    case 'cancelled':
      return '已取消录音，麦克风已关闭。';
    default:
      return '尚未录音。只有点「开始录音」并允许麦克风后才会录音。';
  }
}

function inputInfoText(input) {
  const lines = [];
  const originRate = input.originalSampleRateKnown
    ? `${formatHz(input.originalSampleRate)}（文件声明）`
    : `${formatHz(input.originalSampleRate)}（文件未声明，按解码结果记录）`;
  lines.push(`原始采样率：${originRate}`);
  lines.push(
    `处理采样率：${formatHz(input.sampleRate)}${input.resampled ? '（解码时被浏览器重采样）' : '（未重采样）'}`,
  );
  lines.push(`声道：源 ${formatChannels(input.sourceChannels)} → 处理后 ${formatChannels(input.channels)}`);
  lines.push(`时长：${formatSeconds(input.durationSeconds)}`);
  lines.push(`单声道采样点：${formatCount(input.sampleCount)}`);
  lines.push(`峰值：${input.peak.toFixed(3)}${input.silent ? '（接近静音）' : ''}`);
  lines.push(`来源：${input.sourceName}（${input.sourceKind === 'recording' ? '麦克风录音' : '本地文件'}）`);
  return lines.join('\n');
}

function filesInfoText(state) {
  const lines = [];
  if (state.models && state.models.length) {
    const total = Number.isFinite(state.modelTotalBytes) ? `，合计 ${formatBytes(state.modelTotalBytes)}` : '';
    lines.push(`模型文件：${state.models.length} 个${total}（只记录名字与大小，本页不读取内容）`);
    for (const model of state.models) lines.push(` · ${model.name} · ${formatBytes(model.size)}`);
  } else {
    lines.push('模型文件：未选择');
  }
  lines.push(state.reference ? `参考文件：${state.reference.name} · ${formatBytes(state.reference.size)}` : '参考文件：未选择');
  return lines.join('\n');
}

function engineText(state) {
  const engine = state.engine;
  if (!engine || engine.installed !== true) {
    return `本地推理：不可用 — ${ENGINE_MISSING_MESSAGE}，所以「开始变声」保持禁用。`;
  }
  if (engine.prepared !== true) {
    return '本地推理：引擎已安装，但模型还没准备，所以「开始变声」暂时禁用。';
  }
  return `本地推理：已就绪（${engine.message || engine.engineId}）。`;
}

/** 固定窗口状态：必须让用户看懂「为什么还没法变声」和「要不要截取」。 */
function windowText(windowInfo, state) {
  if (!windowInfo) return '';
  const needed = Number.isFinite(windowInfo.neededSeconds) ? windowInfo.neededSeconds.toFixed(2) : '2.78';
  if (windowInfo.ready && windowInfo.source === 'excerpt') {
    return `本次只使用开头约 ${needed} 秒（你已明确截取）。结果会是约 0.26 秒的片段，不是整句转换。`;
  }
  if (windowInfo.ready) {
    return `这段音频正好是固定窗口（约 ${needed} 秒），会整段处理。结果约 0.26 秒，不是整句转换。`;
  }
  if (windowInfo.code === 'too-short') {
    const have = Number.isFinite(windowInfo.chainSeconds) ? windowInfo.chainSeconds.toFixed(2) : '更短';
    return `这段音频只有约 ${have} 秒，比固定窗口（${needed} 秒）短；这一版不补零，请换一段更长的。`;
  }
  return `这段音频比固定窗口（${needed} 秒）长。程序不会自动裁剪：点「使用开头 2.78 秒」才会截取。`;
}

function progressPercentText(progress) {
  const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : 0;
  const step =
    Number.isInteger(progress.step) && Number.isInteger(progress.total)
      ? `（${progress.step}/${progress.total}）`
      : '';
  return `${progress.label || '正在本地推理'}${step} · ${percent}%`;
}

/** 内存提示：手机端最容易在这里失败，所以提前给出可操作的建议。 */
function memoryText(state) {
  const engine = state.engine;
  if (!engine || engine.installed !== true) return '';
  const memory = state.deviceMemoryGb;
  if (Number.isFinite(memory) && memory > 0 && memory < 4) {
    return `这台设备报告约 ${memory} GB 内存；五个模型（约 0.8 GB 文件）加载后占用更高，可能准备失败。遇到内存不足时请在内存更大的设备上试用。`;
  }
  if (state.memoryPressure) return state.memoryPressure;
  return '';
}

function convertText(state) {
  if (state.preparing) return '正在准备本地引擎…（可点取消）';
  if (state.converting) return '正在变声…（可点取消）';
  if (state.conversion) {
    return `已生成结果：${formatSeconds(state.conversion.durationSeconds)}，${formatHz(state.conversion.sampleRate)}。这只是链路跑通，不代表音色效果已确定。`;
  }
  const engine = state.engine;
  if (engine && engine.installed === false) {
    return `尚未运行。${ENGINE_MISSING_MESSAGE}，所以这个按钮是禁用的。`;
  }
  if (engine && engine.installed === true && engine.prepared !== true) {
    return '尚未运行。本地引擎还没有准备模型。';
  }
  return '尚未运行。';
}

function messagesText(messages) {
  if (!messages || !messages.length) return '';
  return messages
    .map((item) => `${item.level === 'error' ? '！' : item.level === 'warn' ? '·' : '·'} ${item.text}`)
    .join('\n');
}

/** 渲染一次。els 里缺元素也不会抛错。 */
export function render(els, state) {
  const safe = state || {};
  const recording = safe.recording || { status: 'idle' };
  const busy = BUSY.includes(recording.status);
  const input = safe.input || null;
  const previews = safe.previews || {};

  setText(els['record-status'], recordStatusText(recording));
  setText(els['memory-note'], memoryText(safe));

  if (safe.phase === 'decoding') {
    setText(els['input-status'], '正在解码音频…');
  } else if (input) {
    setText(
      els['input-status'],
      `已载入${input.sourceName}：单声道 ${formatSeconds(input.durationSeconds)}，${formatHz(input.sampleRate)}。`,
    );
  } else if (safe.phase === 'error') {
    setText(els['input-status'], '这个输入不可用，看下面的提示。');
  } else {
    setText(els['input-status'], '尚未选择音频。');
  }

  setText(els['input-info'], input ? inputInfoText(input) : '');
  setHidden(els['input-info'], !input);

  setAttribute(els['input-audio'], 'aria-label', INPUT_AUDIO_LABEL);
  // 只有存在可播放的输入时才挂上 src；没有自动播放，播放必须由用户点 audio 控件。
  setUrlAttribute(els['input-audio'], 'src', previews.inputAudio);
  setHidden(els['input-audio'], !previews.inputAudio);

  if (previews.inputWav) {
    setUrlAttribute(els['input-wav'], 'href', previews.inputWav);
    setAttribute(els['input-wav'], 'download', input && input.sourceKind === 'recording' ? 'recording-mono.wav' : 'input-mono.wav');
  } else {
    setUrlAttribute(els['input-wav'], 'href', null);
  }
  setHidden(els['input-wav'], !previews.inputWav);

  setText(els['files-info'], filesInfoText(safe));
  setText(els['engine-status'], engineText(safe));

  setDisabled(els['record-start'], busy || !safe.canRecord);
  setDisabled(els['record-stop'], recording.status !== 'recording');
  setDisabled(els['record-cancel'], !busy);

  setDisabled(els['engine-prepare'], !safe.canPrepare);
  setDisabled(els['convert-start'], !safe.canConvert);
  setDisabled(els['convert-cancel'], !(safe.converting || safe.preparing));
  setText(els['convert-status'], convertText(safe));

  // 固定窗口：如实说明「精确命中 / 需要用户显式截取 / 太短」。
  const windowInfo = input && input.window ? input.window : null;
  setText(els['window-note'], windowText(windowInfo, safe));
  setHidden(els['window-note'], !windowInfo);
  setHidden(els['use-excerpt'], !safe.canUseExcerpt);
  setDisabled(els['use-excerpt'], !safe.canUseExcerpt || busy);

  // 进度：只讲「正在做什么」，不出现张量术语。
  const progress = safe.progress;
  setHidden(els['progress'], !progress);
  if (progress) {
    setText(els['progress-label'], progressPercentText(progress));
    setAttribute(els['progress-bar'], 'value', String(progress.percent || 0));
  }

  const conversion = safe.conversion || null;
  setHidden(els['output-section'], !conversion);
  setHidden(els['output-empty'], Boolean(conversion));
  setAttribute(els['output-audio'], 'aria-label', OUTPUT_AUDIO_LABEL);
  setUrlAttribute(els['output-audio'], 'src', conversion ? previews.outputAudio : null);
  if (conversion && previews.outputWav) {
    setUrlAttribute(els['output-wav'], 'href', previews.outputWav);
    setAttribute(els['output-wav'], 'download', 'converted-mono.wav');
  } else {
    setUrlAttribute(els['output-wav'], 'href', null);
  }
  setHidden(els['output-wav'], !(conversion && previews.outputWav));

  setText(els['messages'], messagesText(safe.messages));
}
