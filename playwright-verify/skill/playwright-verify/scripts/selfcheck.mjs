#!/usr/bin/env node
/**
 * selfcheck.mjs — 环境自检（脚本方式）
 *
 * 用法：node scripts/selfcheck.mjs [--cwd <项目根>]
 *
 * 逐项报告：等长脱敏不变量、规则表、Playwright 运行器、playwright-cli、Python（Excel 编排）、
 * 以及核心库是否可定位。部署后先跑这个，比逐个人工试探快。
 * 必需项失败 → 退出码 1；可选项缺失只提示（执行类/编排类工具会不可用，其余不受影响）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLibDir, parseArgs, finish } from './verify-lib.mjs';

const { flags } = parseArgs();
const cwd = path.resolve(String(flags.cwd || process.cwd()));

const checks = [];
const add = (name, ok, detail, optional = false) => checks.push({ name, ok, detail, optional });

// 1) 核心库可定位
const libDir = findLibDir();
add('核心库（mcp/lib）', !!libDir, libDir || '未找到 —— 请先运行 install.mjs 或设置 PVMCP_HOME');

if (libDir) {
  const { lib } = await import('./verify-lib.mjs');
  try {
    const { selfCheck } = await lib('tokenizer.js');
    const r = selfCheck();
    add('等长脱敏不变量', r.ok, r.ok ? `${r.checked} 组样例通过` : r.problems.join('; '));
  } catch (e) { add('等长脱敏不变量', false, e.message); }

  try {
    const { RULES } = await lib('lint.js');
    add('lint 规则表', RULES.length >= 14,
      `${RULES.length} 条（ERROR ${RULES.filter((x) => x.severity === 'ERROR').length} / WARN ${RULES.filter((x) => x.severity === 'WARN').length}）`);
  } catch (e) { add('lint 规则表', false, e.message); }

  try {
    const { resolvePlaywrightRunner, resolveCliRunner } = await lib('runner.js');
    const pw = resolvePlaywrightRunner(cwd);
    add('Playwright 运行器', !!pw, pw ? pw.how : '未安装（run_verify 不可用，其余工具不受影响）', true);
    const cli = resolveCliRunner(cwd);
    add('playwright-cli', !!cli, cli ? cli.how : '未安装（cli_* 工具不可用）', true);
    // CLI 在但通道配置缺失/跨平台时，cli_* 会以「Daemon process exited（daemonPid）」失败，
    // 真实原因（如 Chromium distribution 'chrome' is not found）埋在堆栈里 —— 在这里提前点名，
    // 免得装完依赖的人以为产品坏了。可选级：装了目标浏览器的机器上缺配置也能跑。
    if (cli) {
      const cfgFile = path.join(cwd, '.playwright', 'cli.config.json');
      let cfg = null;
      try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { /* 缺失/坏文件按未配置处理 */ }
      const platOk = cfg && typeof cfg._平台 === 'string' && cfg._平台.startsWith(process.platform);
      add('CLI 浏览器通道配置', !!platOk,
        platOk ? `${cfgFile}（${cfg._平台}）`
          : `缺失或不匹配（${cfg ? `声明 ${cfg._平台 || '未知'}，当前 ${process.platform}` : `无 ${cfgFile}`}）`
            + ' —— CLI 会回退默认通道。修法：node skill/playwright-verify/scripts/setup-cli-config.mjs',
        true);
    }
  } catch (e) { add('运行器探测', false, e.message); }

  try {
    const { resolvePython } = await lib('orchestrate.js');
    const py = resolvePython();
    add('Python（Excel 编排）', !!py, py || '未找到（orchestrate_excel 用 .csv 仍可用）', true);
  } catch (e) { add('Python 探测', false, e.message); }
}

// 2) Skill 资产完整性
try {
  const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const refs = fs.readdirSync(path.join(skillRoot, 'references'));
  add('references 知识层', refs.length >= 10, `${refs.length} 篇`);
  const assets = fs.readdirSync(path.join(skillRoot, 'assets'));
  add('assets 资产层', assets.length >= 4, `${assets.length} 个模板`);
} catch (e) { add('Skill 资产', false, e.message); }

const required = checks.filter((c) => !c.optional);
const ok = required.every((c) => c.ok);
const text = [
  'playwright-verify Skill 自检',
  `cwd: ${cwd}`,
  '',
  ...checks.map((c) => `  ${c.ok ? 'PASS' : (c.optional ? 'SKIP' : 'FAIL')} ${c.name}: ${c.detail}`),
  '',
  ok ? '必需项全部通过。' : '有关键项失败，请按上面的说明补齐。',
].join('\n');
finish(ok ? 0 : 1, text);
