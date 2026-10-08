/* verify/all.mjs — 一条命令全量验证总入口（顺序执行防跑批互踩）
 * 覆盖：自检 427 项（7 套）/ MCP 44 工具 68 链路 / 扩 UI 全按钮清扫 /
 *       扩展 UI 回归（默认完整版含 live 长流程）/ 双模 / 全链路点名链条
 * 用法：node verify/all.mjs [--quick]（--quick：跳过 selftest/live-fulltest，ui-ext 用 --quick）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = 'D:/work/MCP/web-rpa-mcp/';
const QUICK = process.argv.includes('--quick');
const log = (m) => console.log('[all] ' + m);

/* 电池残件自密封：只删测试前缀残件（与 distribute TEST_FLOW_RE 同族口径：t-/int-/e2e-/live-/ui-e2e- 等），
 * 绝不碰用户流程与外部会话文件（未命名流程-/演示- 的 flows 文件永不清；演示- 的 runs 属 live 电池产物可清） */
const RESIDUE_RE = /^(t-|悬浮-|int-|e2e-|ui-ext-|local-|__probe|演示-订单日报导出)/;
function cleanResidue() {
  const removed = [];
  const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); removed.push(path.basename(p)); } catch (e) { /* ignore */ } };
  // runs/ 电池残件
  try {
    for (const name of fs.readdirSync(ROOT + 'runs')) {
      if (RESIDUE_RE.test(name)) rm(path.join(ROOT, 'runs', name));
    }
  } catch { /* ignore */ }
  // live-fulltest 电池产物（会污染下次门禁哈希，v1.5.19 教训）
  rm(path.join(ROOT, 'verify', 'live-report.json'));
  // backups 测试残件
  try {
    for (const name of fs.readdirSync(ROOT + '.work/backups')) {
      if (RESIDUE_RE.test(name) || /^(obs-|share-probe|sweep-)/.test(name)) rm(path.join(ROOT, '.work/backups', name));
    }
  } catch { /* ignore */ }
  return removed;
}
function residueReport() {
  let runs = 0, flows = 0;
  try { runs = fs.readdirSync(ROOT + 'runs').length; } catch { /* ignore */ }
  try { flows = fs.readdirSync(ROOT + 'flows').filter((f) => RESIDUE_RE.test(f)).length; } catch { /* ignore */ }
  return { runs, flowResidue: flows };
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

const batteries = [
  { name: 'selftest（自检 427 项 7 套）', skip: QUICK, cmd: 'node', args: ['selftest.mjs'], cwd: ROOT + 'mcp', tail: /SELFTEST[^\n]*|全链路[^\n]*/g },
  { name: 'live-fulltest（MCP 44 工具 68 链路）', skip: QUICK, cmd: 'node', args: ['live-fulltest.mjs'], cwd: ROOT + 'verify', tail: /全链路[^\n]*|EXIT[^\n]*|live[^\n]*通过[^\n]*/gi },
  { name: 'button-sweep（/console 全按钮清扫）', cmd: 'node', args: ['button-sweep.mjs'], cwd: ROOT + 'verify', tail: /button-sweep:[^\n]*/g },
  { name: QUICK ? 'ui-ext（扩展 UI 回归 --quick 16）' : 'ui-ext（扩展 UI 回归完整版 17 含 live）', cmd: 'node', args: QUICK ? ['ui-ext.mjs', '--quick'] : ['ui-ext.mjs'], cwd: ROOT + 'verify', tail: /ui-ext 回归[^\n]*/g },
  { name: 'standalone（双模 10 用例）', cmd: 'node', args: ['standalone.mjs'], cwd: ROOT + 'verify', tail: /standalone 验证[^\n]*/g },
  { name: 'fullchain（点名链条 8 用例）', cmd: 'node', args: ['fullchain.mjs'], cwd: ROOT + 'verify', tail: /done exit[^\n]*/g },
];

const results = [];
for (const b of batteries) {
  if (b.skip) { results.push({ name: b.name, code: 'SKIP', note: '--quick 跳过' }); log('SKIP ' + b.name); continue; }
  let r = null, secs = '0', tails = '', attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    attempts = attempt;
    log('RUN  ' + b.name + (attempt > 1 ? '（重试 ' + (attempt - 1) + '）' : '') + ' …');
    const t0 = Date.now();
    r = await run(b.cmd, b.args, b.cwd);
    secs = ((Date.now() - t0) / 1000).toFixed(0);
    tails = (r.out.match(b.tail) || []).slice(-2).join(' | ');
    if (r.code === 0) break;
    if (attempt < 2) log('RETRY ' + b.name + '（时序竞态类失败常见，重试一次）');
  }
  results.push({ name: b.name, code: r.code, note: tails.slice(0, 160) + (attempts > 1 ? '（重试后）' : ''), secs });
  log((r.code === 0 ? 'PASS ' : 'FAIL ') + b.name + '（' + secs + 's）' + (tails ? ' — ' + tails : ''));
}

console.log('\n════ 全量验证汇总 ════');
let failed = 0;
for (const r of results) {
  const mark = r.code === 0 ? '✅' : r.code === 'SKIP' ? '⏭' : '❌';
  console.log(mark + ' ' + r.name + (r.secs ? '（' + r.secs + 's）' : '') + (r.note ? ' — ' + r.note : ''));
  if (r.code !== 0 && r.code !== 'SKIP') failed++;
}
console.log(failed ? '\n存在失败套件：' + failed : '\n全部通过 ✅');
// 电池残件自密封（无论成败都清，防残件堆积与门禁哈希污染）
const removed = cleanResidue();
const rr = residueReport();
console.log('残件自检：清理 ' + removed.length + ' 项' + (removed.length ? '（' + removed.slice(0, 8).join('、') + (removed.length > 8 ? '…' : '') + '）' : '') + '；runs/=' + rr.runs + '，flows/ 测试残件=' + rr.flowResidue + (rr.flowResidue ? ' ⚠' : ' ✅'));
process.exit(failed ? 1 : 0);
