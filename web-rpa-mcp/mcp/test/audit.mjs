// web-rpa-mcp — 覆盖度自检：任何"从未被测试碰过"的能力都会让这个测试失败
// 目的：杜绝死代码（例如 L061 曾经因为一个提前 return 永远触发不了）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');

const server = read(path.join(MCP, 'server.mjs'));
const player = read(path.join(MCP, 'lib', 'player.mjs'));
const lint = read(path.join(MCP, 'lib', 'lint.mjs'));
const runner = read(path.join(MCP, 'runner.mjs'));

const between = (src, a, b) => {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + 1);
  return i < 0 ? '' : src.slice(i, j < 0 ? src.length : j);
};

const toolNames = [...new Set([...server.matchAll(/^tool\('([a-z_]+)'/gm)].map((m) => m[1]))];
const ops = [...new Set([...between(player, 'async function runStep', '/* ---------------- 主流程').matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]))];
const kinds = [...new Set([...between(player, 'async function checkAssertion', 'export async function emptyResultGuard').matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]))];
const lintCodes = [...new Set([...lint.matchAll(/'(L\d{3})'/g)].map((m) => m[1]))].sort();
const runnerCmds = [...new Set([...runner.matchAll(/cmd === '([a-z]+)'/g)].map((m) => m[1]))];

const testFiles = ['unit.mjs', 'rules.mjs', 'mcp-protocol.mjs', 'tools.mjs', 'e2e.mjs', 'integration.mjs'];
const testsSrc = testFiles.map((f) => read(path.join(MCP, 'test', f))).join('\n');

let fail = 0;
const ESCAPE_RE = /[.*+?^$|{}()\[\]\\]/g;
function group(label, items) {
  const missing = items.filter((x) => {
    // 以非单词字符结尾的项（如 "file:"）不能加尾部 \b，否则永远匹配不上
    const tail = /[A-Za-z0-9_]$/.test(x) ? '\\b' : '';
    const re = new RegExp('\\b' + x.replace(ESCAPE_RE, '\\$&') + tail);
    return !re.test(testsSrc);
  });
  const mark = missing.length ? 'FAIL' : 'ok  ';
  console.log('  ' + mark + ' ' + label + '：共 ' + items.length + ' 项' + (missing.length ? '，未被任何测试提到 ' + missing.length + ' 项' : '，全部有覆盖'));
  if (missing.length) { fail++; console.log('       ' + JSON.stringify(missing)); }
}

console.log('\n[覆盖度自检]');
group('MCP 工具', toolNames);
group('步骤类型', ops);
group('断言类型', kinds);
group('静态检查规则', lintCodes);
group('runner 子命令', runnerCmds);
group('变量来源', ['const', 'env:', 'file:', 'secret:', 'flow:', 'table:', 'prompt']);
group('表格格式', ['.xlsx', '.csv', '.tsv', '.txt', '.json']);
group('内置变量', ['today', 'now', 'yesterday', 'tomorrow', 'daystart', 'dayend', 'monthstart', 'yeartoday', 'time', 'date', 'timestamp', 'uuid', 'random', 'root', 'osuser']);

console.log('\n' + (fail ? '覆盖度自检失败：有 ' + fail + ' 组能力从未被测试' : '覆盖度自检通过：所有能力都有测试覆盖'));
process.exit(fail ? 1 : 0);
