#!/usr/bin/env node
/**
 * setup-cli-config.mjs — 生成适配当前平台的 .playwright/cli.config.json
 *
 * 为什么需要它（真踩过的坑，而且是跨平台才会暴露的那种）：
 *   playwright-cli 的默认浏览器通道在不同平台/安装形态下不一样。
 *   本机实测过：源码目录用 msedge、安装目录却去找 chrome —— 于是
 *   「这里能跑、装完就不能跑」，而报错看起来像环境问题。
 *   把通道写死成 msedge 后，Windows 上稳了，但 **Linux/CI 上没有 Edge**，
 *   cli_health 会以 `Chromium distribution 'msedge' is not found` 失败。
 *
 * 所以正确做法不是"写死一个通道"，而是**按平台选**并显式落盘：
 *   · 环境变量 PVMCP_BROWSER_CHANNEL 优先（团队可统一指定，如 msedge / chrome）
 *   · Windows 上优先 msedge（系统自带，省一次浏览器下载）
 *   · 其它平台用 chromium（即 `npx playwright install chromium` 装的那个）
 *
 * 通道决策逻辑在 cli-config.mjs（与 install.mjs 共用同一份，避免两处漂移）。
 *
 * 用法：
 *   node skill/playwright-verify/scripts/setup-cli-config.mjs [--cwd <项目根>] [--channel msedge] [--print]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, finish } from './verify-lib.mjs';
import { pickChannel, buildCliConfig } from './cli-config.mjs';

const { flags } = parseArgs();
const cwd = path.resolve(String(flags.cwd || process.cwd()));

const { channel, source } = pickChannel({
  platform: process.platform,
  flagChannel: flags.channel ? String(flags.channel) : undefined,
});
const config = buildCliConfig({ platform: process.platform, arch: process.arch, channel, source });

const text = `${JSON.stringify(config, null, 2)}\n`;
if (flags.print) {
  finish(0, text);
}

const dir = path.join(cwd, '.playwright');
const file = path.join(dir, 'cli.config.json');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, text, 'utf8');
finish(0, `已写入 ${file}\n  平台: ${config._平台}\n  来源: ${config._通道来源}\n  通道: ${channel || '(未指定，使用默认 chromium)'}`);
