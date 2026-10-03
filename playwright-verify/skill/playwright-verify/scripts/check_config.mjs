#!/usr/bin/env node
/**
 * check_config.mjs — 配置基线体检（脚本方式）
 *
 * 用法：
 *   node scripts/check_config.mjs playwright.config.ts
 *   node scripts/check_config.mjs                      # 自动在 cwd 找 playwright.config.*
 *   node scripts/check_config.mjs --json
 *
 * 放在流水线最前面：配置错的时候后面全是白干。
 * 有 ERROR（如未设 forbidOnly、timeout 过长、trace: off）时退出码 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { lib, parseArgs, finish } from './verify-lib.mjs';

const { flags, positional } = parseArgs();

try {
  const { checkConfig, formatText, findConfigFiles } = await lib('configcheck.js');
  let file = positional[0];
  if (!file) {
    const found = findConfigFiles(process.cwd());
    if (!found.length) {
      finish(2, `在 ${process.cwd()} 下没找到 playwright.config.*。请显式传入配置文件路径。`);
    }
    file = found[0];
  }
  if (!fs.existsSync(file)) finish(2, `配置文件不存在：${path.resolve(file)}`);
  const report = checkConfig(path.resolve(file));
  if (flags.json) finish(report.summary.exitCode, JSON.stringify(report, null, 2));
  finish(report.summary.exitCode, formatText(report));
} catch (e) {
  finish(2, `check_config 无法执行：${e.message}`);
}
