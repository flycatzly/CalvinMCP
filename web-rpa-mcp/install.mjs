#!/usr/bin/env node
// web-rpa-mcp — 安装/初始化：检查依赖、写默认配置、自检、输出 MCP 注册 JSON、安装 skill
// 退出码（统一诚实 SKIP 口径，与 mysql-validate 退出码 3 同义）：
//   0 = 完成且无诚实 SKIP；1 = 存在问题；3 = 无失败但有诚实 SKIP（如缺 playwright 依赖，浏览器面套件未跑）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const MCP_DIR = path.join(ROOT, 'mcp');
const isWin = process.platform === 'win32';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

function step(n, title) { process.stdout.write('\n=== [' + n + '] ' + title + ' ===\n'); }
function info(s) { process.stdout.write(s + '\n'); }
function warn(s) { process.stdout.write('  ! ' + s + '\n'); }

async function main() {
  info('Web RPA MCP 安装器');
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
    const giLines = ['node_modules/', '.work/', 'runs/', 'logs/', 'web-rpa.config.json', 'mcp-register.example.json', '*.tmp-*'];
    const cur = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
    const missing = giLines.filter((l) => cur.split(/\r?\n/).indexOf(l) < 0);
    if (!cur.trim()) fs.writeFileSync(giPath, '# 敏感与生成物（由 install.mjs 生成）\n' + giLines.join('\n') + '\n', 'utf8');
    else if (missing.length) fs.appendFileSync(giPath, missing.join('\n') + '\n', 'utf8');
    info('  ok  .gitignore（敏感路径边界）');
  } catch (e) { warn('生成 .gitignore 失败: ' + String(e && e.message ? e.message : e)); }

  step(3, '写入默认配置');
  const cfgPath = path.join(ROOT, 'web-rpa.config.json');
  if (fs.existsSync(cfgPath)) {
    info('  已存在，跳过: web-rpa.config.json');
  } else {
    fs.writeFileSync(cfgPath, JSON.stringify({
      browser: { mode: 'auto', headless: true, viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' },
      run: { stepTimeoutMs: 15000, navTimeoutMs: 45000, retries: 1, saveEvidence: true, evidenceOn: 'always', humanHandoffTimeoutMs: 180000, emptyResultGuard: true, healMinScore: 0.72 },
      notify: { enabled: false, type: 'generic', webhook: '', on: ['failure', 'healed'], timeoutMs: 8000, mention: '' },
      schedule: { taskPrefix: 'WebRPA' },
      security: { maskSecrets: true },
    }, null, 2) + '\n', 'utf8');
    info('  已生成 web-rpa.config.json（需要告警时用 MCP 工具 notify_config 填写 webhook）');
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
    // 用 node 直接跑 npm-cli.js，避免 shell 参数拼接（DEP0190）
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    let r;
    if (fs.existsSync(npmCli)) {
      r = spawnSync(process.execPath, [npmCli, 'install', '--no-audit', '--no-fund'], { cwd: MCP_DIR, stdio: 'inherit' });
    } else {
      r = spawnSync(isWin ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: MCP_DIR, stdio: 'inherit', shell: isWin });
    }
    if (r.status !== 0) {
      warn('npm install 失败。可改用镜像：npm install --registry=https://registry.npmmirror.com');
      warn('或复用同工作区其它项目已安装的 playwright（本工具会自动搜索兄弟目录与 DSH profile）。');
    } else {
      info('  依赖安装完成');
    }
  }

  step(5, '浏览器可用性');
  try {
    const plan = browserMod.detectBrowserPlan();
    info('  将使用: ' + plan.kind + '  (' + plan.detail + ')');
    if (plan.kind === 'none' || plan.kind === 'chromium-missing') {
      warn('没有找到浏览器，请任选其一：');
      warn('  1) npx playwright install chromium');
      warn('  2) 在 web-rpa.config.json 设置 browser.channel = "msedge"');
      warn('  3) 设置 browser.mode="custom" 且 browser.executablePath="<exe 路径>"');
    } else if (plan.kind === 'msedge' || plan.kind === 'chrome') {
      info('  使用系统浏览器，无需下载 Chromium');
    }
  } catch (e) { warn('浏览器探测失败: ' + String(e && e.message ? e.message : e)); }

  step(6, '运行自检');
  // 诚实 SKIP 口径（与 mysql-validate 退出码 3 同义）：0=全绿；3=无失败但有诚实 SKIP（如缺 playwright 依赖）；1=有失败
  let honestSkip = false;
  const st = spawnSync(process.execPath, [path.join(MCP_DIR, 'selftest.mjs')], { cwd: MCP_DIR, encoding: 'utf8' });
  process.stdout.write(st.stdout || '');
  process.stderr.write(st.stderr || '');
  let selfP = '-', selfF = '-', selfS = '-';
  const sm = ((st.stdout || '') + '\n').match(/SELFTEST \d+ 套：(\d+) 通过 \/ (\d+) 失败 \/ (\d+) 诚实SKIP/);
  if (sm) { selfP = sm[1]; selfF = sm[2]; selfS = sm[3]; }
  const selfOk = st.status === 0 || st.status === 3;
  if (st.status === 0) info('  ok  自检全绿');
  else if (st.status === 3) { honestSkip = true; info('  ⊹ 诚实 SKIP（exit 3）：无失败，但有套件因缺依赖/前置不可跑——未跑部分见自检输出，不冒充全绿'); }
  else warn('  自检失败（exit ' + st.status + '）');

  step(7, '输出 MCP 注册 JSON');
  const reg = { mcpServers: { webrpa: { command: 'node', args: [path.join(MCP_DIR, 'server.mjs')] } } };
  info(JSON.stringify(reg, null, 2));
  info('');
  info('注册方式：');
  info('  Claude Code  : claude mcp add webrpa -- node "' + path.join(MCP_DIR, 'server.mjs') + '"');
  info('  Claude Desktop: %APPDATA%\\Claude\\claude_desktop_config.json');
  info('  Cursor       : ~/.cursor/mcp.json');
  info('  注册后必须重启客户端。');

  step(8, '复制工作流 / 参考文档到技能目录');
  const skillsDirs = [
    path.join(os.homedir(), '.claude', 'skills', 'web-rpa-mcp'),
    path.join(os.homedir(), '.agents', 'skills', 'web-rpa-mcp'),
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
  info('  1) 重启 MCP 客户端，让 webrpa 工具生效');
  info('  2) 让 AI 调用 doctor 确认环境');
  info('  3) 调用 record_start 录一个流程，在浏览器里演示一遍，再 record_stop 生成技能');
  info('');
  info('手工验证：');
  info('  node "' + path.join(MCP_DIR, 'server.mjs') + '" --doctor');
  info('  node "' + path.join(MCP_DIR, 'runner.mjs') + '" list');

  const ok = selfOk;
  info('');
  info('INSTALL_STATUS=' + (ok ? (honestSkip ? 'SKIP' : 'OK') : 'FAIL') + ' SELFTEST=' + selfP + '/' + selfF + '/' + selfS);
  process.exit(ok ? (honestSkip ? 3 : 0) : 1);
}

main().catch((e) => {
  process.stderr.write('安装失败: ' + String(e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
