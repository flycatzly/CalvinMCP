#!/usr/bin/env node
/**
 * install.mjs — 一键安装：Skill + MCP server + DSH bundle + MCP 客户端注册
 *
 * 做四件事，每件都可单独跳过：
 *   1) 依赖自检（node 版本、可选依赖 @playwright/test 与 @playwright/cli）
 *   2) 把项目复制到 ~/.agents/skills/playwright-verify-mcp/，把 Skill 装到 ~/.agents/skills/playwright-verify/
 *   3) 生成 DSH 的 MCP bundle（manifest + cordis.patch.yml，走 @deepseek-ai/dsh-mcp-client）
 *   4) 注册到已检测到的 MCP 客户端（Claude Code / Claude Desktop / Cursor），改前自动备份
 *
 * 用法：
 *   node install.mjs                     # 全套
 *   node install.mjs --no-register       # 只装 Skill 与 bundle，不动客户端配置
 *   node install.mjs --skills-only       # 只装 Skill
 *   node install.mjs --print-config      # 只打印各客户端的配置片段，不写任何文件
 *   node install.mjs --uninstall         # 移除注册项（保留文件，提示手动删）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideCliConfig, pickChannel, buildCliConfig } from './scripts/cli-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // <项目>/skill/playwright-verify
const PROJECT_ROOT = path.resolve(HERE, '..', '..');          // <项目>
const HOME = os.homedir();
const SKILLS_DIR = path.join(HOME, '.agents', 'skills');
const INSTALL_ROOT = path.join(SKILLS_DIR, 'playwright-verify-mcp');
const SKILL_LINK = path.join(SKILLS_DIR, 'playwright-verify');
const SERVER_NAME = 'playwright_verify';   // 工具名会是 mcp__playwright_verify__<tool>

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argVal = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const OPT = {
  noRegister: has('--no-register'),
  skillsOnly: has('--skills-only'),
  printConfig: has('--print-config'),
  uninstall: has('--uninstall'),
  force: has('--force'),
  // 默认工作目录：写进 MCP 注册项的 PVMCP_CWD。
  // 为什么重要：不设它，模型每次调用工具都得传 cwd（多轮对话里反复多花 token，
  // 而且忘传就会去扫错目录）。设一次，工具调用就干净了。
  target: argVal('--target', process.cwd()),
};

const results = [];
const step = (n, title) => console.log(`\n[${n}/4] ${title}`);
const record = (name, status, msg = '') => {
  results.push({ name, status, msg });
  const icon = status === 'ok' ? '✓' : status === 'skip' ? '−' : '✗';
  console.log(`  ${icon} ${name}${msg ? `：${msg}` : ''}`);
};

/* ---------------- 1) 环境自检 ---------------- */
step(1, '环境自检');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 18) {
  console.error(`  ✗ Node 版本过低：${process.versions.node}，需要 >= 18.17`);
  process.exit(2);
}
record('Node 版本', 'ok', `v${process.versions.node}`);

const hasPw = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', '@playwright', 'test'));
const hasCli = fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', '@playwright', 'cli'));
record('@playwright/test', hasPw ? 'ok' : 'skip', hasPw ? '已安装' : '未安装（run_verify / demo 不可用；其余工具不受影响）');
record('@playwright/cli', hasCli ? 'ok' : 'skip', hasCli ? '已安装' : '未安装（cli_* 工具不可用）');
if (!hasPw || !hasCli) {
  console.log(`     如需补齐可选依赖（只有执行层需要，部署本工具不需要）：cd "${PROJECT_ROOT}" && npm install`);
}

