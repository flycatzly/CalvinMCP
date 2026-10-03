/**
 * configobj.js — 从 playwright.config.ts / .js 里取出 defineConfig({...}) 的顶层键
 *
 * 为什么不用 TypeScript 解析器：本 MCP 是零依赖设计（对齐 calvin-db-mcp 的「手写协议、只装驱动」思路）。
 * 配置文件的结构非常规整，用「字符串感知的花括号配平 + 顶层键切分」足够可靠，
 * 而且失败时是「算不出来」而不是「解析崩溃」——扫描器宁可说不知道，也不能倒下。
 */
import { maskAll } from './tokenizer.js';

/** 找 defineConfig( ... ) 或 module.exports = { ... } / export default { ... } 的对象体。 */
export function extractConfigObject(src) {
  const mask = maskAll(src);
  const body = mask.noStrings;
  const openIdx = body.indexOf('{', (() => {
    const dc = body.indexOf('defineConfig');
    if (dc >= 0) return dc;
    const ex = Math.max(body.indexOf('module.exports'), body.indexOf('export default'));
    return ex >= 0 ? ex : 0;
  })());
  if (openIdx < 0) return null;

  // 花括号配平（noStrings 已把字符串内容抹成空格，所以花括号一定是代码花括号）
  let depth = 0;
  let end = -1;
  for (let i = openIdx; i < src.length; i++) {
    if (mask.inComment[i]) continue;
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  return { start: openIdx, end, text: src.slice(openIdx + 1, end), mask };
}

/**
 * 切出顶层键。返回 [{ key, valueText, line }]
 * 只有「花括号/方括号/圆括号深度都为 0」位置上的 `key:` 才算顶层键。
 */
export function topLevelEntries(src) {
  const obj = extractConfigObject(src);
  if (!obj) return [];
  const mask = maskAll(src);
  const inner = ' ' + src.slice(obj.start + 1, obj.end);   // 补一个前导空格，让第一个顶层键也能被 (?:^|[\s,{]) 命中
  const innerOffset = obj.start;                            // inner[0] 是那个空格，对应原文 obj.start
  const entries = [];
  // 顶层键正则：标识符或引号键，后跟冒号
  const keyRe = /(?:^|[\s,{])([A-Za-z_$][\w$]*|'[^']+'|"[^"]+")\s*:/g;
  let m;
  while ((m = keyRe.exec(inner)) !== null) {
    const keyStart = m.index + m[0].indexOf(m[1]);
    const abs = innerOffset + keyStart;
    // 该键必须处在顶层（深度 0）。
    // 注意起点是 obj.start + 1（跳过配置对象自己的 {），不是 innerOffset ——
    // 否则那个 { 会被算进深度，所有键都变成「非顶层」而被全部丢掉。
    let depth = 0;
    for (let i = obj.start + 1; i < abs; i++) {
      if (mask.inComment[i] || mask.inString[i]) continue;
      const c = src[i];
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') depth--;
    }
    if (depth !== 0) continue;

    // 值：从冒号后到「下一个顶层逗号或对象结束」为止
    const colon = innerOffset + m.index + m[0].length;
    let vDepth = 0;
    let vEnd = obj.end;
    for (let i = colon; i < obj.end; i++) {
      if (mask.inComment[i] || mask.inString[i]) continue;
      const c = src[i];
      if (c === '{' || c === '[' || c === '(') vDepth++;
      else if (c === '}' || c === ']' || c === ')') {
        if (vDepth === 0) { vEnd = i; break; }
        vDepth--;
      } else if (c === ',' && vDepth === 0) { vEnd = i; break; }
    }
    const key = m[1].replace(/^['"]|['"]$/g, '');
    entries.push({
      key,
      valueText: src.slice(colon, vEnd).trim(),
      line: src.slice(0, abs).split('\n').length,
      raw: src.slice(abs, vEnd),
    });
  }
  // 去重（同一 key 只留第一次出现）
  const seen = new Set();
  return entries.filter((e) => (seen.has(e.key) ? false : seen.add(e.key)));
}

/** 取 { a: { b: 1 } } 里的嵌套键值。 */
export function nestedGet(entries, key, sub) {
  const e = entries.find((x) => x.key === key);
  if (!e) return undefined;
  const re = new RegExp(`(?:^|[\\s{,])${sub}\\s*:\\s*([^,}]+)`);
  const m = e.valueText.match(re);
  return m ? m[1].trim() : undefined;
}

export default { extractConfigObject, topLevelEntries, nestedGet };
