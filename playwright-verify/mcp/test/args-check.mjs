/**
 * args-check.mjs — MCP 参数规范化与产物命名的回归测试
 *
 * 钉死两类「静默」问题：
 *
 *   A) 静默反转用户意图 —— MCP 客户端可能把布尔参数序列化成字符串，
 *      而 `"false"` 在 JS 里是**真值**。如果代码写 `!!args.run`，
 *      用户明确说「别跑」时工具反而真的启动了浏览器跑回归。
 *      这类问题不报错，只做出与预期相反的动作。
 *
 *   B) 静默覆盖证据 —— CLI 产物（快照/截图）若用「扫目录算序号」命名，
 *      两个并发调用会算出同一个名字，后写的覆盖前一次的证据。
 *      失败现场被替换掉，是最不该丢的东西。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boolArg, numArg, intArg, arrayArg } from '../lib/args.js';
import { resolvePlaywrightRunner, resolveCliRunner } from '../lib/runner.js';
import { handleMessage } from '../server.mjs';
import { installStandaloneReap } from './reap.mjs';

// 单跑兜底：B/D 两节会开浏览器会话，任何退出分支都收掉本机孤儿 daemon/浏览器。
// 在 verify-all 调度下自动跳过，由统一收尾负责（见 reap.mjs 注释）。
installStandaloneReap(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), { label: 'args-check' });

let failures = 0;
const log = (s) => process.stdout.write(`${s}\n`);
const check = (name, cond, extra = '') => {
  if (!cond) failures++;
  log(`${cond ? 'PASS ' : 'FAIL '} ${name}${extra ? `  ${extra}` : ''}`);
};
const throws = (name, fn, expectMsg) => {
  try {
    fn();
    failures++;
    log(`FAIL  ${name}（本该报错却通过了）`);
  } catch (e) {
    const ok = !expectMsg || expectMsg.test(e.message);
    if (!ok) failures++;
    log(`${ok ? 'PASS ' : 'FAIL '} ${name}  → ${e.message.slice(0, 90)}`);
  }
};

/* ================= A) boolArg ================= */
log('=== A) 布尔参数规范化 ===');

check('真 true → true', boolArg(true, 'x') === true);
check('真 false → false', boolArg(false, 'x') === false);
// 这一条是本测试存在的理由：字符串 "false" 必须解析成 false，而不是被当真值
check('字符串 "false" → false（不是真值！）', boolArg('false', 'x') === false);
check('字符串 "true" → true', boolArg('true', 'x') === true);
check('字符串 "FALSE"（大小写）→ false', boolArg('FALSE', 'x') === false);
check('字符串 " false "（带空白）→ false', boolArg(' false ', 'x') === false);
check('字符串 "0" → false', boolArg('0', 'x') === false);
check('字符串 "1" → true', boolArg('1', 'x') === true);
check('数字 1 → true', boolArg(1, 'x') === true);
check('数字 0 → false', boolArg(0, 'x') === false);
check('undefined → 默认 false', boolArg(undefined, 'x') === false);
check('undefined → 默认 true（显式指定）', boolArg(undefined, 'x', true) === true);
check('null → 默认值', boolArg(null, 'x', true) === true);

// 非法值必须报错，绝不静默当成 true/false
throws('字符串 "maybe" 报错', () => boolArg('maybe', 'x'), /应为布尔值/);
throws('字符串 "" 报错', () => boolArg('', 'x'), /应为布尔值/);
throws('数字 2 报错', () => boolArg(2, 'x'), /应为布尔值/);
throws('对象报错', () => boolArg({}, 'x'), /应为布尔值/);
throws('数组报错', () => boolArg([], 'x'), /应为布尔值/);
check('报错信息含参数名', (() => {
  try { boolArg('maybe', 'execution'); return false; } catch (e) { return e.message.includes('execution'); }
})());

/* ================= numArg / arrayArg ================= */
log('');
log('=== 数字与数组参数 ===');
check('numArg 数字', numArg(5, 'x') === 5);
check('numArg 数字字符串（客户端可能序列化）', numArg('30000', 'x') === 30000);
check('numArg undefined → 默认', numArg(undefined, 'x', 42) === 42);
throws('numArg 非数字字符串报错', () => numArg('abc', 'x'), /应为数字/);
throws('numArg NaN 报错', () => numArg(NaN, 'x'), /应为数字/);
throws('numArg 空字符串报错', () => numArg('', 'x'), /应为数字/);
// intArg：下标/计数参数专用 —— 浮点绝不静默取整（keyIndex=1.5 → 静默零行误报「站点没数据」，实测踩过）
check('intArg 整数/数字字符串/3.0 放行，负整数也放行（夹取归调用方）',
  intArg(5, 'x') === 5 && intArg('30000', 'x') === 30000 && intArg(3.0, 'x') === 3
  && intArg(undefined, 'x', 7) === 7 && intArg(-2, 'x') === -2);
