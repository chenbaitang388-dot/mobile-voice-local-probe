/* object URL 登记表。同一个 key 换新地址前先释放旧地址，避免内存泄漏。
   URL 只在内存里，页面离开时应调用 releaseAll。 */

/**
 * @param {{createObjectURL:(blob:any)=>string, revokeObjectURL:(url:string)=>void}} impl
 */
export function createObjectUrlRegistry(impl) {
  if (!impl || typeof impl.createObjectURL !== 'function' || typeof impl.revokeObjectURL !== 'function') {
    throw new TypeError('object URL 登记表需要 createObjectURL / revokeObjectURL');
  }
  const entries = new Map();
  const revoked = [];

  function release(key) {
    if (!entries.has(key)) return false;
    const url = entries.get(key);
    entries.delete(key);
    try {
      impl.revokeObjectURL(url);
      revoked.push(url);
    } catch {
      /* 释放失败不应中断流程 */
    }
    return true;
  }

  function set(key, blob) {
    release(key);
    const url = impl.createObjectURL(blob);
    entries.set(key, url);
    return url;
  }

  function releaseAll() {
    let count = 0;
    for (const key of Array.from(entries.keys())) {
      if (release(key)) count += 1;
    }
    return count;
  }

  return {
    set,
    get: (key) => (entries.has(key) ? entries.get(key) : null),
    has: (key) => entries.has(key),
    release,
    releaseAll,
    size: () => entries.size,
    /** 仅用于测试：被释放过的地址列表。 */
    revokedUrls: () => revoked.slice(),
  };
}
