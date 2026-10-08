#!/usr/bin/env node
/**
 * bite-r48.mjs — 导出录制 JSON 的负向咬合（破坏→跑→还原一体）
 *   B1 recorder.js exportFileName 拔掉保留字符清洗 → 预测恰 5 红
 *      （纯函数清洗矩阵 1、全符号回落 1、vm 成功链 download 正则 1、日志回执正则 1、保真文件名面 1）
 *   B2 floating.js 导出链拔掉 a.click() → 预测恰 1 红（成功链 pins：clicks===1）
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F_REC = path.join(ROOT, 'extension/recorder.js');
const F_FLT = path.join(ROOT, 'extension/floating.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function runCheck(tag) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'mcp/test/floating-check.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
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
  fs.writeFileSync(file, src.replace(from, to), 'utf8');
  const fails = runCheck(tag);
  fs.writeFileSync(file, src, 'utf8');
  const restored = sha(file) === before;
  console.log(`[${tag}] 还原 sha256 ${restored ? '一致 ✅' : '不一致 ❌'}；红 ${fails.length}/${expectN} —— ${fails.length === expectN && restored ? '恰中 ✅' : '偏差 ❌'}`);
  if (!restored || fails.length !== expectN) process.exit(1);
}

console.log('== 基线 ==');
if (runCheck('baseline').length !== 0) { console.error('基线非绿'); process.exit(1); }

console.log('\n== B1 拔保留字符清洗 ==');
bite('B1', F_REC, ".replace(/[\\\\\\/:*?\"<>|]/g, '_')", '', 5);

console.log('\n== B2 拔导出链 a.click() ==');
bite('B2', F_FLT, "          a.click();\n", '          /* BITE-B48 click 拔除 */\n', 1);

console.log('\n== 终态复核 ==');
if (runCheck('final').length !== 0) { console.error('终态非绿'); process.exit(1); }
console.log('\nbite-r48 通过：B1 恰 5 红 / B2 恰 1 红、sha256 往返一致、终态全绿 ✅');
