/* 全局常量。这里只放本机处理需要的数值与文案，不含任何远程地址。 */

export const APP_TITLE = '本地变声 · 第一项';

/** 完整本地推理引擎还没接入时，界面必须显示这句话，并禁用变声。 */
export const ENGINE_MISSING_MESSAGE = '完整本地推理引擎尚未接入';

/** 输入与处理限制。数值同时用于界面提示和单元测试。 */
export const LIMITS = Object.freeze({
  /** 单个音频文件上限（字节）。 */
  maxInputBytes: 24 * 1024 * 1024,
  /** 处理时长上限（秒）。 */
  maxInputSeconds: 30,
  /** 时长过短会被拒绝，避免空文件进入推理链。 */
  minInputSeconds: 0.2,
  /** 单次录音上限（秒），到点自动停止。 */
  maxRecordSeconds: 30,
  /** 参考音色文件上限（字节）。和音频、模型都分开。 */
  maxReferenceBytes: 24 * 1024 * 1024,
  /** 同时可选的模型文件数（只在内存里记元数据，不读内容）。 */
  maxModelFiles: 8,
  /**
   * 单个模型文件上限。真实链路里最大的常见件是 XLSR 类特征模型（约 657 MB），
   * 73.6 MB 的扩散模型远小于此；1 GiB 只作为壳的上限，不代表手机能加载。
   */
  maxModelFileBytes: 1024 * 1024 * 1024,
  /**
   * 所有模型文件合计上限。避免一次选满 8 个 1 GiB 的文件把手机内存打爆。
   */
  maxModelTotalBytes: 2 * 1024 * 1024 * 1024,
});

/**
 * 录音容器候选。必须逐个用 MediaRecorder.isTypeSupported 检查，
 * 不能默认假设 WebM 可用（iOS Safari 常见的是 audio/mp4）。
 */
export const RECORD_MIME_CANDIDATES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/aac',
]);

/** 录音约束：单声道、关掉通话优化，避免把输入先处理一遍。 */
export const AUDIO_CONSTRAINTS = Object.freeze({
  audio: {
    channelCount: { ideal: 1 },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
});

/** 允许的非 audio/* 但实际是音频的 MIME（部分浏览器对 m4a 的报告不一致）。 */
export const AUDIO_MIME_ALLOWLIST = Object.freeze(['video/mp4', 'application/ogg', 'application/octet-stream']);
