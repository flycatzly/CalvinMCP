#!/usr/bin/env node
/**
 * bite-r50.mjs — 面板历史区富渲染的负向咬合（破坏→跑→还原一体）
 *   B1 pvFactsLine 帽改恒不限 → 预测恰 2 红（双面同口径 cap 用例 + 口径边界 cap4 用例）
 *   B2 renderHistory 预览拔除（恒空串）→ 预测恰 2 红（历史行预览行为 + 恶意载荷保真）
 *   替换文本不带行注释（r49 教训：单行 try{}catch{}/同一行余文会被行注释吞）
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F = path.join(ROOT, 'extension/panel.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function runBridge(tag) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'mcp/test/bridge-check.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  console.log(`[${tag}] exit=${r.status} FAIL=${fails.length}${out.includes('全部通过') ? '' : '（未见全绿收尾）'}`);
  for (const l of fails) console.log(`   ${l.trim().slice(0, 110)}`);
  return fails;
}

function bite(tag, from, to, expectN) {
  const before = sha(F);
  const src = fs.readFileSync(F, 'utf8');
  if (!src.includes(from)) { console.error(`[${tag}] 锚文本未命中：${from.slice(0, 60)}`); process.exit(2); }
  fs.writeFileSync(F, src.replace(from, to), 'utf8');
  const fails = runBridge(tag);
  fs.writeFileSync(F, src, 'utf8');
  const restored = sha(F) === before;
  console.log(`[${tag}] 还原 sha256 ${restored ? '一致 ✅' : '不一致 ❌'}；红 ${fails.length}/${expectN} —— ${fails.length === expectN && restored ? '恰中 ✅' : '偏差 ❌'}`);
  if (!restored || fails.length !== expectN) process.exit(1);
}

console.log('== 基线 ==');
if (runBridge('baseline').length !== 0) { console.error('基线非绿'); process.exit(1); }

console.log('\n== B1 pvFactsLine 帽恒不限 ==');
bite('B1', 'const cap = max > 0 ? max : 4;', 'const cap = Infinity;', 2);

console.log('\n== B2 renderHistory 预览拔除 ==');
bite('B2', "const pvEl = mk('h-preview'); pvEl.textContent = h.preview || ''; li.appendChild(pvEl);",
  "const pvEl = mk('h-preview'); pvEl.textContent = ''; li.appendChild(pvEl);", 2);

console.log('\n== 终态复核 ==');
if (runBridge('final').length !== 0) { console.error('终态非绿'); process.exit(1); }
console.log('\nbite-r50 通过：B1 恰 2 红 / B2 恰 2 红、sha256 往返一致、终态全绿 ✅');
