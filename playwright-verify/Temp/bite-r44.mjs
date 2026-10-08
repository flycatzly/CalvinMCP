#!/usr/bin/env node
/**
 * bite-r44.mjs — H30 崩溃现场落盘的负向咬合（破坏→跑→还原一体）
 *   B1 crashbundle.shouldBundle 恒 false（决策短路）→ 预测 H30 七钉红（3 决策 + 3 写盘 + NOT_CRASH 计数）
 *   B2 verify-all close 分支摘掉 persistBundle 调用 → 预测「双分支接线」钉红（1 红）
 *   B3 buildBundleMeta hexExit 写死 '0x0' → 预测 meta 归一钉 + meta.json 落盘钉红（2 红）
 * sha256 精确还原；每步还原后校验哈希往返一致。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F_LIB = path.join(ROOT, 'mcp/lib/crashbundle.js');
const F_VA = path.join(ROOT, 'mcp/test/verify-all.mjs');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function runHardened(tag) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'mcp/test/hardened-check.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  const h30 = fails.filter((l) => l.includes('H30'));
  const cleanEnd = out.includes('加固回归');
  console.log(`[${tag}] exit=${r.status} FAIL=${fails.length}（H30 ${h30.length}）${cleanEnd ? '' : ' ⚠ 无收尾行：套件中途崩溃（崩了不是红了）'}`);
  if (!cleanEnd) console.log(`   tail: ${out.split('\n').slice(-4).join(' | ').slice(0, 300)}`);
  for (const l of fails) console.log(`   ${l.trim().slice(0, 110)}`);
  return { fails, h30 };
}

function bite(tag, file, from, to, expectH30) {
  const before = sha(file);
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(from)) { console.error(`[${tag}] 锚文本未命中，中止：${from.slice(0, 60)}`); process.exit(2); }
  fs.writeFileSync(file, src.replace(from, to), 'utf8');
  const r = runHardened(tag);
  fs.writeFileSync(file, src, 'utf8'); // 精确还原（原字符串写回）
  const after = sha(file);
  const restored = after === before;
  console.log(`[${tag}] 还原 sha256 ${restored ? '一致 ✅' : '不一致 ❌'}（${before.slice(0, 12)} → ${after.slice(0, 12)}）`);
  const hit = r.h30.length === expectH30;
  console.log(`[${tag}] 咬合判定：H30 红 ${r.h30.length} / 预测 ${expectH30} —— ${hit ? '恰中 ✅' : '偏差 ❌（预测错要修正预测或钉）'}`);
  if (!restored || !hit) process.exit(1);
  return restored;
}

console.log('== 基线（应全绿）==');
const base = runHardened('baseline');
if (base.fails.length !== 0) { console.error('基线非绿，先修再咬'); process.exit(1); }

console.log('\n== B1 shouldBundle 恒 false ==');
bite('B1', F_LIB,
  'return !lines.some((l) => l.trim().startsWith(\'FAIL\'));',
  'return false; // BITE-B1 决策短路',
  7);

console.log('\n== B2 verify-all close 分支摘 persistBundle ==');
bite('B2', F_VA,
  'const crashBundle = persistBundle(code, { passCount: summary.passCount, skipCount: summary.skipCount });',
  'const crashBundle = null; // BITE-B2 接线摘除',
  1);

console.log('\n== B3 hexExit 写死 ==');
bite('B3', F_LIB,
  'hexExit: u === null ? null : `0x${u.toString(16).toUpperCase()}`,',
  'hexExit: \'0x0\', // BITE-B3',
  2);

console.log('\n== 终态复核（还原后应全绿）==');
const fin = runHardened('final');
if (fin.fails.length !== 0) { console.error('终态非绿 ❌'); process.exit(1); }
console.log('\nbite-r44 全部通过：3 组恰中预测、sha256 三往返一致、终态全绿 ✅');
