// web-rpa-mcp — 单元测试：核心纯函数 / 表格读取（含自造 xlsx）/ 变量系统
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

import { formatDate, addDays, slugify, maskSecret, redactByKey, redactPath, maskingEnabled, redactKeyList, log, readConfig, writeConfig, DIRS } from '../lib/core.mjs';
import { readTable, resolveColumn, readXlsx } from '../lib/table.mjs';
import { resolveTemplate, resolveBuiltin, resolveToken, autodetectVariables, fromTable, resolveParams } from '../lib/vars.mjs';
import { acquireLock, acquireLockWithWait, releaseLock } from '../lib/ops.mjs';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + (e && e.message ? e.message : e)); console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message : e)); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; failures.push(name + ' -> ' + (e && e.message ? e.message : e)); console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message : e)); }
}

/* ---------- 最小 xlsx 生成器（stored，无压缩）用于验证读取器 ---------- */
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.data, 'utf8');
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);          // stored
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    chunks.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

function makeXlsx(rows) {
  const shared = [];
  const si = [];
  const sheetRows = rows.map((row, r) => {
    const cells = row.map((val, c) => {
      const letter = String.fromCharCode(65 + c);
      const s = String(val === null || val === undefined ? '' : val);
      let idx = shared.indexOf(s);
      if (idx < 0) { shared.push(s); idx = shared.length - 1; }
      return '<c r="' + letter + (r + 1) + '" t="s"><v>' + idx + '</v></c>';
    }).join('');
    return '<row r="' + (r + 1) + '">' + cells + '</row>';
  }).join('');
  const sheet = '<?xml version="1.0"?><worksheet><sheetData>' + sheetRows + '</sheetData></worksheet>';
  const ss = '<?xml version="1.0"?><sst>' + shared.map((s) => '<si><t>' + s.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</t></si>').join('') + '</sst>';
  const wb = '<?xml version="1.0"?><workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  return makeZip([
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: ss },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'webrpa-test-'));
const now = new Date(2026, 8, 30, 10, 34, 12);   // 2026-09-30 10:34:12

console.log('\n[core]');
t('formatDate 常规', () => assert.equal(formatDate(now, 'YYYY-MM-DD'), '2026-09-30'));
t('formatDate 紧凑', () => assert.equal(formatDate(now, 'YYYYMMDD'), '20260930'));
t('formatDate 时间', () => assert.equal(formatDate(now, 'HH:mm:ss'), '10:34:12'));
t('addDays 跨月', () => assert.equal(formatDate(addDays(new Date(2026, 8, 1), -1), 'YYYY-MM-DD'), '2026-08-31'));
t('slugify 中文保留', () => assert.equal(slugify('订单报表 导出/提交'), '订单报表-导出-提交'));
t('slugify 非法字符', () => assert.equal(slugify('a<b>c:d'), 'a-b-c-d'));
t('slugify 空白回退', () => assert.equal(slugify('   ', 'flow'), 'flow'));
t('maskSecret 短串', () => assert.equal(maskSecret('abc'), '***'));
t('maskSecret 长串', () => assert.match(maskSecret('abcdefghijklmn'), /^abc\*+lmn$/));

