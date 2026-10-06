/**
 * generate.js — 页面层 / 用例层分离的脚本生成 + 生成门禁
 *
 * 三篇文章在这一层的共识是同一件事：
 *   页面层与用例层分开存 —— 改 UI 只改页面层，业务路径不动。
 *   选择器策略锁死在运行手册里，模型越不过去（不让模型「自由写脚本」，只让它「填空」）。
 *
 * 所以本模块**不是**让模型自由产出脚本，而是把结构化的原子步骤翻译成 Playwright API：
 *   意图解析 → 场景拆解（原子步骤，每步带稳定定位描述）→ 脚本生成（只做填空）
 *
 * 生成门禁（对应「请先自行验证脚本通过，再保存到本地」这条测试规范）：
 *   生成的脚本必须先过 lint_spec（ERROR 必须为 0）才允许写盘。
 *   脚本还没跑通就提交，是这条流程里最容易踩的坑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { lintSource, parsePageObjectMethods } from './lint.js';

/* ------------------------------------------------------------------ *
 * 定位器：把「稳定定位描述」翻译成 Playwright API（只做填空，不自由发挥）
 * ------------------------------------------------------------------ */

/**
 * 支持的 kind 与对应写法（严格按定位器优先级表）：
 *   role   → getByRole(role, { name })         级别 1：用户/开发者承诺的稳定契约
 *   label  → getByLabel(text)                  级别 2
 *   testid → getByTestId(id)                   级别 3
 *   text   → getByText(text)                   级别 4：随文案改版变化
 *   placeholder → getByPlaceholder(text)
 *   selector → locator(selector)               级别 5：仅在后端下发的稳定 id 等场景使用
 * 禁用：裸 XPath、nth-child、CSS 类名 —— 这些连生成阶段都不允许出现。
 */
export function locatorExpr(loc) {
  if (!loc || typeof loc !== 'object') {
    throw new Error('定位描述缺失：每一步必须带 { kind, ... } 形式的稳定定位描述');
  }
  const { kind } = loc;
  const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  switch (kind) {
    case 'role': {
      const opts = loc.name ? `, { name: ${q(loc.name)} }` : '';
      return `page.getByRole(${q(loc.role || 'button')}${opts})`;
    }
    case 'label': return `page.getByLabel(${q(loc.text)})`;
    case 'testid': return `page.getByTestId(${q(loc.id)})`;
    case 'text': return `page.getByText(${q(loc.text)})`;
    case 'placeholder': return `page.getByPlaceholder(${q(loc.text)})`;
    case 'selector': {
      const sel = String(loc.selector || '');
      if (/^\s*\/\//.test(sel) || /nth-(child|of-type)/i.test(sel)) {
        throw new Error(`拒绝生成脆弱选择器：「${sel}」。裸 XPath 与 nth-child 在生成阶段就被禁止（对应硬规则 1）。`);
      }
      return `page.locator(${q(sel)})`;
    }
    default:
      throw new Error(`未知的定位类型：「${kind}」。可用：role / label / testid / text / placeholder / selector`);
  }
}

/**
 * 规范一个定位描述。
 *
 * 支持「同一元素给多个候选定位」：`{ byText: '订单金额', byTestId: 'order-amount' }`。
 * 这不是画蛇添足，而是从自然语言用例表演化出来的必然需求 ——
 * 用例表里写的是「校验 订单金额 等于 ¥99.00」，人能看懂，但机器只能猜是文本还是 testid。
 * 规则映射层因此同时给出两个候选，由**这里**按定位器优先级选：
 *   testid（开发者承诺的稳定契约）> label > role > placeholder > text（随文案改版变化）> selector
 * 好处是候选信息来自用例表本身（不引入额外人工步骤），而选择标准仍然统一在定位器策略里。
 */
