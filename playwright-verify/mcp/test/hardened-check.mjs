/**
 * hardened-check.mjs — 「对手册的对手」回归：静默失效 / 静默反转 / 静默覆盖 / 静默篡改
 *
 * 这个套件来自一次对抗性审计。它钉的都是同一类问题：**不报错，但结论或行为是错的**。
 * 这类问题比崩溃危险得多 —— 崩溃会被立刻发现，静默错会被当成"通过"信下去。
 *
 * 覆盖：
 *   H1  规则静默失效：PW001 必须命中 `page.waitForTimeout(...)`（最常见写法）
 *   H2  按规则 id 断言：只钉总数会被别的规则填满，抓不到某条规则已死
 *   H3  测试数据不被生成器篡改：字符串里的 `page.getByText(...)` 必须原样保留
 *   H4  模板串插值不吞掉后续代码（否则整个文件被当字符串，用例数静默归零）
 *   H5  不静默覆盖已有文件（默认拒绝，需显式 overwrite）
 *   H6  落盘约束不可被 `--filename=` 绕过
 *   H7  函数式配置不误判为配置错误（不阻断）
 *   H8  断言分类不漏：单行、无 Expected: 的断言失败也要归成 assertion
 *   H9  参数契约：schema 字段全带 description，PVMCP_CWD 回落安全
 *   H10 换行符必须是 LF（CRLF 破坏 shebang 与全树哈希比对）
 *   H11 环境失败分类不漏：缺浏览器/缺通道归 env，不落进 unknown
 *   H12 已知噪声（NO_COLOR/FORCE_COLOR 警告）不挤掉真正的失败原因
 *   H13 安装时 CLI 通道配置的决策矩阵（保留/重生成/显式优先/字节确定）
 *   H14 Python 字节码（__pycache__/*.pyc）四层排除：入库/复制/分发/比对一个都不能漏
 *   H15 路径解析禁用 URL 的 pathname（中文/空格路径被百分号编码，静默指错位置）
 *   H16 版本/文档同步：版本号唯一源 package.json，四份文档的版本记录与自然语言使用示例缺一即发版未完成
 *   H17 智能体线守门：凭据只走环境变量、危险目标拒绝表非空、白名单外动作不静默丢弃
 *   H18 纯净发布包口径：实跑 distribute 验产物 —— 无 node_modules、无 . 前缀内容
 *   H19 发版门禁：distribute 收尾自动一次性副本 verify-all + 终态哈希终查（发版不可能忘）
 *   H20 CLI 失败摘要：根因行优先于堆栈噪声（daemon 崩溃时不能只剩 daemonPid）
 *   H21 并行调度与收尾：部署副本独占末波、只关自己的会话、kill-all 先于产物清理
 *   H22 断言数单一源：suites.mjs 声明是唯一真相，README 表/§15.3/verify-all/CI 全部机械对账
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RULES, lintSource, lint } from '../lib/lint.js';
import { generate, writeGenerated } from '../lib/generate.js';
import { runCli, extractRootCause } from '../lib/cli.js';
import { checkConfigSource } from '../lib/configcheck.js';
import { summarize, clean, classify, CATEGORIES } from '../lib/signature.js';
import { stripKnownNoise } from '../lib/runner.js';
import { DANGEROUS_GOAL_PATTERNS, assertGoalAllowed } from '../lib/agent.js';
import { normalizePlan, verdictOf } from '../lib/nlplan.js';
import { handleMessage } from '../server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};

/* ---------------- H1 / H2: 规则不能静默失效 ---------------- */
log('=== H1/H2) 规则静默失效 ===');

const pw001 = RULES.find((r) => r.id === 'PW001');
check('PW001 存在', !!pw001);
const hits = [
  ['await page.waitForTimeout(3000);', true, '最常见写法'],
  ['await this.page.waitForTimeout(3000);', true, 'this.page 形态'],
  ['await page.locator("#x").waitForTimeout(1);', true, '链式形态'],
  ['waitForTimeout(1000);', true, '裸调用'],
  ['await sleep(500);', true, 'sleep 别名'],
  ['myWaitForTimeout(1);', false, '标识符尾部不该误报'],
  ['antiwaitForTimeout(1);', false, '标识符中间不该误报'],
];
for (const [src, want, why] of hits) {
  const got = pw001.re.test(src);
  check(`PW001 ${want ? '命中' : '不误报'}：${why}`, got === want, src);
}

// 关键：只钉总数会被别的规则填满。逐规则 id 断言才抓得到「某条规则已死」。
const messy = fs.readFileSync(path.join(ROOT, 'demo/tests/messy.spec.ts'), 'utf8');
const messyRes = lintSource(messy, 'messy.spec.ts');
const firedIds = new Set(messyRes.findings.map((f) => f.id));
const expectedIds = ['PW001', 'PW002', 'PW003', 'PW004', 'PW005', 'PW006', 'PW007'];
const dead = expectedIds.filter((id) => !firedIds.has(id));
check('每条关键规则都真的命中过（不是总数凑出来的）', dead.length === 0,
  dead.length ? `从未命中：${dead.join(',')}` : expectedIds.join(','));

/* ---------------- H3: 生成器不得篡改测试数据 ---------------- */
log('');
log('=== H3) 生成器不篡改测试数据 ===');
const tamperInput = {
  spec: 'h3',
  pages: [{
    name: 'p',
    navPath: '/p',
    steps: [
      { act: 'fill', locator: { kind: 'label', text: 'q' }, value: "page.getByText('x')" },
      { act: 'assertText', locator: { kind: 'testid', id: 'out' }, expect: 'page.goto' },
      { act: 'assertVisible', locator: { kind: 'testid', id: 'ok' } },
    ],
  }],
  cases: [{
    title: 't', page: 'p', claims: 'c',
    steps: [
      { act: 'assertText', locator: { kind: 'testid', id: 'out' }, expect: 'page.goto' },
      { act: 'assertVisible', locator: { kind: 'testid', id: 'ok' } },
    ],
  }],
};
const g3 = generate(tamperInput);
const po3 = g3.files.find((f) => f.path.startsWith('pages/')).content;
check('字符串里的 page.getByText(...) 原样保留',
  po3.includes(`fill("page.getByText('x')")`),
  po3.split('\n').find((l) => l.includes('fill('))?.trim());
check('字符串里的 page.goto 原样保留（未被改成 this.page.goto）',
  po3.includes('toHaveText("page.goto")'));
check('定位表达式仍正确使用 this.page',
  /await this\.page\.getByLabel\('q'\)/.test(po3));

/* ---------------- H4: 模板串插值不吞代码 ---------------- */
log('');
log('=== H4) 模板串插值不吞掉后续代码 ===');
const tplCases = [
  ['简单插值', 'test(`case ${1}`, async ({ page }) => {\n  await expect(page.getByTestId(\'a\')).toBeVisible();\n});'],
  ['嵌套插值', 'test(`a ${`b${`c`}`} d`, async ({ page }) => {\n  await expect(page.getByTestId(\'a\')).toBeVisible();\n});'],
  ['插值含对象字面量', 'test(`x ${ { a: 1 }.a } y`, async ({ page }) => {\n  await expect(page.getByTestId(\'a\')).toBeVisible();\n});'],
];
for (const [label, src] of tplCases) {
  const r = lintSource(src, 'tpl.spec.ts');
  check(`模板串用例名不导致用例数归零：${label}`, r.tests === 1, `tests=${r.tests}`);
}
// 真实样例集：tricky 的用例数不能是 0（曾经因为插值 bug 变成 0 而"全绿"）
const tricky = lintSource(fs.readFileSync(path.join(ROOT, 'demo/tests/tricky.spec.ts'), 'utf8'), 'tricky.spec.ts');
check('tricky.spec.ts 用例数 > 0（不是"零用例所以零告警"）', tricky.tests > 0, `tests=${tricky.tests}`);