throws('intArg 数字浮点报错（不静默取整）', () => intArg(1.5, 'x'), /应为整数/);
throws('intArg 字符串小数同样报错', () => intArg('2.5', 'x'), /应为整数/);
throws('intArg 非数字仍报「应为数字」（下层语义不丢）', () => intArg('abc', 'x'), /应为数字/);
check('arrayArg 数组', JSON.stringify(arrayArg(['a', 'b'], 'x')) === '["a","b"]');
check('arrayArg 单字符串 → 单元素数组', JSON.stringify(arrayArg('a', 'x')) === '["a"]');
check('arrayArg undefined → 空数组', arrayArg(undefined, 'x').length === 0);
throws('arrayArg 数字报错', () => arrayArg(5, 'x'), /应为字符串数组/);
throws('arrayArg 含非字符串报错', () => arrayArg(['a', 1], 'x'), /应为字符串数组/);

/* ================= B) 经 MCP 端到端：布尔不能静默反转 ================= */
log('');
log('=== B) 经 MCP 工具调用验证（端到端） ===');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const callTool = async (name, args) => {
  const r = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return r.error ? { protocolError: r.error } : r.result;
};

// run_verify execution:"false" 必须是干跑（绝不真的执行）
// 干跑/执行语义需要执行层才观察得到；缺可选依赖时诚实 SKIP（纯净包口径）——
// 「未装 Playwright 时报缺」这条契约由 protocol-check 专门钉，不在这儿重复。
if (resolvePlaywrightRunner(ROOT)) {
  const dry = await callTool('run_verify', { cwd: ROOT, execution: 'false' });
  check('run_verify execution:"false" → 干跑', dry.structuredContent?.dryRun === true && dry.isError !== true,
    JSON.stringify(dry.structuredContent?.dryRun));
  const dryTrue = await callTool('run_verify', { cwd: ROOT, execution: 'true' });
  check('run_verify execution:"true" 才会真执行（未执行时至少不是干跑标记）',
    dryTrue.structuredContent?.dryRun !== true);
} else {
  log('SKIP  run_verify 干跑/执行语义（缺可选依赖 @playwright/test：纯净包口径 —— 可选依赖由被测项目/本机提供）');
}

// 非法布尔值要以明确错误暴露，而不是静默当成某个值
// 这条必须**不依赖执行层**也成立（守门前置）：参数校验先于能力检查，
// 否则纯净包里会把「参数非法」报成「找不到 Playwright」，把人引去装依赖的歧路。
const bad = await callTool('run_verify', { cwd: ROOT, execution: 'maybe' });
check('非法 execution 值 → isError 且说明原因',
  bad.isError === true && /应为布尔值/.test(bad.content[0].text),
  bad.content[0].text.slice(0, 100));

// generate_scripts write:"false" 不能写盘
const outDir = path.join(ROOT, 'demo/generated-argscheck');
fs.rmSync(outDir, { recursive: true, force: true });
const gen = await callTool('generate_scripts', {
  spec: 'argscheck',
  pages: [{
    name: 'p',
    steps: [
      { act: 'click', locator: { kind: 'role', role: 'button', name: 'x' } },
      { act: 'assertVisible', locator: { kind: 'testid', id: 'ok' } },
    ],
  }],
  cases: [{ title: 't', page: 'p', claims: 'c', steps: [{ act: 'assertVisible', locator: { kind: 'testid', id: 'ok' } }] }],
  write: 'false', outDir: 'demo/generated-argscheck',
});
check('generate_scripts write:"false" → 不写盘', gen.structuredContent?.write === null);
check('generate_scripts write:"false" → 目录未被创建', !fs.existsSync(outDir),
  fs.existsSync(outDir) ? '目录居然存在' : '目录不存在');
// 而 write:"true" 应当真的写盘
const genW = await callTool('generate_scripts', {
  spec: 'argscheck',
  pages: [{
    name: 'p',
    steps: [
      { act: 'click', locator: { kind: 'role', role: 'button', name: 'x' } },
      { act: 'assertVisible', locator: { kind: 'testid', id: 'ok' } },
    ],
  }],
  cases: [{ title: 't', page: 'p', claims: 'c', steps: [{ act: 'assertVisible', locator: { kind: 'testid', id: 'ok' } }] }],
  write: 'true', outDir: 'demo/generated-argscheck',
});
check('generate_scripts write:"true" → 真的写盘', genW.structuredContent?.write?.written === true,
  JSON.stringify(genW.structuredContent?.write?.files?.length));
fs.rmSync(outDir, { recursive: true, force: true });