function canonicalLocator(loc) {
  if (!loc || typeof loc !== 'object') return loc;
  if (loc.kind) return loc;                       // 已经是最终形态
  const PRIORITY = [
    ['byTestId', (v) => ({ kind: 'testid', id: v })],
    ['byLabel', (v) => ({ kind: 'label', text: v })],
    ['byRole', (v) => {
      // 必须显式给 role。若缺省成 'button'，`{ byRole: '按钮' }` 会生成
      // getByRole('button', { name: '按钮' })，而 `{ byRole: 'button' }` 会生成
      // getByRole('button') —— **命中页面上所有按钮**，正是 PW011 要拦的「定位器不唯一」。
      // 生成阶段就拒绝模糊定位，比生成完再过 lint 更早、更省事。
      if (!loc.role) {
        throw new Error(
          '定位描述用了 byRole 但没给 role（如 { byRole: "登录", role: "button" }）。'
          + '缺省成 button 会生成命中多个元素的宽泛定位器 —— 请显式写出角色。',
        );
      }
      return { kind: 'role', role: loc.role, name: v };
    }],
    ['byPlaceholder', (v) => ({ kind: 'placeholder', text: v })],
    ['byText', (v) => ({ kind: 'text', text: v })],
    ['bySelector', (v) => ({ kind: 'selector', selector: v })],
  ];
  for (const [key, build] of PRIORITY) {
    if (loc[key] !== undefined && loc[key] !== null && loc[key] !== '') return build(loc[key]);
  }
  return loc;
}

/** 把定位描述变成人类可读的名字，用于命名页面对象方法。 */
function locName(loc) {
  const l = loc && loc.kind ? loc : canonicalLocator(loc);
  if (!l) return 'element';
  switch (loc.kind) {
    case 'role': return loc.name || loc.role || 'element';
    case 'label': return loc.text;
    case 'testid': return loc.id;
    case 'text': return loc.text;
    case 'placeholder': return loc.text;
    case 'selector': return loc.selector;
    default: return 'element';
  }
}

const camel = (s) => {
  const parts = String(s || '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!parts.length) return 'item';
  const head = parts[0].replace(/^./u, (c) => c.toLowerCase());
  return head + parts.slice(1).map((p) => p.replace(/^./u, (c) => c.toUpperCase())).join('');
};

/** 类名：PascalCase + ASCII 化（理由同 asciiIdentifier）。 */
function pascal(s) {
  const c = camel(s);
  return c.replace(/^./u, (x) => x.toUpperCase());
}

/**
 * 用定位类型给方法名一个**语义前缀**。
 * 好处：名字即使因为中文而带哈希，前面仍有可读的动作信息 ——
 *   fillByLabel_1n3ur  比  fill_1n3ur  有用得多（一眼知道是「按 label 填」）。
 * 用 `label` / `role` / `testid` 这类 ASCII 定位类型做前缀，不引入不确定映射。
 */
function kindPrefix(loc) {
  if (!loc || !loc.kind) return '';
  const k = String(loc.kind);
  return k.charAt(0).toUpperCase() + k.slice(1);
}

/**
 * 变量/方法名必须合法且**有信息量**。
 *
 * 中文标识符在 JS/TS 里语法上合法（`fill账号()` 能编译），但团队规范与评审基本要求 ASCII。
 * 天真的做法（把非 ASCII 全删掉）更糟：`fill账号` 与 `fill密码` 会同时塌成 `fill`，
 * 于是页面对象里出现 `fill()` 与 `fill2()` —— 名字既不合法规范、也完全无法阅读。
 *
 * 所以这里做的是「保留 ASCII 骨架 + 对非 ASCII 部分补一个确定性短哈希」：
 *   fill账号 → fill_a1b2c3，fill密码 → fill_d4e5f6
 * 同一输入永远得到同一名字（可复现、可 diff），不同输入不会撞名。
 * 不引入拼音表：那需要一张大映射且覆盖不全，会把「确定性」这个更重要的性质弄丢。
 */
function shortHash(s) {
  let h = 2166136261 >>> 0;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).slice(0, 5);
}

