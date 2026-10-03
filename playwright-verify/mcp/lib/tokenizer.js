/**
 * tokenizer.js — 等长脱敏（length-preserving masking）
 *
 * 这是 playwright-verify 的核心工序，直接对应原文的三个设计缺陷：
 *
 *   缺陷 2「证据对不上原文」——脱敏后文本长度变了，行号按原文算、证据按脱敏文本取，两边偏移对不上。
 *   缺陷 3「选择器类规则永远不可能命中」——XPath/nth-child 写在字符串里，字符串被抹掉后规则永远匹配不到；
 *          同时 describe/test.step 容器被误判成「没有断言的用例」。
 *
 * 解法（两道工序，不是一道）：
 *   工序 A：maskComments()      —— 只去注释、保留字符串 —— 给「选择器类」规则用（选择器就写在字符串里）
 *   工序 B：maskCommentsAndStrings() —— 再去字符串     —— 给「有没有断言/有没有 await」类规则用
 *                                                       （否则注释或字符串里写的 expect( 会被当成真断言）
 *
 * 关键不变量（本文件的所有函数都必须满足）：
 *   masked.length === original.length，且每个下标 i 上要么是原字符、要么是空格。
 *   被屏蔽的字符只替换成空格或换行，绝不删除 —— 换行必须原样保留，只有这样行号和列偏移才稳定。
 *
 * 因此：检测在脱敏文本上跑，证据回原文取，两者行号列号天然对齐。
 */

/** 脱敏用的占位符：保持长度，保留换行。 */
function blank(ch) {
  return ch === '\n' ? '\n' : ch === '\r' ? '\r' : ' ';
}

/**
 * 判断某处的 `/` 是否开启一个正则字面量。
 *
 * JS 的 `/` 有词法歧义（除号 vs 正则），没有完整解析器无法百分之百判定。
 * 这里用与 testblocks.js 一致的启发式：
 *   前一个有效字符是运算符/分隔符，或前一个词是关键字 → 是正则。
 * 判错的代价不对称：把除号误判成正则会多抹掉一小段代码（可能漏报），
 * 而把正则误判成除号会让 `//` 被当成注释、**整行后续代码消失**（大面积漏报）。
 * 两害相权，这里偏向「宁可当正则」。
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
    if (word) break;
    return '(,=:[!&|?{};+-*%^~<>'.includes(c);
  }
  if (word) return REGEX_PRECEDING_KEYWORDS.has(word);
  return true;   // 行首/文件首的 /
}

/**
 * 第 0 趟：标出正则字面量。
 *
 * 做法：先只做「最小限度的去字符串」拿一份可用于判断前导字符的文本，
 * 再扫一遍找正则。之所以要两小步，是因为判断 `/` 的性质依赖它前面的有效字符，
 * 而那个字符是否属于字符串又得先知道。
 */
function markRegexLiterals(src, inString, inComment) {
  // 最小去字符串：只处理引号字符串与 `//`、`/* */`，用于得到"前导字符"视图。
  // 这一步不需要完美 —— 它的唯一用途是给 looksLikeRegexStart 提供前导字符。
  const probe = new Array(src.length).fill(false);
  const stack = [{ type: 'code', depth: 0 }];
  for (let i = 0; i < src.length;) {
    const st = stack[stack.length - 1];
    const c = src[i];
    if (st.type === 'code') {
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') { probe[i] = true; i++; } continue; }
      if (c === '/' && src[i + 1] === '*') {
        probe[i] = true; probe[i + 1] = true; i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { probe[i] = true; i++; }
        if (i < src.length) { probe[i] = true; if (i + 1 < src.length) probe[i + 1] = true; i += 2; }
        continue;
      }
      if (c === "'" || c === '"') {
        const q = c; probe[i] = true; i++;
        while (i < src.length) {
          if (src[i] === '\\') { probe[i] = true; if (i + 1 < src.length) probe[i + 1] = true; i += 2; continue; }
          if (src[i] === q) { probe[i] = true; i++; break; }
          if (src[i] === '\n') break;
          probe[i] = true; i++;
        }
        continue;
      }
      if (c === '`') { probe[i] = true; i++; stack.push({ type: 'template', depth: 0 }); continue; }
      if (c === '{') { st.depth++; i++; continue; }
      if (c === '}') {
        // 与主状态机同样的配平规则：插值内部的 `}` 配平到 0 时要退回模板状态。
        // 否则 probe 会一直停在模板态，`noStrings` 视图失真，正则识别随之失准。
        if (st.interp && st.depth === 0) { probe[i] = true; i++; stack.pop(); continue; }
        if (st.depth > 0) st.depth--; i++; continue;
      }
      i++;
      continue;
    }
    // 模板串内：整体当作"非代码"，插值里再回到 code
    if (c === '\\') { probe[i] = true; if (i + 1 < src.length) probe[i + 1] = true; i += 2; continue; }
    if (c === '`') { probe[i] = true; i++; stack.pop(); continue; }
    if (c === '$' && src[i + 1] === '{') { probe[i] = true; probe[i + 1] = true; i += 2; stack.push({ type: 'code', depth: 0, interp: true }); continue; }
    probe[i] = true; i++;
  }

  let noStrings = '';
  for (let i = 0; i < src.length; i++) noStrings += probe[i] ? blank(src[i]) : src[i];

  // 扫正则：对每个未被 probe 标记、且不在注释里的 `/` 做判定
  for (let i = 0; i < src.length; i++) {
    if (probe[i]) continue;
    if (src[i] !== '/') continue;
    if (src[i + 1] === '/' || src[i + 1] === '*') continue;
    if (!looksLikeRegexStart(src, i, noStrings)) continue;

    // 扫到结尾
    let j = i + 1;
    let inClass = false;
    let closed = false;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { closed = true; j++; break; }
      j++;
    }
    if (!closed) continue;                 // 没闭合就不当正则，避免吞掉整行
    // flags
    let k = j;
    while (k < src.length && /[a-z]/i.test(src[k])) k++;
    // 标记整段（含开头的 / 与 flags）为 inString
    for (let t = i; t < k; t++) inString[t] = 1;
    i = k - 1;
  }
}

