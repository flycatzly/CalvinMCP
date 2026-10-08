#!/usr/bin/env node
/**
 * bite-r51.mjs — 控制台指引双修复面的负向咬合（破坏→跑→还原一体）
 *   B1 panel.js reconnect 指引拔除 → 预测恰 1 红（连接失败指引 vm 钉）
 *   B2 install.mjs「加载已解压的扩展程序」字样拔除 → 预测恰 1 红（安装引导源码钉）
 *   替换文本均为模板字面量内子串（无行注释吞 catch 问题）
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F_PANEL = path.join(ROOT, 'extension/panel.js');
const F_INST = path.join(ROOT, 'skill/playwright-verify/install.mjs');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function runBridge(tag) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'mcp/test/bridge-check.mjs')], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
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
  // 全量替换（注释与正文同文时必须一起拔——只换首处会留正文、钉不红）
  fs.writeFileSync(file, src.split(from).join(to), 'utf8');
  const fails = runBridge(tag);
  fs.writeFileSync(file, src, 'utf8');
  const restored = sha(file) === before;
  console.log(`[${tag}] 还原 sha256 ${restored ? '一致 ✅' : '不一致 ❌'}；红 ${fails.length}/${expectN} —— ${fails.length === expectN && restored ? '恰中 ✅' : '偏差 ❌'}`);
  if (!restored || fails.length !== expectN) process.exit(1);
}

console.log('== 基线 ==');
if (runBridge('baseline').length !== 0) { console.error('基线非绿'); process.exit(1); }

console.log('\n== B1 reconnect 指引拔除 ==');
bite('B1', F_PANEL, ' —— 桥未运行？在项目目录执行 node mcp/bridge.mjs 起桥后点「保存并重连」（独立模式可不依赖桥）', '', 1);

console.log('\n== B2 安装引导字样拔除 ==');
bite('B2', F_INST, '加载已解压的扩展程序', '加载扩展', 1);

console.log('\n== 终态复核 ==');
if (runBridge('final').length !== 0) { console.error('终态非绿'); process.exit(1); }
console.log('\nbite-r51 通过：B1 恰 1 红 / B2 恰 1 红、sha256 往返一致、终态全绿 ✅');
