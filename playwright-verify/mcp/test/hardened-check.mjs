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
 *   H16 版本/文档同步：版本号唯一源 package.json，三份文档的版本记录与自然语言使用示例缺一即发版未完成
 *   H17 智能体线守门：凭据只走环境变量、危险目标拒绝表非空、白名单外动作不静默丢弃
 *   H18 纯净发布包口径：实跑 distribute 验产物 —— 无 node_modules、无 . 前缀内容
 *   H19 发版门禁：distribute 收尾自动一次性副本 verify-all + 终态哈希终查（发版不可能忘）
 *   H20 CLI 失败摘要：根因行优先于堆栈噪声（daemon 崩溃时不能只剩 daemonPid）
 *   H21 并行调度与收尾：部署副本独占末波、非 serial 按并发帽分波、只关自己的会话、kill-all 先于产物清理
 *   H22 断言数单一源：suites.mjs 声明是唯一真相，README 表/§15.3/verify-all/CI 全部机械对账
 *   H23 安装器镜像式复制：陈旧残留默认自愈，--force 整目录重置，用户杂散文件不动
 *   H24 浏览器缺失分类与通道自愈契约：缺浏览器归 env 不落 unknown、stale-exec-pin 决策规则不漂移
 *   H25 零依赖口径只认副本本地：机器级全局不得污染判定与诚实报缺
 *   H26 成功判定要证据不只退出码：假 CLI 不得「已落盘」假绿（产物在场/非空/魔数/自报信封）
 *   H27 崩溃具名：已知原生崩溃码给可读名（双形态归一），未知码不编造，非崩溃不误标
 *   H28 排除口径单一源：五面从 mcp/lib/exclude.js 派生 + fixture 哨兵（源文件不误杀/产物不漏排）
 *   H29 判据基数 serial 解耦：serialAssertions 求和与 planWaves 同源，find 单取即回归
 *   H30 崩溃/异常退出现场落盘：决策/写盘/自修剪 + verify-all 接线 + bundle 不进收尾清理（证据不被全绿抹掉）
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

  // 陈旧 executablePath 钉：机器生成配置里的路径钉会静默锁死通道（真机实测：
  // launchOptions.executablePath 顶掉 channel；顶层 executablePath 是死字段假钉，
  // 缓存一删就崩而报错不像配置问题）。机器生成物可安全重生成；手工配置含钉是
  // 用户显式意图（自定义构建路径），保留不动。
  const staleTop = { _说明: '由 setup-cli-config.mjs 生成。', _平台: 'win32 (x64)',
    browser: { browserName: 'chromium', executablePath: 'C:/cache/chromium-1243/chrome.exe' } };
  const staleLaunch = { _说明: '由 setup-cli-config.mjs 生成。', _平台: 'win32 (x64)',
    browser: { browserName: 'chromium', launchOptions: { executablePath: 'C:/cache/chromium-1243/chrome.exe' } } };
  const handPinned = { browser: { browserName: 'chromium', launchOptions: { executablePath: 'D:/custom/chrome.exe' } } };
  check('H13 机器生成配置残留顶层 executablePath（死字段假钉）→ 重新生成（stale-exec-pin）',
    decideCliConfig({ cfg: staleTop, platform: 'win32' }).action === 'regenerate'
    && decideCliConfig({ cfg: staleTop, platform: 'win32' }).reason === 'stale-exec-pin');
  check('H13 机器生成配置残留 launchOptions.executablePath（会顶掉 channel）→ 重新生成（stale-exec-pin）',
    decideCliConfig({ cfg: staleLaunch, platform: 'win32' }).action === 'regenerate'
    && decideCliConfig({ cfg: staleLaunch, platform: 'win32' }).reason === 'stale-exec-pin');
  check('H13 手工配置含 executablePath → 原样保留（用户显式意图优先于猜）',
    decideCliConfig({ cfg: handPinned, platform: 'win32' }).action === 'keep');
  check('H13 机器生成 channel 式配置同平台 → 保留（不无谓重写）',
    decideCliConfig({ cfg: gened('win32'), platform: 'win32' }).action === 'keep'
    && decideCliConfig({ cfg: gened('linux'), platform: 'linux' }).action === 'keep');
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
  // r40 排除口径单一源：字面量收敛进 mcp/lib/exclude.js，三面 import 派生 ——
  // 钉改为「单一源有条目 + 三面接线在位」，语义不变（四层排除一个不能漏）。
  const excludeSrc = read('mcp/lib/exclude.js');
  const wired = (src) => src.includes('lib/exclude.js');
  check('H14 install 不复制 __pycache__（否则字节码被带进部署副本）',
    excludeSrc.includes("'__pycache__'") && wired(install));
  check('H14 纯净分发版排除 __pycache__ 与 *.pyc',
    excludeSrc.includes("'__pycache__'") && excludeSrc.includes('\\.pyc') && wired(distribute));
  check('H14 全树比对忽略 __pycache__（否则跨目录重编译误报漂移）',
    excludeSrc.includes("'__pycache__'") && wired(deployed));
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
 * （server 运行时读它，不另存副本）、三份文档都带当前版本号与两节固定内容
 * （版本记录 + 自然语言使用示例）、**每份**文档的版本记录首条都是当前版本且
 * 不写超前版本号（「README 更新了、别的文档忘了」是实测常态）、
 * §15.3 判据行的核心数与 suites.mjs 的 coreCounts 同步（判据行与代码漂移=判据形同虚设）。
 */