/* ---------------- 2) 安装 Skill ---------------- */
step(2, '安装 Skill 到 ~/.agents/skills');
if (OPT.printConfig) {
  record('安装 Skill', 'skip', '--print-config 模式，不写文件');
} else {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  // 复制时跳过大目录：node_modules 太大且可重装，.git 与运行产物没有分发价值。
  // 注意 @playwright/* 是可选的（只有执行类工具需要），所以不复制也不会坏。
  const SKIP = new Set(['node_modules', '.git', '.playwright-artifacts', 'test-results', 'dist', '__pycache__']);
  const copyRec = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      if (e.isDirectory()) copyRec(s, d);
      else fs.copyFileSync(s, d);
    }
  };

  // 布局：INSTALL_ROOT/{mcp, skill/playwright-verify, demo, package.json}
  // 这正是脚本的 verify-lib.mjs 会向上找到 mcp/lib 的那种布局，
  // 也让 PVMCP_HOME=INSTALL_ROOT 能成立。
  try {
    // 只删我们自己管理的两个子树，避免误删别人的东西
    for (const sub of ['mcp', 'skill', 'demo']) {
      const p = path.join(INSTALL_ROOT, sub);
      if (fs.existsSync(p) && OPT.force) fs.rmSync(p, { recursive: true, force: true });
    }
    copyRec(path.join(PROJECT_ROOT, 'mcp'), path.join(INSTALL_ROOT, 'mcp'));
    copyRec(path.join(PROJECT_ROOT, 'skill'), path.join(INSTALL_ROOT, 'skill'));
    if (fs.existsSync(path.join(PROJECT_ROOT, 'demo'))) {
      copyRec(path.join(PROJECT_ROOT, 'demo'), path.join(INSTALL_ROOT, 'demo'));
    }
    // package-lock.json 也要带过去：安装目录若需补装依赖，有锁文件才能复现同一套版本。
    // .gitignore / .gitattributes 也要：装到 skills 目录后如果被纳入某个仓库，
    //   产物目录不该被误提交，换行符也不该被 Git 改写（CRLF 会破坏 shebang）。
    // CI 工作流也要：它是「怎么用这套门禁」的可执行示范，属于交付物的一部分。
    for (const f of ['package.json', 'package-lock.json', '.gitignore', '.gitattributes',
      'README.md', '使用文档.md', '部署说明.md', '部署说明.详细版.md']) {
      const s = path.join(PROJECT_ROOT, f);
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(INSTALL_ROOT, f));
    }
    // 托管根文件只增不删会留下陈旧文件：文档改名/删除后（如 部署文档.md → 部署说明*.md），
    // 源码里没了、安装目录还留着 —— deployed-check 的「没有多余的陈旧文件」会一直报。
    // 所以源码里已不存在的托管文件要清掉（只动这个清单里的名字，不碰用户自己放的东西）。
    const MANAGED_ROOT_FILES = ['package.json', 'package-lock.json', '.gitignore', '.gitattributes',
      'README.md', '使用文档.md', '部署文档.md', '部署说明.md', '部署说明.详细版.md'];
    for (const f of MANAGED_ROOT_FILES) {
      const d = path.join(INSTALL_ROOT, f);
      if (!fs.existsSync(path.join(PROJECT_ROOT, f)) && fs.existsSync(d)) {
        fs.rmSync(d);
        record('清理陈旧托管文件', 'ok', `${f}（源码已无此文件）`);
      }
    }
    const ghDir = path.join(PROJECT_ROOT, '.github');
    if (fs.existsSync(ghDir)) {
      copyRec(ghDir, path.join(INSTALL_ROOT, '.github'));
      record('复制 CI 工作流', 'ok', '.github/workflows/ci.yml');
    } else {
      record('复制 CI 工作流', 'skip', '源目录没有 .github/');
    }
    // .playwright/cli.config.json 必须适配**目标机器**，不能无脑照搬源码目录的。
    // 踩过的坑：配置是 win32 生成的 msedge，装到没有 Edge 的机器上，cli_health 以
    // `Chromium distribution 'msedge' is not found` 失败 —— 「这里能跑、装完就不能跑」。
    // 决策矩阵在 scripts/cli-config.mjs（与 setup-cli-config.mjs 共用同一份，避免漂移）。
    const cliCfgSrc = path.join(PROJECT_ROOT, '.playwright');
    const cliCfgDst = path.join(INSTALL_ROOT, '.playwright');
    if (cliCfgSrc !== cliCfgDst && fs.existsSync(cliCfgSrc)) {
      copyRec(cliCfgSrc, cliCfgDst);
    }
    {
      const cfgFile = path.join(cliCfgDst, 'cli.config.json');
      let cfg = null;
      try {
        if (fs.existsSync(cfgFile)) cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      } catch { cfg = null; }   // 解析失败按「缺失」处理，重生成比留个坏文件好
      const decision = decideCliConfig({ cfg, platform: process.platform });
      if (decision.action === 'keep') {
        record('CLI 通道配置', 'ok', `.playwright/cli.config.json（${decision.detail}）`);
      } else {
        try {
          const { channel, source } = pickChannel({ platform: process.platform });
          const text = `${JSON.stringify(buildCliConfig({ platform: process.platform, arch: process.arch, channel, source }), null, 2)}\n`;
          fs.mkdirSync(cliCfgDst, { recursive: true });
          fs.writeFileSync(cfgFile, text, 'utf8');
          record('CLI 通道配置', 'ok',
            `${cfg ? `已按目标平台重新生成（原配置来自 ${cfg._平台 || '未知平台'}）` : '已按目标平台生成'}；通道: ${channel || '默认 chromium'}（${source}）`);
        } catch (e) {
          record('CLI 通道配置', 'fail',
            `生成失败：${e.message}（可手动执行 node scripts/setup-cli-config.mjs --cwd "${INSTALL_ROOT}"）`);
        }
      }
    }
    record('复制项目', 'ok', INSTALL_ROOT);
  } catch (e) {
    record('复制项目', 'fail', e.message);
  }

  // 2b) 把可选的 Playwright 依赖也带过去，让执行类 / CLI 类工具在安装后即可用。
  //     只复制 npm 包（几 MB），不复制浏览器二进制 —— 那些由 playwright 放在用户缓存目录
  //     （%LOCALAPPDATA%\ms-playwright），本来就不该重复复制。
  if (hasPw || hasCli) {
    try {
      const srcNm = path.join(PROJECT_ROOT, 'node_modules');
      const dstNm = path.join(INSTALL_ROOT, 'node_modules');
      fs.mkdirSync(dstNm, { recursive: true });
      for (const pkg of ['@playwright/test', '@playwright/cli', 'playwright', 'playwright-core']) {
        const s = path.join(srcNm, pkg);
        if (!fs.existsSync(s)) continue;
        copyRec(s, path.join(dstNm, pkg));
      }
      record('复制可选依赖', 'ok', '@playwright/test, @playwright/cli, playwright, playwright-core');
    } catch (e) {
      record('复制可选依赖', 'fail', `${e.message}（执行类工具可在安装目录执行 npm install 补齐）`);
    }
  } else {
    record('复制可选依赖', 'skip', '源目录没有安装 Playwright');
  }

  // 让 agent 能按 ~/.agents/skills/<name>/SKILL.md 发现 Skill
  try {
    copyRec(path.join(PROJECT_ROOT, 'skill', 'playwright-verify'), SKILL_LINK);
    record('安装 Skill', 'ok', SKILL_LINK);
  } catch (e) {
    record('安装 Skill', 'fail', e.message);
  }
}

