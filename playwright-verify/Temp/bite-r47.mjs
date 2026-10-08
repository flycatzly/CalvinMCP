#!/usr/bin/env node
/**
 * bite-r47.mjs — PW006 修饰断言形态扫尾的负向咬合（破坏→跑→还原一体）
 *   B1 PW006 正则收窄回裸 expect(（拔掉 (?:\.\s*(?:soft|poll))?）→ 预测恰 2 红
 *      （ADV 钉「soft 缺 await 命中」「poll 缺 await 命中」；其余钉不冤枉：
 *       messy/语料的裸 expect 命中照旧、await soft/poll 与同步值守卫本就 forbid）
 *   前提已证伪不咬（r20 方法论）：仅回退 EXPECT_HEAD_RE 不会让任何钉红——
 *   旧式剥离在异步来源 soft 上 inner 仍含 .getBy* 可过闸门、同步值仍被闸门放过，
 *   该改动是「判据可信性」的结构修 not 行为面，行为面咬合锚就是正则本身。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F = path.join(ROOT, 'mcp/lib/lint.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function runLint(tag) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'mcp/test/lint-check.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  const cleanEnd = out.includes('全部样例符合预期');
  console.log(`[${tag}] exit=${r.status} FAIL=${fails.length}${cleanEnd ? '' : ' ⚠ 无收尾行'}`);
  for (const l of fails) console.log(`   ${l.trim().slice(0, 120)}`);
  return { fails, cleanEnd };
}

console.log('== 基线（应全绿 58）==');
const base = runLint('baseline');
if (base.fails.length !== 0 || !base.cleanEnd) { console.error('基线非绿，先修再咬'); process.exit(1); }

console.log('\n== B1 正则收窄回裸 expect( ==');
const before = sha(F);
const src = fs.readFileSync(F, 'utf8');
const from = 're: new RegExp(`(?:^|[^\\\\w.])expect(?:\\\\.\\\\s*(?:soft|poll))?\\\\s*\\\\([^;]{0,5000}?\\\\)\\\\s*\\\\.\\\\s*(?:${ASSERTION_ALT})\\\\s*\\\\(`),';
const to = 're: new RegExp(`(?:^|[^\\\\w.])expect\\\\s*\\\\([^;]{0,5000}?\\\\)\\\\s*\\\\.\\\\s*(?:${ASSERTION_ALT})\\\\s*\\\\(`), // BITE-B47';
if (!src.includes(from)) { console.error('锚文本未命中，中止'); process.exit(2); }
fs.writeFileSync(F, src.replace(from, to), 'utf8');
const r = runLint('B1');
fs.writeFileSync(F, src, 'utf8');
const restored = sha(F) === before;
console.log(`[B1] 还原 sha256 ${restored ? '一致 ✅' : '不一致 ❌'}`);
const hit = r.fails.length === 2 && r.fails.every((l) => l.includes('修饰形态'));
console.log(`[B1] 咬合判定：红 ${r.fails.length} / 预测 2（且均为修饰形态钉）—— ${hit ? '恰中 ✅' : '偏差 ❌'}`);
if (!restored || !hit) process.exit(1);

console.log('\n== 终态复核 ==');
const fin = runLint('final');
if (fin.fails.length !== 0 || !fin.cleanEnd) { console.error('终态非绿 ❌'); process.exit(1); }
console.log('\nbite-r47 通过：B1 恰中 2 红、sha256 往返一致、终态全绿 ✅');