function asciiIdentifier(name, fallbackIndex, fallbackWord = 'step') {
  const raw = String(name ?? '');
  // 用 _ 作为分隔符把 ASCII 段与非 ASCII 段切开，保留词边界
  const parts = raw.split(/[^\w$]+/).filter(Boolean);
  const asciiPart = parts.filter((p) => /[A-Za-z0-9$]/.test(p)).join('');
  const hasNonAscii = /[^\x00-\x7F]/.test(raw);
  let base = asciiPart.replace(/[^\w$]/g, '');
  // 名字里完全没有 ASCII 骨架时（例如「账号」），不要只留一个裸哈希（yuxvj）——
  // 那样可读性归零。用调用方给的语义词兜底，得到 fillStep_w1n3u 这种既唯一又能读的结果。
  if (hasNonAscii && !base) base = fallbackWord;
  if (hasNonAscii) base = `${base}_${shortHash(raw)}`;
  if (!base || !/^[A-Za-z_$]/.test(base)) base = `${fallbackWord}${fallbackIndex}_${shortHash(raw)}`;
  return base;
}

/**
 * 组合方法名：语义前缀（定位类型）+ 元素名 + （元素名含非 ASCII 时）确定性短哈希。
 *
 * 为什么要三者都要：
 *   - 只要定位类型（fillLabel）→ 同页两个 label 输入框会撞名成 fillLabel / fillLabel2，无法阅读；
 *   - 只要元素名（fill账号）→ 非 ASCII，不符合团队命名规范；
 *   - 三者组合 → 既语义清晰又必然唯一：
 *       fillLabel_1n3ur（账号）/ fillLabel_964c7（密码）/ fillAccount（纯 ASCII 名称则不带哈希，更干净）
 */
function methodHint(kind, name) {
  const kindAscii = asciiIdentifier(kind || '', 1, 'step');
  // 元素名没有 ASCII 骨架时，兜底词用 `Elem`（而不是定位类型）：
  // 否则会拼出 fillFillYuxvj 这种重复前缀。哈希保证唯一，前缀保证可读。
  const nameAscii = asciiIdentifier(camel(name || ''), 1, 'Elem');
  return `${kindAscii}${pascal(nameAscii)}`;
}

/** 检出「未解析的占位符」——它们被当成字面量写进脚本就会静默生成错代码。 */
const PLACEHOLDER_RES = [
  /\$\{[^}]*\}/,          // ${PW}
  /\{\{[^}]*\}\}/,        // {{password}}
  /<[A-Za-z_][\w-]*>/,    // <PASSWORD>
  /^\s*(?:TODO|TBD|FIXME|XXX)\s*$/i,
];

function assertNoPlaceholder(value, where) {
  if (value === undefined || value === null) return;
  const s = String(value);
  for (const re of PLACEHOLDER_RES) {
    if (re.test(s)) {
      throw new Error(
        `${where} 的值「${s}」看起来是未解析的占位符。`
        + '生成器不会猜你的意图：请把真实值填进来，或改用环境变量读取'
        + '（例如 process.env.PW_PASSWORD）——凭据绝不允许写死在脚本里（硬规则 3）。',
      );
    }
  }
}

/**
 * 语法门禁：用 `new Function` 让 JS 引擎亲自解析一遍。
 * 它接受 TS 类型注解以外的 ES 语法，足以挡住真正的语法错误
 * （未闭合的括号、写坏的模板串、错位的逗号）。
 * 只在生成的门禁里跑，不执行任何代码 —— new Function 只解析，不调用。
 */
export function syntaxCheck(source, label) {
  // 去掉 TS 专有语法后再交给 JS 解析器
  const body = source
    .replace(/^\s*import\s+type\s[^;]+;?$/gm, '')             // import type ...
    .replace(/^\s*import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?$/gm, '') // import {...}
    .replace(/\bexport\s+class\s+/g, 'class ')
    .replace(/\bexport\s+default\s+/g, 'const __d = ')
    .replace(/\bexport\s+/g, '')
    .replace(/:\s*(?:Promise<void>|Promise<[^>]*>|void|string|number|boolean|any|Page|Locator)(?=\s*[,)=;{])/g, '')
    .replace(/readonly\s+/g, '')
    .replace(/\bas\s+const\b/g, '');
  try {
    // eslint-disable-next-line no-new-func
    new Function(body);
    return { ok: true, label };
  } catch (e) {
    return { ok: false, label, error: e.message };
  }
}