console.log('\n[redaction 键名脱敏]');
t('redactByKey 命中键名整体脱敏（不分大小写）', () => {
  const out = redactByKey({ Password: 'P@ss-1', user: 'u1' }, new Set(['password']));
  assert.equal(out.Password, '***');
  assert.equal(out.user, 'u1');
});
t('redactByKey 嵌套数组递归且不改入参', () => {
  const input = { list: [{ token: 'T-1' }, { ok: 1 }], n: 5 };
  const out = redactByKey(input, new Set(['token']));
  assert.equal(out.list[0].token, '***');
  assert.equal(out.list[1].ok, 1);
  assert.equal(out.n, 5);
  assert.equal(input.list[0].token, 'T-1', 'redactByKey 不应改动入参');
});
t('redactByKey 关闭或空名单时原样返回', () => {
  const v = { password: 'x' };
  assert.equal(redactByKey(v, new Set(['password']), false), v);
  assert.equal(redactByKey(v, new Set()), v);
});
t('maskingEnabled 默认开、maskSecrets=false 关；redactKeyList 自定义名单整体替换', () => {
  assert.equal(maskingEnabled({}), true);
  assert.equal(maskingEnabled({ security: { maskSecrets: true } }), true);
  assert.equal(maskingEnabled({ security: { maskSecrets: false } }), false);
  assert.ok(redactKeyList({}).has('password'), '默认名单应含 password');
  const custom = redactKeyList({ security: { redactKeys: ['订单号'] } });
  assert.ok(custom.has('订单号'));
  assert.ok(!custom.has('password'), '自定义名单应整体替换默认');
});
t('log() 额外字段命中 redactKeys 脱敏后落盘', () => {
  const before = readConfig().security;
  writeConfig({ security: { maskSecrets: true, redactKeys: ['password'] } });
  try {
    log('unit-redact', 'info', '脱敏探针', { password: 'FAKE-LOG-PW-42', user: 'u-ok-42' });
    const raw = fs.readFileSync(path.join(DIRS.logs, formatDate(new Date()) + '.log'), 'utf8');
    assert.ok(raw.indexOf('FAKE-LOG-PW-42') < 0, '日志泄露了 password 明文');
    assert.ok(raw.indexOf('u-ok-42') >= 0, '普通字段不应被脱敏');
  } finally {
    writeConfig({ security: before });
  }
});

console.log('\n[redaction 路径脱敏]');
t('redactPath 包内路径保留 mcp/ 相对段且行列号不动', () => {
  const out = redactPath('    at requireFlow (file:///D:/work/MCP/web-rpa-mcp/mcp/lib/store.mjs:69:17)');
  assert.equal(out, '    at requireFlow (lib/store.mjs:69:17)');
});
t('redactPath 包外/含空格路径只留文件名，行列号不动', () => {
  assert.equal(redactPath('读取 C:\\Users\\alice\\data\\orders.xlsx 失败'), '读取 orders.xlsx 失败');
  assert.equal(redactPath('at f (C:\\Program Files\\App\\run.js:1:2)'), 'at f (run.js:1:2)');
  assert.equal(redactPath('at g (/home/alice/x.log:5:1)'), 'at g (x.log:5:1)');
});
t('redactPath 无路径文本与 URL 里的伪路径原样返回', () => {
  assert.equal(redactPath('流程不存在: x（用 flow_list 查看可用流程）'), '流程不存在: x（用 flow_list 查看可用流程）');
  assert.equal(redactPath('见 https://example.com/home/user/x'), '见 https://example.com/home/user/x');
  assert.equal(redactPath(undefined), '');
});

console.log('\n[table]');
const csv = path.join(tmp, 'orders.csv');
fs.writeFileSync(csv, '\uFEFF订单号,金额,状态\nA001,"1,200",待处理\nA002,300,已完成\nA003,450,已完成\n', 'utf8');
t('CSV 表头', () => assert.deepEqual(readTable(csv).headers, ['订单号', '金额', '状态']));
t('CSV 行数', () => assert.equal(readTable(csv).rows.length, 3));
t('CSV 引号内逗号', () => assert.equal(readTable(csv).rows[0][1], '1,200'));
t('resolveColumn 列名', () => assert.equal(resolveColumn(readTable(csv), '状态'), 2));
t('resolveColumn 字母', () => assert.equal(resolveColumn(readTable(csv), 'A'), 0));
t('resolveColumn 1基序号', () => assert.equal(resolveColumn(readTable(csv), '2'), 1));
t('resolveColumn 模糊', () => assert.equal(resolveColumn(readTable(csv), '订单'), 0));

const xlsx = path.join(tmp, 'orders.xlsx');
fs.writeFileSync(xlsx, makeXlsx([['订单号', '金额', '状态'], ['B001', '999', '待处理'], ['B002', '888', '已完成']]));
t('XLSX 表头', () => assert.deepEqual(readTable(xlsx).headers, ['订单号', '金额', '状态']));
t('XLSX 单元格', () => assert.equal(readTable(xlsx).rows[1][0], 'B002'));
t('XLSX 原始矩阵', () => assert.equal(readXlsx(xlsx).length, 3));

t('TSV 读取（有表头）', () => {
  const f = path.join(tmp, 'a.tsv');
  fs.writeFileSync(f, '单号\t金额\nT1\t10\nT2\t20\n', 'utf8');
  const t2 = readTable(f);
  assert.deepEqual(t2.headers, ['单号', '金额']);
  assert.equal(t2.rows[1][0], 'T2');
});