/**
 * 单趟词法扫描，产出掩码。
 *
 * 返回：
 *   inComment[i]  true —— 下标 i 的字符属于注释
 *   inString[i]   true —— 下标 i 的字符属于字符串字面量（含引号与模板串）
 *
 * 支持：// 行注释、/* 块注释、'...'、"..."、`...`（含 ${} 嵌套插值）、转义序列。
 * 之所以要手写状态机而不是正则：模板串里的 ${ } 可以嵌套任意表达式，
 * 插值内部还可能再出现字符串和注释，正则处理不了（原文也用「模板串里的花括号」埋了误报陷阱）。
 */
export function scanMasks(src) {
  const n = src.length;
  const inComment = new Uint8Array(n);
  const inString = new Uint8Array(n);

  // 第 0 趟：先标出正则字面量（整段算作 inString）。
  //
  // 为什么必须抢在注释之前做：测试代码里 `const re = /https?:\/\//;` 极常见。
  // 若先跑注释状态机，正则里的 `\/` 会被当成转义、后面的 `//` 会被当成**行注释**，
  // 于是这一行的后续代码被整行抹成空白 —— 实测 `await page.click('a')` 直接消失。
  // 后果不是报错，而是**后续规则全部静默失效**：门禁给出一份"干净"报告。
  // 这比崩溃危险得多，所以顺序在这里是正确性的一部分。
  markRegexLiterals(src, inString, inComment);

  // 状态栈：模板串插值可能层层嵌套，所以用栈而不是单个状态变量。
  // 元素形状：{ type: 'template' | 'code', braceDepth }
  const stack = [{ type: 'code', braceDepth: 0 }];
  let i = 0;

  const top = () => stack[stack.length - 1];

  while (i < n) {
    // 已经在第 0 趟被标为正则：整段跳过，状态机不介入
    if (inString[i]) { i++; continue; }

    const st = top();
    const ch = src[i];
    const next = src[i + 1];

    if (st.type === 'code') {
      // ---- 注释 ----
      if (ch === '/' && next === '/') {
        while (i < n && src[i] !== '\n') { inComment[i] = 1; i++; }
        continue;
      }
      if (ch === '/' && next === '*') {
        inComment[i] = 1; inComment[i + 1] = 1; i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { inComment[i] = 1; i++; }
        if (i < n) { inComment[i] = 1; if (i + 1 < n) inComment[i + 1] = 1; i += 2; }
        continue;
      }
      // ---- 字符串 ----
      if (ch === "'" || ch === '"') {
        const quote = ch;
        inString[i] = 1; i++;
        while (i < n) {
          if (src[i] === '\\') { inString[i] = 1; if (i + 1 < n) inString[i + 1] = 1; i += 2; continue; }
          if (src[i] === quote) { inString[i] = 1; i++; break; }
          if (src[i] === '\n') break; // 未闭合字符串，保守收尾，避免把整个文件吞掉
          inString[i] = 1; i++;
        }
        continue;
      }
      if (ch === '`') {
        inString[i] = 1; i++;
        stack.push({ type: 'template', braceDepth: 0 });
        continue;
      }
      // ---- 花括号 ----
      // 关键：如果当前 code 状态是「模板串插值的内部」（interp 为真），
      // 那么 `{` / `}` 必须配平，且配平到 0 时要把 `}` 这个定界符消费掉并**退回模板状态**。
      // 少这一步会毁掉整个文件的解析：
      //   `case ${1}` 之后回到模板状态，模板的**收尾反引号**会被当成「开启一个新模板」，
      //   于是从那里到文件末尾全被标成字符串 —— 用例一条都扫不出来（静默失明，不是报错）。
      if (ch === '{') { st.braceDepth++; i++; continue; }
      if (ch === '}') {
        if (st.interp && st.braceDepth === 0) {
          inString[i] = 1;              // 这个 `}` 是插值的定界符，属于模板串
          i++;
          stack.pop();                  // 退回模板状态
          continue;
        }
        if (st.braceDepth > 0) st.braceDepth--;
        i++; continue;
      }
      i++;
      continue;
    }

    // ---- 模板串内部 ----
    if (ch === '\\') { inString[i] = 1; if (i + 1 < n) inString[i + 1] = 1; i += 2; continue; }
    if (ch === '`') { inString[i] = 1; i++; stack.pop(); continue; }
    if (ch === '$' && next === '{') {
      // 进入插值：`${` 本身属于模板串；其内部是一个新的 code 状态。
      // 新状态必须记住 interp=true，这样它的 `}` 才会被当作定界符而不是普通花括号。
      inString[i] = 1; inString[i + 1] = 1; i += 2;
      stack.push({ type: 'code', braceDepth: 0, interp: true });
      continue;
    }
    inString[i] = 1; i++;
  }

  return { inComment, inString };
}

