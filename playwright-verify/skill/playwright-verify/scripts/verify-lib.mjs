/**
 * verify-lib.mjs — 定位核心库（mcp/lib）
 *
 * 为什么需要它：这个 Skill 有两种用法 ——
 *   (a) 通过 MCP 工具调用（工具已注册进客户端）；
 *   (b) 直接用 scripts/ 里的命令（CLI 方式，脚本用、CI 用、没有 MCP 客户端时也能用）。
 * 两种用法必须跑同一份判定逻辑，否则「MCP 说 ERROR 0、脚本说 ERROR 2」这种自相矛盾
 * 会把门禁的公信力一次性废掉。所以这里统一做一件事：找到那一份 mcp/lib。
 *
 * 查找顺序：
 *   1) $PVMCP_HOME 或 $PVMCP_LIB 环境变量（显式指定，最优先）
 *   2) 从本文件向上逐级找 mcp/lib/index.js（开发时的仓库布局）
 *   3) ~/.agents/skills/playwright-verify-mcp/mcp/lib （全局安装布局）
 * 找不到就明确报错并说明怎么装 —— 绝不静默降级成「跳过检查」。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function looksLikeLib(dir) {
  try {
    return fs.statSync(path.join(dir, 'lint.js')).isFile()
      && fs.statSync(path.join(dir, 'configcheck.js')).isFile();
  } catch { return false; }
}

function candidates() {
  const out = [];
  if (process.env.PVMCP_LIB) out.push(process.env.PVMCP_LIB);
  if (process.env.PVMCP_HOME) out.push(path.join(process.env.PVMCP_HOME, 'mcp', 'lib'));
  // 从 scripts/ 向上找（仓库布局：<root>/skill/playwright-verify/scripts → <root>/mcp/lib）
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    out.push(path.join(dir, 'mcp', 'lib'));
    dir = path.dirname(dir);
  }
  // 全局安装布局
  const home = os.homedir();
  out.push(path.join(home, '.agents', 'skills', 'playwright-verify-mcp', 'mcp', 'lib'));
  out.push(path.join(home, '.agents', 'skills', 'playwright-verify', 'mcp', 'lib'));
  return out;
}

/** 找到 mcp/lib 绝对路径；找不到返回 null。 */
export function findLibDir() {
  for (const c of candidates()) {
    if (c && looksLikeLib(c)) return c;
  }
  return null;
}

/** 动态 import 一个核心模块；找不到直接抛错（并给出安装指引）。 */
export async function lib(moduleName) {
  const dir = findLibDir();
  if (!dir) {
    throw new Error(
      '找不到 playwright-verify 的核心库（mcp/lib）。\n'
      + '请任选一种方式：\n'
      + '  1) 在仓库里跑：node skill/playwright-verify/install.mjs\n'
      + '  2) 手动设置：$env:PVMCP_HOME="<项目根>"（该目录下应有 mcp/lib/）\n'
      + `  3) 确认 ~/.agents/skills/playwright-verify-mcp/mcp/lib 存在\n`
      + `已查找的位置：\n${candidates().filter(Boolean).map((c) => `  - ${c}`).join('\n')}`,
    );
  }
  return import(pathToFileURL(path.join(dir, moduleName)).href);
}

/** 统一的 CLI 入口样板：解析 --flag value 形式的参数。 */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

/** 按退出码结束，并把结论打印出来。门禁语义：0 通过 / 1 阻断 / 2 用法或环境错误。 */
export function finish(code, text) {
  if (text) process.stdout.write(`${text}\n`);
  process.exit(code);
}