/* ---------------- H5: 不静默覆盖 ---------------- */
log('');
log('=== H5) 不静默覆盖已有文件 ===');
const outDir = path.join(ROOT, '.h5-out');
fs.rmSync(outDir, { recursive: true, force: true });
const w1 = writeGenerated(g3, outDir);
check('首次写盘成功', w1.written === true);
const poPath = path.join(outDir, 'pages', 'PPage.ts');
const manual = '// 人手改过的重要注释\n';
fs.writeFileSync(poPath, manual + fs.readFileSync(poPath, 'utf8'));
const w2 = writeGenerated(g3, outDir);
check('第二次默认拒绝覆盖', w2.written === false && w2.reason === 'EXISTS', JSON.stringify(w2.conflicts));
check('拒绝时列出冲突文件', Array.isArray(w2.conflicts) && w2.conflicts.includes('pages/PPage.ts'));
check('人手改动未被抹掉', fs.readFileSync(poPath, 'utf8').includes('人手改过的重要注释'));
const w3 = writeGenerated(g3, outDir, { overwrite: true });
check('显式 overwrite:true 才覆盖', w3.written === true);
check('覆盖后确实替换了', !fs.readFileSync(poPath, 'utf8').includes('人手改过的重要注释'));
fs.rmSync(outDir, { recursive: true, force: true });

/* ---------------- H6: 落盘约束不可绕过 ---------------- */
log('');
log('=== H6) 落盘约束不可被 --filename= 绕过 ===');
const bypass = await runCli({
  cwd: ROOT, session: 'h6', subcommand: 'snapshot',
  args: ['--filename=../../tmp/evil.md'],
});
check('拒绝调用方自带 --filename', bypass.ok === false && bypass.reason === 'ARTIFACT_PATH_NOT_ALLOWED',
  bypass.reason);
const bypass2 = await runCli({
  cwd: ROOT, session: 'h6', subcommand: 'screenshot',
  args: ['--filename', 'C:/Windows/Temp/evil.png'],
});
check('拒绝 --filename value 分离写法', bypass2.ok === false && bypass2.reason === 'ARTIFACT_PATH_NOT_ALLOWED',
  bypass2.reason);
// 顺序钉：越权参数的拒绝必须发生在「CLI 装没装」检查**之前**。
// 上面两条行为断言在装了 CLI 的机器上抓不到顺序回归 —— 顺序错了守门照样"过"，
// 只有未装 CLI 的环境（纯净发布包）才暴露成「守门静默失效」。实测踩过，所以顺序本身也钉死。
{
  const cliSrc = fs.readFileSync(path.join(ROOT, 'mcp', 'lib', 'cli.js'), 'utf8');
  const guardIdx = cliSrc.indexOf("reason: 'ARTIFACT_PATH_NOT_ALLOWED'");
  const capIdx = cliSrc.indexOf("reason: 'CLI_NOT_INSTALLED'");
  check('H6 守门先于能力检查（顺序反转=纯净包上守门静默失效）',
    guardIdx > 0 && capIdx > 0 && guardIdx < capIdx, `guard@${guardIdx} capability@${capIdx}`);
}

/* ---------------- H7: 函数式配置不误判 ---------------- */
log('');
log('=== H7) 函数式配置不被误判为配置错误 ===');
const arrowCfg = "import { defineConfig } from '@playwright/test';\n"
  + 'export default defineConfig(() => ({ timeout: 300_000 }));';
const a1 = checkConfigSource(arrowCfg, 'arrow.ts');
check('箭头形式：不阻断（exitCode 0）', a1.summary.exitCode === 0, a1.summary.verdict);
check('箭头形式：verdict 标为 UNPARSEABLE', a1.summary.verdict === 'UNPARSEABLE');
check('箭头形式：仍指出读到的问题（timeout 过长）', a1.findings.some((f) => f.id === 'CFG002'));
check('箭头形式：读不到的键降级为 WARN', a1.findings.find((f) => f.id === 'CFG001')?.level === 'WARN');

const fnCfg = "import { defineConfig } from '@playwright/test';\n"
  + 'export default defineConfig(function () { return { timeout: 300_000 }; });';
const a2 = checkConfigSource(fnCfg, 'fn.ts');
check('function 形式：不阻断', a2.summary.exitCode === 0, a2.summary.verdict);
check('function 形式：CFG000 为 WARN 而非 ERROR',
  a2.findings.find((f) => f.id === 'CFG000')?.level === 'WARN');

// 反向保护：真正的坏配置必须照样阻断（别把该拦的也放过）
const brokenCfg = "import { defineConfig } from '@playwright/test';\n"
  + "export default defineConfig({ timeout: 300_000, use: { trace: 'off' } });";
const a3 = checkConfigSource(brokenCfg, 'broken.ts');
check('普通对象的坏配置仍然阻断（BLOCK / exitCode 1）',
  a3.summary.verdict === 'BLOCK' && a3.summary.exitCode === 1, `${a3.summary.verdict} ${a3.summary.exitCode}`);
// 基线必须仍然干净
const baseCfg = fs.readFileSync(path.join(ROOT, 'demo/configs/playwright.config.baseline.ts'), 'utf8');
const a4 = checkConfigSource(baseCfg, 'baseline.ts');
check('基线配置仍然 0 ERROR / 0 WARN / 0 INFO',
  a4.summary.errorCount === 0 && a4.summary.warnCount === 0 && a4.summary.infoCount === 0,
  JSON.stringify(a4.summary));

/* ---------------- H8: 断言分类不漏 ---------------- */
log('');
log('=== H8) 断言失败不能被漏归成 unknown ===');
const oneLiners = [
  'Error: expect(locator).toBeVisible() failed',
  'Error: expect(locator).toHaveText(expected) failed',
  'Error: expect(page).toHaveURL(expected) failed',
];
for (const m of oneLiners) {
  const got = classify(clean(m));
  check(`单行断言失败归为 assertion：${m.slice(7, 45)}`, got === 'assertion', got);
}
// 端到端：一条只有单行错误的报告，也必须归成 assertion
const rep = summarize({
  stats: { expected: 0, unexpected: 1, flaky: 0, skipped: 0, duration: 1 },
  suites: [{
    title: 's', file: 's.spec.ts',
    specs: [{
      title: 'T', ok: false, file: 's.spec.ts',
      tests: [{ status: 'unexpected', results: [{ status: 'failed', errors: [{ message: 'Error: expect(locator).toBeVisible() failed' }] }] }],
    }],
  }],
});
check('报告里单行断言失败 → assertion（不是 unknown）',
  rep.clusters[0]?.category === 'assertion', rep.clusters[0]?.category);

