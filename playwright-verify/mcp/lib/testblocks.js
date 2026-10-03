/**
 * testblocks.js — 把用例块与容器块分开
 *
 * 对应原文缺陷 1 与缺陷 3：
 *   缺陷 1：用 /test\s*\(/ 找用例块，而 test.only( 里 test 后面跟的是 .only，整块漏扫，
 *          于是「拦 .only 的规则恰恰被 .only 自己骗过去了」。
 *          修法：块起始正则改成 test(?:\s*\.\s*\w+)?\s*\(，并把 test.skip( / test.fixme( 一起纳进来。
 *   缺陷 3：test.describe( 容器块没有断言，被判成「没有断言的用例」（假阳性）。
 *          修法：容器与用例分开处理 —— 容器只单独拦 .only，不参与断言/等待等检查。
 *
 * 本模块还负责用花括号配平提取回调体范围，并且**跳过长字符串、注释、正则字面量**，
 * 否则回调体里的一句话里带 } 就会提前收尾。
 *
 * 性能约定：所有函数只接受调用方传进来的 mask（maskAll 的产物），
 * 不在函数内部重新扫描 —— 否则对大文件是 O(n²)。
 */
import { maskAll, splitLines } from './tokenizer.js';

/**
 * 判断某个下标是否是正则字面量的起始斜杠。
 * 用「前一个非空白字符」推断：出现在 ( , = : [ ! & | ? { } ; return 之后，或行首，则是正则。
 * 这是启发式，但足以避免把 /}/ 之类当成代码花括号（原文的陷阱样例之一）。
 */
/**
 * 判断某个下标是否是正则字面量的起始斜杠。
 *
 * 两个判据：
 *   1) 前一个非空白字符是运算符/分隔符（`return /re/` 之外的多数情形）；
 *   2) 前一个词是**关键字**（return / typeof / case / in / of / new / delete / void / do / else / instanceof）。
 *      第 2 条一开始漏了，于是 `return /}/.test(x)` 里的正则没被识别成 token，
 *      花括号配平把正则里的 `}` 当成代码花括号，函数体被提前截断。
 *      （这类漏判不会报错，只会**静默算错范围** —— 比崩溃更难发现。）
 *
 * 这是启发式：JavaScript 的 `/` 本来就有词法歧义，没有完整解析器无法百分之百判定。
 * 所以调用方还有「绝不后退」的兜底，保证最坏情况只是范围偏大，而不是挂死。
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'case', 'yield', 'await', 'throw',
]);

function looksLikeRegexStart(src, slashIdx, noStrings) {
  let word = '';
  for (let i = slashIdx - 1; i >= 0; i--) {
    const c = noStrings[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (word) break;
      continue;
    }
    if (/[\w$]/.test(c)) { word = c + word; continue; }
    if (word) break;   // 命中了「关键字 + 空白 + /」的形态
    return '(,=:[!&|?{};+-*%^~<>'.includes(c);
  }
  if (word) return REGEX_PRECEDING_KEYWORDS.has(word);
  return true;   // 行首/文件首的 /
}

/** 跳过一个字符串/注释/正则字面量，返回新的下标（指向该 token 之后）。 */
/** 一个 token 结束后的「安全下一站」：**绝不后退**。 */
const forward = (from, to) => (to > from ? to : from + 1);

/**
 * 跳过一个字符串 / 注释 / 正则字面量。
 *
 * **不变量：返回值严格大于 i**（除极少数退化输入时也至少 +1）。
 * 这一条不是洁癖，是防死循环的硬条件：
 * 调用方普遍写成 `i = skipToken(...) - 1; continue;`，靠 for 的 `i++` 回到下一站。
 * 如果 skipToken 返回的值 ≤ i，循环就会**原地或回退**，在合法输入上永久挂死。
 * 实测触发形态（真实存在于测试代码里）：
 *     const re = /https?:\/\//;
 * 正则里的 `\/` 与 `//` 让「字符串标记」与实际位置错位，
 * 于是 skipToken 在下一个位置被调用时返回了它的起点，循环卡死。
 */
function skipToken(src, i, mask) {
  const { inComment, inString } = mask;
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    let j = i;
    while (j < src.length && src[j] !== '\n') j++;
    return forward(i, j);
  }
  if (c === '/' && src[i + 1] === '*') {
    let j = i + 2;
    while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
    return forward(i, Math.min(j + 2, src.length));
  }
  if (inString[i]) {
    // 字符串/正则已被 mask 标记，直接跳到连续标记结束处
    let j = i;
    while (j < src.length && inString[j]) j++;
    return forward(i, j);
  }
  if (c === '/' && looksLikeRegexStart(src, i, mask.noStrings)) {
    let j = i + 1;
    let inClass = false;
    while (j < src.length) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '[') inClass = true;
      else if (src[j] === ']') inClass = false;
      else if (src[j] === '/' && !inClass) { j++; break; }
      else if (src[j] === '\n') break;
      j++;
    }
    return forward(i, j);
  }
  return i + 1;
}

