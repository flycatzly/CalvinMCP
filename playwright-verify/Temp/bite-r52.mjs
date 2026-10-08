#!/usr/bin/env node
/**
 * bite-r52.mjs — CSV 公式注入中和的负向咬合（破坏→跑→还原一体）
 *   B1 formatCsv 拔中和（/^[=+\-@\t\r]/ 判定改恒 false）→ 预测恰 2 红
 *      （四形态中和钉 + TAB/CR 钉；BOM/转义钉不冤枉、judgeCollect 等无关钉保持绿）
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F = path.join(ROOT, 'mcp/lib/collect.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function runNl(tag) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'mcp/test/nl-agent-check.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  console.log(`[${tag}] exit=${r.status} FAIL=${fails.length}${out.includes('全部通过') ? '' : '（未见全绿收尾）'}`);
  for (const l of fails) console.log(`   ${l.trim().slice(0, 110)}`);
  return fails;
}

console.log('== 基线 ==');
if (runNl('baseline').length !== 0) { console.error('基线非绿'); process.exit(1); }

console.log('\n== B1 拔公式注入中和 ==');
const before = sha(F);
const src = fs.readFileSync(F, 'utf8');
const from = 'if (/^[=+\\-@\\t\\r]/.test(s)) s = `\'${s}`;';
if (!src.includes(from)) { console.error(`锚文本未命中：${from}`); process.exit(2); }
fs.writeFileSync(F, src.replace(from, 'if (false) s = `\'${s}`;'), 'utf8');
const fails = runNl('B1');
fs.writeFileSync(F, src, 'utf8');
const restored = sha(F) === before;
console.log(`[B1] 还原 sha256 ${restored ? '一致 ✅' : '不一致 ❌'}；红 ${fails.length}/2 —— ${fails.length === 2 && restored ? '恰中 ✅' : '偏差 ❌'}`);
if (!restored || fails.length !== 2) process.exit(1);

console.log('\n== 终态复核 ==');
if (runNl('final').length !== 0) { console.error('终态非绿'); process.exit(1); }
console.log('\nbite-r52 通过：B1 恰 2 红、sha256 往返一致、终态全绿 ✅');