/* ---------------- MCP 层一致性 ---------------- */
log('');
log('=== MCP 层：isError 与 exitCode 一致 ===');
const cfgViaMcp = await handleMessage({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name: 'check_config', arguments: { cwd: ROOT, file: 'demo/configs/playwright.config.legacy.ts' } },
});
check('坏配置经 MCP 返回 isError', cfgViaMcp.result?.isError === true);

/* ---------------- H9: 参数契约（description 覆盖 + 默认工作目录） ---------------- */
log('');
log('=== H9) 参数契约 ===');
const { TOOLS } = await import('../server.mjs');
let fieldTotal = 0;
const noDesc = [];
for (const t of TOOLS) {
  for (const [k, v] of Object.entries(t.inputSchema?.properties || {})) {
    fieldTotal++;
    if (!v.description) noDesc.push(`${t.name}.${k}`);
    for (const [k2, v2] of Object.entries(v.items?.properties || {})) {
      fieldTotal++;
      if (!v2.description) noDesc.push(`${t.name}.${k}[].${k2}`);
    }
  }
}
// 为什么钉这个：工具描述与 schema **每次请求都进上下文**，是模型填对参数的第一手依据。
// 缺描述的字段会让模型靠猜，猜错就多一轮工具调用 —— 既费 token 又慢。
check('所有参数字段都有 description（含一层嵌套）', noDesc.length === 0,
  noDesc.length ? `缺 ${noDesc.length} 个：${noDesc.join(', ')}` : `${fieldTotal} 个字段全覆盖`);

// PVMCP_CWD 让 cwd 变为可选：不开子进程，直接验证默认值来源
const { default: _ } = { default: null };
const cwdDefault = process.env.PVMCP_CWD;
check('本机已配置 PVMCP_CWD（安装器写入）或可回落到 process.cwd()',
  typeof cwdDefault === 'string' || cwdDefault === undefined,
  cwdDefault ? `PVMCP_CWD=${cwdDefault}` : '未设置 → 回落到启动目录');

log('');
log('=== H10) 换行符必须是 LF（跨平台一致性的前提）===');
/*
 * 为什么钉这个：Windows 上 git 默认 core.autocrlf=true，会把仓库里的 LF 检出成 CRLF。
 * 对本项目来说 CRLF 不只是「多一个字符」：
 *   · mcp/py/read_cases.py 带 shebang，CRLF 会让 Linux 上的 `#!/usr/bin/env python\r` 找不到解释器；
 *   · 生成的 .ts/.mjs 要过本工具的语法门禁与 Playwright 解析 ——
 *     如果本地与 CI 的换行符不同，deployed-check 的全树哈希会无故报漂移（假失败）；
 *   · 所以 .gitattributes 里 `* text=auto eol=lf` 是必需品，不是洁癖。
 * 这里直接读工作区字节来验，不依赖 git 命令（CI 上未必有完整 git）。
 */
const LF_FILES = [
  'mcp/py/read_cases.py',
  'mcp/lib/lint.js',
  'mcp/lib/tokenizer.js',
  'mcp/server.mjs',
  'skill/playwright-verify/SKILL.md',
  'README.md',
];
const crlfFiles = [];
for (const f of LF_FILES) {
  const b = fs.readFileSync(path.join(ROOT, f));
  for (let i = 0; i < b.length - 1; i++) {
    if (b[i] === 0x0d && b[i + 1] === 0x0a) { crlfFiles.push(f); break; }
  }
}
check('关键文件是 LF 换行（CRLF 会破坏 shebang 与哈希比对）', crlfFiles.length === 0,
  crlfFiles.length ? `CRLF：${crlfFiles.join(', ')}` : `${LF_FILES.length} 个文件均为 LF`);
{
  // 纯净发布包按发布规范不含 . 前缀文件 —— 该钉在源码树验证，包里诚实跳过而不是误报缺失。
  const ga = path.join(ROOT, '.gitattributes');
  if (fs.existsSync(ga)) {
    check('.gitattributes 声明了 eol=lf',
      /text=auto\s+eol=lf|\* text=auto/.test(fs.readFileSync(ga, 'utf8')));
  } else {
    log('SKIP  .gitattributes 声明 eol=lf（纯净发布包不含 . 前缀文件 —— 该钉在源码树验证）');
  }
}

log('');
log('=== H11) 环境不可达必须归成 env（缺浏览器不能落进 unknown）===');
/*
 * 为什么钉这个：真实踩过 —— chromium headless shell 没装时，9 条回归全挂在
 * browserType.launch，而归因输出是 unknown:9「人工判定」。
 * 一个环境问题被当成 9 条未知失败推给人：这就是 H8 的镜像问题 ——
 * H8 钉「断言失败不被漏成 unknown」，H11 钉「环境失败不被漏成 unknown」。
 * 两边都不漏，unknown 才真的是「没见过的形态」。
 */
check('缺浏览器（browserType.launch: Executable doesn\'t exist）归为 env',
  classify(clean("Error: browserType.launch: Executable doesn't exist at C:\\ms-playwright\\chromium_headless_shell-1243\\chrome-headless-shell.exe")) === 'env');
check('CLI 缺通道（Chromium distribution not found）归为 env',
  classify(clean("Error: Chromium distribution 'msedge' is not found at C:\\cache\\ms-playwright")) === 'env');
check('环境失败的派活口径不派人查用例',
  /不要派人去查用例/.test(CATEGORIES.env.action));

log('');
log('=== H12) 已知噪声不能挤掉真正的失败原因 ===');
/*
 * 为什么钉这个：Playwright worker 启动时硬编码 FORCE_COLOR=1，与我们设的
 * NO_COLOR 冲突，Node 于是往 stderr 刷「NO_COLOR 被忽略」警告 —— 实测一次
 * 回归能刷十几行。诊断只回尾部几行（lastLines），噪声会把真正的失败原因
 * 挤出视野：这就是「不报错但结论错」的又一形态 —— 排查方向被噪声带偏。
 * 钉四条：噪声行被剔除；真实行保留；很像警告的行不误删；清洗幂等。
 */
{
  const noiseLine = "(node:47172) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.";
  const mixed = ['真实错误：locator(".btn").click: Timeout 30000ms exceeded', noiseLine, noiseLine, '  at foo.spec.ts:10:5'].join('\n');
  const stripped = stripKnownNoise(mixed);
  check('NO_COLOR/FORCE_COLOR 警告行被剔除', !stripped.includes('NO_COLOR') && !stripped.includes('FORCE_COLOR'));
  check('真实错误与堆栈原样保留', stripped.includes('真实错误') && stripped.includes('at foo.spec.ts:10:5'));
  check('普通 Warning 行不被误删（只删已知噪声）',
    stripKnownNoise('Warning: 真正需要人看的警告').includes('需要人看的警告'));
  check('stripKnownNoise 幂等（清洗链各环节都吃同一份文本）',
    stripKnownNoise(stripped) === stripped);
  // 端到端语义：噪声刷屏后，尾部 3 行仍是失败原因而不是警告
  const noisyTail = ['launch 测试', noiseLine, noiseLine, 'Error: browserType.launch: Executable doesn\'t exist at C:\\x'].join('\n');
  const tail3 = stripKnownNoise(noisyTail).split('\n').slice(-3).join('\n');
  check('尾部诊断窗口不被噪声占位', tail3.includes('browserType.launch') && !tail3.includes('NO_COLOR'));
}

