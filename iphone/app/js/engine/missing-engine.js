/* 这一版随页面发布的唯一适配器：完整的本地推理引擎还没接进来。
 * 它永远报告 installed:false / prepared:false，convert 一定拒绝，
 * 不会产生任何「变声结果」。这是诚实占位，不是模拟引擎；
 * 模拟引擎只存在于 tests/ 里。 */

import { ENGINE_API_VERSION, EngineUnavailableError } from './adapter.js';
import { ENGINE_MISSING_MESSAGE } from '../config.js';

export function createMissingEngine(options = {}) {
  const detail = typeof options.detail === 'string' ? options.detail : null;
  let disposed = false;

  function status() {
    return {
      installed: false,
      prepared: false,
      code: 'engine-missing',
      message: ENGINE_MISSING_MESSAGE,
      engineId: 'missing',
      apiVersion: ENGINE_API_VERSION,
      models: 0,
      detail: disposed ? '适配器已释放' : detail,
    };
  }

  return {
    apiVersion: ENGINE_API_VERSION,
    engineId: 'missing',
    status,
    async prepare() {
      // 没有引擎可准备：明确报告未安装，也不读取任何模型内容。
      return status();
    },
    async convert() {
      throw new EngineUnavailableError(ENGINE_MISSING_MESSAGE, 'engine-missing');
    },
    cancel() {
      /* 没有可取消的推理 */
    },
    async dispose() {
      disposed = true;
    },
  };
}
