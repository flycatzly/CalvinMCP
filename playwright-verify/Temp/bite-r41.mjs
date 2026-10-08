// r41 负向咬合一体脚本：破坏 → 跑 hardened → 还原 → sha256 三往返校验
// B1 serialAssertions 回退 find 单取        预期恰 2 红（多拓扑+同源口径）
// B2 判据基数回退 find 字面量               预期恰 1 红（解耦接线钉）
// B3 serial 计入回退 deployed-check 硬编码   预期恰 1 红（硬编码回归钉）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const SUITES_F = path.join(ROOT, 'mcp/test/suites.mjs');
const VA_F = path.join(ROOT, 'mcp/test/verify-all.mjs');

const baseSuites = sha(SUITES_F);
const baseVa = sha(VA_F);
console.log(`基线 sha256 suites=${baseSuites.slice(0, 16)}… verify-all=${baseVa.slice(0, 16)}…`);

function runHardened() {
  const r = spawnSync(process.execPath, ['mcp/test/hardened-check.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  const fails = (r.stdout || '').split('\n').filter((l) => l.startsWith('FAIL'));
  return fails;
}

function bite(name, file, from, to, expectN, expectKeywords) {
  const orig = fs.readFileSync(file, 'utf8');
  if (!orig.includes(from)) { console.error(`BITE ${name}: 锚点未命中，中止（不破坏）`); process.exit(1); }
  fs.writeFileSync(file, orig.replace(from, to));
  const fails = runHardened();
  const okN = fails.length === expectN;
  const okKw = expectKeywords.every((kw) => fails.some((f) => f.includes(kw)));
  console.log(`\nBITE ${name}: ${fails.length} 红（预期 ${expectN}）${okN ? '✓' : '✗ 不符！'} 关键词命中 ${okKw ? '✓' : '✗'}`);
  for (const f of fails) console.log(`  ${f.slice(0, 120)}`);
  fs.writeFileSync(file, orig); // 还原
  const nowSha = sha(file);
  const base = file === SUITES_F ? baseSuites : baseVa;
  console.log(`  还原 sha256 ${nowSha === base ? '一致 ✓' : `不一致 ✗ ${nowSha} != ${base}`}`);
  return okN && okKw && nowSha === base;
}

const r1 = bite('B1', SUITES_F,
  'return suites.filter((s) => s.serial).reduce((n, s) => n + s.assertions, 0);',
  'return suites.find((s) => s.serial)?.assertions ?? 0;',
  2, ['多 serial 拓扑基数', '同源口径']);

const r2 = bite('B2', VA_F,
  'const SERIAL_N = serialAssertions();',
  'const SERIAL_N = SUITES.find((s) => s.serial).assertions;',
  1, ['判据基数走 serialAssertions']);

const r3 = bite('B3', VA_F,
  'const s = SUITES.find((x) => x.serial && x.file === r.file);',
  "const s = SUITES.find((x) => x.serial && r.file.includes('deployed-check'));",
  1, ['deployed-check 文件名硬编码回归即红']);

console.log(`\n终态 sha256 复核 suites=${sha(SUITES_F) === baseSuites ? '一致 ✓' : '✗'} verify-all=${sha(VA_F) === baseVa ? '一致 ✓' : '✗'}`);
console.log(`咬合结论：B1=${r1 ? '恰 2 红 ✓' : '✗'} B2=${r2 ? '恰 1 红 ✓' : '✗'} B3=${r3 ? '恰 1 红 ✓' : '✗'}`);
process.exit(r1 && r2 && r3 ? 0 : 1);
