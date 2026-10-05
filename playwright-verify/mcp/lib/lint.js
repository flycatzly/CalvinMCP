/**
 * lint_spec.js — Playwright 用例静态扫描
 *
 * 设计要点（每一条都对应原文的一个教训）：
 *  1. 「先脱敏再切块，且脱敏必须等长」—— 检测在脱敏文本上跑，证据回原文取，行号列号天然对齐。
 *  2. 「选择器类规则要在保留字符串的那份文本上跑」—— 见 PW003/PW004/PW011。
 *  3. 「容器与用例分开处理」—— describe / test.step 不参与断言检查，只单独拦 .only。
 *  4. 「宁漏不误报」—— 门禁的公信力是它唯一的资产；宁可少报，不可冤枉。
 *  5. ERROR 必须以退出码 1 结束，只有这样才能挂进 CI。WARN 是提示人工确认，不是凑数。
 *
 * 规则编号：PW001–PW014 为原文规则的完整还原；PW101+ 为补充规则（明确标注，默认参与但可关）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { maskAll, splitLines } from './tokenizer.js';
import { findTestBlocks, matchParen } from './testblocks.js';

/* ------------------------------------------------------------------ *
 * 规则表
 * ------------------------------------------------------------------ */

/** 上下文里能查到的、真正属于 Playwright 的断言方法名。 */
const PW_ASSERTIONS = [
  'toBeVisible', 'toBeHidden', 'toBeEnabled', 'toBeDisabled', 'toBeEditable', 'toBeEmpty',
  'toBeChecked', 'toBeFocused', 'toBeInViewport', 'toBeAttached', 'toBeTruthy', 'toBeFalsy',
  'toBe', 'toEqual', 'toBeLessThan', 'toBeLessThanOrEqual', 'toBeGreaterThan', 'toBeGreaterThanOrEqual',
  'toBeNaN', 'toBeNull', 'toBeUndefined', 'toBeDefined', 'toBeInstanceOf', 'toContain',
  'toContainEqual', 'toHaveLength', 'toHaveProperty', 'toHaveText', 'toContainText',
  'toHaveValue', 'toHaveValues', 'toHaveAttribute', 'toHaveClass', 'toHaveCSS', 'toHaveCount',
  'toHaveId', 'toHaveJSProperty', 'toHaveScreenshot', 'toHaveTitle', 'toHaveURL', 'toMatch',
  'toMatchSnapshot', 'toMatchAriaSnapshot', 'toPass', 'toThrow', 'toThrowError', 'toSatisfy',
  'toStrictEqual', 'toMatchObject',
];
const ASSERTION_ALT = PW_ASSERTIONS.join('|');

/**
 * 「这次断言是不是异步的」判据。
 *
 * Playwright 的断言只在**参数是异步来源**时才是 Promise：
 *     await expect(page.getByText('x')).toBeVisible();   // 异步，不 await 就假通过
 *     expect(amount).toBe('¥99.00');                     // 同步，不 await 正确
 *     expect(pathRe.test(p)).toBe(true);                 // 同步，不 await 正确
 *
 * 如果不区分这两种，PW006 会把所有正常的同步值断言都判成 ERROR —— 这就是
 * 「一次冤枉就够把门禁废掉」。所以 PW006 只在这个正则命中参数时才成立。
 */
const ASYNC_SOURCE_RE = new RegExp(
  '(?:^|[^\\w.$])(?:page|frame|frameLocator|context)\\s*\\.\\s*\\w+'
  + '|\\.\\s*(?:locator|getBy\\w+|filter|and|or|first|last|nth|visible|waitFor\\w*|evaluate|innerText|inputValue)\\s*\\(',
);

/**
 * 规则定义。
 *   scope: 'line'   逐行（在 noComments 或 noStrings 文本上）
 *   scope: 'file'   文件级一次性检查
 *   scope: 'block'  需要用例块信息
 */
