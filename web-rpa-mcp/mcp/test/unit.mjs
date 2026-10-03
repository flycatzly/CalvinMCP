// web-rpa-mcp — 单元测试：核心纯函数 / 表格读取（含自造 xlsx）/ 变量系统
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import assert from 'node:assert/strict';

import { formatDate, addDays, slugify, maskSecret } from '../lib/core.mjs';
import { readTable, resolveColumn, readXlsx } from '../lib/table.mjs';
import { resolveTemplate, resolveBuiltin, resolveToken, autodetectVariables, fromTable, resolveParams } from '../lib/vars.mjs';

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

console.log('\n总计: ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\n失败项:\n' + failures.join('\n')); }
process.exit(fail ? 1 : 0);
