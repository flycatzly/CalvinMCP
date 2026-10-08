#!/usr/bin/env node
/**
 * bite-r49.mjs — 插拔式双模的负向咬合（破坏→跑→还原一体）
 *   B1 panel.js 配置键回退 legacy（get/set 都只碰 base/token）→ 预测恰 2 红
 *      （键统一 pin：保存不再写 pv_*；旧键迁移 pin：pv_* 永不生成）
 *   B2 floating.js 拔 generate 分支的独立模式守卫 → 预测恰 1 红
 *      （守卫钉：本地模式点 generate 后 pv-bridge 发出 +0 变 +1、日志指引消失）
 *   前提证伪不咬：bridgeCall 第二层守卫单独拔除无钉红（分支守卫是承重层，第二层是兜底）
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const F_PANEL = path.join(ROOT, 'extension/panel.js');
const F_FLT = path.join(ROOT, 'extension/floating.js');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function runSuite(file, tag) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'mcp/test', file)], { cwd: ROOT, encoding: 'utf8', timeout: 180_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  console.log(`[${tag}] exit=${r.status} FAIL=${fails.length}${out.includes('全部通过') ? '' : '（未见全绿收尾）'}`);
  for (const l of fails) console.log(`   ${l.trim().slice(0, 110)}`);
  return fails;
}

function bite(tag, file, edits, runner, expectN) {
  const before = sha(file);
  const src = fs.readFileSync(file, 'utf8');
  let mutated = src;
  for (const [from, to] of edits) {
    if (!mutated.includes(from)) { console.error(`[${tag}] 锚文本未命中：${from.slice(0, 60)}`); process.exit(2); }
    mutated = mutated.replace(from, to);
  }
  fs.writeFileSync(file, mutated, 'utf8');
  const fails = runner(tag);
  fs.writeFileSync(file, src, 'utf8');
  const restored = sha(file) === before;
  console.log(`[${tag}] 还原 sha256 ${restored ? '一致 ✅' : '不一致 ❌'}；红 ${fails.length}/${expectN} —— ${fails.length === expectN && restored ? '恰中 ✅' : '偏差 ❌'}`);
  if (!restored || fails.length !== expectN) process.exit(1);
}

console.log('== 基线 ==');
if (runSuite('bridge-check.mjs', 'baseline-bridge').length !== 0
  || runSuite('floating-check.mjs', 'baseline-float').length !== 0) { console.error('基线非绿'); process.exit(1); }

console.log('\n== B1 配置键回退 legacy ==');
bite('B1', F_PANEL, [
  ['const got = await chrome.storage.local.get([\'pv_base\', \'pv_token\', \'base\', \'token\']);',
    'const got = await chrome.storage.local.get([\'base\', \'token\']); // BITE-B49'],
  // 同一行出现两处（load 迁移写 + save 保存写）：逐处拔成 legacy（replace 只换首处，排两条）。
  // 替换文本不带行注释：迁移写在单行 try{}catch{} 里，行注释会吞掉 catch（r49 咬合首跑实测）
  ['await chrome.storage.local.set({ pv_base: base, pv_token: token });',
    'await chrome.storage.local.set({ base, token });'],
  ['await chrome.storage.local.set({ pv_base: base, pv_token: token });',
    'await chrome.storage.local.set({ base, token });'],
], (t) => runSuite('bridge-check.mjs', t), 2);

console.log('\n== B2 拔 generate 分支独立模式守卫 ==');
bite('B2', F_FLT, [
  ["        if (mode === 'local') { logLine('独立模式：生成需要 MCP 桥（点 ⚡ 切回依赖模式）；导出 JSON 是本地能力，可用。'); return; }\n", ''],
], (t) => runSuite('floating-check.mjs', t), 1);

console.log('\n== 终态复核 ==');
if (runSuite('bridge-check.mjs', 'final-bridge').length !== 0
  || runSuite('floating-check.mjs', 'final-float').length !== 0) { console.error('终态非绿'); process.exit(1); }
console.log('\nbite-r49 通过：B1 恰 2 红 / B2 恰 1 红、sha256 往返一致、终态全绿 ✅');