t('TXT 逐行文本：不把第一行当表头吃掉', () => {
  const f = path.join(tmp, 'nos.txt');
  fs.writeFileSync(f, 'N1\nN2\nN3\n', 'utf8');
  const t2 = readTable(f);
  assert.equal(t2.rows.length, 3, '第一行被当成表头了');
  assert.equal(t2.rows[0][0], 'N1');
  assert.equal(t2.rows[2][0], 'N3');
  assert.equal(fromTable(f + '#值@0'), 'N1');
  assert.equal(fromTable(f + '#1@2'), 'N3');
});

t('JSON 标量数组：不把第一项当表头吃掉', () => {
  const f = path.join(tmp, 'scalars.json');
  fs.writeFileSync(f, JSON.stringify(['J1', 'J2', 'J3']), 'utf8');
  const t2 = readTable(f);
  assert.equal(t2.rows.length, 3, '第一项被当成表头了');
  assert.equal(t2.rows[0][0], 'J1');
});

t('JSON 对象数组：键作为表头', () => {
  const f = path.join(tmp, 'objs.json');
  fs.writeFileSync(f, JSON.stringify([{ 单号: 'J1', 金额: 5 }, { 单号: 'J2', 金额: 6 }]), 'utf8');
  const t2 = readTable(f);
  assert.deepEqual(t2.headers, ['单号', '金额']);
  assert.equal(t2.rows[0][0], 'J1');
  assert.equal(resolveColumn(t2, '金额'), 1);
  assert.equal(fromTable(f + '#单号@1'), 'J2');
});