/* ---------------- 3) 生成 DSH MCP bundle ---------------- */
step(3, '生成 DSH MCP bundle');
const serverPath = path.join(INSTALL_ROOT, 'mcp', 'server.mjs');
const bundleDir = path.join(INSTALL_ROOT, 'dsh-bundle');
const patchFile = path.join(bundleDir, 'cordis.patch.yml');
const manifestFile = path.join(bundleDir, 'package.json');

const patchContent = `# DSH MCP client 接线：把 playwright-verify-mcp 注册成一个 MCP 服务器
# - serverName 决定工具名空间：工具会以 mcp__${SERVER_NAME}__<tool> 出现
# - transport: stdio —— 本地程序走 stdio；注意 stdio 握手时会先起一个临时探测进程
# - failOnStartupError: true —— 连不上就让插件激活失败，而不是静默少一批工具
# - env.PVMCP_CWD —— 默认工作目录。设了它，模型调用工具时不必每次传 cwd
#   （多轮对话里省 token，也避免忘传就去扫错目录）。
- insert:
    - id: playwright-verify-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ${SERVER_NAME}
        transport: stdio
        command: ${JSON.stringify(process.execPath)}
        args:
          - ${JSON.stringify(serverPath)}
        cwd: ${JSON.stringify(INSTALL_ROOT)}
        env:
          PVMCP_CWD: ${JSON.stringify(OPT.target)}
        toolCallTimeoutMs: 600000
        failOnStartupError: true
`;

const manifestContent = `${JSON.stringify({
  name: '@local/playwright-verify-mcp',
  version: '1.0.0',
  private: true,
  type: 'module',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}, null, 2)}\n`;