/** 从 openIdx（左括号）出发找到配对右括号下标；找不到返回 -1。 */
export function matchParen(src, openIdx, mask) {
  const m = mask || maskAll(src);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (m.inComment[i] || m.inString[i]) { i = skipToken(src, i, m) - 1; continue; }
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    else if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipToken(src, i, m) - 1; continue; }
    else if (c === '/' && looksLikeRegexStart(src, i, m.noStrings)) { i = skipToken(src, i, m) - 1; continue; }
  }
  return -1;
}

/** 从 openIdx（左花括号）出发找到配对右花括号下标；找不到返回 -1。 */
export function matchBrace(src, openIdx, mask) {
  const m = mask || maskAll(src);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (m.inComment[i] || m.inString[i]) { i = skipToken(src, i, m) - 1; continue; }
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    else if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) { i = skipToken(src, i, m) - 1; continue; }
    else if (c === '/' && looksLikeRegexStart(src, i, m.noStrings)) { i = skipToken(src, i, m) - 1; continue; }
  }
  return -1;
}

/**
 * 从 [from, to) 里取出第一个字符串/模板串字面量的内容。
 * 返回 { text, start } 或 null。模板串的插值 `${…}` 会被写成 `<expr>` 占位，
 * 这样用例名保持可读且稳定（不会因为插值里的数值变化而产生假差异）。
 */
function extractName(src, from, to, mask) {
  let i = from;
  while (i < to && /\s/.test(src[i])) i++;
  if (i >= to) return null;
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  if (!mask.inString[i]) return null;          // 不是字面量（可能是变量），不猜

  // 用掩码取到该字面量的结束处：end 是「第一个不再被标记的位置」。
  let end = i;
  while (end < to && mask.inString[end]) end++;

  // 字面量的**外框**（开引号与闭引号）也在掩码里，所以内容是 [i+1, end-1)。
  // 注意 end 是「第一个未标记的位置」，闭引号本身是被标记的，因此 end-1 就是它。
  const contentFrom = i + 1;
  const contentTo = end - 1;
  if (contentTo <= contentFrom) return { text: '', start: contentFrom };

  // 模板串的插值写成 <expr> 占位。
  // 两个细节都是踩出来的：
  //   1) 不能只走「被标记的字符」—— 插值里的表达式是**代码**、不被标记，
  //      跳跃式扫描会在 `${` 处断掉，名字被截成 `case $`。
  //      所以按连续区间遍历，遇到被标记的区间就当字面量文本处理。
  //   2) 用「从 ${ 扫到配对 }」而不是正则 `\$\{[^}]*\}` ——
  //      后者遇到嵌套对象字面量（`${ { a: 1 }.a }`）只吃到第一个 `}`。
  let text = '';
  let k = contentFrom;
  while (k < contentTo) {
    if (!mask.inString[k]) { k++; continue; }          // 插值表达式内部，跳过
    if (src[k] === '$' && src[k + 1] === '{') {
      let depth = 0;
      let j = k + 1;
      for (; j < contentTo; j++) {
        const c = src[j];
        if (c === '\\') { j++; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { j++; break; } }
      }
      text += '<expr>';
      k = j;
      continue;
    }
    text += src[k];
    k++;
  }
  return { text, start: contentFrom };
}

/** 在 [from, to) 里找**顶层**（括号/方括号深度为 0）的 `=>`；找不到返回 -1。 */
function topLevelArrow(src, from, to, mask) {
  let depth = 0;
  for (let i = from + 1; i < to - 1; i++) {
    if (mask.inComment[i] || mask.inString[i]) continue;
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '=' && src[i + 1] === '>') return i;
  }
  return -1;
}

/** 建立 行号 → 行首偏移 索引，并给出 偏移 → 行号 的二分查找。 */
export function makeLineIndex(src) {
  const lines = splitLines(src);
  const lineStart = new Map();
  for (const l of lines) lineStart.set(l.line, l.start);
  const lineOf = (offset) => {
    let lo = 1;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStart.get(mid) <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  };
  return { lines, lineOf };
}

/**
 * 找出文件里所有 test(...) / test.xxx(...) / describe(...) 块。
 *
 * 返回数组，每项：
 *   { kind:'test'|'container', head, modifier, name, nameLine, line, endLine,
 *     callStart, callEnd, bodyStart, bodyEnd }
 *
 * kind 判定：
 *   - describe(...) / test.describe(...)                        → container
 *   - test.step / test.use / before* / after*                   → container
 *   - test(...) / test.only(...) / test.skip(...) / test.fixme → test
 */