log('=== H16) 版本/文档同步（缺一处即发版未完成）===');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const V = String(pkg.version || '');
  const docs = ['README.md', '部署说明.md', 'skill/playwright-verify/SKILL.md'];
  const texts = new Map(docs.map((d) => [d, fs.readFileSync(path.join(ROOT, d), 'utf8')]));
  // 版本记录节切片：从「## 版本记录」标题到下一个二级标题/文末（正文里提到「版本记录」的散文不算）
  const recordSection = (t) => {
    const m = /\n## 版本记录/.exec(t);
    if (!m) return '';
    const next = t.indexOf('\n## ', m.index + 5);
    return t.slice(m.index, next === -1 ? undefined : next);
  };

  const missingVer = docs.filter((d) => !texts.get(d).includes(`v${V}`));
  check('H16 三份文档都带当前版本号（唯一源 package.json）',
    /^\d+\.\d+\.\d+$/.test(V) && missingVer.length === 0,
    `v${V}${missingVer.length ? ` 缺：${missingVer.join(', ')}` : ' 全部在位'}`);

  const missingRecord = docs.filter((d) => !texts.get(d).includes('版本记录'));
  check('H16 三份文档都有「版本记录」节（版本说明同步落点）',
    missingRecord.length === 0, missingRecord.length ? `缺：${missingRecord.join(', ')}` : '全部在位');

  const missingNl = docs.filter((d) => !texts.get(d).includes('自然语言使用示例'));
  check('H16 三份文档都有「自然语言使用示例」（说人话就能用）',
    missingNl.length === 0, missingNl.length ? `缺：${missingNl.join(', ')}` : '全部在位');

  // 每份文档的版本记录首条都得是当前版本 —— 只查 README 不够：实测常态是
  // 「README 更新了、另外两份忘了」，读者拿的往往是部署/安装文档而不是 README。
  const staleFirst = [];
  for (const [d, t] of texts) {
    const first = (recordSection(t).match(/v(\d+\.\d+\.\d+)/) || [])[1];
    if (first !== V) staleFirst.push(`${d}(${first || '无'})`);
  }
  check('H16 三份文档版本记录首条都是当前版本（记录跟得上版本）',
    staleFirst.length === 0, staleFirst.length ? staleFirst.join(', ') : `三份首条均为 v${V}`);

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
    ahead.length === 0, ahead.length ? ahead.join(', ') : '三份均无超前');

  // 判据行与代码的 CORE 漂移是静默的：verify-all 自己按 CORE 判「一致 ✅」，
  // 文档里那行数没人复核 —— 所以让机器来对：§15.3 核心数 == suites.mjs 的 coreCounts（数字单一源）。
  const { coreCounts } = await import('./suites.mjs');
  const core = coreCounts();
  const codeVals = [core[1], core[2], core[3]].map(String);
  const docLine = /核心断言 mode 1 = (\d+)、mode 2 = (\d+)、mode 3 = (\d+)/.exec(texts.get('部署说明.md'));
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

  const depDoc = fs.readFileSync(path.join(ROOT, '部署说明.md'), 'utf8');
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
 * --parallel 的安全性完全依赖调度形状与两件收尾事，全都是「不报错但结论错」的静默面：
 *   1) 调度形状：部署副本验证（整树哈希比对）必须独占末波 —— 与任何写盘并发都会报假漂移；
 *      非 serial 套件按并发帽分波（每波 ≤ MAX_WAVE）—— 全部同波就是 9~14 个 Node 进程的
 *      启动风暴，2026-10 实测 8 跑 2 损伤（0xC0000409 fail-fast 打崩 bridge-check、
 *      protocol-check 的 cli_health 最小闭环被并发挤兑假红，非代码回归）；
 *   2) 套件收尾只关自己的会话：close-all 会把并发兄弟套件的会话一起杀掉（实测踩踏面）；
 *   3) harness 收尾统一 kill-all 收割孤儿浏览器：残留句柄会让 distribute 的 rmSync 报 EPERM（实测踩过）。
 * 另钉临时生成目录（args-check 的 demo/generated-argscheck）进三处排除表 ——
 * 它在并行波内正建正删，漏排除就是「偶发假漂移/偶发打包失败」。
 * 这些被「优化」掉的症状都是偶发假失败，最难查的回归类，所以机械钉住而不是靠注释。
 */
