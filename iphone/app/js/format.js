/* 纯格式化函数，界面与测试共用。不使用 toLocaleString，保证输出稳定。 */

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index]}`;
}

export function formatSeconds(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 10) return `${seconds.toFixed(2)} 秒`;
  return `${seconds.toFixed(1)} 秒`;
}

export function formatHz(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return '未知';
  if (hz >= 1000) {
    const value = hz / 1000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

export function formatCount(count) {
  if (!Number.isFinite(count)) return '—';
  const text = String(Math.round(count));
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (i > 0 && (text.length - i) % 3 === 0) out += ',';
    out += text[i];
  }
  return out;
}

export function formatChannels(channels) {
  if (!Number.isFinite(channels) || channels <= 0) return '未知';
  return channels === 1 ? '单声道' : `${channels} 声道`;
}