log('');
log('=== H13) 安装时的 CLI 通道配置决策不能漂移 ===');
/*
 * 为什么钉这个：通道配置是「这里能跑、装完就不能跑」问题的高发点（实测踩过
 * win32 的 msedge 配置被带到没有 Edge 的机器上）。决策矩阵必须每条分支都活：
 * 少一条分支就是一类安装事故。另外 buildCliConfig 必须字节确定 ——
 * deployed-check 的全树哈希比对以它为前提，抖动一次就是一次假漂移。
 */
{
  const { decideCliConfig, pickChannel, buildCliConfig } = await import('../../skill/playwright-verify/scripts/cli-config.mjs');
  const gened = (platform) => buildCliConfig({ platform, arch: 'x64', ...pickChannel({ platform }) });
  const winCfg = gened('win32');
  const linuxCfg = gened('linux');
  const handCfg = { browser: { browserName: 'chromium', launchOptions: { channel: 'chrome', headless: false } } };

  check('H13 配置缺失 → 重新生成', decideCliConfig({ cfg: null, platform: 'win32' }).action === 'regenerate');
  check('H13 同平台产物 → 原样保留（手工调过的 launchOptions 不被抹掉）',
    decideCliConfig({ cfg: winCfg, platform: 'win32' }).action === 'keep');
  check('H13 跨平台产物 → 按目标平台重新生成（msedge 不带到 Linux）',
    decideCliConfig({ cfg: winCfg, platform: 'linux' }).action === 'regenerate'
    && decideCliConfig({ cfg: linuxCfg, platform: 'win32' }).action === 'regenerate');
  check('H13 手工配置（无 _平台）→ 原样保留',
    decideCliConfig({ cfg: handCfg, platform: 'linux' }).action === 'keep');
  check('H13 PVMCP_BROWSER_CHANNEL 显式指定压过「保留」',
    decideCliConfig({ cfg: winCfg, platform: 'win32', envChannel: 'chrome' }).action === 'regenerate');
  check('H13 平台默认通道：win32→msedge、其它→chromium',
    pickChannel({ platform: 'win32', envChannel: undefined }).channel === 'msedge'
    && pickChannel({ platform: 'linux', envChannel: undefined }).channel === null
    && pickChannel({ platform: 'linux', envChannel: undefined }).source.includes('chromium'));
  // 字节确定性：同输入两次构造必须逐字节一致（全树哈希比对的前提）
  check('H13 buildCliConfig 字节确定（同输入必同输出）',
    JSON.stringify(buildCliConfig({ platform: 'win32', arch: 'x64', channel: 'msedge', source: '测试' }))
    === JSON.stringify(buildCliConfig({ platform: 'win32', arch: 'x64', channel: 'msedge', source: '测试' })));
  check('H13 生成的配置带 _平台（部署副本语义校验依赖它判平台归属）',
    typeof winCfg._平台 === 'string' && winCfg._平台.startsWith('win32'));
}

/* ---------------- H14:运行时字节码不能污染一致性比对与分发 ---------------- */
/*
 * Python 字节码内嵌**编译时的源码路径**：源码树编译出的 .pyc 与部署副本里
 * 重新编译出的 .pyc 必然字节不同。若把它纳入全树哈希比对，跑过一次 Python
 * 之后部署验证就会误报「漂移」—— 误报喊多了，真正的漂移就没人信了。
 * 四层排除必须同时在位：.gitignore（不入库）、install（不复制）、
 * distribute（不进纯净分发版）、deployed-check（不参与比对）。
 */
log('=== H14) Python 字节码不能污染一致性比对与分发 ===');
{
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const install = read('skill/playwright-verify/install.mjs');
  const distribute = read('skill/playwright-verify/scripts/distribute.mjs');
  const deployed = read('mcp/test/deployed-check.mjs');

  {
    // 纯净发布包按发布规范不含 . 前缀文件 —— 该钉在源码树验证，包里诚实跳过而不是误报缺失。
    const gi = path.join(ROOT, '.gitignore');
    if (fs.existsSync(gi)) {
      const gitignore = read('.gitignore');
      check('H14 .gitignore 挡住字节码（__pycache__/ 与 *.pyc）',
        gitignore.includes('__pycache__/') && gitignore.includes('*.pyc'));
    } else {
      log('SKIP  H14 .gitignore 挡住字节码（纯净发布包不含 . 前缀文件 —— 该钉在源码树验证）');
    }
  }
  check('H14 install 不复制 __pycache__（否则字节码被带进部署副本）',
    install.includes("'__pycache__'"));
  check('H14 纯净分发版排除 __pycache__ 与 *.pyc',
    distribute.includes("'__pycache__'") && distribute.includes('\\.pyc'));
  check('H14 全树比对忽略 __pycache__（否则跨目录重编译误报漂移）',
    deployed.includes("'__pycache__'"));
}

/* ---------------- H15:路径解析不得用 URL 的 pathname 属性 ---------------- */
/*
 * `new URL(import.meta.url)` 取 pathname 会把非 ASCII 字符留成**百分号编码**
 * （`发布版本` → `%E5%8F%91%E5%B8%83%E7%89%88%E6%9C%AC`），路径静默指向不存在的
 * 位置 —— 中文用户名、中文目录下部署时资产/根目录解析全体失灵，且错误信息里
 * 编码串不易一眼看破。必须走 fileURLToPath。此问题在 wechat-ai 发包实测中
 * 真实发生过（URL 的 pathname 对中文目录名百分号编码，26 条断言被静默跳过）。
 *
 * 正则用字符串拼接构造：写成字面量的话，本文件自身就含违例子串，扫描器会先抓到自己
 * —— H3（测试数据不被篡改/自我污染）的镜像教训。
 */
log('=== H15) 路径解析不得取 URL 的 pathname（编码后静默指错位置）===');
{
  const PATHNAME_RE = new RegExp('\\.' + 'pathname\\b');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(m?js|cjs)$/.test(e.name)) {
        const src = fs.readFileSync(abs, 'utf8');
        if (PATHNAME_RE.test(src)) offenders.push(path.relative(ROOT, abs));
      }
    }
  };
  walk(path.join(ROOT, 'mcp'));
  walk(path.join(ROOT, 'skill'));
  check('H15 mcp/ 与 skill/ 源码不取 URL 的 pathname（一律 fileURLToPath）',
    offenders.length === 0,
    offenders.length ? `违例：${offenders.join(', ')}` : '全树无该反模式');
}

/* ---------------- H16:版本/文档同步不能靠人记 ---------------- */
/*
 * 发版纪律是「每次版本更新，版本号 + 版本说明同步到全部对应文档，缺一处即视为
 * 发版未完成」。纪律靠人记就一定会漏 —— 版本号在文档间漂移是静默的：没人报错，
 * 只是读者拿着对不上的版本号来问。所以钉四件事：版本号唯一源是 package.json
 * （server 运行时读它，不另存副本）、四份文档都带当前版本号与两节固定内容
 * （版本记录 + 自然语言使用示例）、**每份**文档的版本记录首条都是当前版本且
 * 不写超前版本号（「README 更新了、别的文档忘了」是实测常态）、
 * §15.3 判据行的核心数与 suites.mjs 的 coreCounts 同步（判据行与代码漂移=判据形同虚设）。
 */
