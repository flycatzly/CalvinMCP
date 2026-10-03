// web-rpa-mcp — 零依赖表格读取：CSV/TSV/JSON + 最小 XLSX(ZIP+inflateRaw) 解析
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

/* ---------- 最小 ZIP 读取 ---------- */
function readZip(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 65558);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/xlsx 文件（未找到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { buf, entries };
}

function readEntry(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  const b = zip.buf;
  const lh = e.localOff;
  if (b.readUInt32LE(lh) !== 0x04034b50) throw new Error('zip 本地头损坏: ' + name);
  const nameLen = b.readUInt16LE(lh + 26);
  const extraLen = b.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  let size = e.compSize;
  if (!size) {
    // 极少数写入器把大小放在数据描述符里：截到下一个条目起点
    size = b.length - start;
  }
  const data = b.subarray(start, Math.min(start + size, b.length));
  if (e.method === 0) return data;
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error('不支持的 zip 压缩方式: ' + e.method);
}

/* ---------- XML 极小工具 ---------- */
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function colLetterToIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) {
    if (ch < 'A' || ch > 'Z') continue;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const body = m[1];
    const ts = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1]));
    out.push(ts.join(''));
  }
  return out;
}

/** 解析工作表为 string[][]（按 r 属性定位列，补齐空洞） */
function parseSheet(xml, shared) {
  const rows = [];
  if (!xml) return rows;
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowAttrs = rm[1];
    const body = rm[2];
    const rowNum = Number((/\br="(\d+)"/.exec(rowAttrs) || [])[1] || rows.length + 1);
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1] || '';
      const inner = cm[2] || '';
      const ref = (/\br="([A-Z]+)\d+"/.exec(attrs) || [])[1];
      const t = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      let val = '';
      if (t === 'inlineStr') {
        val = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join('');
      } else {
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vm ? decodeXml(vm[1]) : '';
        if (t === 's') val = shared[Number(raw)] ?? '';
        else if (t === 'b') val = raw === '1' ? 'TRUE' : 'FALSE';
        else val = raw;
      }
      const idx = ref ? colLetterToIndex(ref) : cells.length;
      cells[idx] = val;
    }
    const width = cells.length;
    const arr = new Array(width);
    for (let i = 0; i < width; i++) arr[i] = cells[i] ?? '';
    const rIdx = rowNum - 1;
    rows[rIdx] = arr;
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

function resolveSheetPath(zip, sheetName) {
  const wb = readEntry(zip, 'xl/workbook.xml');
  const rels = readEntry(zip, 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) return 'xl/worksheets/sheet1.xml';
  const wbXml = wb.toString('utf8');
  const relXml = rels.toString('utf8');
  const relMap = new Map();
  for (const m of relXml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) relMap.set(m[1], m[2]);
  const sheets = [...wbXml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"/g)];
  let target = null;
  if (sheetName) {
    const hit = sheets.find((s) => decodeXml(s[1]) === sheetName);
    if (hit) target = relMap.get(hit[2]);
  } else if (sheets.length) {
    target = relMap.get(sheets[0][2]);
  }
  if (!target) return 'xl/worksheets/sheet1.xml';
  const clean = target.replace(/^\//, '').replace(/^xl\//, '');
  return 'xl/' + clean;
}

/* ---------- 对外 API ---------- */

export function readXlsx(file, { sheet } = {}) {
  const zip = readZip(fs.readFileSync(file));
  const shared = parseSharedStrings(readEntry(zip, 'xl/sharedStrings.xml')?.toString('utf8'));
  const sheetPath = resolveSheetPath(zip, sheet);
  const data = readEntry(zip, sheetPath);
  if (!data) throw new Error('未找到工作表: ' + sheetPath);
  return parseSheet(data.toString('utf8'), shared);
}

function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch === '\r') { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/** 读取表格文件为 { headers, rows, columns } */
export function readTable(file, opts = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error('表格文件不存在: ' + abs);
  const ext = path.extname(abs).toLowerCase();
  let matrix;
  // 有些格式天生没有表头（逐行文本、标量 JSON 数组）——不能把第一行当表头吃掉
  let noHeader = false;
  if (ext === '.xlsx' || ext === '.xlsm') matrix = readXlsx(abs, opts);
  else if (ext === '.json') {
    const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (Array.isArray(j)) {
      if (j.length && typeof j[0] === 'object' && !Array.isArray(j[0])) {
        const headers = Object.keys(j[0]);
        matrix = [headers, ...j.map((o) => headers.map((h) => (o[h] ?? '')))];
      } else {
        matrix = j.map((r) => (Array.isArray(r) ? r : [r]));
        noHeader = true;
      }
    } else {
      matrix = [[String(j)]];
      noHeader = true;
    }
  } else if (ext === '.csv') matrix = parseDelimited(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''), ',');
  else if (ext === '.tsv') matrix = parseDelimited(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''), '\t');
  else if (ext === '.txt') {
    matrix = fs.readFileSync(abs, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => [l]);
    noHeader = true;
  } else throw new Error('不支持的表格格式: ' + ext + '（支持 .xlsx .csv .tsv .txt .json）');

  const headerRowIdx = opts.headerRow === undefined ? (noHeader ? -1 : 0) : opts.headerRow;
  const headers = headerRowIdx >= 0
    ? (matrix[headerRowIdx] || []).map((h, i) => (String(h).trim() !== '' ? String(h).trim() : '列' + (i + 1)))
    : [(matrix[0] && matrix[0].length > 1) ? '列1' : '值'];
  const rows = matrix.slice(headerRowIdx + 1).filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  return { file: abs, headers, rows, matrix, allRows: matrix };
}

/** 把列标识（名称 / A 列字母 / 1 基序号）解析为列下标 */
export function resolveColumn(table, col) {
  if (col === undefined || col === null || col === '') return 0;
  const s = String(col).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n >= 1 ? n - 1 : 0;            // 人类习惯 1 基
  }
  if (/^[A-Za-z]{1,3}$/.test(s)) return colLetterToIndex(s);
  const lower = s.toLowerCase();
  const idx = table.headers.findIndex((h) => h.toLowerCase() === lower);
  if (idx >= 0) return idx;
  const fuzzy = table.headers.findIndex((h) => h.toLowerCase().includes(lower));
  if (fuzzy >= 0) return fuzzy;
  throw new Error('未找到列「' + s + '」。可用列: ' + table.headers.join(' | '));
}

export const _internal = { readZip, readEntry, parseSheet, parseSharedStrings, decodeXml, colLetterToIndex };