if (OPT.printConfig || OPT.skillsOnly) {
  record('生成 bundle', 'skip', OPT.printConfig ? '--print-config 模式' : '--skills-only 模式');
} else {
  try {
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(patchFile, patchContent, 'utf8');
    fs.writeFileSync(manifestFile, manifestContent, 'utf8');
    record('生成 bundle', 'ok', bundleDir);
  } catch (e) {
    record('生成 bundle', 'fail', e.message);
  }
}

/* ---------------- 4) 注册到 MCP 客户端 ---------------- */
step(4, '注册到 MCP 客户端');

/** 通用注册项（Claude Code / Desktop / Cursor 都认 mcpServers 这一层）。 */
const ENTRY = {
  command: process.execPath,
  args: [serverPath],
  // PVMCP_CWD：让「默认工作目录」一次配好，工具调用不必每次带 cwd。
  env: { PVMCP_CWD: OPT.target },
};
const genericConfig = { mcpServers: { 'playwright-verify': ENTRY } };

function mergeInto(file, { remove = false } = {}) {
  try {
    let obj = {};
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw) obj = JSON.parse(raw);
      if (!remove) {
        const backup = `${file}.bak-playwright-verify`;
        if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      }
    } else if (remove) {
      return { s: 'skip', msg: '文件不存在' };
    }
    if (!obj.mcpServers || typeof obj.mcpServers !== 'object') obj.mcpServers = {};
    if (remove) {
      if (!obj.mcpServers['playwright-verify']) return { s: 'skip', msg: '没有注册项' };
      delete obj.mcpServers['playwright-verify'];
    } else {
      obj.mcpServers['playwright-verify'] = ENTRY;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    return { s: 'ok', msg: file };
  } catch (e) {
    return { s: 'fail', msg: `${file}: ${e.message}` };
  }
}

if (OPT.printConfig) {
  console.log('\n  DSH（推荐，走官方 mcp-client 插件）—— 把下面这个 bundle 目录安装进 DSH：');
  console.log(`    ${bundleDir}`);
  console.log('  或者把这段 patch 合并进你的 DSH profile 组合：\n');
  console.log(patchContent.split('\n').map((l) => `    ${l}`).join('\n'));
  console.log('\n  Claude Code / Claude Desktop / Cursor 通用配置片段：\n');
  console.log(JSON.stringify(genericConfig, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));
  record('打印配置', 'ok');
} else if (OPT.skillsOnly) {
  record('注册客户端', 'skip', '--skills-only 模式');
} else {
  const targets = [
    ['Claude Code (~/.claude.json)', path.join(HOME, '.claude.json')],
    ['Claude Desktop', path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')],
    ['Cursor', path.join(HOME, '.cursor', 'mcp.json')],
  ];
  let anyOk = false;
  for (const [label, file] of targets) {
    if (OPT.noRegister) { record(label, 'skip', '--no-register'); continue; }
    if (!fs.existsSync(file)) { record(label, 'skip', '未检测到该客户端'); continue; }
    const r = mergeInto(file, { remove: OPT.uninstall });
    if (r.s === 'ok') anyOk = true;
    record(label, r.s, r.msg);
  }
  if (!anyOk && !OPT.noRegister) {
    console.log('  − 未检测到已安装的 MCP 客户端。用 --print-config 拿配置片段手工接入。');
  }
  if (!OPT.uninstall) {
    console.log('\n  DSH 用户：优先装 bundle（比手工 JSON 更稳）：');
    console.log(`    ${bundleDir}`);
  }
}

/* ---------------- 汇总 ---------------- */
console.log('\n========== 安装结果 ==========');
for (const r of results) console.log(`  [${r.status.toUpperCase()}] ${r.name}${r.msg ? ` — ${r.msg}` : ''}`);
const failed = results.filter((r) => r.status === 'fail');
console.log(failed.length
  ? `\nINSTALL_STATUS=FAIL FAILED=${failed.length}`
  : '\nINSTALL_STATUS=OK');
console.log('\n下一步：');
console.log('  1) 重启 MCP 客户端 / 重新加载 DSH 配置');
console.log('  2) 跑自检：node skill/playwright-verify/scripts/selfcheck.mjs');
console.log('  3) 在客户端确认出现 13 个 mcp__playwright_verify__* 工具');
process.exit(failed.length ? 1 : 0);