export const RULES = [
  /* ---------- ERROR：阻断，退出码 1 ---------- */
  {
    id: 'PW001', severity: 'ERROR', scope: 'line', text: 'noStrings', tier: 'core',
    title: '固定时长等待',
    // ⚠ 这条规则曾经**静默失效**。旧写法是：
    //     /(?:^|[^\w.])waitForTimeout\s*\(/
    //   字符类 [^\w.] 明确排除了点号，于是 `await page.waitForTimeout(3000)`
    //   根本匹配不上（`page` 的 `e` 是 \w，`.` 又被排除，前缀无处可落）——
    //   而它恰恰是真实代码里最常见、最该被拦下的形态。
    //
    //   为什么长期没被发现：messy 样例集的 ERROR **总数**被其它规则填满了，
    //   计数看起来"正常"。这类「规则已经死了、报告却正常」的问题，只断言总数抓不到 ——
    //   所以 lint-check 现在同时按**规则 id** 断言命中（见 expectIds）。
    //
    // 现写法：`\bwaitForTimeout(` —— 词边界后紧跟调用括号。
    //   覆盖：page.waitForTimeout( / this.page.waitForTimeout( / locator.waitForTimeout( / 裸 waitForTimeout(
    //   挡住：myWaitForTimeout( / antiwaitForTimeout(（\b 不成立，因为前面是 \w）
    //   为什么不写成「点号形态 + (?<![\w$])」：那样反而全挂 ——
    //   真实调用里点号前面**永远是**标识符字符（page. / this.page.），
    //   在点号上加「前面不能是 \w」的断言，等于把所有真实调用排除掉（实测 A 分支 false）。
    //   这条弯路值得留在注释里：否定断言加在错误的位置，会让规则「看起来更严格、实际全失效」。
    re: /\bwaitForTimeout\s*\(|(?:^|[^\w.$])(?:sleep|delay|pause)\s*\(\s*\d/,
    fix: '等状态变化（toBeVisible/toHaveURL）、等网络条件（waitForResponse）、或等轮询条件（expect.poll）。'
      + '固定等待不是「慢」，它把问题藏起来：环境越快白等越久，环境越慢照样失败，失败现场永远只说「超时」，不说在等哪个条件。',
  },
  {
    id: 'PW002', severity: 'ERROR', scope: 'file', text: 'noStrings', tier: 'core',
    title: '.only 泄漏',
    // 三条形态都要认：test.only( / test.describe(.serial)*.only( / describe(.serial)*.only(
    // 对抗洞（钉住）：test.describe.only( 里 describe 前面是「.」，被 [^\w$.] 前缀类挡住，
    // 两条旧分支一条都匹配不上 —— 最常见的 describe 形态 .only 反而漏报。
    // 第三分支把 test. 前缀设为可选、允许 describe 与 only 之间夹链式修饰（.serial/.parallel）；
    // 前缀类仍排除 \w 与 .，所以 mytest.only( / x.test.only( 依旧不冤枉。
    re: /(?:^|[^\w$.])test\s*\.\s*only\s*\(|(?:^|[^\w$.])(?:test\s*\.\s*)?describe(?:\s*\.\s*\w+)*\s*\.\s*only\s*\(/,
    fix: '提交前删掉 .only，并在 playwright.config 里设 forbidOnly: !!process.env.CI 做双保险。'
      + '注意：本规则的坑在于「用来拦 .only 的规则会被 .only 自己骗过去」——块起始正则必须写成 test(?:\\s*\\.\\s*\\w+)?\\s*\\( 才扫得到 test.only( 的用例体。',
  },
  {
    id: 'PW003', severity: 'ERROR', scope: 'line', text: 'noComments', tier: 'core',
    title: '绝对 XPath 定位',
    re: /locator\s*\(\s*['"`]\s*(?:xpath\s*=\s*)?\s*(?:\/\/|\(?\/\/)/i,
    fix: '改用语义定位器：getByRole > getByLabel > getByTestId > getByText。'
      + '绝对 XPath 描述的是实现，前端结构一动就全废。'
      + '（本规则依赖「保留字符串」的脱敏文本 —— 选择器就写在字符串里，字符串被抹掉则本规则永远不可能命中。）',
  },
  {
    id: 'PW004', severity: 'ERROR', scope: 'line', text: 'noComments', tier: 'core',
    title: 'nth-child / nth-of-type 结构定位',
    re: /nth-(?:child|of-type)\s*\(/i,
    fix: '改用 getByRole / getByTestId。按第几个子元素定位，等于把页面 DOM 结构焊死在用例里。',
  },
  {
    id: 'PW005', severity: 'ERROR', scope: 'line', text: 'noStrings', tier: 'core',
    title: 'force: true 绕过可操作性检查',
    re: /force\s*:\s*true/,
    fix: 'force 会跳过可见性/稳定性等待，把「元素不可点」这个真问题掩盖成一次侥幸成功。'
      + '先查为什么不可点：被遮挡就等遮挡物消失，动画未完成就等状态稳定。',
  },
  {
    id: 'PW006', severity: 'ERROR', scope: 'stmt', text: 'noStrings', tier: 'core',
    title: 'Playwright 断言没有 await（假通过）',
    // 匹配允许跨行（[^;] 含换行、禁跨语句），上限 5000 字符防病态回溯：
    // prettier 把长断言折行后，行级正则连匹配都匹配不上 —— 规则会静默失明。
    re: new RegExp(`(?:^|[^\\w.])expect\\s*\\([^;]{0,5000}?\\)\\s*\\.\\s*(?:${ASSERTION_ALT})\\s*\\(`),
    requireAsyncSource: true,
    fix: 'Playwright 断言是异步的，不 await 就不会被计入失败，用例会「永远通过」——'
      + '这是最危险的写法，因为它在报告里长得和成功一模一样。'
      + '（判据限定一：只有断言参数是 page/locator/getBy* 这类异步来源时才判 ERROR ——'
      + 'expect(amount).toBe() 这种同步值断言不 await 是正确的，不该冤枉。'
      + '判据限定二：await 判定在语句级 —— await page.goto(...); expect(...).toBeVisible(); 里'
      + '那个 await 属于 goto，断言本身仍然漏 await；而 const p = expect(...).toBeVisible(); await p; '
      + '这种把 promise 接走再等的写法不算漏。）',
  },
  {
    id: 'PW007', severity: 'ERROR', scope: 'block', tier: 'core',
    title: '用例内没有任何 expect 断言',
    fix: '一条没有断言的用例只证明「页面没崩」，不证明任何业务事实。'
      + '要么补断言，要么把它降级成 setup。'
      + '（容器块 describe / test.step 已排除，否则会误报 —— 容器当然没有断言，它只是分组。）',
  },
  {
    id: 'PW008', severity: 'ERROR', scope: 'line', text: 'noStrings', tier: 'core',
    title: '把 Playwright 断言降级成 JS 判断',
    // 接收者允许带调用后缀（一层括号嵌套）与链式成员：
    //   !await page.locator('#x').isVisible()   ← 旧式只认「名字.谓词」，中间的 ('#x') 一出现就漏报
    //   !(await page.locator('#x').isVisible()) ← 括号形态同样漏
    // 简单形态 !await panel.isVisible() 由同一正则覆盖；谓词名后必须紧跟 (，isVisibleHelper( 不冤枉。
    re: /!\s*\(?\s*await\s+[\w.$]+(?:\s*\((?:[^()]|\([^()]*\))*\))?(?:\s*\.\s*[\w.$]+(?:\s*\((?:[^()]|\([^()]*\))*\))?)*\s*\.\s*(?:isVisible|isHidden|isEnabled|isDisabled|isChecked|isEditable)\s*\(/,
    fix: 'isVisible() 返回真假值，写成 if (!await x.isVisible()) 会静默通过而不产生失败证据。'
      + '改用 expect(x).toBeVisible()，让它自动重试并输出可归因的失败。',
  },

  /* ---------- WARN：人工确认 ---------- */
  {
    id: 'PW009', severity: 'WARN', scope: 'line', text: 'noStrings', tier: 'core',
    title: '只用 toHaveCount 判存在',
    re: /\.\s*toHaveCount\s*\(/,
    fix: 'toHaveCount 只数数量，不校验内容与可见性。若真意是「这条记录出现在列表里」，'
      + '应断言其文本或可见性；数量断言容易在数据变化时变成脆弱用例。',
  },
  {
    id: 'PW010', severity: 'WARN', scope: 'line', text: 'noComments', tier: 'core',
    title: 'CSS 类名或结构选择器',
    re: /locator\s*\(\s*['"`][^'"`]*\.[A-Za-z_-][\w-]*|locator\s*\(\s*['"`][^'"`]*\s*>\s*[A-Za-z]/,
    fix: '类名与 > 结构由样式/布局决定，改版即失效。改用 getByRole / getByLabel / getByTestId。',
  },
  {
    id: 'PW011', severity: 'WARN', scope: 'line', text: 'noComments', tier: 'core',
    title: '使用 .first()/.last()/.nth() 位置收敛',
    re: /\.\s*(?:first|last|nth)\s*\(\s*(?:\)|\d)/,
    fix: '位置收敛说明定位器本身不唯一 —— 根因是定位器缺陷，不是「多匹配就取第一个」能解决的。'
      + '优先把定位器收紧到唯一命中；确需收敛时，注释写明为什么这里的顺序稳定。',
  },
  {
    id: 'PW012', severity: 'WARN', scope: 'line', text: 'noComments', tier: 'core',
    title: 'networkidle 等待',
    re: /(['"`])networkidle\1/,
    fix: 'networkidle 在长轮询、心跳、埋点上报的页面上永远等不到，且已被官方标记为不推荐。'
      + '改为等具体的网络响应（waitForResponse）或等页面上可观测的状态。',
  },
  {
    id: 'PW013', severity: 'WARN', scope: 'line', text: 'noStrings', tier: 'core',
    title: '超时放宽到 100 秒以上',
    // 两种放宽形态：选项写法（timeout: / timeout=）与调用写法（test.setTimeout( / setDefaultTimeout(）。
    // 对抗洞（钉住）：test.setTimeout(300_000) 只有调用形态，旧正则要求 [:]= 直接漏报。
    // 调用分支带 (?<![A-Za-z]) 的等价写法（前缀类排除 \w）：resetTimeout( 里的 set 段不许起匹配，
    // clearTimeout( 也不许 —— 那是清定时器，不是放宽超时。阈值仍由 timeoutOver100s 求值把关。
    re: /(?:timeout|Timeout)\s*[:=]\s*\d[\d_]*(?:\s*\*\s*\d[\d_]*)*|(?:^|[^\w])set(?:Default)?[Tt]imeout\s*\(\s*\d[\d_]*(?:\s*\*\s*\d[\d_]*)*/,
    custom: 'timeoutOver100s',
    fix: '放宽超时不是修复，是把「功能坏了」拖延成「跑得很慢」。超长超时会让所有失败都以「超时」的形式出现，'
      + '你再也分不清是页面慢了还是功能坏了。先定位真正的等待条件。'
      + '（判据是「算出来的毫秒值 > 100000」，不是「看起来数字很长」——'
      + '正则数位数会把合法的 15_000 从 `_000` 处截出匹配而误报，这里改为求值。）',
  },
  {
    id: 'PW014', severity: 'WARN', scope: 'line', text: 'noComments', tier: 'core',
    title: ':visible 旧写法',
    re: /['"`][^'"`]*:visible/,
    fix: 'Playwright 1.63 起用 locator.visible() 取代 :visible 伪类。旧写法在新版本上行为不一致。',
  },

  /* ---------- 补充规则（原文之外，对齐两篇文章的硬约束） ---------- */
  {
    id: 'PW101', severity: 'ERROR', scope: 'line', text: 'noComments', tier: 'ext',
    title: '疑似凭据写死在用例里',
    re: /(?:password|passwd|pwd|secret|token|apiKey|api_key|accessKey)\s*[:=]\s*['"`][^'"`]{3,}['"`]/i,
    fix: '账号密码只允许从环境变量 / 密钥管理读取，绝不写死在用例或 Skill 里。'
      + '写死的凭据会进 git 历史，也会在环境切换时静默失效。',
  },
  {
    id: 'PW102', severity: 'ERROR', scope: 'line', text: 'noStrings', tier: 'ext',
    title: 'commit 前遗留的调试代码',
    re: /(?:^|[^\w.])debugger\s*;|(?:^|[^\w.])page\s*\.\s*pause\s*\(/,
    fix: 'page.pause() 与 debugger 会让 CI 挂住直到超时。提交前删除。',
  },
  {
    id: 'PW103', severity: 'WARN', scope: 'line', text: 'noStrings', tier: 'ext',
    title: '静默的 test.skip / test.fixme',
    re: /(?:^|[^\w$.])test\s*\.\s*(?:skip|fixme)\s*\(/,
    // 只对**静默**的跳过报警：带理由 + 单号的跳过是规范允许的（也正是文档教人写的写法）。
    // 少了这道判据，PW103 会把「按规范写的跳过」也报出来 —— 这种误报会让人开始无视这条规则。
    custom: 'silentSkipOnly',
    customNeedsCall: true,
    fix: '被跳过的用例不会失败，但也不再提供任何保护 —— 它会静默积累。'
      + '跳过必须带理由和跟踪单号（如 test.fixme(true, "ISSUE-123 等待接口修复")）。',
  },
  {
    id: 'PW104', severity: 'WARN', scope: 'line', text: 'noStrings', tier: 'ext',
    title: 'test.slow() 放宽超时',
    re: /\.\s*slow\s*\(\s*\)/,
    fix: 'test.slow() 把超时乘三。若只是掩盖慢，它和放宽超时同罪；'
      + '确属正常长流程时，注释写明预期耗时与上限。',
  },
  {
    id: 'PW106', severity: 'WARN', scope: 'line', text: 'noStrings', tier: 'ext',
    title: '空等待：waitForLoadState/waitForSelector 无参',
    // 正则只圈出「调用」，「空参」交给 custom 判 —— 且必须看保留字符串的那份文本：
    // 在去字符串文本上 waitForSelector('.x') 的实参被抹成空格，看起来就是 waitForSelector()，
    // 只看正则会把所有带参等待误报成空等待（对抗样例 PW106-有参不冤枉 钉住这个洞）。
    re: /waitFor(?:LoadState|Selector|Function)\s*\(/,
    custom: 'emptyArgsOnly',
    customNeedsCall: true,
    fix: '无参调用只等默认条件，往往不是你要等的那个条件。显式写出等待目标，失败归因才有依据。',
  },
  {
    id: 'PW107', severity: 'WARN', scope: 'line', text: 'noComments', tier: 'ext',
    title: '用例内直接访问生产域名',
    re: /goto\s*\(\s*['"`]https?:\/\/(?:[^'"`]*\.)?(?:prod|production)\b|goto\s*\(\s*['"`]https?:\/\/www\./i,
    fix: '默认只允许在 test / staging 环境跑，生产验证必须走独立审批。'
      + '把 baseURL 交给 config 与 env 映射，用例里不出现生产域名。',
  },
];

/* ------------------------------------------------------------------ *
 * 属性化对抗语料（v1.8.13）：每条规则自带 bad（必须命中自己）与 good（不许命中自己）。
 *
 * 为什么按规则属性组织、而不是继续手写一份远处的清单：
 *   手写清单只会给「曾经咬过人的规则」配语料（实测只有 6/20 条规则有专属边界回归），
 *   新规则落地时没人记得补 —— 而「改一次正则悄悄放宽/收紧、总数看起来正常」恰恰
 *   是 PW001 的教训。语料跟着规则走 + rules-check 覆盖门（每条规则必须带 bad/good），
 *   新规则不带语料就进不了表。
 *
 * raw: true 的样例按完整文件处理（PW007 这类块级规则不能包进标准用例体——
 * 包装器自带的 expect 会把「无断言」这个判据本身掩盖掉）。
 * ------------------------------------------------------------------ */
const RULE_SAMPLES = {
  PW001: {
    bad: `await page.waitForTimeout(3_000);`,
    good: `await expect(page.getByTestId('row')).toBeVisible();`,
  },
  PW002: {
    bad: `test.only('冒烟', () => {});`,
    good: `test('冒烟', () => {});`,
  },
  PW003: {
    bad: `await page.locator('//ul[@id="list"]/li[2]').click();`,
    good: `await page.getByRole('listitem').click();`,
  },
  PW004: {
    bad: `await page.locator('li:nth-child(2)').click();`,
    good: `await page.getByRole('listitem').click();`,
  },
  PW005: {
    bad: `await page.locator('#save').click({ force: true });`,
    good: `await page.locator('#save').click();`,
  },
  PW006: {
    bad: `expect(page.getByTestId('total')).toBeVisible();`,
    good: `await expect(page.getByTestId('total')).toBeVisible();`,
  },
  PW007: {
    raw: true,
    bad: `test('无断言', async ({ page }) => {\n  await page.goto('/home');\n});`,
    good: `test('有断言', async ({ page }) => {\n  await page.goto('/home');\n  await expect(page.getByTestId('h1')).toBeVisible();\n});`,
  },
  PW008: {
    bad: `if (!await page.getByLabel('同意').isChecked()) {\n  throw new Error('未同意');\n}`,
    good: `await expect(page.getByLabel('同意')).toBeChecked();`,
  },
  PW009: {
    bad: `await expect(page.getByTestId('rows')).toHaveCount(3);`,
    good: `await expect(page.getByTestId('rows')).toBeVisible();`,
  },
  PW010: {
    bad: `await page.locator('.btn-primary').click();`,
    good: `await page.getByTestId('submit').click();`,
  },
  PW011: {
    bad: `await page.getByRole('option').first().click();`,
    good: `await page.getByRole('option', { name: '标准' }).click();`,
  },
  PW012: {
    bad: `await page.waitForLoadState('networkidle');`,
    good: `await page.waitForLoadState('domcontentloaded');`,
  },
  PW013: {
    bad: `test.setTimeout(150_000);`,
    good: `test.setTimeout(30_000);`,
  },
  PW014: {
    bad: `await page.locator('button:visible').click();`,
    good: `await page.getByRole('button').click();`,
  },
  PW101: {
    bad: `const password = 'Sup3rSecret!';`,
    good: `const password = process.env.E2E_PASSWORD;`,
  },
  PW102: {
    bad: `debugger;`,
    good: `await page.getByTestId('next').click();`,
  },
  PW103: {
    bad: `test.skip('支付回调', () => {});`,
    good: `test.skip(process.env.CI, 'ISSUE-123 仅 CI 环境跳过');`,
  },
  PW104: {
    bad: `test.slow();`,
    good: `await page.getByTestId('next').click();`,
  },
  PW106: {
    bad: `await page.waitForLoadState();`,
    good: `await page.waitForLoadState('domcontentloaded');`,
  },
  PW107: {
    bad: `await page.goto('https://www.example.com/account');`,
    good: `await page.goto('/account');`,
  },
};

// 属性附加：语料挂在规则对象上（r.samples），展开与覆盖门都从规则表走 —— 单一源。
for (const r of RULES) {
  const s = RULE_SAMPLES[r.id];
  if (s) r.samples = s;
}

/**
 * 展开属性化语料：每条规则出 bad（expectIds=[自己]）与 good（forbidIds=[自己]）两案。
 * 覆盖门在 rules-check（每条规则必须带 samples）—— 这里只负责如实展开。
 */
export function adversarialCorpus(rules = RULES) {
  const out = [];
  for (const r of rules) {
    const s = r.samples;
    if (!s) continue;
    if (s.bad) out.push({ id: r.id, kind: 'bad', name: `${r.id} bad：${r.title}`, src: s.bad, expectIds: [r.id], raw: !!s.raw });
    if (s.good) out.push({ id: r.id, kind: 'good', name: `${r.id} good：正常写法不冤枉`, src: s.good, forbidIds: [r.id], raw: !!s.raw });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 页面对象（PO）方法解析 —— 用来消掉 PW007 的一类误报
 * ------------------------------------------------------------------ */

/**
 * 为什么要做这件事：
 *   原文的 PW007 是「用例内没有任何 expect 断言」。这在**断言写在本用例里**的形态下正确，
 *   但一旦团队采用页面对象分层（页面层放操作与断言、用例层只写业务路径），
 *   断言就落在页面层方法里，用例体里一个 expect 都没有 ——
 *   此时 PW007 会冤枉**每一条**用例。而「一次冤枉就够把门禁废掉」。
 *
 * 处理方式：把「调用了页面对象方法，且那个方法里有断言」识别出来，降级为 WARN 交人确认，
 * 而不是 ERROR 阻断。仍然保留 WARN，是因为这条链路是跨文件的推断，
 * 人扫一眼比正则更可靠 —— 宁漏不误报，但也不要悄悄放过。
 *
 * 什么样的文件算页面对象：类声明 + 构造函数接收 page。这是个保守判据，
 * 只用来减少误报，不参与任何阻断决策。
 */
export function parsePageObjectMethods(src, mask) {
  const m = mask || maskAll(src);
  const methods = new Map(); // methodName -> { hasAssertion, hasOnlyComments }
  if (!/class\s+\w+\s*\{/.test(m.noComments)) return methods;
  if (!/constructor\s*\([^)]*\bpage\b/.test(m.noComments)) return methods;

  const text = m.noComments;
  const lines = splitLines(text);
  // 方法声明：可选的 async / 修饰符 + 方法名 + ( 参数 ) + { 或 : 类型 {
  const re = /(?:^|[\s;}])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{;]*)?\{/gm;
  let mm;
  while ((mm = re.exec(text)) !== null) {
    const name = mm[1];
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor', 'function'].includes(name)) continue;
    const braceIdx = mm.index + mm[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = braceIdx; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    const body = text.slice(braceIdx, end + 1);
    const line = text.slice(0, mm.index).split('\n').length;
    methods.set(name, {
      hasAssertion: /(?:^|[^\w.$])expect\s*(?:\.\s*\w+)?\s*\(/.test(body),
      line,
      length: body.length,
      lines: lines.slice(line - 1, line - 1 + 12).map((l) => l.text),
    });
  }
  return methods;
}

/** 用页面对象的断言信息判断某个用例体是否「间接有断言」。 */
function resolveIndirectAssertion(bodyNoComments, poMethods) {
  if (!poMethods || poMethods.size === 0) return null;
  // 找出用例体里调用的所有方法名（foo( / this.foo( / bar.foo(）
  const called = new Set();
  const re = /(?:^|[^\w$])(?:this\.|\w+\.)?([A-Za-z_$][\w$]*)\s*\(/g;
  let mm;
  while ((mm = re.exec(bodyNoComments)) !== null) called.add(mm[1]);
  const hits = [];
  for (const name of called) {
    const info = poMethods.get(name);
    if (info && info.hasAssertion) hits.push(name);
  }
  return hits.length ? hits : null;
}



/* ------------------------------------------------------------------ *
 * 文件收集
 * ------------------------------------------------------------------ */

const DEFAULT_INCLUDE = ['.spec.ts', '.spec.js', '.spec.mts', '.spec.mjs', '.spec.tsx', '.spec.jsx',
  '.test.ts', '.test.js', '.test.mts', '.test.mjs', '.test.tsx', '.test.jsx'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'playwright-report',
  'test-results', '.cache', 'coverage', 'out']);

export function collectFiles(target, opts = {}) {
  const include = opts.include || DEFAULT_INCLUDE;
  const exclude = (opts.exclude || []).map((s) => s.replace(/\\/g, '/'));
  const found = [];
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) {
      const base = path.basename(p);
      if (SKIP_DIRS.has(base)) return;
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
      return;
    }
    const norm = p.replace(/\\/g, '/');
    if (!include.some((s) => norm.endsWith(s))) return;
    if (exclude.some((e) => norm.includes(e))) return;
    found.push(p);
  };
  walk(target);
  return found.sort();
}

/* ------------------------------------------------------------------ *
 * 单项检查实现
 * ------------------------------------------------------------------ */

function evidenceSlice(srcLines, lineNo) {
  const l = srcLines[lineNo - 1];
  return l ? l.text : '';
}

/**
 * 把 `timeout: 15_000` / `timeout: 300 * 1000` 这类字面量**求值**成毫秒数。
 * 只认数字、下划线分隔符和 `*`，绝不用 eval —— 这是静态扫描器，不能执行被测代码。
 * 返回 null 表示算不出来（变量、表达式），此时不能判定，宁漏不误报。
 */
export function evalTimeoutLiteral(expr) {
  const parts = String(expr).split('*').map((s) => s.trim());
  let value = 1;
  for (const p of parts) {
    const digits = p.replace(/_/g, '');
    if (!/^\d+$/.test(digits)) return null;
    value *= Number(digits);
    if (!Number.isFinite(value)) return null;
  }
  return value;
}

/** 自定义判据注册表：正则只负责定位，真正的判定逻辑写在这里，便于单测。 */
const CUSTOM_CHECKS = {
  /** PW013：算出来的超时值 > 100 秒才报。 */
  timeoutOver100s(line, mm) {
    const tail = mm[0].slice(mm[0].search(/\d/));
    const ms = evalTimeoutLiteral(tail);
    return ms !== null && ms > 100_000;
  },

  /**
   * PW103：只报**静默**的跳过。
   *
   * 「静默」= 调用里没有说明性字符串。判据必须看**保留字符串**的原文，
   * 因为理由就写在字符串里 —— 与选择器类规则必须看字符串是同一个道理。
   *
   * 判据按 Playwright 的调用形态分两种：
   *   test.skip(true, '理由')      → 第二个实参是理由（第一个是条件/用例名）
   *   test.skip('用例名', fn)      → 名字不是理由，报
   *   test.skip(process.env.CI)    → 条件式跳过，不是"缺理由"，不报
   *   test.fixme('理由')           → 第一个实参是理由
   *
   * 一句话：**看理由所在的位置有没有真实字符串**，而不是「调用里有没有字符串」。
   * 用后者会把 `test.skip(process.env.CI === 'true')` 里的 `'true'` 当成理由而漏报。
   */
  silentSkipOnly(callText) {
    const m = /(?:^|[\w$.])test\s*\.\s*(skip|fixme)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(callText.trim());
    if (!m) return true;                      // 形态认不出，按静默处理（宁可提示人看一眼）
    const args = splitTopLevelArgs(m[2]);
    if (!args.length) return true;            // test.skip() 裸调用
    const isReason = (s) => {
      const q = s.trim().match(/^(['"`])([\s\S]*)\1$/);
      return !!q && q[2].trim().length >= 4;
    };
    // 第一实参是 true/false 或非字符串 → 理由应在第二实参
    const first = args[0].trim();
    if (first === 'true' || first === 'false' || !/^['"`]/.test(first)) {
      // 条件式跳过（第一实参是表达式而非布尔字面量）时，不存在"第二实参是理由"这回事
      if (args.length === 1) return true;
      return !isReason(args[1] || '');
    }
    // 第一实参是字符串：它是用例名，不是理由
    return true;
  },

  /**
   * PW106 的「空参」判据：callText 来自「保留字符串」的文本（customNeedsCall），
   * 所以 waitForSelector('.x') 的实参在这里是可见的 —— 有参就不算空等待。
   * 反过来，注释里的 waitForSelector() 在正则那一层已被抹掉，根本走不到这里。
   */
  emptyArgsOnly(callText) {
    return /waitFor(?:LoadState|Selector|Function)\s*\(\s*\)/.test(callText);
  },
};

/** 按顶层逗号切分实参（忽略字符串与括号内部的逗号）。 */
function splitTopLevelArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += s[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * 从某个匹配处向后取出「整条调用」的文本（到与开括号配对的闭括号为止）。
 *
 * 为什么需要：有些判据要看的不是一个匹配片段，而是整条调用 ——
 * 例如 PW103 判断 `test.skip(...)` 有没有带理由，而理由常在**下一行**：
 *     test.skip(true,
 *       'ISSUE-123 等待接口修复');
 * 只看当前行会把它当成静默跳过（误报）。
 *
 * 取的是「保留字符串」的对齐文本（rule.text 指定的那份），并从匹配处的行首往后扫，
 * 这样多行调用能完整覆盖。扫不到闭括号时退化为「本行」。
 */
function callTextAt(text, lines, lineIdx, maxLines = 8) {
  const line = lines[lineIdx];
  let out = line.text;
  let depth = 0;
  let seen = false;
  for (let li = lineIdx; li < Math.min(lines.length, lineIdx + maxLines); li++) {
    const seg = li === lineIdx ? lines[li].text : lines[li].text;
    if (li > lineIdx) out += `\n${seg}`;
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (c === '(') { depth++; seen = true; }
      else if (c === ')') { depth--; if (seen && depth <= 0) return out; }
    }
  }
  return out;
}

/** 逐行检查（两份脱敏文本之一）。 */
function runLineRules(ctx, rule, text) {
  const lines = splitLines(text);
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (!l.text.trim()) continue;
    rule.re.lastIndex = 0;
    const mm = rule.re.exec(l.text);
    if (!mm) continue;
    if (rule.negative) {
      rule.negative.lastIndex = 0;
      if (rule.negative.test(l.text)) continue;   // 例如断言那行有 await → 放过
    }
    // PW006 专用闸门：断言参数不是异步来源时，这条「缺 await」是正常的同步断言，不该冤枉
    if (rule.requireAsyncSource) {
      const arg = mm[0].replace(/^[^\w]*expect\s*\(/, '');
      const inner = arg.slice(0, arg.lastIndexOf(')'));
      ASYNC_SOURCE_RE.lastIndex = 0;
      if (!ASYNC_SOURCE_RE.test(inner)) continue;
    }
    // 自定义判据拿到的是「整条调用」的文本（可能跨行），而不是单行片段。
    //
    // 关键细节：判据若需要看**字符串内容**（如 PW103 的跳过理由），必须用
    // 「保留字符串」的那份文本 —— 规则本身跑在 noStrings 上，那里理由已经变成空格了。
    // 这也是「一道脱敏不可能同时满足两类规则」的又一个实例。
    if (rule.custom && CUSTOM_CHECKS[rule.custom]) {
      const source = (rule.customNeedsCall && ctx.mask && ctx.mask.noComments)
        ? ctx.mask.noComments
        : text;
      const callText = rule.customNeedsCall
        ? callTextAt(source, splitLines(source), li)
        : l.text;
      if (!CUSTOM_CHECKS[rule.custom](callText, mm)) continue;
    }
    ctx.push({
      id: rule.id,
      severity: rule.severity,
      tier: rule.tier,
      title: rule.title,
      file: ctx.file,
      line: l.line,
      evidence: evidenceSlice(ctx.srcLines, l.line),   // 证据一律回「原文」取
      match: mm[0],
      fix: rule.fix,
    });
  }
}

/** 文件级检查。 */
function runFileRule(ctx, rule) {
  const text = rule.text ? ctx.mask[rule.text] : ctx.src;
  rule.re.lastIndex = 0;
  const mm = rule.re.exec(text);
  if (!mm) return;
  const line = text.slice(0, mm.index).split('\n').length;
  ctx.push({
    id: rule.id,
    severity: rule.severity,
    tier: rule.tier,
    title: rule.title,
    file: ctx.file,
    line,
    evidence: evidenceSlice(ctx.srcLines, line),
    match: mm[0],
    fix: rule.fix,
  });
}

/** 语句级检查（PW006）：断言有没有被 await 是**语句级**事实，不是行级事实。
 *
 *  两个行级机制抓不到的洞（对抗样例钉住）：
 *    await page.goto('/x'); expect(a).toBeVisible();
 *      —— 行级 negative /await/ 看到 goto 的 await 就整行放过，断言本身仍然漏 await（漏报）
 *    expect(\n  page.getByTestId('y')\n).toBeVisible();
 *      —— prettier 折行后整条语句跨行，行级正则连匹配都匹配不上（静默失明）
 *
 *  判据：在去字符串文本上做全局匹配（[^;] 允许跨行、禁止跨语句），
 *  「断言的结果交出去没有」只看 expect 之前那截语句前缀 ——
 *  await / return / 变量接走（const p = ...）都算交出去，放过。
 *  反过来 const p = expect(...).toBeVisible(); await p; 也不该冤枉：
 *  旧式整行 /await/ 在两行分开时会误报，语句前缀 + 接走判定把它消掉。
 *
 *  刻意不做数据流跟踪：`arr.forEach(x => expect(x).toBe())` 里 promise 被丢掉的形态抓不到 ——
 *  箭头表达式体（安全，promise 交回 runner）与回调体（丢弃）语法同形，区分需要数据流分析。
 *  宁漏不误报，这里选择放过，并把已知边界写进规则文案。 */
const HAND_BACK_RE = /\bawait\s*$|\breturn\s*$|[\w$]+\s*=\s*$/;

function runStmtRules(ctx, rule) {
  const text = ctx.mask[rule.text];
  const re = new RegExp(rule.re.source, 'g');
  let mm;
  while ((mm = re.exec(text)) !== null) {
    // expect 起点：match 可能带一个前置分隔符字符（^ 或 [^\w.] 消耗的那一个）
    const expectAt = mm.index + (mm[0].startsWith('expect') ? 0 : 1);
    // 语句起点：expect 之前最近的语句分隔符（; 或块边界）之后
    let stmtStart = 0;
    for (const sep of [';', '{', '}']) {
      const i = text.lastIndexOf(sep, expectAt - 1);
      if (i + 1 > stmtStart) stmtStart = i + 1;
    }
    const prefix = text.slice(stmtStart, expectAt);
    if (HAND_BACK_RE.test(prefix)) continue;   // await / return / 变量接走 → 结果交出去了，放过
    // 断言参数不是异步来源时，这条「缺 await」是正常的同步断言，不该冤枉
    if (rule.requireAsyncSource) {
      const arg = mm[0].replace(/^[^\w]*expect\s*\(/, '');
      const inner = arg.slice(0, arg.lastIndexOf(')'));
      ASYNC_SOURCE_RE.lastIndex = 0;
      if (!ASYNC_SOURCE_RE.test(inner)) continue;
    }
    const line = text.slice(0, expectAt).split('\n').length;
    ctx.push({
      id: rule.id,
      severity: rule.severity,
      tier: rule.tier,
      title: rule.title,
      file: ctx.file,
      line,
      evidence: evidenceSlice(ctx.srcLines, line),   // 证据一律回「原文」取
      match: mm[0],
      fix: rule.fix,
    });
  }
}

/** 用例块级检查：PW007 断言存在性。 */
function runBlockRules(ctx, rule) {
  if (rule.id !== 'PW007') return;
  // 断言存在性检测：用「只去注释」的文本 —— 若用去字符串的文本，
  // `expect` 本身作为裸标识符会被抹掉，所有正规用例都会被误判成「没有断言」。
  // 用去注释文本则：`expect(...)` 保留可见、`.toBeVisible(` 也保留可见，
  // 而注释里的假 expect 已被抹掉（那正是陷阱样例要防的）。
  const assertRe = new RegExp(`(?:^|[^\\w.$])expect(?:\\.\\s*(?:soft|poll|configure))?\\s*\\(|\\.\\s*(?:${ASSERTION_ALT})\\s*\\(`);
  for (const b of ctx.blocks) {
    if (b.kind !== 'test') continue;                     // 容器不检查断言
    if (/^(skip|fixme)$/.test(b.modifier)) continue;     // 明确跳过的用例不追断言
    const seg = b.bodyStart >= 0 && b.bodyEnd > b.bodyStart
      ? ctx.mask.noComments.slice(b.bodyStart, b.bodyEnd + 1)
      : ctx.mask.noComments.slice(b.callStart, b.callEnd + 1);
    assertRe.lastIndex = 0;
    if (assertRe.test(seg)) continue;

    // 直接断言找不到 → 再看是不是「断言在页面对象方法里」（PO 分层的正常形态）。
    // 这一步是跨文件推断，所以最多只报 WARN，绝不阻断 —— 误报才是门禁最大的成本。
    const indirect = resolveIndirectAssertion(seg, ctx.poMethods);
    if (indirect) {
      ctx.push({
        id: rule.id,
        severity: 'WARN',
        tier: rule.tier,
        title: '用例未直接断言（断言在页面对象方法内）',
        file: ctx.file,
        line: b.line,
        evidence: evidenceSlice(ctx.srcLines, b.line),
        match: b.name,
        testName: b.name,
        fix: `本用例通过页面对象方法间接断言：${indirect.join('、')}。`
          + '这是 PO 分层的正常形态，因此只提示人工确认：确认那些方法里的断言真的覆盖了本用例的主张，'
          + '若覆盖不足，仍应在本用例里补一条直接断言。',
      });
      continue;
    }

    ctx.push({
      id: rule.id,
      severity: rule.severity,
      tier: rule.tier,
      title: rule.title,
      file: ctx.file,
      line: b.line,
      evidence: evidenceSlice(ctx.srcLines, b.line),
      match: b.name,
      testName: b.name,
      fix: rule.fix,
    });
  }
}

/** 配置驱动的规则开关与级别覆盖。 */
function applyRuleConfig(rules, cfg) {
  const off = new Set(cfg.disableRules || []);
  const sev = cfg.severityOverrides || {};
  const tiers = new Set(cfg.tiers || ['core', 'ext']);
  return rules
    .filter((r) => !off.has(r.id) && tiers.has(r.tier))
    .map((r) => (sev[r.id] ? { ...r, severity: sev[r.id] } : r));
}

/* ------------------------------------------------------------------ *
 * 单文件 / 批量
 * ------------------------------------------------------------------ */

export function lintSource(src, filename = '(inline)', opts = {}) {
  const findings = [];
  const mask = maskAll(src);
  const srcLines = splitLines(src);
  const ctx = {
    src, file: filename, mask, srcLines,
    blocks: findTestBlocks(src, mask),
    // 页面对象方法注册表（由 lint 批量扫描时传入）；单文件调用时为空，
    // 此时 PW007 退化成原文行为（用例里没有 expect 就是 ERROR）。
    poMethods: opts.poMethods || new Map(),
    push: (f) => findings.push(f),
  };
  const rules = applyRuleConfig(RULES, opts.ruleConfig || {});

  for (const rule of rules) {
    try {
      if (rule.scope === 'line') runLineRules(ctx, rule, mask[rule.text]);
      else if (rule.scope === 'file') runFileRule(ctx, rule);
      else if (rule.scope === 'stmt') runStmtRules(ctx, rule);
      else if (rule.scope === 'block') runBlockRules(ctx, rule);
    } catch (err) {
      findings.push({
        id: rule.id, severity: 'WARN', tier: rule.tier, title: rule.title,
        file: filename, line: 1, evidence: '', match: '',
        fix: `规则执行异常（已降级为 WARN，不影响其它规则）：${err.message}`,
      });
    }
  }

  // 去重：同一文件同一行同一规则只报一次
  const seen = new Set();
  const deduped = [];
  for (const f of findings) {
    const key = `${f.id}|${f.file}|${f.line}|${f.match}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }
  deduped.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id));

  const tests = ctx.blocks.filter((b) => b.kind === 'test');
  const containers = ctx.blocks.filter((b) => b.kind === 'container');
  return {
    file: filename,
    tests: tests.length,
    containers: containers.length,
    testNames: tests.map((t) => `${t.modifier ? `${t.modifier}:` : ''}${t.name}`),
    findings: deduped,
  };
}

export function lint(target, opts = {}) {
  const files = collectFiles(target, opts);

  // 第一遍：把所有页面对象的断言信息收集起来，供第二遍的 PW007 做跨文件推断。
  // 只扫 .ts/.js 且排除了 .spec./.test. 的文件 —— 页面层通常不带这些后缀。
  const poMethods = new Map();
  for (const f of files) {
    if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(f)) continue;
    try {
      const src = fs.readFileSync(f, 'utf8');
      for (const [name, info] of parsePageObjectMethods(src)) {
        // 同名方法取「有断言」的那个：宁可认为有断言（→ WARN 而非 ERROR），符合宁漏不误报
        if (!poMethods.has(name) || info.hasAssertion) poMethods.set(name, info);
      }
    } catch { /* 读不到就跳过，不影响其它文件 */ }
  }

  const results = [];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch (e) {
      results.push({ file: f, tests: 0, containers: 0, testNames: [], findings: [], readError: e.message });
      continue;
    }
    results.push(lintSource(src, f, { ...opts, poMethods }));
  }

  const all = results.flatMap((r) => r.findings);
  const errorCount = all.filter((f) => f.severity === 'ERROR').length;
  const warnCount = all.filter((f) => f.severity === 'WARN').length;
  const byId = {};
  for (const f of all) {
    byId[f.id] = byId[f.id] || { id: f.id, severity: f.severity, title: f.title, count: 0 };
    byId[f.id].count++;
  }

  return {
    tool: 'lint_spec',
    version: 1,
    target,
    filesScanned: results.length,
    testCount: results.reduce((s, r) => s + r.tests, 0),
    summary: {
      errorCount,
      warnCount,
      // 门禁语义：ERROR 必须把脚本以退出码 1 结束，否则它挂不进 CI（只有 WARN 的检查等于没有检查）
      exitCode: errorCount > 0 ? 1 : 0,
      verdict: errorCount > 0 ? 'BLOCK' : (warnCount > 0 ? 'PASS_WITH_WARNINGS' : 'PASS'),
    },
    byRule: Object.values(byId).sort((a, b) => b.count - a.count),
    files: results,
    findings: all,
  };
}

/* ------------------------------------------------------------------ *
 * 报告渲染
 * ------------------------------------------------------------------ */

export function formatText(report) {
  const out = [];
  out.push(`lint_spec  target=${report.target}`);
  out.push(`扫描文件 ${report.filesScanned} 个，识别用例 ${report.testCount} 条`);
  for (const r of report.files) {
    if (!r.findings.length) {
      out.push(`  [OK  ] ${r.file}　用例 ${r.tests} 条，零告警`);
      continue;
    }
    out.push(`  [FILE] ${r.file}　用例 ${r.tests} 条`);
    for (const f of r.findings) {
      const pad = f.severity === 'ERROR' ? 'ERROR' : 'WARN ';
      out.push(`    [${pad}] ${f.id} ${f.file}:${f.line}　${f.title}`);
      if (f.evidence) out.push(`           证据: ${f.evidence.trim()}`);
      if (f.fix) out.push(`           修法: ${f.fix}`);
    }
  }
  out.push('');
  out.push(`汇总: ERROR ${report.summary.errorCount} / WARN ${report.summary.warnCount}`);
  for (const b of report.byRule) out.push(`  ${b.severity === 'ERROR' ? 'ERROR' : 'WARN '} ${b.id} × ${b.count}　${b.title}`);
  out.push(`结论: ${report.summary.verdict}（退出码 ${report.summary.exitCode}）`);
  if (report.summary.errorCount > 0) {
    out.push('ERROR 必须清零才能合入 —— 这是本门禁的阻断条件。');
  }
  return out.join('\n');
}

export default { lint, lintSource, formatText, RULES, adversarialCorpus, collectFiles, parsePageObjectMethods };