/* ================= C) 产物命名不互相覆盖 ================= */
log('');
log('=== C) CLI 产物命名唯一性（并发不覆盖证据） ===');
if (!resolveCliRunner(ROOT)) {
  log('SKIP  C) CLI 产物命名唯一性（缺可选依赖 @playwright/cli：纯净包口径 —— 可选依赖由被测项目/本机提供）');
} else {
  const { runCli, ARTIFACT_DIRS } = await import('../lib/cli.js');
  const session = `uniq-${Date.now().toString(36)}`;
  const PAGE = 'data:text/html,' + encodeURIComponent('<h1>uniq</h1>');

  const opened = await runCli({ cwd: ROOT, session, subcommand: 'open', args: [PAGE] });
  check('CLI 会话打开成功', opened.ok, opened.summary);

  // 并发发 4 次 snapshot：文件名必须互不相同（否则后写的覆盖先写的）
  const shots = await Promise.all([1, 2, 3, 4].map(() =>
    runCli({ cwd: ROOT, session, subcommand: 'screenshot', args: [] })));
  const files = shots.map((s) => s.artifacts?.file).filter(Boolean);
  check('4 次并发截图都拿到了产物路径', files.length === 4, `${files.length}/4`);
  check('4 个产物路径互不相同（并发不覆盖证据）', new Set(files).size === files.length,
    files.map((f) => path.basename(f)).join(', '));
  check('4 个截图文件都真实存在', files.every((f) => fs.existsSync(f)),
    files.filter((f) => !fs.existsSync(f)).join(', ') || '全部存在');
  await runCli({ cwd: ROOT, session, subcommand: 'close', args: [] });

  // 清理本次产物
  for (const f of files) { try { fs.unlinkSync(f); } catch { /* 忽略 */ } }
}

/* ================= D) 浏览器通道优先级：显式 --browser > 配置文件 channel ================= */
/*
 * 钉的是「显式参数 > 配置文件 > CLI 默认」这条优先级链（docs: cli-mode.md 通道配置节）。
 * 为什么值得钉：配置文件 channel 与命令行 --browser 同时存在时，谁生效是第三方 CLI 的
 * 语义 —— 如果哪天反过来（配置压过显式参数），症状是「命令行指了浏览器却打开了另一个」，
 * 不报错、只是行为与说好的不一样，最难查的那类。
 *
 * 实测方法（不依赖本机装了什么浏览器，也与 daemon 冷热无关）：临时目录里放一份
 * channel 指向「不存在的通道名」的配置，用 --config 显式指给 CLI（每次调用都生效，
 * 实测过预热 daemon 也照样认），看失败信息点名谁 ——
 *   · 不带 --browser → 失败必须点名配置里的假通道名（配置生效；实测报
 *     `Unsupported chromium channel "..."`）；
 *   · 带 --browser X → 结果里**不得**再出现假通道名（显式参数覆盖配置；
 *     X 能真打开就成功，打不开则失败信息点名 X 或缺可执行文件 —— 与配置无关）。
 * 两问都不看「成功与否」，只看「谁的名字被点名」—— 无浏览器的机器同样可判，
 * 断言数因此与机器无关（CORE 判据不用为环境加项）。
 */
log('');
log('=== D) 浏览器通道优先级（显式 --browser 覆盖配置文件 channel） ===');
{
  const BOGUS = 'nonexistent-channel-xyz';
  if (!resolveCliRunner(ROOT)) {
    log('SKIP  D) 浏览器通道优先级（缺可选依赖 @playwright/cli：纯净包口径 —— 可选依赖由被测项目/本机提供）');
  } else {
    const { runCli } = await import('../lib/cli.js');
    const { pickChannel } = await import('../../skill/playwright-verify/scripts/cli-config.mjs');
    const { channel } = pickChannel({ platform: process.platform });
    const flagVal = channel || 'chromium';   // 只是个「要试的名字」：打不开也会点它，而不是配置的假名字
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-prio-'));
    try {
      const cfgPath = path.join(tmp, 'cli.config.json');
      fs.writeFileSync(cfgPath, JSON.stringify({
        _说明: 'args-check D) 优先级探针：channel 指向不存在的通道，看失败点名谁就是谁生效',
        _平台: `${process.platform} (probe)`,
        browser: { browserName: 'chromium', launchOptions: { channel: BOGUS } },
      }, null, 2));
      const PAGE = 'data:text/html,' + encodeURIComponent('<h1>prio</h1>');
      const session = `prio-${Date.now().toString(36)}`;

      const viaCfg = await runCli({ cwd: ROOT, session, subcommand: 'open', args: [PAGE, '--config', cfgPath] });
      const cfgText = `${viaCfg.summary || ''} ${viaCfg.stderrTail || ''}`;
      check('无 --browser 时配置文件 channel 生效（失败点名配置的通道，不静默换别的）',
        !viaCfg.ok && cfgText.includes(BOGUS), cfgText.slice(0, 120));

      const viaFlag = await runCli({ cwd: ROOT, session, subcommand: 'open', args: [PAGE, '--config', cfgPath, '--browser', flagVal] });
      const flagText = `${viaFlag.summary || ''} ${viaFlag.stderrTail || ''}`;
      check('显式 --browser 覆盖配置文件 channel（结果不再点名配置的假通道）',
        !flagText.includes(BOGUS), flagText.slice(0, 120));

      await runCli({ cwd: ROOT, session, subcommand: 'close', args: [] });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录残留无害 */ }
    }
  }
}

log('');
log(failures === 0 ? '参数规范化与产物命名回归全部通过 ✅' : `${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