console.log('\n[vars]');
t('内置 today', () => assert.equal(resolveBuiltin('today', '', now), '2026-09-30'));
t('内置 today 格式化', () => assert.equal(resolveBuiltin('today', 'YYYYMMDD', now), '20260930'));
t('内置 yesterday', () => assert.equal(resolveBuiltin('yesterday', 'YYYY-MM-DD', now), '2026-09-29'));
t('内置 tomorrow', () => assert.equal(resolveBuiltin('tomorrow', 'YYYYMMDD', now), '20261001'));
t('内置 random 位数', () => assert.match(resolveBuiltin('random', '8', now), /^\d{8}$/));
t('内置 today-7 偏移', () => assert.equal(resolveBuiltin('today-7', 'YYYY-MM-DD', now), '2026-09-23'));
t('内置 today+3 偏移', () => assert.equal(resolveBuiltin('today+3', 'YYYYMMDD', now), '20261003'));
t('内置 now-1 偏移', () => assert.equal(resolveBuiltin('now-1', 'YYYY-MM-DD', now), '2026-09-29'));
t('内置 yesterday-7 偏移', () => assert.equal(resolveBuiltin('yesterday-7', 'YYYY-MM-DD', now), '2026-09-22'));
t('模板 偏移变量', () => assert.equal(resolveTemplate('D=${today-7:YYYYMMDD}', { now }), 'D=20260923'));
t('模板 偏移+格式', () => assert.equal(resolveTemplate('${today+1:YYYY年MM月DD日}', { now }), '2026年10月01日'));
t('内置 daystart/dayend', () => {
  assert.equal(resolveBuiltin('daystart', '', now), '2026-09-30 00:00:00');
  assert.equal(resolveBuiltin('dayend', '', now), '2026-09-30 23:59:59');
});
t('内置 monthstart/yeartoday', () => {
  assert.equal(resolveBuiltin('monthstart', '', now), '2026-09-01');
  assert.equal(resolveBuiltin('yeartoday', '', now), '2026-01-01');
});
t('内置 time/date/timestamp/uuid/root', () => {
  assert.equal(resolveBuiltin('time', '', now), '10:34:12');
  assert.equal(resolveBuiltin('date', '', now), '2026-09-30');
  assert.equal(resolveBuiltin('timestamp', '', now), String(now.getTime()));
  assert.match(resolveBuiltin('uuid', '', now), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(String(resolveBuiltin('root', '', now)).length > 0);
});
t('内置 env / osuser', () => {
  process.env.WEBRPA_UNIT_ENV = 'ENV-OK';
  assert.equal(resolveBuiltin('env', 'WEBRPA_UNIT_ENV', now), 'ENV-OK');
  const u2 = resolveBuiltin('osuser', '', now);
  assert.ok(u2 === null || typeof u2 === 'string');
});
t('resolveToken 支持 file: 内联读取', () => {
  const f = path.join(tmp, 'val.txt');
  fs.writeFileSync(f, '  FILE-VALUE  \n', 'utf8');
  assert.equal(resolveToken('file:' + f, { now }), 'FILE-VALUE');
});
t('模板 参数优先', () => assert.equal(resolveTemplate('单据-\${no}', { values: { no: 'X9' }, now }), '单据-X9'));
t('模板 内置日期', () => assert.equal(resolveTemplate('D=\${today:YYYYMMDD}', { now }), 'D=20260930'));
t('模板 未知保留', () => assert.equal(resolveTemplate('a\${mystery}b', { now }), 'a\${mystery}b'));
t('模板 重复替换', () => assert.equal(resolveTemplate('\${today}/\${today}', { now }), '2026-09-30/2026-09-30'));

t('fromTable CSV 首行', () => assert.equal(fromTable(csv + '#订单号'), 'A001'));
t('fromTable CSV 第2行', () => assert.equal(fromTable(csv + '#订单号@1'), 'A002'));
t('fromTable CSV 全部', () => assert.equal(fromTable(csv + '#订单号@*'), 'A001\nA002\nA003'));
t('fromTable CSV 列序号', () => assert.equal(fromTable(csv + '#3@2'), '已完成'));
t('fromTable XLSX', () => assert.equal(fromTable(xlsx + '#订单号@1'), 'B002'));

t('autodetect 今天->today', () => {
  const r = autodetectVariables([{ op: 'fill', value: '2026-09-30' }], now);
  assert.equal(r.steps[0].value, '\${today:YYYY-MM-DD}');
  assert.equal(r.replaced.length, 1);
});
t('autodetect 昨天->yesterday', () => {
  const r = autodetectVariables([{ op: 'fill', value: '20260929' }], now);
  assert.equal(r.steps[0].value, '\${yesterday:YYYYMMDD}');
});
t('autodetect 明日->tomorrow', () => {
  const r = autodetectVariables([{ op: 'fill', value: '2026/10/01' }], now);
  assert.equal(r.steps[0].value, '\${tomorrow:YYYY/MM/DD}');
});
t('autodetect 非今天不改', () => {
  const r = autodetectVariables([{ op: 'fill', value: '2020-01-01' }], now);
  assert.equal(r.steps[0].value, '2020-01-01');
});
t('autodetect 敏感值不采集', () => {
  const r = autodetectVariables([{ op: 'fill', value: 'secret123', sensitive: true }, { op: 'fill', value: 'secret123', sensitive: true }], now);
  assert.equal(r.suggestions.length, 0);
});
t('autodetect 重复值建议', () => {
  const r = autodetectVariables([{ op: 'fill', value: 'AB-12345' }, { op: 'fill', value: 'AB-12345' }], now);
  assert.equal(r.suggestions.length, 1);
});

await ta('resolveParams 必填缺失', async () => {
  const r = await resolveParams({ params: [{ name: 'no', required: true, source: 'prompt' }] }, {}, { now });
  assert.deepEqual(r.missing, ['no']);
});
await ta('resolveParams provided 优先', async () => {
  const r = await resolveParams({ params: [{ name: 'no', default: 'D1' }] }, { no: 'P1' }, { now });
  assert.equal(r.values.no, 'P1');
});
await ta('resolveParams source=env', async () => {
  process.env.WEBRPA_TEST_VAR = 'ENVVAL';
  const r = await resolveParams({ params: [{ name: 'v', source: 'env:WEBRPA_TEST_VAR' }] }, {}, { now });
  assert.equal(r.values.v, 'ENVVAL');
});
await ta('resolveParams source=excel', async () => {
  const r = await resolveParams({ params: [{ name: 'no', source: 'excel:' + xlsx + '#订单号@1' }] }, {}, { now });
  assert.equal(r.values.no, 'B002');
});
await ta('resolveParams source=file', async () => {
  const f = path.join(tmp, 'pf.txt');
  fs.writeFileSync(f, 'FROM-FILE\n', 'utf8');
  const r = await resolveParams({ params: [{ name: 'v', source: 'file:' + f }] }, {}, { now });
  assert.equal(r.values.v, 'FROM-FILE');
});
await ta('resolveParams source=table（excel 别名）', async () => {
  const f = path.join(tmp, 'orders2.csv');
  fs.writeFileSync(f, '单号,金额\nA1,1\nA2,2\n', 'utf8');
  const r = await resolveParams({ params: [{ name: 'v', source: 'table:' + f + '#单号@1' }] }, {}, { now });
  assert.equal(r.values.v, 'A2');
});
await ta('resolveParams source=const 取默认值', async () => {
  const r = await resolveParams({ params: [{ name: 'v', source: 'const', default: 'D' }] }, {}, { now });
  assert.equal(r.values.v, 'D');
});
await ta('resolveParams source=prompt 缺失被记为 missing', async () => {
  const r = await resolveParams({ params: [{ name: 'v', source: 'prompt', required: true }] }, {}, { now });
  assert.deepEqual(r.missing, ['v']);
});
await ta('resolveParams 参数互相引用', async () => {
  const r = await resolveParams({ params: [{ name: 'd', default: '\${today:YYYYMMDD}' }, { name: 'tag', default: 'T-\${d}' }] }, {}, { now });
  assert.equal(r.values.d, '20260930');
  assert.equal(r.values.tag, 'T-20260930');
});

console.log('\n[schedule]');
const { validateSpec } = await import('../lib/schedule.mjs');
t('validateSpec daily 不校验时刻', () => assert.equal(validateSpec({ frequency: 'daily', at: '00:00' }, now), null));
t('validateSpec once 未来时刻通过', () => assert.equal(validateSpec({ frequency: 'once', date: '2026/10/01', at: '09:00' }, now), null));
t('validateSpec once 时刻已过被拦下', () => {
  const msg = validateSpec({ frequency: 'once', date: '2026/09/30', at: '09:00' }, now);
  assert.ok(msg && msg.indexOf('已经过去') >= 0, '应当报"已经过去"，实际: ' + msg);
});
t('validateSpec once 不传 date 时今天的过去时刻被拦下', () => {
  const msg = validateSpec({ frequency: 'once', at: '00:01' }, now);
  assert.ok(msg && msg.indexOf('已经过去') >= 0, '默认取今天时已过的时刻应被拦下: ' + msg);
});
t('validateSpec once 非法 date/at 格式被拦下', () => {
  assert.ok(String(validateSpec({ frequency: 'once', date: '2026-10-01', at: '09:00' }, now)).indexOf('date 格式') >= 0, '连字符日期应提示改用 YYYY/MM/DD');
  assert.ok(String(validateSpec({ frequency: 'once', date: '2026/10/02', at: '9点' }, now)).indexOf('at 格式') >= 0, '非法时刻应被拦下');
});

console.log('\n[ops 定时预期]');
const { scheduleIntervalHours } = await import('../lib/ops.mjs');
t('scheduleIntervalHours minute 按 everyMinutes', () => assert.equal(scheduleIntervalHours({ frequency: 'minute', everyMinutes: 10 }), 10 / 60));
t('scheduleIntervalHours minute 默认 30 分钟', () => assert.equal(scheduleIntervalHours({ frequency: 'minute' }), 0.5));
t('scheduleIntervalHours hourly 按 everyHours', () => assert.equal(scheduleIntervalHours({ frequency: 'hourly', everyHours: 2 }), 2));
t('scheduleIntervalHours daily/weekly/monthly', () => {
  assert.equal(scheduleIntervalHours({ frequency: 'daily' }), 24);
  assert.equal(scheduleIntervalHours({ frequency: 'weekly' }), 168);
  assert.equal(scheduleIntervalHours({ frequency: 'monthly' }), 720);
});
t('scheduleIntervalHours once/logon 无固定间隔返回 null', () => {
  assert.equal(scheduleIntervalHours({ frequency: 'once', date: '2026/12/31', at: '10:00' }), null);
  assert.equal(scheduleIntervalHours({ frequency: 'logon' }), null);
});

console.log('\n[run 预算解析 resolveRunBudget]');
const { resolveRunBudget } = await import('../lib/core.mjs');
t('显式参数优先于配置', () => {
  assert.deepEqual(resolveRunBudget(5000, { maxDurationMs: 60000 }, 'manual'), { maxDurationMs: 5000, cappedBy: null });
});
t('未传显式则用配置 run.maxDurationMs', () => {
  assert.deepEqual(resolveRunBudget(undefined, { maxDurationMs: 60000 }, 'manual'), { maxDurationMs: 60000, cappedBy: null });
});
t('manual 触发不吃无人值守默认上限', () => {
  assert.deepEqual(resolveRunBudget(undefined, { maxDurationMs: 0, unattendedMaxDurationMs: 7200000 }, 'manual'), { maxDurationMs: 0, cappedBy: null });
});
t('schedule 且未配总超时时启用无人值守默认上限', () => {
  assert.deepEqual(resolveRunBudget(undefined, { maxDurationMs: 0, unattendedMaxDurationMs: 7200000 }, 'schedule'),
    { maxDurationMs: 7200000, cappedBy: 'unattendedMaxDurationMs' });
});
t('显式 maxDurationMs=0 是逃生舱（schedule 也不封顶）', () => {
  assert.deepEqual(resolveRunBudget(0, { maxDurationMs: 0, unattendedMaxDurationMs: 7200000 }, 'schedule'), { maxDurationMs: 0, cappedBy: null });
});
t('unattendedMaxDurationMs=0 关闭无人值守默认上限', () => {
  assert.deepEqual(resolveRunBudget(undefined, { maxDurationMs: 0, unattendedMaxDurationMs: 0 }, 'schedule'), { maxDurationMs: 0, cappedBy: null });
});
t('chain 子流程触发方式不吃无人值守上限（只随父预算）', () => {
  assert.deepEqual(resolveRunBudget(undefined, { maxDurationMs: 0, unattendedMaxDurationMs: 7200000 }, 'chain:parent'), { maxDurationMs: 0, cappedBy: null });
  assert.deepEqual(resolveRunBudget(3000, { maxDurationMs: 0, unattendedMaxDurationMs: 7200000 }, 'chain:parent'), { maxDurationMs: 3000, cappedBy: null });
});

console.log('\n[工具入参校验 validateArgs]');
const { validateArgs } = await import('../lib/core.mjs');
const S_RUN = { type: 'object', properties: { flowId: { type: 'string' }, headed: { type: 'boolean' }, maxDurationMs: { type: 'integer', minimum: 0 }, videoOn: { type: 'string', enum: ['failure', 'always'] } }, required: ['flowId'] };
t('合法参数通过且未声明键保留', () => {
  const r = validateArgs({ flowId: 'x', 未来新键: 1 }, S_RUN);
  assert.equal(r.ok, true);
  assert.equal(r.value.flowId, 'x');
  assert.equal(r.value['未来新键'], 1);
});
t('字符串数字/布尔保守转换（LLM 客户端常发字符串）', () => {
  const r = validateArgs({ flowId: 'x', maxDurationMs: '5000', headed: 'false' }, S_RUN);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.maxDurationMs, 5000);
  assert.equal(r.value.headed, false);
});
t('转不动的字符串报错并点名参数', () => {
  const r = validateArgs({ flowId: 'x', maxDurationMs: 'abc' }, S_RUN);
  assert.equal(r.ok, false);
  assert.equal(r.error.param, 'maxDurationMs');
  assert.ok(/整数/.test(r.error.message), r.error.message);
});
t('minimum 拒绝负数（负的总超时限不再被静默当"不限"）', () => {
  const r = validateArgs({ flowId: 'x', maxDurationMs: -1 }, S_RUN);
  assert.equal(r.ok, false);
  assert.equal(r.error.param, 'maxDurationMs');
  assert.ok(/≥ 0/.test(r.error.message), r.error.message);
});
t('enum 拒绝拼错的取值', () => {
  const r = validateArgs({ flowId: 'x', videoOn: 'sometimes' }, S_RUN);
  assert.equal(r.ok, false);
  assert.equal(r.error.param, 'videoOn');
});
t('required 缺失点名参数', () => {
  const r = validateArgs({ maxDurationMs: 1 }, S_RUN);
  assert.equal(r.ok, false);
  assert.equal(r.error.param, 'flowId');
  assert.ok(/缺少必填/.test(r.error.message), r.error.message);
});
t('数组元素逐个校验（items[1].flow）', () => {
  const S = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { flow: { type: 'string' } }, required: ['flow'] } } }, required: ['items'] };
  const r = validateArgs({ items: [{ flow: 'a' }, {}] }, S);
  assert.equal(r.ok, false);
  assert.equal(r.error.param, 'items[1].flow');
});
t('object 类型拒绝数组、整数拒绝小数', () => {
  const S = { type: 'object', properties: { params: { type: 'object' }, n: { type: 'integer' } } };
  assert.equal(validateArgs({ params: [] }, S).ok, false);
  assert.equal(validateArgs({ n: 1.5 }, S).ok, false);
  assert.equal(validateArgs({ n: 2 }, S).ok, true);
});
t('未声明类型的片段不设限', () => {
  const S = { type: 'object', properties: { 任意: {} } };
  const r = validateArgs({ 任意: [1, 'x', null] }, S);
  assert.equal(r.ok, true, JSON.stringify(r));
});

