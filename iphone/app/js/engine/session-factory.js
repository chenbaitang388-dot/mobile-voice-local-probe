/* ONNX 会话工厂：把「用哪种后端建会话」这一件事隔离出来，方便注入真实 ort 运行时。
 *
 * 后端策略沿用已经验证过的 GPU 兼容模式：
 * - 只请求一种后端（默认 webgpu），失败就让创建失败——不会把整个会话悄悄退回 CPU；
 * - 不设置 disable_cpu_ep_fallback，所以图里 GPU 不支持的节点仍可由本机 CPU 处理；
 * - 纯 CPU 是显式选项（backend: 'wasm'），需要调用方主动选择。
 *
 * 因此「用了 GPU」只代表请求了 GPU；逐节点落在哪个后端由运行时决定，本层不做任何断言。 */

import { chainError } from './contract.js';

export const SESSION_BACKENDS = Object.freeze({ WEBGPU: 'webgpu', WASM: 'wasm' });

export function createSessionFactory(options = {}) {
  const { runtime } = options;
  if (!runtime || !runtime.InferenceSession || typeof runtime.InferenceSession.create !== 'function') {
    throw new TypeError('会话工厂需要一个提供 InferenceSession.create 的运行时');
  }

  return {
    /**
     * @param {ArrayBuffer} buffer 模型字节
     * @param {{backend?:string}} [createOptions]
     */
    async create(buffer, createOptions = {}) {
      const backend = createOptions.backend || SESSION_BACKENDS.WEBGPU;
      if (backend !== SESSION_BACKENDS.WEBGPU && backend !== SESSION_BACKENDS.WASM) {
        throw chainError('bad-backend', `不支持的后端：${backend}`);
      }
      if (!buffer || typeof buffer.byteLength !== 'number' || buffer.byteLength === 0) {
        throw chainError('bad-model', '模型文件是空的');
      }
      const session = await runtime.InferenceSession.create(buffer, {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
      });
      if (!session || typeof session.run !== 'function') {
        throw chainError('bad-session', '运行时没有返回可用的会话');
      }
      return { session, backend };
    },
  };
}