log('=== H21) 并行调度与收尾不得静默回归 ===');
{
  const { SUITES, planWaves, MAX_WAVE } = await import('./suites.mjs');
  const waves = planWaves(SUITES);
  const last = waves[waves.length - 1];
  check('H21 部署副本验证独占末波（整树比对不容并发写入）',
    waves.length >= 2 && last.length === 1 && last[0].file.includes('deployed-check'),
    `波次 ${waves.map((w) => w.length).join('+')}`);
  // 波形状契约（2026-10 修）：旧口径「其余全部第一波」正是启动风暴的来源。
  // 并发帽分波要同时成立四个方向：不超帽、波数最小化（不退化成一队一波，保住并发收益）、
  // 非 serial 全员进波、deployed-check 不混进任何非末波。
  const rest = SUITES.filter((s) => !s.serial);
  const planned = waves.slice(0, -1);
  check('H21 非 serial 按并发帽分波（每波 ≤ 帽、波数最小化、不退化成一队一波）',
    planned.every((w) => w.length > 0 && w.length <= MAX_WAVE)
    && planned.length === Math.ceil(rest.length / MAX_WAVE)
    && planned.flat().length === rest.length
    && !planned.flat().some((s) => s.file.includes('deployed-check')),
    `波次 ${waves.map((w) => w.length).join('+')}，帽 ${MAX_WAVE}`);
  check('H21 分波保持声明顺序（串行模式逐波逐序 == 纯串行的前提）',
    waves.flat().map((s) => s.file).join('|') === SUITES.map((s) => s.file).join('|'),
    'flat 顺序与声明顺序不一致');
  check('H21 并发帽常数合理（整数 ≥2），非法 maxWave 回退默认不静默改语义',
    Number.isInteger(MAX_WAVE) && MAX_WAVE >= 2
    && planWaves(SUITES, { maxWave: 0 }).length === waves.length
    && planWaves(SUITES, { maxWave: 2.5 }).length === waves.length
    && planWaves(SUITES, { maxWave: 2 }).length === Math.ceil(rest.length / 2) + 1,
    `MAX_WAVE=${MAX_WAVE}`);

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
  // r40 排除口径单一源：distribute/deployed-check 的排除表派生自 exclude.js，
  // verify-all 的 ARTIFACT_DIRS 是路径清单（形态不同）独立维护 —— 三处缺一不可。
  const exSrc = fs.readFileSync(path.join(ROOT, 'mcp', 'lib', 'exclude.js'), 'utf8');
  check('H21 临时生成目录三处排除（分发/整树比对/收尾清理，防并行波内建删成假漂移）',
    exSrc.includes("'generated-argscheck'")
    && distSrc.includes('lib/exclude.js') && depSrc.includes('lib/exclude.js')
    && vaSrc.includes("'demo/generated-argscheck'"),
    '单一源条目 + distribute/deployed-check 派生接线 + verify-all 路径清单独立');
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

log('=== H24) 浏览器缺失分类与通道自愈契约不能漂移 ===');
/*
 * 为什么钉这个：cli_health 的自愈闭环只该修「环境缺浏览器」，绝不该把断言失败/
 * 超时/CLI 未装也当成缺浏览器去重写配置（那会把别的失败掩盖成「换了个浏览器
 * 还是失败」）。签名识别的三条形态全部来自真机实测 —— 夹具就是当时的真实报错
 * 原文（含 daemon 噪声行在前的形态，分类必须不受噪声行干扰）。
 */
{
  const { matchBrowserMissing } = await import('../lib/cli.js');
  const realDaemonNoiseThenMissing = 'Error: Daemon pid=30584: Daemon process exited with code 1\n'
    + 'Error: Browser "chromium" is not installed; expected executable at '
    + 'C:\\Users\\x\\AppData\\Local\\Temp\\empty-browsers\\chromium_headless_shell-1243\\'
    + 'chrome-headless-shell-win64\\chrome-headless-shell.exe. Run `playwright-cli install-browser chromium` to install';
  const realExecPinMissing = '[PlaywrightError: Failed to launch chromium because executable doesn\'t exist at '
    + 'C:/no-such/chromium-999/chrome-win64/chrome.exe]';
  const realDistMissing = "[PlaywrightError: Chromium distribution 'chrome' is not found at "
    + 'C:\\Users\\x\\AppData\\Local\\ms-playwright\\chrome-1243]';

  const m1 = matchBrowserMissing(realDaemonNoiseThenMissing);
  const m2 = matchBrowserMissing(realExecPinMissing);
  const m3 = matchBrowserMissing(realDistMissing);
  check('H24 三类浏览器缺失签名全命中分类（含缓存被清的真实报错形态，daemon 噪声行不干扰）',
    m1?.kind === 'browser-not-installed' && m1.dist === 'chromium'
    && m2?.kind === 'executable-missing'
    && m3?.kind === 'distribution-not-found' && m3.dist === 'chrome',
    `m1=${m1?.kind} m2=${m2?.kind} m3=${m3?.kind}`);
  check('H24 非浏览器缺失类失败不误分类（断言失败/超时/CLI 未装 都不该触发通道自愈）',
    matchBrowserMissing('expect(locator).toBeVisible() failed: locator resolved to 0 elements') === null
    && matchBrowserMissing('Error: Timeout 30000ms exceeded while waiting for navigation') === null
    && matchBrowserMissing('找不到 playwright-cli。请先执行：npm i -g @playwright/cli@latest') === null
    && matchBrowserMissing('') === null);
  // 自愈重写的内容契约：channel 走平台默认、任一层级都绝不写 executablePath ——
  // 路径钉正是本轮诊断出的「顶掉 channel / 死字段假钉」根源（E4/E5/E6 实测）。
  const { pickChannel, buildCliConfig } = await import('../../skill/playwright-verify/scripts/cli-config.mjs');
  const healed = buildCliConfig({ platform: 'win32', arch: 'x64', ...pickChannel({ platform: 'win32', envChannel: undefined }) });
  check('H24 自愈重写内容契约：channel 取平台默认且任一层级无 executablePath',
    healed.browser?.launchOptions?.channel === 'msedge'
    && healed.browser?.executablePath === undefined
    && healed.browser?.launchOptions?.executablePath === undefined
    && typeof healed._说明 === 'string' && healed._说明.includes('setup-cli-config'));
}

log('=== H25) 零依赖口径只认副本本地（机器级全局不得污染判定与诚实报缺）===');
/*
 * 为什么钉这个：@playwright/cli「由本机提供、装法 npm i -g」是执行契约（部署说明），
 * 但零依赖判定（mode 2 预检 / 套件 SKIP / cli_health 诚实报缺）一旦也认机器全局，
 * 装了全局 shim 的开发机就永远验不了纯净包形态 —— 实测三面：发版门禁嵌套 mode 2
 * 预检顶红（永不可绿）、净树 cli_health 被坏全局顶替成「超时无响应」、逐套件对账
 * 在混合态下静默跳过（假绿面）。修法把判定面与执行面分开：PVMCP_LOCAL_ONLY_DEPS=1
 * 只认副本本地（verify-all 全程置位），默认仍兜底机器全局（真实用户契约原样）。
 * 三条钉分别钉住「开关生效」「诚实报缺不被顶替」「默认契约不变」。
 */
{
  const { resolveCliRunner } = await import('../lib/runner.js');
  // 伪全局：镜像 npm 全局布局（PATH 目录的兄弟目录 @playwright/cli/playwright-cli.js）。
  // 没装真全局的机器（CI 零依赖 job）也能观察到兜底行为 —— 钉不依赖开发机状态。
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-h25-global-'));
  const fakeBin = path.join(fakeRoot, 'bin');
  const fakeCli = path.join(fakeRoot, '@playwright', 'cli', 'playwright-cli.js');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
  fs.writeFileSync(fakeCli, 'process.exit(0);\n');
  const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-h25-cwd-'));
  const savedPath = process.env.PATH;
  const savedKnob = process.env.PVMCP_LOCAL_ONLY_DEPS;
  try {
    process.env.PATH = fakeBin + path.delimiter + savedPath;
    process.env.PVMCP_LOCAL_ONLY_DEPS = '1';
    const scoped = resolveCliRunner(emptyCwd);
    check('H25 验收口径只认副本本地：机器级全局在位仍解析不到（零依赖判定不被机器状态污染）',
      scoped === null, scoped ? `误解析到 ${scoped.how}` : 'null');
    const health = await handleMessage({
      jsonrpc: '2.0', id: 9025, method: 'tools/call',
      params: { name: 'cli_health', arguments: { cwd: emptyCwd } },
    });
    const hTxt = JSON.stringify(health?.result?.structuredContent || {}) + (health?.result?.content?.[0]?.text || '');
    check('H25 cli_health 诚实报缺不被机器级全局顶替（纯净包口径）',
      health?.result?.isError === true && /CLI_NOT_INSTALLED|找不到 playwright-cli/.test(hTxt),
      hTxt.split('\n')[0].slice(0, 80));
    delete process.env.PVMCP_LOCAL_ONLY_DEPS;
    const fallback = resolveCliRunner(emptyCwd);
    check('H25 默认（无开关）仍兜底机器级全局 —— 执行契约向后兼容（npm i -g 装法不破坏）',
      !!fallback && String(fallback.how).includes('playwright-cli'), fallback ? String(fallback.how) : 'null');
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedKnob === undefined) delete process.env.PVMCP_LOCAL_ONLY_DEPS; else process.env.PVMCP_LOCAL_ONLY_DEPS = savedKnob;
    try { fs.rmSync(fakeRoot, { recursive: true, force: true }); fs.rmSync(emptyCwd, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
}

log('=== H26) 成功判定要证据，不只退出码（假 CLI 不得出「已落盘」假绿）===');
/*
 * 为什么钉这个：runCli 旧判定只看退出码 + 超时，而「快照已落盘：<路径>」的摘要
 * 只引用**声明路径**、从不验文件在场 —— 裸 `process.exit(0)` 的假 CLI 能骗出
 * 「CLI 最小闭环通过」的整套假绿（r36 咬合实录 + r37 复现台双证：ok:true 而
 * claimedExists:false）。退出码 0 只说明进程活着回来，不说明活干了。
 * 修法：证据面判据全用结构事实（产物在场/非空/png·pdf 魔数/快照 ref=eN 标记/
 * CLI 自报 isError 信封），不用措辞匹配；open/close 等无产物子命令保持退出码契约。
 * 桩放在 cwd/node_modules/@playwright/cli/playwright-cli.js —— 本地解析第一优先
 * （runner.js resolveCliRunner），与机器全局/PATH 状态无关，任何机器上钉的语义一致。
 */
{
  const { runCli, cliHealthCheck } = await import('../lib/cli.js');
  const stubCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-h26-cwd-'));
  const stubDir = path.join(stubCwd, 'node_modules', '@playwright', 'cli');
  const stubPath = path.join(stubDir, 'playwright-cli.js');
  fs.mkdirSync(stubDir, { recursive: true });
  // 生成「伪 CLI」：exit 0 + 按 --filename 写产物（或不写），stdout 可注入
  const writeStub = ({ write = null, writeExpr = null, stdout = '' }) => {
    const lines = [
      "const fs = require('fs');",
      "const i = process.argv.indexOf('--filename');",
      'const p = i >= 0 ? process.argv[i + 1] : null;',
    ];
    if (writeExpr) lines.push(`if (p) fs.writeFileSync(p, ${writeExpr});`);
    else if (write !== null) lines.push(`if (p) fs.writeFileSync(p, ${JSON.stringify(write)});`);
    lines.push(`process.stdout.write(${JSON.stringify(stdout)});`);
    lines.push('process.exit(0);');
    fs.writeFileSync(stubPath, `${lines.join('\n')}\n`);
  };
  const claimOf = (r) => r?.artifacts?.snapshot || r?.artifacts?.file || '';
  try {
    // 1) 裸 exit(0)：什么都没写 —— 必须诚实失败，摘要不得谎称已落盘
    writeStub({});
    const bare = await runCli({ cwd: stubCwd, session: 'h26', subcommand: 'snapshot', args: [] });
    check('H26 裸 exit(0) 无产物 → snapshot 诚实失败 ARTIFACT_MISSING，摘要不再谎称已落盘',
      bare.ok === false && bare.reason === 'ARTIFACT_MISSING'
      && !/快照已落盘/.test(bare.summary || '') && /不存在/.test(bare.summary || ''),
      `ok=${bare.ok} reason=${bare.reason} summary=${String(bare.summary).slice(0, 60)}`);

    // 2) 空文件产物：exit 0 + 写了个空文件 —— 不算数
    writeStub({ write: '' });
    const empty = await runCli({ cwd: stubCwd, session: 'h26', subcommand: 'snapshot', args: [] });
    check('H26 空产物文件不算数（exit 0 + 空文件 → ARTIFACT_MISSING）',
      empty.ok === false && empty.reason === 'ARTIFACT_MISSING' && /为空/.test(empty.summary || ''),
      `reason=${empty.reason} summary=${String(empty.summary).slice(0, 60)}`);

    // 3) 形状不对的快照：非空但没有 ref=eN 标记 —— 不是真快照
    writeStub({ write: 'hello world\n' });
    const junk = await runCli({ cwd: stubCwd, session: 'h26', subcommand: 'snapshot', args: [] });
    check('H26 快照产物形状不对（无 ref=eN 标记）→ ARTIFACT_SHAPE',
      junk.ok === false && junk.reason === 'ARTIFACT_SHAPE' && /ref=eN/.test(junk.summary || ''),
      `reason=${junk.reason} summary=${String(junk.summary).slice(0, 60)}`);

    // 4) 真快照：含 ref=eN 标记 —— 通过且摘要如实
    writeStub({ write: '- button "按钮" [ref=e2]\n' });
    const goodSnap = await runCli({ cwd: stubCwd, session: 'h26', subcommand: 'snapshot', args: [] });
    check('H26 真快照产物（含 ref=eN）仍判通过，摘要如实指路',
      goodSnap.ok === true && goodSnap.reason === 'OK'
      && /快照已落盘/.test(goodSnap.summary || '')
      && goodSnap.summary.includes(claimOf(goodSnap)),
      `ok=${goodSnap.ok} reason=${goodSnap.reason}`);

    // 5) 截图形状：exit 0 + 文本文件 —— 缺 PNG 魔数不是真截图
    writeStub({ write: 'not a png at all' });
    const badShot = await runCli({ cwd: stubCwd, session: 'h26', subcommand: 'screenshot', args: [] });
    check('H26 截图产物缺 PNG 魔数 → ARTIFACT_SHAPE（不是真截图）',
      badShot.ok === false && badShot.reason === 'ARTIFACT_SHAPE' && /PNG 魔数/.test(badShot.summary || ''),
      `reason=${badShot.reason}`);

    // 6) 真截图：PNG 魔数在场 —— 通过
    writeStub({ writeExpr: "Buffer.from('iVBORw0KGgo=', 'base64')" });
    const goodShot = await runCli({ cwd: stubCwd, session: 'h26', subcommand: 'screenshot', args: [] });
    check('H26 真截图产物（PNG 魔数在场）仍判通过',
      goodShot.ok === true && goodShot.reason === 'OK' && /截图已落盘/.test(goodShot.summary || ''),
      `ok=${goodShot.ok} reason=${goodShot.reason}`);

    // 7) CLI 自报失败信封：exit 0 但 stdout 是 isError:true —— 产品层失败宣告不能被吞
    writeStub({ stdout: '{"isError": true, "error": "Error: fake fail"}' });
    const envelope = await runCli({ cwd: stubCwd, session: 'h26', subcommand: 'open', args: ['data:text/html,x'] });
    check('H26 CLI 自报 isError 信封（exit 0）→ CLI_REPORTED_ERROR，不被退出码吞掉',
      envelope.ok === false && envelope.reason === 'CLI_REPORTED_ERROR'
      && /自报失败/.test(envelope.summary || ''),
      `ok=${envelope.ok} reason=${envelope.reason} summary=${String(envelope.summary).slice(0, 60)}`);

    // 8) 标题面：cli_health 最小闭环骗不出「通过」—— 假 CLI 只有假活，失败步指明缺哪步
    writeStub({});
    const health = await cliHealthCheck({ cwd: stubCwd, session: 'h26health' });
    const failedSteps = (health.steps || []).filter((s) => !s.ok).map((s) => s.step);
    check('H26 cli_health 最小闭环被假 CLI 骗不出「通过」（假活不认账，失败步指明缺哪步）',
      health.ok === false && !/最小闭环通过/.test(health.verdict || '')
      && failedSteps.includes('snapshot') && failedSteps.includes('screenshot'),
      `ok=${health.ok} verdict=${String(health.verdict).slice(0, 40)} failed=[${failedSteps.join(',')}]`);
  } finally {
    try { fs.rmSync(stubCwd, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
}

/* ---------------- H27:崩溃必须具名，退出码不能退化成天书 ---------------- */
/*
 * 2026-10 实测：--parallel 启动风暴把 bridge-check 打崩时，汇总只报
 * 「异常退出（退出码 3221226505，无 FAIL 行）」—— 人要自己把 3221226505 换算成
 * 0xC0000409 再查 NTSTATUS 表才知道是 fail-fast，没人会做第二步，崩溃就被当成
 * 「不知道什么随机失败」放过去。修法：summarizeSuiteExit 对**已知**原生崩溃码给可读名。
 * 三分判据：① 已知码必须具名且双形态归一（3221226505 与 -1073740791 是同一个码）；
 * ② 未知码绝不编造名字（保持「异常退出（退出码 N）」原措辞 —— 诚实优于好看）；
 * ③ 普通异常退出（exit 2 等非崩溃码）不许被误标成「进程崩溃」（误报崩溃同样误导排查）。
 */
log('=== H27) 崩溃具名：已知码给可读名，未知码不编造，非崩溃不误标 ===');
{
  const { summarizeSuiteExit, crashLabel } = await import('./suites.mjs');
  const c1 = summarizeSuiteExit(3221226505, '', '\nFATAL ERROR: v8::ToLocalChecked\n');
  const c2 = summarizeSuiteExit(-1073740791, '', '\nFATAL ERROR: v8::ToLocalChecked\n');
  check('H27 已知崩溃码具名（0xC0000409 fail-fast），正负双形态归一同名',
    c1.detail.includes('进程崩溃') && c1.detail.includes('0xC0000409')
    && c1.detail.includes('fail-fast') && c1.detail.includes('无 FAIL 行')
    && c2.detail === c1.detail && crashLabel(3221226505) === crashLabel(-1073740791),
    c1.detail);
  check('H27 崩溃码表覆盖常见原生码（ACCESS_VIOLATION / STACK_OVERFLOW / SIGABRT）',
    String(crashLabel(0xC0000005)).includes('ACCESS_VIOLATION')
    && String(crashLabel(0xC00000FD)).includes('STACK_OVERFLOW')
    && String(crashLabel(134)).includes('SIGABRT'),
    `${crashLabel(0xC0000005)} / ${crashLabel(0xC00000FD)} / ${crashLabel(134)}`);
  const c3 = summarizeSuiteExit(345678, '', '');
  check('H27 未知退出码不编造名字（保持「异常退出」原措辞，不虚报崩溃名）',
    c3.detail === '异常退出（退出码 345678，无 FAIL 行）' && crashLabel(345678) === null,
    c3.detail);
  const c4 = summarizeSuiteExit(2, '', '');
  check('H27 普通异常退出不误标成「进程崩溃」（非崩溃码走原措辞）',
    !c4.detail.includes('进程崩溃') && c4.detail.includes('异常退出')
    && c4.detail.includes('退出码 2'),
    c4.detail);
}

log('=== H28) 排除口径单一源 + fixture 哨兵（三面不误杀源文件/不漏排产物）===');
/*
 * 为什么钉这个：五面各写排除清单时，手工差集会静默假红 —— r38 净树多排 demo 与
 * package-lock.json → 4 套假红蒸发 290 断言（demo 是测试样例/靶场源、lock 在部署
 * 副本比对面）；r40 诊断又抓出 deployed-check 漏 generated-booltest、install 漏
 * generated 系、缺失面零豁免（「失败保留产物」+「重装前产物已清」组合假「丢文件」）
 * 三处差集。哨兵两类都钉死：源文件哨兵必须存活、产物哨兵必须排除。
 */
{
  const ex = await import('../lib/exclude.js');
  check('H28 排除集合恰为三集合并集、无重复（generated-booltest/Temp/scratch 全在，差集已收敛）',
    ex.EXCLUDE_DIRS.length === ex.DEPENDENCY_DIRS.length + ex.ARTIFACT_DIRS.length + ex.SANDBOX_DIRS.length
    && new Set(ex.EXCLUDE_DIRS).size === ex.EXCLUDE_DIRS.length
    && ['generated-booltest', 'Temp', 'scratch', '__pycache__'].every((n) => ex.EXCLUDE_DIRS.includes(n)),
    `共 ${ex.EXCLUDE_DIRS.length} 个`);
  check('H28 排除面不含源文件类（demo/tests 样例、package-lock.json、mcp/skill/extension 绝不进排除口径）',
    ['demo', 'tests', 'mcp', 'skill', 'extension', 'package.json', 'package-lock.json', 'README.md']
      .every((n) => !ex.EXCLUDE_DIRS.includes(n)),
    `排除面：${ex.EXCLUDE_DIRS.join(',')}`);
  {
    const src = ['mcp/server.mjs', 'demo/tests/messy.spec.ts', 'demo/generated-e2e/x.json', 'test-results/a/b.png'];
    const d1 = ex.diffManifests(src, src);
    const d2 = ex.diffManifests(src, ['mcp/server.mjs', 'demo/tests/messy.spec.ts']);
    const d3 = ex.diffManifests(['mcp/server.mjs', 'demo/tests/messy.spec.ts'],
      ['mcp/server.mjs', 'demo/generated-booltest/g.js']);
    check('H28 漂移判定运行时产物双向豁免（源侧产物缺失不报丢、副本侧产物不多余、真源文件漂移照抓）',
      d1.missing.length === 0 && d1.unexpectedExtra.length === 0
      && d2.missing.length === 0
      && d3.unexpectedExtra.length === 0
      && d3.missing.length === 1 && d3.missing[0] === 'demo/tests/messy.spec.ts',
      `d2.missing=${d2.missing.length} d3.missing=${JSON.stringify(d3.missing)}`);
  }
}

log('=== H28b) fixture 哨兵真跑：install 复制面与 nettree 净树面 ===');
{
  const os = await import('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-exclude-h28-'));
  const src = path.join(tmp, 'src');
  const home = path.join(tmp, 'home');
  const put = (rel, content) => {
    const p = path.join(src, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  // 夹具源树：4 个真文件（install/nettree 的 import 依赖）+ 两类哨兵
  put('mcp/lib/exclude.js', fs.readFileSync(path.join(ROOT, 'mcp', 'lib', 'exclude.js'), 'utf8'));
  put('skill/playwright-verify/install.mjs', fs.readFileSync(path.join(ROOT, 'skill', 'playwright-verify', 'install.mjs'), 'utf8'));
  put('skill/playwright-verify/scripts/cli-config.mjs', fs.readFileSync(path.join(ROOT, 'skill', 'playwright-verify', 'scripts', 'cli-config.mjs'), 'utf8'));
  put('skill/playwright-verify/scripts/nettree.mjs', fs.readFileSync(path.join(ROOT, 'skill', 'playwright-verify', 'scripts', 'nettree.mjs'), 'utf8'));
  // 源文件哨兵（r38 坑主角在列）：必须存活进副本/净树
  put('mcp/server.mjs', '// sentinel-src');
  put('skill/playwright-verify/SKILL.md', '# sentinel');
  put('demo/tests/messy.spec.ts', '// sentinel-demo-src');
  put('demo/cases/e2e.xlsx', 'sentinel-xlsx');
  put('extension/manifest.json', '{}');
  put('package.json', '{}');
  put('package-lock.json', '{}');
  put('.gitignore', 'node_modules');
  // 产物/依赖/试验场哨兵：必须被排除
  put('node_modules/foo/index.js', '// dep-sentinel');
  put('demo/generated-booltest/g.js', '// artifact-sentinel');
  put('test-results/z.txt', 'artifact');
  put('Temp/t.mjs', '// sandbox-sentinel');
  put('.git/config', 'git');

  // install 复制面真跑（沙箱 HOME + 夹具树 install.mjs，H23 同构）
  const instEnv = { ...process.env, USERPROFILE: home, HOME: home };
  const r = spawnSync(process.execPath, [path.join(src, 'skill', 'playwright-verify', 'install.mjs')],
    { cwd: src, encoding: 'utf8', timeout: 300000, env: instEnv });
  const INST = path.join(home, '.agents', 'skills', 'playwright-verify-mcp');
  const instAlive = ['mcp/server.mjs', 'demo/tests/messy.spec.ts', 'demo/cases/e2e.xlsx', 'package-lock.json', 'extension/manifest.json']
    .every((f) => fs.existsSync(path.join(INST, f)));
  const instGone = ['node_modules', 'demo/generated-booltest', 'test-results', 'Temp', '.git']
    .every((d) => !fs.existsSync(path.join(INST, d)));
  check('H28 install 复制面不误杀源文件哨兵（demo 样例/lock/xlsx/extension 全进副本）',
    r.status === 0 && instAlive,
    instAlive ? '5 个哨兵在位' : `status=${r.status} ${(r.stderr || '').slice(0, 80)}`);
  check('H28 install 复制面不漏排产物哨兵（node_modules/generated-booltest/test-results/Temp/.git 全不进）',
    instGone, `INST=${INST}`);

  // nettree 净树面真跑（夹具树 nettree.mjs）
  const dst = path.join(tmp, 'dst');
  const rn = spawnSync(process.execPath, [path.join(src, 'skill', 'playwright-verify', 'scripts', 'nettree.mjs'), dst],
    { cwd: src, encoding: 'utf8', timeout: 120000 });
  const netAlive = ['mcp/server.mjs', 'demo/tests/messy.spec.ts', 'demo/cases/e2e.xlsx', 'package-lock.json', '.gitignore']
    .every((f) => fs.existsSync(path.join(dst, f)));
  const netGone = ['node_modules', 'demo/generated-booltest', 'test-results', 'Temp', '.git']
    .every((d) => !fs.existsSync(path.join(dst, d)));
  check('H28 净树忠实镜像不误杀源文件哨兵（demo 样例/lock 在位、.gitignore 保留）',
    rn.status === 0 && netAlive,
    netAlive ? '5 个哨兵在位' : `status=${rn.status} ${(rn.stderr || '').slice(0, 80)}`);
  check('H28 净树排除面不漏排产物哨兵（node_modules/generated-booltest/test-results/Temp/.git 全排净）',
    netGone, `dst=${dst}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

log('=== H29) 判据基数 serial 解耦：与 planWaves 同源求和，find 单取即回归 ===');
/*
 * 为什么钉这个（r41）：判据行原先从 SUITES 里 find 第一个 serial 套件取 assertions 当
 * serial 段基数 —— 现拓扑只有 deployed-check（30）时数值碰巧对；但 planWaves 早已支持
 * 多 serial 各独占一波全都会跑，一旦再加 serial 套件，实跑 total 把跑了的 serial 全
 * 计入，期望值却只算第一个 → 判据行自己假红（验收链自身判据失真）。计入面同步解耦：
 * 跑了的 serial 按 suites.mjs 声明（serial: true）匹配，不硬编码 deployed-check 文件名。
 * 差集理由（为什么不全解耦）：verify-all 调度面的 s.file.includes('deployed-check')
 * 保留 —— 那是 deployed-check 的「未安装 → 诚实 SKIP」安装前置判定，套件自身语义，
 * 不是判据口径。负钉按「去 // 注释后」匹配，防「注释写禁词也红」的误伤。
 */
{
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const vaSrc = read('mcp/test/verify-all.mjs');
  const vaCode = vaSrc.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const { SUITES, planWaves, serialAssertions } = await import('./suites.mjs');

  check('H29 判据基数走 serialAssertions 求和（与 planWaves 同源），find 单取回归即红',
    vaCode.includes('serialAssertions(')
    && !vaCode.includes('SUITES.find((s) => s.serial).assertions'));

  check('H29 判据段计入按 suites.mjs 声明匹配（serial: true），deployed-check 文件名硬编码回归即红',
    vaCode.includes('x.serial && x.file === r.file')
    && !vaCode.includes("r.file.includes('deployed-check')"));

  const one = SUITES.filter((s) => s.serial);
  check('H29 单 serial 拓扑基数 = 该套声明（现拓扑 deployed-check 恰 30，与改前数值等价）',
    one.length === 1 && one[0].assertions === 30 && serialAssertions() === one[0].assertions,
    `serials=${one.length} sum=${serialAssertions()}`);

  // 多 serial 夹具：求和必须 18（7+11），find 单取只剩 7 —— 钉的就是「漏算后续 serial」
  const fix = [
    { name: 'a', file: 'a.mjs', assertions: 5 },
    { name: 'b', file: 'b.mjs', assertions: 7, serial: true },
    { name: 'c', file: 'c.mjs', assertions: 11, serial: true },
    { name: 'd', file: 'd.mjs', assertions: 13 },
  ];
  const waves = planWaves(fix, { maxWave: 2 });
  const serialWaves = waves.filter((w) => w.length === 1 && w[0].serial);
  check('H29 多 serial 拓扑基数 = 全部 serial 声明求和 18（find 单取只剩 7 即回归），且各占一波',
    serialAssertions(fix) === 18 && serialWaves.length === 2,
    `sum=${serialAssertions(fix)} serialWaves=${serialWaves.length}`);

  check('H29 同源口径：serialAssertions 与 planWaves serial 波序列断言求和一致',
    serialAssertions(fix) === serialWaves.reduce((n, w) => n + w[0].assertions, 0));
}

/* ---------------- H30:崩溃/异常退出现场必须落盘（证据不落盘=不可分析） ---------------- */
/*
 * r43 取证 campaign 的正反两面：w4-trio-03 的 0xC0000409 靠复现台即时落盘才定住
 * 成员退出码与崩溃点；mode1 sanity 首跑瞬断因 stdout 被管道吞而永久不可分类。
 * verify-all 原来只在内存里留尾部 12 行 —— 本组钉住 crashbundle.js 的决策/写盘/
 * 自修剪、verify-all 的接线（崩溃 close 分支 + 挂死分支都落盘）、以及
 *「bundle 不进收尾清理清单」（下次全绿不许抹掉上次的崩溃证据，r42 留存帽教训）。
 */
log('=== H30) 崩溃/异常退出现场落盘：决策/写盘/自修剪/接线/证据不被全绿抹掉 ===');
{
  const { shouldBundle, buildBundleMeta, writeCrashBundle, pruneBundles, CRASH_BUNDLE_DIR, CRASH_BUNDLE_KEEP } = await import('../lib/crashbundle.js');

  // 1) 决策纯函数：与 summarizeSuiteExit 崩溃/异常退出分支同口径
  check('H30 全绿不落 bundle（零产出零噪音）', shouldBundle(0, 'PASS x\n') === false);
  check('H30 已知崩溃码无 FAIL 行 → 落（0xC0000409 形态）',
    shouldBundle(3221226505, 'PASS 1\nPASS 2\n') === true);
  check('H30 不可分类瞬断（exit 1 无 FAIL，r43 sanity 形态）也落',
    shouldBundle(1, 'PASS 部分输出\n') === true);
  check('H30 断言失败（有 FAIL 行）不落（那是 failedLines 的职责面）',
    shouldBundle(1, 'PASS a\nFAIL 断言 x\n') === false);
  check('H30 signal kill（exit null）无 FAIL 也落（挂死守卫同口径）',
    shouldBundle(null, '跑到一半\n') === true);

  // 2) meta 组装：确定性、退出码双形态、时钟注入可静态断言
  const m = buildBundleMeta({ suiteName: '套件', suiteFile: 'mcp/test/x-check.mjs', exitCode: -1073740791, startedAt: 1000, endedAt: 3500, durationMs: 2500, passCount: 4, skipCount: 0, mode: '3', parallel: true, freememGB: 43.2, rssMB: 120 });
  check('H30 meta：有符号退出码无符号归一 + hex 双形态可读（-1073740791 = 0xC0000409）',
    m.exitCode === -1073740791 && m.unsignedExit === 3221226505 && m.hexExit === '0xC0000409',
    JSON.stringify({ u: m.unsignedExit, h: m.hexExit }));
  check('H30 meta：时点/时长/计数/拓扑如实',
    m.startedAt === '1970-01-01T00:00:01.000Z' && m.endedAt === '1970-01-01T00:00:03.500Z'
    && m.durationMs === 2500 && m.passCount === 4 && m.parallel === true && m.mode === '3',
    JSON.stringify({ s: m.startedAt, d: m.durationMs }));

  // 3) 写盘活性：沙箱目录真写三件、NOT_CRASH 零写、写失败诚实不掀翻
  const box = path.join(os.tmpdir(), `pv-crashbundle-h30-${Date.now()}`);
  const w1 = writeCrashBundle(box, { suiteName: '智能体线', suiteFile: 'mcp/test/nl-agent-check.mjs', exitCode: 3221226505, out: 'PASS a\nPASS b\n', err: '', startedAt: Date.now() - 1800, endedAt: Date.now(), durationMs: 1800, passCount: 4, skipCount: 0, mode: '1', parallel: true });
  const files = w1.written ? fs.readdirSync(w1.dir).sort() : [];
  check('H30 崩溃落盘三件齐全（stdout/stderr 全量 + meta.json）',
    w1.written && files.join(',') === 'meta.json,stderr.log,stdout.log'
    && fs.readFileSync(path.join(w1.dir, 'stdout.log'), 'utf8') === 'PASS a\nPASS b\n',
    `${w1.written} ${files.join(',')}`);
  check('H30 meta.json 落盘内容与组装一致（hexExit 保真）',
    w1.written && JSON.parse(fs.readFileSync(path.join(w1.dir, 'meta.json'), 'utf8')).hexExit === '0xC0000409');
  const w2 = writeCrashBundle(box, { suiteName: 'x', exitCode: 0, out: 'PASS\n', err: '', endedAt: Date.now() });
  // existsSync 守卫：SUT 被咬坏时目录可能根本没建过——钉要干净变红，不许自己崩（「崩了不是红了」对钉同样成立）
  const bundleRoot = path.join(box, CRASH_BUNDLE_DIR);
  const before = fs.existsSync(bundleRoot) ? fs.readdirSync(bundleRoot).length : 0;
  check('H30 NOT_CRASH 不写盘（目录计数不增）',
    w2.written === false && w2.reason === 'NOT_CRASH' && before === 1,
    JSON.stringify({ w2: w2.reason, before }));
  fs.mkdirSync(box, { recursive: true }); // SUT 全短路时 box 可能从未被建——钉自身先保证场地存在（崩了不是红了）
  fs.writeFileSync(path.join(box, 'a-file'), 'x'); // 「文件当父目录」——mkdir recursive 对不存在路径会真建出来，只有父为文件才 ENOTDIR
  const w3 = writeCrashBundle(path.join(box, 'a-file', 'sub'), { suiteName: 'x', exitCode: 5, out: '', err: '', endedAt: Date.now() });
  check('H30 写失败不掀翻 harness（诚实 WRITE_FAILED，不抛错）',
    w3.written === false && String(w3.reason).startsWith('WRITE_FAILED'),
    String(w3.reason));

  // 4) 自修剪：时间戳前缀字典序 = 时间序，只删最旧
  const bRoot = path.join(box, 'prune-fixture');
  for (let i = 0; i < CRASH_BUNDLE_KEEP + 3; i++) fs.mkdirSync(path.join(bRoot, `2026-10-08T00-${String(i).padStart(2, '0')}-00-000_fake${i}`), { recursive: true });
  const pr = pruneBundles(bRoot);
  const left = fs.readdirSync(bRoot).sort();
  check('H30 自修剪保留最近 KEEP 个、删最旧 3 个（证据不无限堆积）',
    pr.pruned === 3 && left.length === CRASH_BUNDLE_KEEP && left[0].includes('00-03'),
    JSON.stringify({ pruned: pr.pruned, n: left.length, oldest: left[0] }));

  // 5) verify-all 接线（源码钉，去注释后匹配 —— 注释写禁词不误伤，r41 口径）
  const vaSrc = fs.readFileSync(path.join(ROOT, 'mcp/test/verify-all.mjs'), 'utf8');
  const vaStripped = vaSrc.replace(/^\s*\/\/.*$/gm, '');
  check('H30 verify-all 接线：import crashbundle 且写盘调用在位',
    vaStripped.includes("from '../lib/crashbundle.js'") && /writeCrashBundle\(ROOT/.test(vaStripped));
  const persistCalls = (vaStripped.match(/persistBundle\(/g) || []).length;
  check('H30 verify-all 接线：崩溃 close 分支与挂死分支都落盘（持久化点 ≥2）',
    persistCalls >= 2, `persistBundle( 出现 ${persistCalls} 次`);
  const artIdx = vaSrc.indexOf('const ARTIFACT_DIRS');
  const artBlock = artIdx === -1 ? '' : vaSrc.slice(artIdx, vaSrc.indexOf('];', artIdx));
  check('H30 bundle 目录不进 verify-all 收尾清理清单（下次全绿不许抹掉崩溃证据）',
    artBlock !== '' && !artBlock.includes("'crash-bundles'"));

  // 6) 排除口径单一源：crash-bundles 在 exclude.js（分发/比对/复制/净树自动排除）
  const exSrc = fs.readFileSync(path.join(ROOT, 'mcp/lib/exclude.js'), 'utf8');
  check('H30 crash-bundles 进 exclude.js ARTIFACT_DIRS 单一源（五面派生，副本不假漂移/发布包不夹带）',
    exSrc.includes("'crash-bundles'"));

  fs.rmSync(box, { recursive: true, force: true });
}

log('');
log(failures === 0 ? '加固回归全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