console.log('\n[路径穿越防护 assertSafeId / pattern]');
const { assertSafeId, SAFE_ID_PATTERN } = await import('../lib/core.mjs');
const { flowPath, runsFlowRoot, runDir } = await import('../lib/store.mjs');
t('assertSafeId 放行常规 id / 中文 / 内部点号', () => {
  assert.equal(assertSafeId('ok-id_1'), 'ok-id_1');
  assert.equal(assertSafeId('中文流程'), '中文流程');
  assert.equal(assertSafeId('a.b'), 'a.b');
});
t('assertSafeId 拒绝路径穿越与非法字符', () => {
  for (const bad of ['../x', '..\\x', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', '..', 'x..y', '..x']) {
    assert.throws(() => assertSafeId(bad), /不合法/, '应拒绝: ' + bad);
  }
});
t('assertSafeId 拒绝点号开头/收尾/空/超长', () => {
  for (const bad of ['', '.hidden', 'a.', 'a ', 'x'.repeat(129)]) {
    assert.throws(() => assertSafeId(bad), /不合法/, '应拒绝: ' + JSON.stringify(bad));
  }
});
t('assertSafeId 拒绝控制符', () => {
  const nul = String.fromCharCode(0), us = String.fromCharCode(31);
  assert.throws(() => assertSafeId('a' + nul + 'b'), /不合法/);
  assert.throws(() => assertSafeId('a' + us + 'b'), /不合法/);
});
t('flowPath 拒绝穿越 id（曾可读 flows/ 之外任意 .json）', () => {
  assert.throws(() => flowPath('../web-rpa.config'), /不合法/);
  assert.throws(() => flowPath('..\\web-rpa.config'), /不合法/);
  const p = flowPath('ok-id');
  assert.ok(p.endsWith(path.join('flows', 'ok-id.json')), p);
});
t('runsFlowRoot/runDir 拒绝穿越 flowId/stamp', () => {
  assert.throws(() => runsFlowRoot('../x'), /不合法/);
  assert.throws(() => runsFlowRoot(''), /不合法/);
  assert.throws(() => runDir('ok', '../x'), /不合法/);
  assert.throws(() => runDir('ok', 'a.'), /不合法/);
  const d = runDir('ok', '20261004-120000-000');
  assert.ok(d.endsWith(path.join('runs', 'ok', '20261004-120000-000')), d);
});
t('validateArgs pattern 拦截非法 id 并点名参数', () => {
  const S = { type: 'object', properties: { flowId: { type: 'string', pattern: SAFE_ID_PATTERN } }, required: ['flowId'] };
  const r = validateArgs({ flowId: '../web-rpa.config' }, S);
  assert.equal(r.ok, false);
  assert.equal(r.error.param, 'flowId');
  assert.equal(validateArgs({ flowId: 'ok-id' }, S).ok, true);
  assert.equal(validateArgs({ flowId: '中文流程' }, S).ok, true, JSON.stringify(validateArgs({ flowId: '中文流程' }, S)));
});
t('validateArgs pattern 同样覆盖数组元素路径', () => {
  const S = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { flow: { type: 'string', pattern: SAFE_ID_PATTERN } }, required: ['flow'] } } }, required: ['items'] };
  const r = validateArgs({ items: [{ flow: 'a' }, { flow: '..\\x' }] }, S);
  assert.equal(r.ok, false);
  assert.equal(r.error.param, 'items[1].flow');
});
t('SAFE_ID_PATTERN 编译为合法正则且与 assertSafeId 同向', () => {
  const re = new RegExp(SAFE_ID_PATTERN);
  assert.equal(re.test('ok-id'), true);
  assert.equal(re.test('中文流程'), true);
  assert.equal(re.test('a:b'), false);
  assert.equal(re.test('a/b'), false);
  assert.equal(re.test('a\\b'), false);
  assert.equal(re.test(''), false);
  assert.equal(re.test('x'.repeat(129)), false);
});