export function findTestBlocks(src, mask) {
  const m = mask || maskAll(src);
  const { lineOf } = makeLineIndex(src);
  const blocks = [];

  // 块起始：describe 或 test，允许中间带 .modifier；负向后顾避免匹配 myTest( 或 obj.test(
  const startRe = /(?<![\w$.])(describe|test)((?:\s*\.\s*\w+)*)\s*\(/g;
  let mm;
  while ((mm = startRe.exec(src)) !== null) {
    const at = mm.index;
    if (m.inComment[at] || m.inString[at]) continue;

    const head = mm[1];
    const mods = mm[2] || '';
    const modifier = (mods.match(/\.\s*(\w+)/g) || []).map((s) => s.replace(/[.\s]/g, '')).join('.');
    const openParen = at + mm[0].length - 1;
    const closeParen = matchParen(src, openParen, m);
    if (closeParen < 0) continue;

    // 用例名：第一个实参，如果它是字符串/模板串字面量，就取其内容。
    //
    // 为什么用掩码定位而不是正则匹配引号：
    //   模板串里可以有插值 —— `test(\`case ${1}\`, ...)`。
    //   写成 `(['"`])((?:\\.|(?!\1)[^\\])*)\1` 会在 `${` 处被 `{` 与 `}` 的配对规则绊住，
    //   匹配失败 → 整条用例**完全不登记**（不是误报，是彻底看不见，更危险）。
    //   掩码的 inString 是词法扫描出来的、天然正确处理嵌套与插值，直接用它更稳。
    const nameInfo = extractName(src, openParen + 1, closeParen, m);
    const name = nameInfo ? nameInfo.text : '(未命名)';
    const nameStart = nameInfo ? nameInfo.start : openParen;

    // 回调体：必须**跳过参数列表**再找花括号。
    // 坑 1：`async ({ page }) => { ... }` 里第一个 { 是解构参数，不是函数体 ——
    //        直接取「第一个 {」会把用例体缩成参数对象，于是所有断言检查都失效
    //        （全部误报「用例内没有任何断言」）。
    // 坑 2：不能用 indexOf('=>') 找箭头 —— 参数列表里可以再写箭头函数。
    //        所以只认**顶层**（括号深度 0）的那个 `=>`。
    // 坑 3：花括号必须**紧跟**在箭头之后才算函数体。
    //        反例：`test('a', async ({page}) => test.step('s', () => { ... }))`
    //        外层 test 是表达式体（没有自己的花括号），若放宽成「箭头之后第一个 {」，
    //        就会把内层 step 的花括号当成外层用例的体 —— 于是两条块共用同一段正文，
    //        PW007 会拿内层的断言去判断外层，误报「用例内没有任何断言」。
    let bodyStart = -1;
    let bodyEnd = -1;
    const arrowIdx = topLevelArrow(src, openParen, closeParen, m);
    if (arrowIdx >= 0) {
      let i = arrowIdx + 2;
      // 跳过箭头与花括号之间的空白与注释
      while (i < closeParen && (/\s/.test(src[i]) || m.inComment[i])) i++;
      if (src[i] === '{') {
        bodyStart = i;
        bodyEnd = matchBrace(src, i, m);
      }
    }

    const CONTAINER_MODS = new Set(['describe', 'step', 'use', 'beforeAll', 'afterAll', 'beforeEach', 'afterEach', 'slow', 'configure']);
    // test 命名空间下**没有回调体**的成员不是用例声明：test.setTimeout / test.skip(true,"...") /
    // test.info() / test.expect(n) / test.extend(…) 全都是配置或断言调用。
    // 不排除它们会凭空造出「用例」并误报 PW007（一次冤枉就够废掉门禁）。
    const NON_BLOCK_MEMBERS = new Set(['setTimeout', 'info', 'extend', 'expect', 'setTestId']);
    if (NON_BLOCK_MEMBERS.has(modifier)) continue;
    if (bodyStart < 0) continue;   // 没有回调体 → 不是用例/容器块

    let kind;
    if (head === 'describe') kind = 'container';
    else if (CONTAINER_MODS.has(modifier)) kind = 'container';
    else kind = 'test';

    blocks.push({
      kind,
      head,
      modifier: head === 'describe' ? 'describe' : (modifier || ''),
      name,
      nameLine: lineOf(nameStart),
      callStart: at,
      callEnd: closeParen,
      line: lineOf(at),
      endLine: bodyEnd >= 0 ? lineOf(bodyEnd) : lineOf(closeParen),
      bodyStart,
      bodyEnd,
    });
  }
  blocks.sort((a, b) => a.callStart - b.callStart);
  return blocks;
}

export default { findTestBlocks, matchParen, matchBrace, makeLineIndex };