/** 把描述性步骤规范化为生成器内部用的结构。 */
export function normalizeSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('steps 不能为空：请给出至少一个原子步骤（场景拆解的结果）');
  }
  const known = ['goto', 'fill', 'click', 'check', 'uncheck', 'select', 'press', 'hover',
    'assertText', 'assertVisible', 'assertCount', 'waitForResponse'];
  // 动作名归一：大小写与分隔符都不敏感（assert_visible / assertVisible / assertvisible 等价）。
  // 写成大小写敏感会让调用方踩无谓的坑 —— 接口不该逼人猜拼写。
  const canonical = new Map(known.map((k) => [k.toLowerCase(), k]));
  return steps.map((s, i) => {
    const raw = String(s.act || '').replace(/[_\-\s]/g, '').toLowerCase();
    const act = canonical.get(raw);
    if (!act) {
      throw new Error(`第 ${i + 1} 步的动作「${s.act}」不支持。可用：${known.join(' / ')}（大小写不敏感）`);
    }
    return { ...s, act, index: i, locator: canonicalLocator(s.locator) };
  }).map((s) => {
    // 未解析的占位符必须在生成前拦下：把它们当字面量写进脚本，会静默产出错代码 ——
    // 跑起来报的是「元素找不到」，而真正的原因是值根本没填。
    const at = `第 ${s.index + 1} 步（${s.act}）`;
    assertNoPlaceholder(s.value, `${at} 的 value`);
    assertNoPlaceholder(s.expect, `${at} 的 expect`);
    assertNoPlaceholder(s.url, `${at} 的 url`);
    return s;
  });
}

/* ------------------------------------------------------------------ *
 * 页面层生成
 * ------------------------------------------------------------------ */

const PO_HEADER = `/**
 * 本文件由 playwright-verify-mcp 的 generate_scripts 生成。
 *
 * 页面层：只放「定位与操作」，不放业务路径。
 * 改 UI 只改这一层，用例层不动 —— 这是 PO 分层唯一的收益来源。
 */
import { type Page, expect } from '@playwright/test';

`;

