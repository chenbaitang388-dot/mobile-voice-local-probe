/* 模型文件 → 图角色 的确定性映射。
 * 只按文件名的 basename 精确匹配；同名多次出现视为歧义；名字像某个角色但不是这个版本，
 * 明确报「版本不对」，而不是猜着用。 */

import { ROLE_ORDER, ROLE_SPECS, chainError } from './contract.js';

const MOBILE_XLSR = 'xlsr12-fixed-44480-int8.onnx';

export function basenameOf(name) {
  if (typeof name !== 'string') return '';
  const parts = name.split(/[\\/]/);
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * @param {Iterable<{name?:string,size?:number}>} files
 * @returns {{ok:boolean, roles:Record<string,any>, errors:Array<{code:string,message:string}>, ignored:Array<{name:string,reason:string}>}}
 */
export function mapModelFiles(files) {
  const list = Array.from(files || []).filter(Boolean);
  const errors = [];
  const ignored = [];
  const byBasename = new Map();
  const contested = new Set();

  for (const file of list) {
    const selectedName = basenameOf(file && file.name);
    const base = selectedName === MOBILE_XLSR ? ROLE_SPECS.xlsr.basename : selectedName;
    if (!base) {
      errors.push({ code: 'empty-name', message: '有一个模型文件没有文件名' });
      continue;
    }
    if (byBasename.has(base)) {
      contested.add(base);
      byBasename.delete(base);
      errors.push({ code: 'ambiguous-role', message: `${selectedName} 的模型角色重复，无法确定用哪个` });
      continue;
    }
    if (contested.has(base)) continue;
    byBasename.set(base, file);
  }

  const roles = Object.create(null);
  for (const id of ROLE_ORDER) {
    const spec = ROLE_SPECS[id];
    const file = byBasename.get(spec.basename);
    if (file) {
      roles[id] = file;
      byBasename.delete(spec.basename);
    } else if (!contested.has(spec.basename)) {
      errors.push({ code: 'missing-role', message: `缺少 ${spec.basename}` });
    }
  }

  for (const [base] of byBasename) {
    const lower = base.toLowerCase();
    const family = ROLE_ORDER.map((id) => ROLE_SPECS[id]).find((spec) => lower.includes(spec.family));
    if (family) {
      errors.push({
        code: 'wrong-variant',
        message: `${base} 不是这个固定窗口版本；需要 ${family.basename}`,
      });
    } else {
      ignored.push({ name: base, reason: 'not-a-chain-role' });
    }
  }

  return { ok: errors.length === 0, roles, errors, ignored };
}

export function describeMappingProblems(errors) {
  return errors.map((item) => item.message).join('；');
}

export function requireMapping(files) {
  const mapping = mapModelFiles(files);
  if (!mapping.ok) {
    throw chainError('model-roles', `模型文件不匹配：${describeMappingProblems(mapping.errors)}`);
  }
  return mapping;
}
