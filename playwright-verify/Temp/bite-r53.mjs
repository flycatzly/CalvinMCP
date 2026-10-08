#!/usr/bin/env node
/**
 * bite-r53.mjs — 推进检测两击制的负向咬合（破坏→跑→还原一体）
 *   B1 两击制回退单击停 → 预测恰 1 红（flow-check /pure 站钉；F7 神圣钉不冤枉）
 *   B2 sameRows 恒 false → 预测恰 1 红（F7 神圣钉红——解耦承重在推进判定上；
 *      恒 true 不红（/pure 仍两击放行）——前提证伪不咬，r20 方法论）
 *   flow-check 单跑 ~90s；替换文本不带行注释
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F_SRV = path.join(ROOT, 'mcp/server.mjs');
const F_COL = path.join(ROOT, 'mcp/lib/collect.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function runFlow(tag) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'mcp/test/flow-check.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  console.log(`[${tag}] exit=${r.status} FAIL=${fails.length}${out.includes('全部通过') ? '' : '（未见全绿收尾）'}`);
  for (const l of fails) console.log(`   ${l.trim().slice(0, 110)}`);
  return fails;
}

function bite(tag, file, from, to, expectN) {
  const before = sha(file);
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(from)) { console.error(`[${tag}] 锚文本未命中：${from.slice(0, 60)}`); process.exit(2); }
  fs.writeFileSync(file, src.split(from).join(to), 'utf8');
  const fails = runFlow(tag);
  fs.writeFileSync(file, src, 'utf8');
  const restored = sha(file) === before;
  console.log(`[${tag}] 还原 sha256 ${restored ? '一致 ✅' : '不一致 ❌'}；红 ${fails.length}/${expectN} —— ${fails.length === expectN && restored ? '恰中 ✅' : '偏差 ❌'}`);
  if (!restored || fails.length !== expectN) process.exit(1);
}

console.log('== 基线 ==');
if (runFlow('baseline').length !== 0) { console.error('基线非绿'); process.exit(1); }

console.log('\n== B1 两击制回退单击停 ==');
bite('B1', F_SRV, 'if (dupStreak >= 2) { stopReason = \'no-new-rows\'; break; }',
  'if (dupStreak >= 1) { stopReason = \'no-new-rows\'; break; }', 1);

console.log('\n== B2 sameRows 恒 false ==');
bite('B2', F_COL, 'return ra.every((row, i) => JSON.stringify(Array.isArray(row) ? row : []) === JSON.stringify(Array.isArray(rb[i]) ? rb[i] : []));',
  'return false;', 1);

console.log('\n== 终态复核 ==');
if (runFlow('final').length !== 0) { console.error('终态非绿'); process.exit(1); }
console.log('\nbite-r53 通过：B1 恰 1 红 / B2 恰 1 红、sha256 往返一致、终态全绿 ✅');