/** 生成页面对象的方法清单。每一项都带 `key`，供用例层精确复用（不靠位置猜）。 */
function poMethodsFor(steps) {
  const methods = [];
  const seen = new Set();
  const push = (nameHint, humanHint, body, doc, src) => {
    // 归一到 ASCII 标识符：中文标识符语法上合法（fill账号 能编译），
    // 但团队规范与代码评审基本都要求 ASCII 方法名，生成器不该产出让人别扭的代码。
    const base = asciiIdentifier(camel(nameHint), methods.length + 1);
    let n = base;
    let k = 2;
    while (seen.has(n)) n = `${base}${k++}`;
    seen.add(n);
    methods.push({ name: n, body, doc, key: stepKey(src), src });
  };

  for (const s of steps) {
    const loc = s.locator || {};
    switch (s.act) {
      case 'fill': {
        push(methodHint('fill', locName(loc)), `fill ${locName(loc)}`,
          [`await ${thisLocatorExpr(loc)}.fill(${JSON.stringify(String(s.value ?? ''))});`],
          `填入「${locName(loc)}」。`, s);
        break;
      }
      case 'click': {
        push(methodHint('open', locName(loc)), `open ${locName(loc)}`, [`await ${thisLocatorExpr(loc)}.click();`],
          `点击「${locName(loc)}」。`, s);
        break;
      }
      case 'check': {
        push(methodHint('check', locName(loc)), `check ${locName(loc)}`, [`await ${thisLocatorExpr(loc)}.check();`],
          `勾选「${locName(loc)}」。`, s);
        break;
      }
      case 'uncheck': {
        push(methodHint('uncheck', locName(loc)), `uncheck ${locName(loc)}`, [`await ${thisLocatorExpr(loc)}.uncheck();`],
          `取消勾选「${locName(loc)}」。`, s);
        break;
      }
      case 'select': {
        push(methodHint('select', locName(loc)), `select ${locName(loc)}`,
          [`await ${thisLocatorExpr(loc)}.selectOption(${JSON.stringify(String(s.value ?? ''))});`],
          `在「${locName(loc)}」中选择「${s.value}」。`, s);
        break;
      }
      case 'press': {
        push(methodHint('press', locName(loc)), `press ${locName(loc)}`,
          [`await ${thisLocatorExpr(loc)}.press(${JSON.stringify(String(s.key ?? 'Enter'))});`],
          `在「${locName(loc)}」按 ${s.key ?? 'Enter'}。`, s);
        break;
      }
      case 'hover': {
        push(methodHint('hover', locName(loc)), `hover ${locName(loc)}`, [`await ${thisLocatorExpr(loc)}.hover();`],
          `悬停「${locName(loc)}」。`, s);
        break;
      }
      case 'assertVisible': {
        push(methodHint('expectVisible', locName(loc)), `expect ${locName(loc)} visible`, [`await expect(${thisLocatorExpr(loc)}).toBeVisible();`],
          `断言「${locName(loc)}」可见。`, s);
        break;
      }
      case 'assertText': {
        push(methodHint('expectText', locName(loc)), `expect ${locName(loc)} text`,
          [`await expect(${thisLocatorExpr(loc)}).toHaveText(${JSON.stringify(String(s.expect ?? ''))});`],
          `断言「${locName(loc)}」文本等于「${s.expect}」。`, s);
        break;
      }
      case 'assertCount': {
        push(methodHint('expectCount', locName(loc)), `expect ${locName(loc)} count`,
          [`await expect(${thisLocatorExpr(loc)}).toHaveCount(${Number(s.expect) || 0});`],
          `断言「${locName(loc)}」数量为 ${s.expect}。`, s);
        break;
      }
      case 'waitForResponse': {
        push(methodHint('wait', s.urlIncludes || 'response'), `wait ${s.urlIncludes || 'response'}`,
          [`await this.page.waitForResponse((r) => r.url().includes(${JSON.stringify(String(s.urlIncludes || ''))}) && r.ok());`],
          `等待包含「${s.urlIncludes}」的响应成功返回。`, s);
        break;
      }
      default:
        break; // goto 属于导航，不放页面层
    }
  }
  return methods;
}

/** 一步的唯一键：动作 + 定位 + 取值 + 预期。用于「用例层复用页面层方法」的精确匹配。 */
function stepKey(s) {
  if (!s) return '';
  return JSON.stringify({
    act: s.act, locator: s.locator ?? null, value: s.value ?? null,
    expect: s.expect ?? null, key: s.key ?? null, urlIncludes: s.urlIncludes ?? null,
  });
}

