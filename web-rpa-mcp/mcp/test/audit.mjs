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

/* ---------------- 配置接线检查：DEFAULT_CONFIG 的键必须被生产代码读取 ----------------
   只定义、没人读的配置键 = 死开关：文档/配置里写着能调，实际改了没有任何效果（配置说谎）。
   v1.5.5 之前 security.maskSecrets / security.redactKeys / run.blockSensitiveAutofill 就是这种状态。
   口径：把 DEFAULT_CONFIG 字面量块本身从源码里抠掉（定义处不算消费），其余生产源码里键名必须出现。 */
function skipStr(src, i) {
  const q = src[i];
  i++;
  while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
  return i + 1;
}
function skipComment(src, i) {
  if (src[i] === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; return i; }
  if (src[i] === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); return j < 0 ? src.length : j + 2; }
  return i;
}
function braceBlock(src, start) {
  let depth = 0, i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') { i = skipStr(src, i); continue; }
    if (c === '/') { const n = skipComment(src, i); if (n !== i) { i = n; continue; } }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    i++;
  }
  return src.slice(start);
}
function depth1Keys(block) {
  const keys = [];
  let depth = 0, i = 0;
  while (i < block.length) {
    const c = block[i];
    if (c === "'" || c === '"' || c === '`') { i = skipStr(block, i); continue; }
    if (c === '/') { const n = skipComment(block, i); if (n !== i) { i = n; continue; } }
    if (c === '{' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ']') { depth--; i++; continue; }
    if (depth === 1 && /[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < block.length && /[\w$]/.test(block[j])) j++;
      let k = j;
      while (k < block.length && /\s/.test(block[k])) k++;
      if (block[k] === ':') keys.push(block.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return keys;
}

const coreSrc = read(path.join(MCP, 'lib', 'core.mjs'));
const defStart = coreSrc.indexOf('{', coreSrc.indexOf('export const DEFAULT_CONFIG'));
const defBlock = braceBlock(coreSrc, defStart);
const cfgKeys = [];
for (const section of depth1Keys(defBlock)) {
  const sub = braceBlock(defBlock, defBlock.indexOf('{', defBlock.indexOf(section + ':')));
  for (const k of depth1Keys(sub)) cfgKeys.push(section + '.' + k);
}
const libFiles = ['core', 'store', 'ops', 'player', 'browser', 'chain', 'lint', 'locators', 'notify', 'recorder', 'schedule', 'secrets', 'table', 'vars'];
const prodSrc = [server, runner, ...libFiles.map((f) => read(path.join(MCP, 'lib', f + '.mjs')))]
  .join('\n').split(defBlock).join('');

const missingCfg = cfgKeys.filter((dotted) => {
  const leaf = dotted.split('.')[1];
  const tail = /[A-Za-z0-9_]$/.test(leaf) ? '\\b' : '';
  return !(new RegExp('\\b' + leaf.replace(ESCAPE_RE, '\\$&') + tail)).test(prodSrc);
});
{
  const mark = missingCfg.length ? 'FAIL' : 'ok  ';
  console.log('  ' + mark + ' 配置接线（防死配置键）：共 ' + cfgKeys.length + ' 项' +
    (missingCfg.length ? '，从未被生产代码读取 ' + missingCfg.length + ' 项' : '，全部有接线'));
  if (missingCfg.length) {
    fail++;
    console.log('       ' + JSON.stringify(missingCfg) + '（死开关：配置里能改，实际没人读。要么接线，要么从 DEFAULT_CONFIG 移除）');
  }
}

/* ---------------- 工具参数 / 配置键的测试提及 ----------------
   参数与配置键「契约里有、测试从不提」= 行为没有任何锁：改坏了也不会红。
   口径与上面各组一致（地板线）：名字至少要在 test/ 里出现过；FAIL 带 tool.param / section.key 定位。 */
function mentionGroup(label, pairs) {
  const missing = pairs.filter(([, s]) => {
    const tail = /[A-Za-z0-9_]$/.test(s) ? '\\b' : '';
    return !(new RegExp('\\b' + s.replace(ESCAPE_RE, '\\$&') + tail)).test(testsSrc);
  });
  const mark = missing.length ? 'FAIL' : 'ok  ';
  console.log('  ' + mark + ' ' + label + '：共 ' + pairs.length + ' 项' +
    (missing.length ? '，未被任何测试提到 ' + missing.length + ' 项' : '，全部有测试提及'));
  if (missing.length) { fail++; console.log('       ' + JSON.stringify(missing.map(([d]) => d))); }
}

// inputSchema 的 properties 顶层键 = 该工具的入参（嵌套的 viewport.width 之类是字段结构，不算独立参数）
const toolParams = [];
{
  const re = /^tool\('([a-z_]+)'/gm;
  let m;
  while ((m = re.exec(server))) {
    let i = server.indexOf('(', m.index) + 1;
    while (i < server.length) {
      const n = skipComment(server, i);
      if (n !== i) { i = n; continue; }
      if (/\s/.test(server[i]) || server[i] === ',') { i++; continue; }
      if (server[i] === "'" || server[i] === '"' || server[i] === '`') { i = skipStr(server, i); continue; }
      if (server[i] === '{') break;
      i++;
    }
    const schema = braceBlock(server, i);
    const pi = schema.indexOf('properties');
    if (pi < 0) continue;
    const pb = braceBlock(schema, schema.indexOf('{', pi));
    for (const k of depth1Keys(pb)) toolParams.push(m[1] + '.' + k);
  }
}
mentionGroup('工具参数（inputSchema）', toolParams.map((d) => [d, d.split('.')[1]]));
mentionGroup('配置键（DEFAULT_CONFIG）', cfgKeys.map((d) => [d, d.split('.')[1]]));

console.log('\n' + (fail ? '覆盖度自检失败：有 ' + fail + ' 组能力从未被测试' : '覆盖度自检通过：所有能力都有测试覆盖'));
process.exit(fail ? 1 : 0);