/** 工序 A：只去注释，保留字符串。给选择器类规则用。 */
export function maskComments(src) {
  const { inComment } = scanMasks(src);
  let out = '';
  for (let i = 0; i < src.length; i++) out += inComment[i] ? blank(src[i]) : src[i];
  return out;
}

/** 工序 B：去注释 + 去字符串。给「断言/await 存在性」类规则用。 */
export function maskCommentsAndStrings(src) {
  const { inComment, inString } = scanMasks(src);
  let out = '';
  for (let i = 0; i < src.length; i++) out += (inComment[i] || inString[i]) ? blank(src[i]) : src[i];
  return out;
}

/** 同时产出两份脱敏文本 + 掩码，避免重复扫描。 */
export function maskAll(src) {
  const { inComment, inString } = scanMasks(src);
  let noComments = '';
  let noStrings = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    noComments += inComment[i] ? blank(c) : c;
    noStrings += (inComment[i] || inString[i]) ? blank(c) : c;
  }
  return { noComments, noStrings, inComment, inString };
}

/**
 * 把文本切成行，每行带 absoluteOffset，便于「行号 → 原文偏移」回查证据。
 * 返回的行已去掉行尾 \r，line 从 1 开始。
 */
export function splitLines(text) {
  const lines = [];
  let start = 0;
  let lineNo = 1;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      let end = i;
      if (end > start && text[end - 1] === '\r') end--;
      lines.push({ line: lineNo, start, end, text: text.slice(start, end) });
      start = i + 1;
      lineNo++;
    }
  }
  return lines;
}

/**
 * 脱敏自检：证明「等长脱敏」这条不变量成立。
 * 任何一条不成立，行号与证据就会错位（缺陷 2 会复发）。
 */
export function selfCheck() {
  const cases = [
    `await page.waitForTimeout(3000); // 固定等待`,
    `test.only('a', async () => { await expect(page.getByText('x')).toBeVisible(); });`,
    `await page.locator('//div[@id="app"]/span[2]').click();`,
    `const s = \`前缀 \${ a + b } 后缀 \${ \`嵌套\` }\`;`,
    `/* 块注释 \n 跨行 */ await page.click('button');`,
    `await page.locator(\`.css-1x2y3z\`).nth(2).click();`,
    `const re = /\\/\\/not-a-comment/; await page.click('a');`,
  ];
  const problems = [];
  for (const src of cases) {
    const a = maskComments(src);
    const b = maskCommentsAndStrings(src);
    if (a.length !== src.length) problems.push(`maskComments 长度变化: ${JSON.stringify(src)}`);
    if (b.length !== src.length) problems.push(`maskCommentsAndStrings 长度变化: ${JSON.stringify(src)}`);
    // 换行位置必须逐一对应，否则行号会漂移
    for (let i = 0; i < src.length; i++) {
      if ((src[i] === '\n') !== (a[i] === '\n') || (src[i] === '\n') !== (b[i] === '\n')) {
        problems.push(`换行偏移漂移 @${i}: ${JSON.stringify(src.slice(0, 40))}`);
        break;
      }
    }
  }
  // 语义检查：脱敏后不该再看见注释里的假代码
  const tricky = `// await page.waitForTimeout(9999)\nawait page.click('a');`;
  if (maskCommentsAndStrings(tricky).includes('waitForTimeout')) {
    problems.push('注释内的假代码未被脱敏（会导致误报）');
  }
  // 语义检查：保留字符串后，选择器必须仍可见（否则选择器规则永远不命中）
  const withSel = `await page.locator('//div[@id="app"]');`;
  if (!maskComments(withSel).includes('//div[@id="app"]')) {
    problems.push('字符串被误抹，选择器类规则将永远无法命中');
  }
  return { ok: problems.length === 0, problems, checked: cases.length };
}