await ta('schedule.taskPrefix 配置驱动系统任务名前缀（恢复默认不残留）', async () => {
  const { taskName, defaultTaskPrefix } = await import('../lib/schedule.mjs');
  const before = readConfig().schedule;
  writeConfig({ schedule: { taskPrefix: 'XPA' } });
  try {
    assert.equal(taskName('f1'), 'XPA\\f1');
  } finally {
    writeConfig({ schedule: before });
  }
  // 默认前缀随实例隔离漂移（WEBRPA_ROOT 注入时带 ROOT 短哈希），断言"恢复到默认"而非字面量
  assert.equal(taskName('f1'), defaultTaskPrefix() + '\\f1', 'taskPrefix 未恢复默认');
});

/* ---------- 锁：有界等待 acquireLockWithWait（profile 锁等待语义的底层件） ---------- */
await ta('acquireLockWithWait 无竞争立即拿到（含 waitMs=0 不等待路径）', async () => {
  const id = 't-unit-lock-w0';
  try {
    const r = await acquireLockWithWait(id, { trigger: 'unit' }, 2000);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.waitedMs < 200, '无竞争不应有可观等待: ' + r.waitedMs);
    const r0 = await acquireLockWithWait(id + '-0', { trigger: 'unit' }, 0);
    assert.equal(r0.ok, true, JSON.stringify(r0));
  } finally { releaseLock(id); releaseLock(id + '-0'); }
});

