// web-rpa-mcp — 全链路自检：按顺序跑完 7 套测试并给出汇总
// 顺序设计：便宜的先跑（纯函数/静态规则），贵的后跑（真实浏览器），最后用覆盖度自检兜底。
// 用法：node selftest.mjs                全部 7 套
//       node selftest.mjs unit e2e      只跑指定套件（名字=文件名去掉 .mjs）
//       node selftest.mjs integration --group 14   套件名后的参数原样透传给测试脚本
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  { file: 'unit.mjs', name: '单元测试' },
  { file: 'rules.mjs', name: '静态检查规则' },
  { file: 'mcp-protocol.mjs', name: 'MCP 协议' },
  { file: 'tools.mjs', name: '工具全量实测' },
  { file: 'e2e.mjs', name: '端到端（真实录制/回放）' },
  { file: 'integration.mjs', name: '集成测试' },
  { file: 'audit.mjs', name: '覆盖度自检' },
];

const argv = process.argv.slice(2);
const picked = argv.filter((a) => !a.startsWith('-')).map((a) => a.replace(/\.mjs$/, ''));
const passthrough = argv.filter((a) => a.startsWith('-'));
const suites = picked.length ? SUITES.filter((s) => picked.includes(s.file.replace(/\.mjs$/, ''))) : SUITES;
if (!suites.length) {
  console.error('没有匹配的套件: ' + picked.join(', '));
  console.error('可选: ' + SUITES.map((s) => s.file.replace(/\.mjs$/, '')).join(' '));
  process.exit(2);
}

function runOne(suite) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log('\n════ [' + suite.file + '] ' + suite.name + ' ════');
    const child = spawn(process.execPath, [path.join(__dirname, 'test', suite.file), ...passthrough], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('close', (code) => resolve({ ...suite, code: code === 0 ? 0 : (code || 1), ms: Date.now() - started }));
    child.on('error', (e) => { console.error('无法启动 ' + suite.file + ': ' + e.message); resolve({ ...suite, code: 1, ms: Date.now() - started }); });
  });
}

const results = [];
for (const s of suites) {
  results.push(await runOne(s));
  // 前置套件挂了就不浪费浏览器时间：e2e/integration 一定跑不绿
  if (results[results.length - 1].code !== 0 && (s.file === 'unit.mjs' || s.file === 'rules.mjs')) {
    console.log('\n前置套件失败，跳过其余测试（先修 ' + s.file + '）');
    for (const rest of suites.slice(results.length)) results.push({ ...rest, code: -1, ms: 0 });
    break;
  }
}

console.log('\n════════ 全链路汇总 ════════');
let failed = 0;
for (const r of results) {
  const mark = r.code === 0 ? 'ok  ' : (r.code === -1 ? 'skip' : 'FAIL');
  if (r.code > 0) failed++;
  console.log('  ' + mark + ' ' + r.file.padEnd(18) + (r.code === -1 ? '' : (r.ms / 1000).toFixed(1) + 's'));
}
console.log(failed ? '\n全链路失败：' + failed + ' 套未通过' : '\n全链路通过：' + suites.length + ' 套全绿');
process.exit(failed ? 1 : 0);