log('=== H16) 版本/文档同步（缺一处即发版未完成）===');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const V = String(pkg.version || '');
  const docs = ['README.md', '部署说明.md', '部署说明.详细版.md', 'skill/playwright-verify/SKILL.md'];
  const texts = new Map(docs.map((d) => [d, fs.readFileSync(path.join(ROOT, d), 'utf8')]));
  // 版本记录节切片：从「## 版本记录」标题到下一个二级标题/文末（正文里提到「版本记录」的散文不算）
  const recordSection = (t) => {
    const m = /\n## 版本记录/.exec(t);
    if (!m) return '';
    const next = t.indexOf('\n## ', m.index + 5);
    return t.slice(m.index, next === -1 ? undefined : next);
  };

  const missingVer = docs.filter((d) => !texts.get(d).includes(`v${V}`));
  check('H16 四份文档都带当前版本号（唯一源 package.json）',
    /^\d+\.\d+\.\d+$/.test(V) && missingVer.length === 0,
    `v${V}${missingVer.length ? ` 缺：${missingVer.join(', ')}` : ' 全部在位'}`);

  const missingRecord = docs.filter((d) => !texts.get(d).includes('版本记录'));
  check('H16 四份文档都有「版本记录」节（版本说明同步落点）',
    missingRecord.length === 0, missingRecord.length ? `缺：${missingRecord.join(', ')}` : '全部在位');

  const missingNl = docs.filter((d) => !texts.get(d).includes('自然语言使用示例'));
  check('H16 四份文档都有「自然语言使用示例」（说人话就能用）',
    missingNl.length === 0, missingNl.length ? `缺：${missingNl.join(', ')}` : '全部在位');

  // 每份文档的版本记录首条都得是当前版本 —— 只查 README 不够：实测常态是
  // 「README 更新了、另外三份忘了」，读者拿的往往是部署/安装文档而不是 README。
  const staleFirst = [];
  for (const [d, t] of texts) {
    const first = (recordSection(t).match(/v(\d+\.\d+\.\d+)/) || [])[1];
    if (first !== V) staleFirst.push(`${d}(${first || '无'})`);
  }
  check('H16 四份文档版本记录首条都是当前版本（记录跟得上版本）',
    staleFirst.length === 0, staleFirst.length ? staleFirst.join(', ') : `四份首条均为 v${V}`);

  // 超前版本号（文档写了还没发的版本）会把读者引向不存在的行为 —— 只在版本记录节里查，
  // 全文查会被示例里的第三方版本号（如 Node v24.x）误伤。
  const [vmaj, vmin, vpat] = V.split('.').map(Number);
  const ahead = [];
  for (const [d, t] of texts) {
    for (const m of recordSection(t).matchAll(/v(\d+)\.(\d+)\.(\d+)/g)) {
      const cmp = (Number(m[1]) - vmaj) || (Number(m[2]) - vmin) || (Number(m[3]) - vpat);
      if (cmp > 0) ahead.push(`${d} ${m[0]}`);
    }
  }
  check('H16 版本记录无超前版本号（不写还没发的版本）',
    ahead.length === 0, ahead.length ? ahead.join(', ') : '四份均无超前');

  // 判据行与代码的 CORE 漂移是静默的：verify-all 自己按 CORE 判「一致 ✅」，
  // 文档里那行数没人复核 —— 所以让机器来对：§15.3 核心数 == suites.mjs 的 coreCounts（数字单一源）。
  const { coreCounts } = await import('./suites.mjs');
  const core = coreCounts();
  const codeVals = [core[1], core[2], core[3]].map(String);
  const docLine = /核心断言 mode 1 = (\d+)、mode 2 = (\d+)、mode 3 = (\d+)/.exec(texts.get('部署说明.详细版.md'));
  check('H16 §15.3 核心判据数与 suites.mjs 的 coreCounts 一致（判据行不与代码漂移）',
    !!docLine && codeVals[0] === docLine[1] && codeVals[1] === docLine[2] && codeVals[2] === docLine[3],
    `代码 CORE ${codeVals.join('/')} / §15.3 ${docLine ? docLine.slice(1).join('/') : '(无)'}`);

  const readme = texts.get('README.md');
  check('H16 同步规范在位且写明「缺一处即视为发版未完成」',
    readme.includes('版本与文档同步规范') && readme.includes('缺一处即视为发版未完成'));
}

/* ---------------- H17:智能体线的守门不能静默失效 ---------------- */
/*
 * 智能体线（nl_test_goal）把自然语言目标当指令驱动浏览器，风险面比只读工具大。
 * 三件事必须钉死，任何一件被「优化」掉都属于静默失效：
 *   1) 凭据只从环境变量读 —— 源码不得出现 key 形态字面量，key 只经 DEEPSEEK_API_KEY 一个通道；
 *   2) 危险目标拒绝表非空且条条有理由 —— 表被删空后守门会静默放行一切；
 *   3) 白名单外动作不静默丢弃、无断言不算通过 —— 两者都会产出「看起来绿」的假结果。
 */