await ta('acquireLockWithWait 撞活锁后预算内等对方放（waitedMs 如实上报）', async () => {
  const id = 't-unit-lock-w1';
  acquireLock(id, { trigger: 'unit-holder' });
  const releaser = setTimeout(() => releaseLock(id), 400);
  try {
    const r = await acquireLockWithWait(id, { trigger: 'unit-waiter' }, 2000);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.waitedMs >= 300, '应真等到对方放锁（约 400ms 后才放）: ' + r.waitedMs);
  } finally { clearTimeout(releaser); releaseLock(id); }
});

await ta('acquireLockWithWait 超预算诚实失败：ok=false 带 heldBy 与 waitedMs', async () => {
  const id = 't-unit-lock-w2';
  acquireLock(id, { trigger: 'unit-holder' });
  try {
    const r = await acquireLockWithWait(id, { trigger: 'unit-waiter' }, 300);
    assert.equal(r.ok, false);
    assert.ok(r.heldBy && r.heldBy.held === true, 'heldBy 应指向仍持有锁的一方: ' + JSON.stringify(r.heldBy));
    assert.ok(r.waitedMs >= 250, '超预算失败也要如实报等待时长: ' + r.waitedMs);
    assert.ok(r.waitedMs < 1500, '不应远超预算: ' + r.waitedMs);
  } finally { releaseLock(id); }
});

await ta('browser.profileWaitMs 配置键可写可读（默认 3000；0=撞上即报的旧行为口径）', async () => {
  const before = readConfig().browser;
  assert.equal(typeof before.profileWaitMs, 'number', 'DEFAULT_CONFIG.browser 应带 profileWaitMs');
  writeConfig({ browser: Object.assign({}, before, { profileWaitMs: 4321 }) });
  try {
    assert.equal(readConfig().browser.profileWaitMs, 4321);
    writeConfig({ browser: Object.assign({}, readConfig().browser, { profileWaitMs: 0 }) });
    assert.equal(readConfig().browser.profileWaitMs, 0, '0 必须原样保留（不被默认值吞掉）');
  } finally {
    writeConfig({ browser: before });
  }
  assert.equal(readConfig().browser.profileWaitMs, before.profileWaitMs, '恢复后不残留');
});

console.log('\n总计: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\n失败项:\n' + failures.join('\n')); }
process.exit(fail ? 1 : 0);