/** 生成一个页面对象的源码。 */
export function renderPageObject({ className, steps, navPath }) {
  const methods = poMethodsFor(steps);
  const lines = [PO_HEADER];
  lines.push(`export class ${className} {`);
  lines.push('  readonly page: Page;');
  lines.push('');
  lines.push('  constructor(page: Page) {');
  lines.push('    this.page = page;');
  lines.push('  }');
  lines.push('');
  if (navPath) {
    lines.push('  /** 打开本页面（相对 baseURL，切环境不用改用例）。 */');
    lines.push('  async goto(): Promise<void> {');
    lines.push(`    await this.page.goto(${JSON.stringify(navPath)});`);
    lines.push('  }');
    lines.push('');
  }
  if (!methods.length) {
    lines.push('  /** 本页面只有导航，没有需要封装的交互。 */');
    lines.push('  async ready(): Promise<void> {');
    lines.push("    await expect(this.page.locator('body')).toBeVisible();");
    lines.push('  }');
    lines.push('');
  }
  for (const m of methods) {
    lines.push(`  /** ${m.doc} */`);
    lines.push(`  async ${m.name}(): Promise<void> {`);
    for (const b of m.body) lines.push(`    ${b}`);
    lines.push('  }');
    lines.push('');
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/**
 * 页面对象里的定位表达式统一用 `this.page.`。
 *
 * 为什么在**生成时就写对**，而不是生成完再对整份文件做 `page.` → `this.page.` 替换：
 *   那种「事后正则替换」会连**字符串字面量里的内容**一起改。
 *   实测：`fill("page.getByText('x')")` 会被改成 `fill("this.page.getByText('x')")` ——
 *   测试数据被静默篡改，断言可能永远不成立，而且看不出是生成器干的。
 *   生成器改的是代码，不是数据；数据必须原样保留。
 */
function thisLocatorExpr(loc) {
  return locatorExpr(loc).replace(/^page\./, 'this.page.');
}

/* ------------------------------------------------------------------ *
 * 用例层生成
 * ------------------------------------------------------------------ */

/**
 * 渲染用例层。
 * @param {object} o
 * @param {Array} o.pages  [{ className, file }] —— file 是相对 pages/ 的文件名（不含扩展名）
 * @param {Array} o.cases  [{ title, claims, pageVar, className, navTo, body }]
 */
export function renderSpec({ pages, cases }) {
  const lines = [];
  lines.push('/**');
  lines.push(' * 本文件由 playwright-verify-mcp 的 generate_scripts 生成。');
  lines.push(' *');
  lines.push(' * 用例层：只放业务路径与断言主张，不放定位细节。');
  lines.push(' * 改 UI 只改页面层，本文件不动 —— 这是 PO 分层的收益所在。');
  lines.push(' */');
  lines.push("import { test, expect } from '@playwright/test';");
  for (const p of pages) {
    // 不写 .ts 扩展名：TS 的模块解析默认不接受带扩展名的相对导入
    // （除非开了 allowImportingTsExtensions）。生成物要能直接跑，就别踩这个坑。
    lines.push(`import { ${p.className} } from '../pages/${p.file.replace(/\.ts$/, '')}';`);
  }
  lines.push('');
  for (const c of cases) {
    lines.push(`test(${JSON.stringify(c.title)}, async ({ page }) => {`);
    // 交付契约：必须给出「这条用例证明了什么」的一句话说明
    lines.push(`  // 本用例证明：${c.claims}`);
    lines.push(`  const ${c.pageVar} = new ${c.className}(page);`);
    if (c.navTo) lines.push(`  await ${c.pageVar}.goto();`);
    lines.push('');
    for (const stmt of c.body) lines.push(`  ${stmt}`);
    lines.push('});');
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 顶层生成 + 门禁
 * ------------------------------------------------------------------ */

/**
 * 从结构化输入生成页面层 + 用例层文件。
 *
 * @param {object} input
 * @param {Array}  input.pages   [{ name, navPath, steps:[…] }]
 * @param {Array}  input.cases   [{ title, page, claims, steps:[…] }]
 * @param {object} [opts]         { selfVerify:true, lintOptions }
 * @returns {{ files: {path, content}[], lint, verified, written }}
 */
export function generate(input, opts = {}) {
  const { pages = [], cases = [] } = input || {};
  if (!pages.length) throw new Error('pages 不能为空：至少给出一个页面及其原子步骤');
  if (!cases.length) throw new Error('cases 不能为空：至少给出一个用例路径');

  // 按「session + name」去重：session 不同则视为不同页，避免同一 session 重复 navPath 覆盖。
  // 传入重复 name 时报错（静默覆盖是 bug，不是约定）。
  const pageByName = new Map();
  const pageOutputs = [];
  for (const p of pages) {
    const className = p.className || asciiIdentifier(`${pascal(p.name)}Page`, pageOutputs.length + 1);
    const steps = normalizeSteps(p.steps || []);
    const content = renderPageObject({ className, steps, navPath: p.navPath });
    // 同名静默覆盖是 bug，不是约定 —— 直接报错
    if (pageByName.has(p.name)) throw new Error(`页面 name="${p.name}" 重复，请去重或为其中一个指定不同的 className`);
    pageByName.set(p.name, { className, steps, navPath: p.navPath });
    pageOutputs.push({ file: `${className}.ts`, path: `pages/${className}.ts`, content, className, name: p.name, steps });
  }

  const specName = String(input.spec || input.fileName || 'generated').replace(/\.spec\.ts$/, '');
  const caseBodies = [];
  for (let ci = 0; ci < cases.length; ci++) {
    const c = cases[ci];
    const entry = pageByName.get(c.page);
    if (!entry) throw new Error(`用例「${c.title}」引用了不存在的页面「${c.page}」`);
    const { className, steps: pageSteps } = entry;
    const pageVar = asciiIdentifier(`${camel(c.page)}Page`, ci + 1);
    // 页面层方法索引：按 stepKey 精确查找要复用的方法，不靠位置猜
    const methodByKey = new Map(poMethodsFor(pageSteps).map((m) => [m.key, m]));
    // navPath 存在时 renderSpec 会生成 pageVar.goto()（用 navPath），
    // caseSteps 循环中所有 goto 步骤均应跳过，避免冗余导航覆盖 navPath。
    // 判据用 entry.navPath（来源可靠），不用 methodByKey（stepKey 与 method.key 可能失配）。
    const hasNavPath = Boolean(entry.navPath);
    const caseSteps = normalizeSteps(c.steps || []);
    const body = [];
    for (const s of caseSteps) {
      const method = methodByKey.get(stepKey(s));
      if (method && s.act !== 'goto') {
        body.push(`await ${pageVar}.${method.name}();`);
        continue;
      }
      switch (s.act) {
        // goto 步骤：如果 page 有 navPath（renderSpec 已生成 pageVar.goto()），
        // 用例层不再重复生成 page.goto()，避免覆盖 navPath 或产生冗余导航。
        case 'goto':
          if (!hasNavPath) {
            body.push(`await page.goto(${JSON.stringify(s.url || '/')});`);
          }
          break;
        case 'assertText':
          body.push(`await expect(${locatorExpr(s.locator)}).toHaveText(${JSON.stringify(String(s.expect ?? ''))});`); break;
        case 'assertVisible':
          body.push(`await expect(${locatorExpr(s.locator)}).toBeVisible();`); break;
        case 'assertCount':
          body.push(`await expect(${locatorExpr(s.locator)}).toHaveCount(${Number(s.expect) || 0});`); break;
        default:
          body.push(`// TODO 本步在页面层没有对应方法：${s.act} ${JSON.stringify(s.locator || {})}`);
      }
    }
    caseBodies.push({
      title: c.title,
      claims: c.claims || '（未声明 —— 交付时必须补上「这条用例证明了什么」）',
      pageVar,
      className,
      navTo: c.nav !== false,
      body,
    });
  }

  const specContent = renderSpec({ pages: pageOutputs, cases: caseBodies });
  const files = [
    ...pageOutputs.map(({ path: p, content }) => ({ path: p, content })),
    { path: `tests/${specName}.spec.ts`, content: specContent },
  ];

  // ---- 生成门禁：生成的脚本自己必须先过 lint ----
  // 要先把**本次生成的页面对象**方法登记好，否则 PW007 会把「断言写在页面层」
  // 的合法生成物判成「用例内没有断言」而挡住写盘（这正是我们刚修掉的那类误报）。
  const poMethods = new Map();
  for (const f of files) {
    if (!/^pages\//.test(f.path)) continue;
    for (const [name, info] of parsePageObjectMethods(f.content)) {
      if (!poMethods.has(name) || info.hasAssertion) poMethods.set(name, info);
    }
  }

  const lintRuns = files.map((f) => ({
    file: f.path,
    result: lintSource(f.content, f.path, { poMethods }),
  }));
  const errorCount = lintRuns.reduce((s, r) => s + r.result.findings.filter((x) => x.severity === 'ERROR').length, 0);
  const warnCount = lintRuns.reduce((s, r) => s + r.result.findings.filter((x) => x.severity === 'WARN').length, 0);

  // ---- 语法门禁：生成物必须是合法语法 ----
  // lint 是正则层面的检查，它不会发现「括号没闭合」这类问题；
  // 让引擎亲自解析一遍，才能保证写盘的确实是能跑的代码。
  const syntax = files.map((f) => syntaxCheck(f.content, f.path));
  const syntaxErrors = syntax.filter((s) => !s.ok);
  const selfVerify = opts.selfVerify !== false;

  return {
    tool: 'generate_scripts',
    version: 1,
    files,
    claims: caseBodies.map((c) => ({ title: c.title, claims: c.claims })),
    syntax: { passed: syntaxErrors.length === 0, results: syntax },
    lint: {
      errorCount,
      warnCount,
      // 门禁语义：生成的脚本若自带 ERROR 或语法错误，不允许写盘 ——
      // 「脚本还没跑通就提交」是这条流程里最容易踩的坑。
      passed: errorCount === 0 && syntaxErrors.length === 0,
      files: lintRuns.map((r) => ({
        file: r.file,
        errorCount: r.result.findings.filter((x) => x.severity === 'ERROR').length,
        warnCount: r.result.findings.filter((x) => x.severity === 'WARN').length,
        findings: r.result.findings,
      })),
    },
    selfVerify,
    verified: selfVerify && errorCount === 0 && syntaxErrors.length === 0,
    verdict: (errorCount === 0 && syntaxErrors.length === 0)
      ? '生成物通过静态门禁（语法 OK / ERROR 0），可以写入仓库'
      : `生成物未通过门禁（语法错误 ${syntaxErrors.length} / ERROR ${errorCount}），已阻止写盘`,
  };
}

/**
 * 把生成结果写盘（只有通过门禁才允许落盘）。
 *
 * @param {object} result generate() 的产物
 * @param {string} outDir 目标目录
 * @param {object} [opts] { overwrite = false }
 *
 * 为什么默认**不覆盖**已有文件：
 *   生成的页面对象很可能落到人手写过、带注释的文件路径上。
 *   静默覆盖会直接抹掉人的工作，而返回值只说「已写盘 N 个文件」——看不出毁了什么。
 *   所以默认拒绝并逐个列出冲突文件，由调用方显式选择 overwrite: true。
 */
export function writeGenerated(result, outDir, opts = {}) {
  const overwrite = opts.overwrite === true;
  if (!result.lint.passed) {
    return {
      written: false,
      reason: 'LINT_GATE_BLOCKED',
      message: `生成物有 ${result.lint.errorCount} 个 ERROR，按门禁不写盘。请先修复规则表里列出的问题。`,
      findings: result.lint.files.flatMap((f) => f.findings),
    };
  }

  // 先整体检查冲突再写 —— 避免「写了一半才发现冲突」，留下半成品目录
  const conflicts = [];
  for (const f of result.files) {
    const abs = path.join(outDir, f.path);
    if (!fs.existsSync(abs)) continue;
    const existing = fs.readFileSync(abs, 'utf8');
    if (existing !== f.content) {
      conflicts.push({ path: f.path, abs, bytes: Buffer.byteLength(existing, 'utf8') });
    }
  }
  if (conflicts.length && !overwrite) {
    return {
      written: false,
      reason: 'EXISTS',
      message: `目标目录已有 ${conflicts.length} 个同名文件，默认不覆盖（避免抹掉手写内容）。`
        + '确认要覆盖请传 overwrite: true；或换一个 outDir。',
      conflicts: conflicts.map((c) => c.path),
      conflictDetails: conflicts,
    };
  }

  const written = [];
  for (const f of result.files) {
    const abs = path.join(outDir, f.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, 'utf8');
    written.push(abs);
  }
  return {
    written: true,
    files: written,
    overwritten: conflicts.length ? conflicts.map((c) => c.path) : [],
  };
}

export default { generate, writeGenerated, locatorExpr, normalizeSteps, renderPageObject, renderSpec };