log('=== H17) 智能体线：凭据/守门/判定不得静默失效 ===');
{
  const keyRe = /sk-[A-Za-z0-9]{10,}/;
  const offenders = [];
  for (const rel of ['mcp/server.mjs', 'mcp/lib/llmclient.js', 'mcp/lib/nlplan.js', 'mcp/lib/agent.js', 'mcp/lib/explore.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (keyRe.test(src)) offenders.push(rel);
  }
  check('H17 源码无 key 形态字面量（凭据只从环境变量读）',
    offenders.length === 0, offenders.length ? `违例：${offenders.join(', ')}` : '全无');

  const llmSrc = fs.readFileSync(path.join(ROOT, 'mcp/lib/llmclient.js'), 'utf8');
  check('H17 LLM key 只经 DEEPSEEK_API_KEY 环境变量通道（无其它入口）',
    llmSrc.includes('DEEPSEEK_API_KEY') && !/api[_-]?key\s*[:=]\s*['"]/.test(llmSrc));

  check('H17 危险目标拒绝表非空且条条有理由（表删空=守门静默失效）',
    DANGEROUS_GOAL_PATTERNS.length >= 5 && DANGEROUS_GOAL_PATTERNS.every((p) => p.why && p.re));
  check('H17 危险目标实际被拒（破坏性/生产/真实资金）',
    ['drop table users', '删除生产库数据', '对真实资金账户转账'].every((g) => assertGoalAllowed(g).ok === false));

  const bad = normalizePlan({ steps: [{ act: 'eval', target: 'x' }, { act: 'screenshot' }] });
  check('H17 白名单外动作拒绝且不静默丢弃（计划整体作废，不挑着执行）',
    bad.ok === false && bad.steps.length === 0 && bad.problems.length > 0);
  check('H17 无断言的执行不算通过（Blocked，防「全绿但什么都没验」）',
    verdictOf([{ act: 'goto', ok: true }]) === 'Blocked');
}

/* ---------------- H18:纯净发布包口径不得静默失守 ---------------- */
/*
 * 发布口径是「纯净发布包：无 node_modules、无任何 . 前缀内容，解压/拷贝即可部署」。
 * 只钉「排除规则写在脚本里」不够 —— 规则写对了但没生效（或被新增的复制分支绕过）
 * 是静默失效，静态检查看不见。所以**真跑一次 distribute** 到临时目录，验产物本身：
 * 独立于 distribute 自己的自校验再走一遍（同一个规则自查自己不算证据）。
 */
log('=== H18) 纯净发布包：无 node_modules / 无 . 前缀内容 ===');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmcp-dist-pin-'));
  const out = path.join(tmp, 'dist');
  try {
    const r = spawnSync(process.execPath,
      [path.join(ROOT, 'skill', 'playwright-verify', 'scripts', 'distribute.mjs'), '--out', out, '--force', '--no-gate'],
      { encoding: 'utf8', timeout: 120_000 });
    const offenders = [];
    const walk = (dir, rel = '') => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r2 = rel ? `${rel}/${e.name}` : e.name;
        if (e.name.startsWith('.') || e.name === 'node_modules') { offenders.push(r2); continue; }
        if (e.isDirectory()) walk(path.join(dir, e.name), r2);
      }
    };
    const ran = r.status === 0 && fs.existsSync(out);
    if (ran) walk(out);
    check('H18 纯净分发版实跑产物无 node_modules / 无 . 前缀内容（拷贝即部署）',
      ran && offenders.length === 0,
      !ran ? `distribute 退出 ${r.status}：${String(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ')}`
        : offenders.length ? `违例：${offenders.slice(0, 6).join(', ')}${offenders.length > 6 ? ' …' : ''}`
          : `实跑通过：${fs.readdirSync(out).length} 个顶层条目全净`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------------- H19: 发版门禁不得静默失效 ---------------- */
/*
 * 交付树纯净性最大的敌人是「验收跑在交付树里」：证据落盘约定会把 <cwd> 跑脏
 * （实测抓过 3 个证据文件残留）。§15 把「验收跑一次性副本 + 终态哈希终查」定为
 * 发版流程；流程靠人记就会忘，所以门禁长在 distribute 收尾 —— 发版=跑 distribute，
 * 不可能忘。三件事必须钉死，任何一件被「优化」掉都属于静默失效：
 *   1) 门禁接线在位 —— 自动跑、--no-gate 显式跳过、PV_SKIP_RELEASE_GATE 防嵌套递归；
 *   2) 机械链路真的走 —— 实跑 distribute：副本 → 终态哈希终查 → 副本删除一个不少；
 *   3) --no-gate 真的跳 —— 跳过是显式能力：跳过要留痕、也不误拦。
 * 实跑带 PV_GATE_SKIP_VERIFY=1（只跳嵌套 verify-all —— 那步是套娃；真实发版必跑）。
 * 嵌套 verify-all 自身带 PV_SKIP_RELEASE_GATE=1，与本节实跑互不递归。
 */
log('=== H19) 发版门禁：副本验收 + 终态哈希终查不得静默失效 ===');
{
  const distPath = path.join(ROOT, 'skill', 'playwright-verify', 'scripts', 'distribute.mjs');
  const dsrc = fs.readFileSync(distPath, 'utf8');
  check('H19 门禁接线在位（自动跑 / --no-gate 显式跳过 / 嵌套防递归 / 自检开关）',
    dsrc.includes('发版门禁') && dsrc.includes("'no-gate'") && dsrc.includes('PV_SKIP_RELEASE_GATE') && dsrc.includes('PV_GATE_SKIP_VERIFY'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pvmcp-gate-pin-'));
  const out = path.join(tmp, 'dist');
  const env = { ...process.env, PV_GATE_SKIP_VERIFY: '1' };
  delete env.PV_SKIP_RELEASE_GATE;
  try {
    const r = spawnSync(process.execPath, [distPath, '--out', out, '--force'],
      { encoding: 'utf8', timeout: 120_000, env });
    const text = (r.stdout || '') + (r.stderr || '');
    check('H19 门禁实跑通过（副本验收 + 终态哈希终查 + 副本删除）',
      r.status === 0 && text.includes('发版门禁: 通过') && text.includes('终态哈希终查') && text.includes('副本已删除'),
      r.status !== 0 ? `distribute 退出 ${r.status}：${text.trim().split('\n').slice(-2).join(' ')}`
        : (text.split('\n').find((l) => l.includes('发版门禁: 通过')) || '').trim());
    const copyLine = text.split('\n').find((l) => l.includes('副本: ')) || '';
    const copyPath = copyLine.split('副本: ')[1] || '';
    check('H19 门禁副本验后整目录删除（临时目录不留存）',
      copyPath !== '' && !fs.existsSync(copyPath), copyPath || '未见副本路径行');

    const r2 = spawnSync(process.execPath, [distPath, '--out', out, '--force', '--no-gate'],
      { encoding: 'utf8', timeout: 120_000, env });
    const text2 = (r2.stdout || '') + (r2.stderr || '');
    check('H19 --no-gate 显式跳过生效（跳过留痕、不误拦）',
      r2.status === 0 && text2.includes('发版门禁: 已跳过') && !text2.includes('发版门禁: 通过'),
      (text2.split('\n').find((l) => l.includes('发版门禁')) || '').trim());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const depDoc = fs.readFileSync(path.join(ROOT, '部署说明.详细版.md'), 'utf8');
  check('H19 发版文档写明门禁（§15 发布流程 + 发版门禁字样，发版者看得到）',
    depDoc.includes('发版门禁') && depDoc.includes('## 15. 发布流程'));
}

/* ---------------- H20: CLI 失败根因不得被堆栈噪声淹没 ---------------- */
/*
 * 实际踩过的坑：playwright-cli daemon 起不来时（如机器没有 Chrome），真实根因
 * `Chromium distribution 'chrome' is not found` 写在 stderr 中段，后面跟着几十行
 * Node 堆栈，尾部只剩 `daemonPid: 3316` —— 失败摘要按「尾部 3 行」取值时，
 * 排障的人拿到的是 daemonPid，等于把根因让位给噪声：门禁报了失败却没报原因，
 * 派活口径直接失真（「该谁修」答不出来）。修复后摘要必须优先提取
 * PlaywrightError 根因行；命中已知浏览器缺失模式时附上修法。
 */
log('=== H20) CLI 失败摘要：根因行优先，daemonPid 噪声让位 ===');
{
  // 样本取自真实故障输出（Windows 无 Chrome、无通道配置时的 daemon 崩溃）
  const realNoise = [
    'Error: Daemon pid=18264: Daemon process exited with code 1',
    "[PlaywrightError: Chromium distribution 'chrome' is not found at C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    'Run "npx playwright install chrome"] {',
    '  log: []',
    '}',
    '    at ChildProcess.<anonymous> (node:internal/child_process)',
    '  daemonPid: 18264',
  ].join('\n');
  const s1 = extractRootCause(realNoise, '');
  check('H20 PlaywrightError 根因优先于堆栈噪声（不被 daemonPid 淹没）',
    s1.includes("Chromium distribution 'chrome' is not found") && !s1.includes('daemonPid'),
    s1);
  check('H20 已知浏览器缺失模式附修法（setup-cli-config / playwright install 二选一）',
    s1.includes('setup-cli-config') && s1.includes('npx playwright install chrome'));

  const s2 = extractRootCause('Error: Daemon pid=1: Daemon process exited with code 7\n    at x (y)\n    daemonPid: 1', '');
  check('H20 无 PlaywrightError 时提首个 Error 行（仍是根因方向，不是尾部噪声）',
    s2.startsWith('Daemon pid=1: Daemon process exited with code 7') && !s2.includes('at x'),
    s2);

  const s3 = extractRootCause('line-a\nline-b\nline-c', '');
  check('H20 无任何 Error 行时回退尾部行（原兜底行为不变）',
    s3.split('\n').length === 3 && s3.endsWith('line-c'), s3);

  // 崩溃取证（2026-10 实测踩过）：套件进程 0xC0000409 崩溃时一行 FAIL 都没有，
  // 旧口径 detail 只剩「? 项失败（退出码 …）」、stderr 里的 FATAL ERROR 整段丢弃 ——
  // 偶发崩溃查不出根因，门禁报了失败却没留证据。归类在 suites.summarizeSuiteExit，
  // 这里钉住两个方向：有 FAIL 行 FAIL 优先（断言取证不被尾部顶掉），
  // 无 FAIL 行的异常退出保留输出尾部（崩溃根因不丢）。
  const { summarizeSuiteExit } = await import('./suites.mjs');
  const crashCls = summarizeSuiteExit(3221226505,
    'PASS H0 前半段\nPASS H1 中段\n',
    '\nFATAL ERROR: v8::ToLocalChecked Empty MaybeLocal\n----- Native stack trace -----\n');
  const failCls = summarizeSuiteExit(1, 'FAIL 用例 A 断言炸了\nPASS 用例 B\n', '');
  check('H20 退出取证：FAIL 行优先，崩溃（无 FAIL 行）保留输出尾部不丢根因',
    crashCls.detail.includes('无 FAIL 行')
    && crashCls.failedLines.some((l) => l.includes('FATAL ERROR'))
    && crashCls.failedLines.some((l) => l.includes('Native stack'))
    && failCls.detail.startsWith('1 项失败')
    && failCls.failedLines.length === 1 && failCls.failedLines[0].startsWith('FAIL'),
    crashCls.detail);
}

/* ---------------- H21:并行调度与收尾不得静默回归 ---------------- */
/*
 * --parallel 的安全性完全依赖三件事，全都是「不报错但结论错」的静默面：
 *   1) 调度结构：部署副本验证（整树哈希比对）必须独占末波 —— 与任何写盘并发都会报假漂移；
 *   2) 套件收尾只关自己的会话：close-all 会把并发兄弟套件的会话一起杀掉（实测踩踏面）；
 *   3) harness 收尾统一 kill-all 收割孤儿浏览器：残留句柄会让 distribute 的 rmSync 报 EPERM（实测踩过）。
 * 另钉临时生成目录（args-check 的 demo/generated-argscheck）进三处排除表 ——
 * 它在并行波内正建正删，漏排除就是「偶发假漂移/偶发打包失败」。
 * 这些被「优化」掉的症状都是偶发假失败，最难查的回归类，所以机械钉住而不是靠注释。
 */
log('=== H21) 并行调度与收尾不得静默回归 ===');
{
  const { SUITES, planWaves } = await import('./suites.mjs');
  const waves = planWaves(SUITES);
  const last = waves[waves.length - 1];
  check('H21 部署副本验证独占末波（整树比对不容并发写入）',
    waves.length >= 2 && last.length === 1 && last[0].file.includes('deployed-check'),
    `波次 ${waves.map((w) => w.length).join('+')}`);
  check('H21 其余套件同波（并发收益不被误砍）',
    waves[0].length === SUITES.length - 1 && !waves[0].some((s) => s.file.includes('deployed-check')),
    `首波 ${waves[0].length}/${SUITES.length - 1}`);

  const nlSrc = fs.readFileSync(path.join(ROOT, 'mcp/test/nl-agent-e2e.mjs'), 'utf8');
  check('H21 套件收尾只关自己的会话（close-all 会杀并发兄弟会话）',
    !/subcommand:\s*'close-all'/.test(nlSrc) && nlSrc.includes('usedSessions'),
    /subcommand:\s*'close-all'/.test(nlSrc) ? 'nl-agent-e2e 仍在调 close-all' : '按 usedSessions 逐个 close');

  const vaSrc = fs.readFileSync(path.join(ROOT, 'mcp/test/verify-all.mjs'), 'utf8');
  const reapAt = vaSrc.indexOf("subcommand: 'kill-all'");
  check('H21 harness 收尾 kill-all 收割孤儿，且先于产物清理（防 rmSync EPERM 回潮）',
    reapAt !== -1 && reapAt < vaSrc.indexOf('ARTIFACT_DIRS.filter'),
    reapAt === -1 ? 'verify-all 收尾缺 kill-all' : 'kill-all 在产物清理之前');

  const distSrc = fs.readFileSync(path.join(ROOT, 'skill/playwright-verify/scripts/distribute.mjs'), 'utf8');
  const depSrc = fs.readFileSync(path.join(ROOT, 'mcp/test/deployed-check.mjs'), 'utf8');
  check('H21 临时生成目录三处排除（分发/整树比对/收尾清理，防并行波内建删成假漂移）',
    distSrc.includes("'generated-argscheck'") && depSrc.includes("'generated-argscheck'")
    && vaSrc.includes("'demo/generated-argscheck'"),
    'distribute / deployed-check / verify-all 排除表');
}

/* ---------------- H22:断言数单一源与 CI 定义不得漂移 ---------------- */
/*
 * README 套件表、§15.3 判据行、verify-all 判据各抄一份断言数的话，漂移是静默的：
 * 改了套件忘了文档 → 读者拿错数；改了声明忘了判据 → 「一致 ✅」变成空话。
 * 所以数字只有一个源：suites.mjs 的声明字段（assertions / assertionsNoDep / dotPins），
 * 其余全部机械对账 —— README 表逐行对声明；verify-all 真的逐套校验（接线在位）；
 * 声明字段自身完备（缺字段会静默用错基准数）；expectedAssertions 环境矩阵行为正确
 * （混合态不校验、. 前缀钉按在位加）；CI 工作流三 job 定义与 §15.3 口径一致
 * （CI 是判据的常驻执行者，定义漂移 = 三态验收悄悄缩水）。
 */
log('=== H22) 断言数单一源与 CI 定义不得漂移 ===');
{
  const { SUITES, expectedAssertions, PIN_FILES } = await import('./suites.mjs');

  // 1) README 套件表逐行断言数 == 声明（表格是给人看的那份「数」）
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const tIdx = readme.indexOf('| 套件 | 验证什么 | 断言数 |');
  const rows = [];
  if (tIdx !== -1) {
    for (const l of readme.slice(tIdx).split('\n')) {
      if (l.trim().startsWith('|')) rows.push(l);
      else if (rows.length) break;
    }
  }
  const tableNums = rows.slice(2)
    .map((l) => l.split('|').map((c) => c.trim()).filter(Boolean).pop());
  const declared = SUITES.map((s) => String(s.assertions));
  check('H22 README 套件表断言数与 suites.mjs 声明逐行一致（末行为矩阵形态）',
    tableNums.length === SUITES.length + 1
    && declared.every((n, i) => tableNums[i] === n)
    && /矩阵/.test(tableNums[SUITES.length] || ''),
    `表 ${tableNums.join('/') || '(无)'} / 声明 ${declared.join('/')}`);

  // 2) verify-all 逐套校验接线在位 —— 只导出不调用等于没对账
  const vaSrc = fs.readFileSync(path.join(ROOT, 'mcp/test/verify-all.mjs'), 'utf8');
  check('H22 verify-all 逐套件断言数校验接线在位（数字单一源真被对账）',
    vaSrc.includes('expectedAssertions') && vaSrc.includes('countDrift') && vaSrc.includes('coreCounts'),
    'expectedAssertions / countDrift / coreCounts 在位');

  // 3) 声明字段完备：browser 套件零依赖态部分执行必须声明 assertionsNoDep，
  //    否则 expectedAssertions 会静默拿全量数当基准去比零依赖态的半截结果
  const badDecls = SUITES.filter((s) => !Number.isInteger(s.assertions) || s.assertions <= 0
    || (s.dotPins !== undefined && (!Number.isInteger(s.dotPins) || s.dotPins < 0 || s.dotPins > s.assertions))
    || (s.browser && !s.needs && !Number.isInteger(s.assertionsNoDep)));
  check('H22 声明字段完备（缺字段会静默用错基准数）',
    badDecls.length === 0, badDecls.length ? badDecls.map((s) => s.name).join(', ') : `${SUITES.length} 套声明完备`);

  // 4) expectedAssertions 纯函数环境矩阵：全量/零依赖/混合三态 × 存在性钉在位数
  const dotted = SUITES.find((s) => s.dotPins);
  check('H22 expectedAssertions 环境矩阵行为正确（混合态不校验、存在性钉按在位数加）',
    !!dotted && PIN_FILES.length === dotted.dotPins
    && expectedAssertions(dotted, { fullDeps: true, noDeps: false, pins: 0 }) === dotted.assertions
    && expectedAssertions(dotted, { fullDeps: true, noDeps: false, pins: dotted.dotPins }) === dotted.assertions + dotted.dotPins
    && expectedAssertions(dotted, { fullDeps: false, noDeps: true, pins: 1 }) === dotted.assertions + 1
    && expectedAssertions(dotted, { fullDeps: true, noDeps: true, pins: 0 }) === null,
    `纯函数环境矩阵（PIN_FILES ${PIN_FILES.length} == dotPins ${dotted ? dotted.dotPins : '?'}）`);

  // 5) CI 工作流三 job 定义与判据口径一致（缺 job/漏命令 = 三态验收悄悄缩水）。
  //    存在性守卫（同 H10/H14）：纯净发布包按口径不含 . 前缀内容，包里诚实 SKIP 不误报缺失。
  const ciPath = path.join(ROOT, '.github', 'workflows', 'ci.yml');
  if (fs.existsSync(ciPath)) {
    const ciSrc = fs.readFileSync(ciPath, 'utf8');
    const jobBlock = (name) => {
      const m = new RegExp(`^  ${name}:`, 'm').exec(ciSrc);
      if (!m) return '';
      const rest = ciSrc.slice(m.index + m[0].length);
      const next = /^ {2}\S/m.exec(rest);
      return rest.slice(0, next ? next.index : undefined);
    };
    const zero = jobBlock('zero-dep');
    const full = jobBlock('full');
    const gate = jobBlock('release-gate');
    check('H22 CI 三 job 在位且口径不漂移（零依赖裸跑 mode 1/2、双平台全量 mode 3、门禁 needs 双 job）',
      !!zero && !/run:.*npm ci/.test(zero) && /--mode 1/.test(zero) && /--mode 2/.test(zero)
      && /run:.*npm ci/.test(full) && /npx playwright install/.test(full) && /install-browser/.test(full)
      && /--mode 3/.test(full) && /ubuntu-latest/.test(full) && /windows-latest/.test(full)
      && /distribute\.mjs/.test(gate) && /needs:\s*\[[^\]]*zero-dep[^\]]*full[^\]]*\]/.test(gate),
      'zero-dep（裸跑）/ full（双平台+双装浏览器）/ release-gate（distribute）');
  } else {
    log('SKIP  CI 三 job 定义（纯净发布包不含 . 前缀内容 —— 该钉在源码树验证）');
  }
}

log('=== H23) 安装器镜像式复制：陈旧残留默认自愈，--force 整目录重置 ===');
{
  // 沙箱真装：USERPROFILE/HOME 重定向到临时目录 —— install.mjs 的 INSTALL_ROOT、
  // SKILL_LINK、客户端注册全部落进沙箱，不碰真机部署副本。
  const os = await import('node:os');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-install-h23-'));
  const sInstall = path.join(tmpHome, '.agents', 'skills', 'playwright-verify-mcp');
  const sSkill = path.join(tmpHome, '.agents', 'skills', 'playwright-verify');
  const staleA = path.join(sInstall, 'mcp', 'lib', 'stale-old.js');
  const staleB = path.join(sSkill, 'references', 'stale-old.md');
  const stray = path.join(sInstall, 'my-notes.txt');
  // 预置旧账：假装上一版留下了这些文件（源码已删、部署副本还留的形态）+ 用户杂散根文件
  fs.mkdirSync(path.join(sInstall, 'mcp', 'lib'), { recursive: true });
  fs.writeFileSync(staleA, '// stale');
  fs.mkdirSync(path.join(sSkill, 'references'), { recursive: true });
  fs.writeFileSync(staleB, '# stale');
  fs.writeFileSync(stray, 'user file');
  const instEnv = { ...process.env, USERPROFILE: tmpHome, HOME: tmpHome };
  const r1 = spawnSync(process.execPath, [path.join(ROOT, 'skill', 'playwright-verify', 'install.mjs')],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: instEnv });
  const ok1 = r1.status === 0 && (r1.stdout || '').includes('INSTALL_STATUS=OK');
  check('H23 沙箱默认安装成功（镜像式：先清后拷）', ok1,
    ok1 ? 'INSTALL_STATUS=OK' : `status=${r1.status} ${(r1.stderr || '').slice(0, 100)}`);
  check('H23 默认安装清掉两处陈旧残留（部署副本子树 + 现役 Skill 目录），新文件在位，用户杂散根文件不动',
    !fs.existsSync(staleA) && !fs.existsSync(staleB)
    && fs.existsSync(path.join(sInstall, 'mcp', 'server.mjs'))
    && fs.existsSync(path.join(sSkill, 'SKILL.md'))
    && fs.existsSync(stray),
    `deploy-stale=${fs.existsSync(staleA)} skill-stale=${fs.existsSync(staleB)} stray=${fs.existsSync(stray)}`);
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'skill', 'playwright-verify', 'install.mjs'), '--force'],
    { cwd: ROOT, encoding: 'utf8', timeout: 600000, env: instEnv });
  check('H23 --force 整目录重置：杂散根文件被清、安装仍成功（node_modules 重拷）',
    r2.status === 0 && (r2.stdout || '').includes('INSTALL_STATUS=OK')
    && !fs.existsSync(stray) && fs.existsSync(path.join(sInstall, 'mcp', 'server.mjs')),
    `status=${r2.status} stray=${fs.existsSync(stray)}`);
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

log('');
log(failures === 0 ? '加固回归全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
