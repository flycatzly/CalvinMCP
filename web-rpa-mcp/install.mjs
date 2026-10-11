#!/usr/bin/env node
// 天璇驭页 PagePilot (pagepilot-mcp) — 安装/初始化：检查依赖、写默认配置、自检、输出 MCP 注册 JSON、安装 skill
// 退出码：0 = 完成且自检通过；1 = 存在问题
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const MCP_DIR = path.join(ROOT, 'mcp');
const isWin = process.platform === 'win32';

// 可选：--no-register 跳过自动注册；--no-skill 跳过技能文档复制
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

function step(n, title) { process.stdout.write('\n=== [' + n + '] ' + title + ' ===\n'); }
function info(s) { process.stdout.write(s + '\n'); }
function warn(s) { process.stdout.write('  ! ' + s + '\n'); }

async function main() {
  info('天璇驭页 · PagePilot 安装器');
  info('项目目录: ' + ROOT);

  step(1, '检查 Node 版本');
  const major = Number(process.versions.node.split('.')[0]);
  info('Node ' + process.version);
  if (major < 18) { warn('需要 Node >= 18.17，请升级后再运行'); process.exit(1); }

  step(2, '准备目录');
  for (const d of ['flows', 'runs', 'logs', '.work']) {
    fs.mkdirSync(path.join(ROOT, d), { recursive: true });
    info('  ok  ' + d);
  }
  // 纯净分发包不带任何 `.` 前缀文件/目录：敏感与生成物的 git 边界在这里补齐（已存在只补缺行，不覆盖）
  try {
    const giPath = path.join(ROOT, '.gitignore');
    const giLines = ['node_modules/', '.work/', 'runs/', 'logs/', 'pagepilot.config.json', 'mcp-register.example.json', '*.tmp-*'];
    const cur = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
    const missing = giLines.filter((l) => cur.split(/\r?\n/).indexOf(l) < 0);
    if (!cur.trim()) fs.writeFileSync(giPath, '# 敏感与生成物（由 install.mjs 生成）\n' + giLines.join('\n') + '\n', 'utf8');
    else if (missing.length) fs.appendFileSync(giPath, missing.join('\n') + '\n', 'utf8');
    info('  ok  .gitignore（敏感路径边界）');
  } catch (e) { warn('生成 .gitignore 失败: ' + String(e && e.message ? e.message : e)); }

  step(3, '写入默认配置');
  const cfgPath = path.join(ROOT, 'pagepilot.config.json');
  if (fs.existsSync(cfgPath)) {
    info('  已存在，跳过: pagepilot.config.json');
  } else {
    fs.writeFileSync(cfgPath, JSON.stringify({
      browser: { mode: 'auto', headless: true, viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' },
      run: { stepTimeoutMs: 15000, navTimeoutMs: 45000, retries: 1, saveEvidence: true, evidenceOn: 'always', humanHandoffTimeoutMs: 180000, emptyResultGuard: true, healMinScore: 0.72 },
      notify: { enabled: false, type: 'generic', webhook: '', on: ['failure', 'healed'], timeoutMs: 8000, mention: '' },
      schedule: { taskPrefix: 'PagePilot' },
      security: { maskSecrets: true },
    }, null, 2) + '\n', 'utf8');
    info('  已生成 pagepilot.config.json（需要告警时用 MCP 工具 notify_config 填写 webhook）');
  }

  step(4, '解析 playwright 依赖');
  const browserMod = await import(pathToFileURL(path.join(MCP_DIR, 'lib', 'browser.mjs')).href);
  let pw = { ok: false, err: null };
  try {
    await browserMod.getPlaywright();
    pw.ok = true;
  } catch (e) { pw.err = String(e && e.message ? e.message : e); }
  if (pw.ok) {
    info('  ok  已找到可用的 playwright');
  } else {
    warn('未找到 playwright，尝试安装（需要联网）...');
    info('  原因: ' + String(pw.err).split('\n')[0]);
    // 纯净版不声明 npm 依赖：playwright 按需显式安装。运行时会自动搜索
    // 同工作区 / DSH profile / 全局目录里的现成 playwright，找得到就不会走到这里。
    // 用 node 直接跑 npm-cli.js，避免 shell 参数拼接（DEP0190）
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    let r;
    if (fs.existsSync(npmCli)) {
      r = spawnSync(process.execPath, [npmCli, 'install', 'playwright', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: MCP_DIR, stdio: 'inherit' });
    } else {
      r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['install', 'playwright', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: MCP_DIR, stdio: 'inherit', shell: isWin });
    }
    if (r.status !== 0) {
      warn('npm install playwright 失败。可改用镜像：npm install playwright --registry=https://registry.npmmirror.com');
      warn('或复用同工作区其它项目已安装的 playwright（本工具会自动搜索兄弟目录与 DSH profile）。');
    } else {
      info('  playwright 安装完成，重新验证…');
      try { await browserMod.getPlaywright(); pw.ok = true; } catch { pw.ok = false; }
      info(pw.ok ? '  ok  playwright 现在可用' : '  !  安装后仍未找到 playwright（浏览器另需 npx playwright install chromium）');
    }
  }

  step(5, '浏览器可用性');
  try {
    const plan = browserMod.detectBrowserPlan();
    info('  将使用: ' + plan.kind + '  (' + plan.detail + ')');
    if (plan.kind === 'none' || plan.kind === 'chromium-missing') {
      warn('没有找到浏览器，请任选其一：');
      warn('  1) npx playwright install chromium');
      warn('  2) 在 pagepilot.config.json 设置 browser.channel = "msedge"');
      warn('  3) 设置 browser.mode="custom" 且 browser.executablePath="<exe 路径>"');
    } else if (plan.kind === 'msedge' || plan.kind === 'chrome') {
      info('  使用系统浏览器，无需下载 Chromium');
    }
  } catch (e) { warn('浏览器探测失败: ' + String(e && e.message ? e.message : e)); }

  step(6, '运行自检（doctor）');
  const st = spawnSync(process.execPath, [path.join(MCP_DIR, 'server.mjs'), '--doctor'], { cwd: MCP_DIR, encoding: 'utf8' });
  const docText = st.stdout || '';
  const brace = docText.indexOf('{');
  let doctor = null;
  if (brace >= 0) { try { doctor = JSON.parse(docText.slice(brace)); } catch { /* 解析失败按无报告处理 */ } }
  let selfOk = false;
  if (doctor) {
    info('  Node ' + doctor.node + ' | playwright ' + (doctor.playwright && doctor.playwright.ok ? 'ok' : '缺') + ' | 流程 ' + doctor.flows + ' 个');
    // 浏览器缺失不阻断安装（只影响浏览器面工具，按需处理）；其余问题视为安装失败
    selfOk = (doctor.problems || []).filter((p) => p !== '没有可用浏览器').length === 0;
    for (const p of doctor.problems || []) warn(p);
    for (const h of doctor.hints || []) info('  · ' + h);
    if (selfOk) info('  ok  自检通过');
  } else {
    warn('doctor 未产出报告（exit ' + st.status + '）');
    process.stdout.write(docText); process.stderr.write(st.stderr || '');
  }

  step(7, '自动注册 MCP 客户端');
  const serverPath = path.join(MCP_DIR, 'server.mjs');
  const REG_KEY = 'pagepilot';
  const reg = { mcpServers: { [REG_KEY]: { command: 'node', args: [serverPath] } } };
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  // 合并式写入单个客户端配置：文件存在才改（客户端未装则跳过）；解析失败不碰原文件；
  // 备份只在首次生成（.bak-pagepilot-mcp = 装前原件；重装不覆盖原始备份，保证可回滚）。
  function mergeInto(file) {
    let obj = {};
    if (fs.existsSync(file)) {
      try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { s: 'skip', msg: '配置解析失败，未改动' }; }
    } else if (!fs.existsSync(path.dirname(file))) { return { s: 'skip', msg: '客户端未安装' }; }
    const backup = file + '.bak-pagepilot-mcp';
    let backed = false;
    if (fs.existsSync(file) && !fs.existsSync(backup)) { fs.copyFileSync(file, backup); backed = true; }
    if (!obj.mcpServers || typeof obj.mcpServers !== 'object') obj.mcpServers = {};
    obj.mcpServers[REG_KEY] = { command: 'node', args: [serverPath] };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return { s: 'ok', msg: backed ? '已写入（原文件备份为 ' + path.basename(backup) + '）' : '已写入（沿用首次备份 ' + path.basename(backup) + '）' };
  }
  function registerAll() {
    const results = [];
    // 1) Claude Code CLI（用户级）：优先官方命令；参数含 cmd 元字符时跳过（下方 JSON 直写效果相同）
    try {
      const v = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: true });
      if (v.status === 0) {
        spawnSync('claude', ['mcp', 'remove', REG_KEY, '-s', 'user'], { stdio: 'ignore', shell: true });
        // Windows 下 shell:true 拼接 argv 给 cmd.exe（DEP0190）：路径含空格要加引号，
        // 含 cmd 元字符则放弃 CLI 通道（避免被解释执行），JSON 直写已覆盖同样效果。
        const cmdQuote = (a) => (/[&|<>^()%!"\n\r]/.test(a) ? null : /\s/.test(a) ? '"' + a + '"' : a);
        const argv = ['mcp', 'add', REG_KEY, '-s', 'user', '--', 'node', serverPath].map(cmdQuote);
        if (argv.every(Boolean)) {
          const r2 = spawnSync('claude', argv, { encoding: 'utf8', shell: true });
          results.push(['Claude Code (CLI 用户级)', r2.status === 0 ? 'ok' : 'skip', r2.status === 0 ? 'claude mcp add 成功' : 'CLI 返回失败']);
        } else {
          results.push(['Claude Code (CLI 用户级)', 'skip', '安装路径含 cmd 元字符，跳过 CLI 注册（已由 ~/.claude.json 方式覆盖）']);
        }
      }
    } catch { /* 无 claude CLI 时跳过 */ }
    // 2) 各客户端配置合并写入（文件存在才改/父目录在则创建，未装诚实跳过）——写后回读验证注册键
    const targets = [
      ['Claude Code (~/.claude.json)', path.join(os.homedir(), '.claude.json')],
      ['Claude Desktop', path.join(appData, 'Claude', 'claude_desktop_config.json')],
      ['Cursor', path.join(os.homedir(), '.cursor', 'mcp.json')],
      ['Windsurf', path.join(os.homedir(), '.codeium', 'windsurf', 'mcp.json')],
      ['VS Code (Copilot MCP)', path.join(appData, 'Code', 'User', 'mcp.json')],
    ];
    for (const [name, file] of targets) {
      const r1 = mergeInto(file);
      let verified = false;
      if (r1.s === 'ok') {
        try {
          const back = JSON.parse(fs.readFileSync(file, 'utf8'));
          verified = !!(back.mcpServers && back.mcpServers[REG_KEY] && back.mcpServers[REG_KEY].args && back.mcpServers[REG_KEY].args[0] === serverPath);
        } catch { verified = false; }
      }
      if (r1.s === 'ok') results.push([name, verified ? 'ok' : 'fail', verified ? r1.msg : '写入后回读未命中，需人工检查该配置']);
      else results.push([name, r1.s, r1.msg]);
    }
    for (const [n, st2, m2] of results) info('  ' + (st2 === 'ok' ? '✓' : st2 === 'fail' ? '✗' : '⊹') + ' ' + n + '：' + m2);
    const okPaths = results.filter(([, st2]) => st2 === 'ok');
    if (okPaths.length) info('  已注册 ' + REG_KEY + ' → node ' + serverPath + '（重启客户端生效）');
    return { anyOk: results.some(([, st2]) => st2 === 'ok'), anyFail: results.some(([, st2]) => st2 === 'fail') };
  }
  let regOk = false;
  let regMode = 'manual';
  if (has('--no-register')) {
    info('  按要求跳过（--no-register）');
  } else {
    const regResult = registerAll();
    regOk = regResult.anyOk && !regResult.anyFail;
    regMode = regOk ? 'auto' : (regResult.anyFail ? 'verify-failed' : 'manual');
    info('  注册完成。重启 MCP 客户端后生效；如需移除可删除各配置中的 mcpServers.' + REG_KEY + ' 条目。');
    if (!regOk) warn('未检测到已知客户端，请将下方注册 JSON 手工加入你的客户端配置。');
  }
  fs.writeFileSync(path.join(ROOT, 'mcp-register.example.json'), JSON.stringify(reg, null, 2) + '\n', 'utf8');
  info('');
  info('注册 JSON（同 ' + path.join(ROOT, 'mcp-register.example.json') + '）：');
  info(JSON.stringify(reg, null, 2));
  info('  注册后必须重启客户端。');

  step(8, '复制技能文档到技能目录');
  const skillsDirs = [
    path.join(os.homedir(), '.claude', 'skills', 'pagepilot-mcp'),
    path.join(os.homedir(), '.agents', 'skills', 'pagepilot-mcp'),
  ];
  if (has('--no-skill')) {
    info('  按要求跳过（--no-skill）');
  } else {
    for (const dir of skillsDirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        for (const item of ['SKILL.md', 'workflows', 'references']) {
          const src = path.join(ROOT, item);
          if (!fs.existsSync(src)) continue;
          const dst = path.join(dir, item);
          fs.cpSync(src, dst, { recursive: true });
        }
        info('  ok  ' + dir);
      } catch (e) { warn('复制到 ' + dir + ' 失败: ' + String(e && e.message ? e.message : e)); }
    }
  }

  step(9, '完成');
  info('下一步：');
  info('  1) 重启 MCP 客户端，让 pagepilot 工具生效');
  info('  2) 让 AI 调用 doctor 确认环境');
  info('  3) 调用 record_start 录一个流程，在浏览器里演示一遍，再 record_stop 生成技能');
  info('');
  info('手工验证：');
  info('  node "' + path.join(MCP_DIR, 'server.mjs') + '" --doctor');
  info('  node "' + path.join(MCP_DIR, 'runner.mjs') + '" list');

  info('');
  info('INSTALL_STATUS=' + (selfOk ? 'OK' : 'FAIL') + ' REG=' + regMode);
  process.exit(selfOk ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write('安装失败: ' + String(e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
