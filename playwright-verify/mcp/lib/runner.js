/**
 * runner.js — 执行层（体力活，与生成解耦）
 *
 * 两条设计决定，都有具体理由：
 *
 * 1) **子进程输出重定向到文件，不用管道。**
 *    沙箱环境下，程序无法通过命名管道捕获另一个程序的输出（Node 的 child_process
 *    spawn/exec 默认 stdio:'pipe' 会 EPERM）。所以这里把 stdout/stderr 直接写进文件
 *    （stdio: ['ignore', fd, fd]），跑完再读文件。收益不止是绕过限制：
 *    长回归的日志不会撑爆内存，产物天然落盘可归档，还能直接当工单附件。
 *
 * 2) **执行与生成解耦。**
 *    生成可以换模型、换策略，执行层不变。所以本模块只做「跑起来、收证据」，
 *    不生成任何用例代码，也不修改断言 —— healer 可以提议修，但把断言放宽到能过
 *    和修好定位器在代码上长得几乎一样，必须人来判。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** 收集一个可执行文件的所有候选路径（Windows 下 npx 是 .cmd，spawn 需要带扩展名）。 */
function resolveExecutable(cmd, env, cwd) {
  const candidates = [];
  const isWin = process.platform === 'win32';
  if (path.isAbsolute(cmd)) {
    candidates.push(cmd);
    if (isWin && !/\.(cmd|exe|bat)$/i.test(cmd)) candidates.push(`${cmd}.cmd`, `${cmd}.exe`);
    return candidates;
  }
  // 相对路径（如 node_modules/.bin/npx）
  if (cmd.includes('/') || cmd.includes('\\')) {
    candidates.push(path.resolve(cwd, cmd));
    if (isWin) candidates.push(path.resolve(cwd, `${cmd}.cmd`));
    return candidates;
  }
  const pathVar = env.PATH || env.Path || '';
  for (const dir of pathVar.split(isWin ? ';' : ':')) {
    if (!dir) continue;
    candidates.push(path.join(dir, cmd));
    if (isWin) candidates.push(path.join(dir, `${cmd}.cmd`), path.join(dir, `${cmd}.exe`));
  }
  return candidates;
}

/** 找出第一个真实存在的可执行文件；都找不到返回 null。 */
export function findExecutable(cmd, env = process.env, cwd = process.cwd()) {
  for (const c of resolveExecutable(cmd, env, cwd)) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* 忽略不可读目录 */ }
  }
  return null;
}

/**
 * 已知噪声行：Playwright 的 worker 启动时把 FORCE_COLOR=1 硬编码进自己的
 * 子进程环境（node_modules/playwright/lib/runner/index.js），于是每个 worker
 * 都会打印一条「NO_COLOR 被忽略」的 Node 警告。实测一次回归能刷出十几行。
 * 危害不是美观，而是我们只回**尾部几行**做诊断 —— 噪声会把真正的失败原因
 * 挤出诊断视野。所以展示层（tail/摘要）剔除这些行；**落盘日志保持原样**，
 * 归档证据不加工。
 */
const NOISE_RES = [
  /^\(node:\d+\)\s+Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set\.\s*$/,
];
export function stripKnownNoise(text) {
  if (!text) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !NOISE_RES.some((re) => re.test(line)))
    .join('\n');
}

/**
 * 跑一个命令，输出重定向到文件。
 * @returns {{ code, stdout, stderr, stdoutFile, stderrFile, durationMs, timedOut, spawnError }}
 */
/**
 * 超时收尾：把整棵进程树一起收掉，而不是只杀直接子进程。
 * Windows 上 child.kill 只作用于直接子进程 —— 客户端死了，它拉起的 worker/浏览器
 * 还挂在机器上（实测孤儿 chrome-headless-shell 整棵树就是这么留下的）。
 * taskkill /T /F 连树收；taskkill 不可用时退回 SIGKILL（尽力而为）。
 * POSIX 保持 SIGKILL，语义不变。
 */
function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    try {
      const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', timeout: 15_000,
      });
      if (r.status === 0) return;
    } catch { /* 落到下面兜底 */ }
  }
  try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
}

export function runToFiles({ command, args = [], cwd, env = {}, timeoutMs = 300_000, logDir, logName, shell = false }) {
  return new Promise((resolve) => {
    const started = Date.now();
    fs.mkdirSync(logDir, { recursive: true });
    const base = logName || `run-${started}`;
    const stdoutFile = path.join(logDir, `${base}.out.log`);
    const stderrFile = path.join(logDir, `${base}.err.log`);
    const outFd = fs.openSync(stdoutFile, 'w');
    const errFd = fs.openSync(stderrFile, 'w');

    // NO_COLOR 让日志更易归档与 diff。
    // 关键细节：不能只把 FORCE_COLOR 设成空串 —— Node 判定的是「变量是否存在」，
    // 存在就会警告「NO_COLOR 被忽略」，而那条警告会混进 stderr，
    // 把真正的失败原因挤出我们只读前若干行的诊断视野。
    // 所以两个变量都必须从子进程环境里彻底删掉，而不是赋空值。
    //
    // PYTHONIOENCODING / PYTHONUTF8：Windows 上 Python 子进程会继承控制台的 GBK（cp936）
    // 作为 stdio 编码，于是任何中文输出（我们的读取助手会打印中文诊断）都可能
    // 直接抛 UnicodeEncodeError 崩掉 —— 而且看起来像「Python 脚本有 bug」。
    // 强制 UTF-8 是唯一稳妥的修法（对非 Python 子进程无副作用）。
    const childEnv = { ...process.env, ...env };
    delete childEnv.FORCE_COLOR;
    delete childEnv.NO_COLOR;
    childEnv.NO_COLOR = '1';
    childEnv.PYTHONIOENCODING = 'utf-8';
    childEnv.PYTHONUTF8 = '1';
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: childEnv,
        stdio: ['ignore', outFd, errFd],   // 关键：写文件，不用管道
        windowsHide: true,
        shell,                              // 仅 .cmd shim 兜底时才为 true
      });
    } catch (e) {
      fs.closeSync(outFd); fs.closeSync(errFd);
      resolve({
        code: -1, stdout: '', stderr: '', stdoutFile, stderrFile,
        durationMs: Date.now() - started, timedOut: false, spawnError: e.message,
      });
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const done = (code, spawnError) => {
      clearTimeout(timer);
      try { fs.closeSync(outFd); } catch { /* 已关闭 */ }
      try { fs.closeSync(errFd); } catch { /* 已关闭 */ }
      const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
      resolve({
        code: code ?? -1,
        stdout: read(stdoutFile),
        stderr: read(stderrFile),
        stdoutFile,
        stderrFile,
        durationMs: Date.now() - started,
        timedOut,
        spawnError: spawnError || null,
      });
    };

    child.on('error', (e) => done(-1, e.message));
    child.on('close', (code) => done(code, null));
  });
}

/**
 * 找 Playwright 的可执行入口。优先项目本地 node_modules，避免依赖全局安装。
 * 返回 { command, args0 } —— args0 是「前缀参数」，调用方把真实参数接在后面。
 */
export function resolvePlaywrightRunner(cwd) {
  const isWin = process.platform === 'win32';
  const localCli = path.join(cwd, 'node_modules', '@playwright', 'test', 'cli.js');
  if (fs.existsSync(localCli)) {
    return { command: process.execPath, prefix: [localCli], how: 'node @playwright/test/cli.js' };
  }
  const localBin = path.join(cwd, 'node_modules', '.bin', isWin ? 'playwright.cmd' : 'playwright');
  if (fs.existsSync(localBin)) {
    return { command: localBin, prefix: [], how: 'node_modules/.bin/playwright' };
  }
  return null;
}

/**
 * 找 playwright-cli（CLI 模式用）。
 *
 * 关键坑：Windows 上 node_modules/.bin/playwright-cli 是 **.cmd 批处理**，
 * 而 Node 24 出于安全考虑禁止直接 spawn .cmd（会得到 spawn EINVAL）——
 * 网上常见的绕法是 shell:true，但那要重新处理引号转义，容易出注入问题。
 * 更干净的做法是**绕开 shim，直接用 node 跑真正的 JS 入口**
 * （与 @playwright/test 用 node cli.js 跑法是同一个思路）。
 */
export function resolveCliRunner(cwd) {
  // 优先用 @playwright/test/cli.js（与本机已有的 chromium-1243 配套，
  // 避免 @playwright/cli 0.1.22 捆绑的 playwright-core 1.64.0-alpha 找不到 chromium-1247）。
  const testCli = path.join(cwd, 'node_modules', '@playwright', 'test', 'cli.js');
  if (fs.existsSync(testCli)) {
    return { command: process.execPath, prefix: [testCli, 'cli'], how: 'node @playwright/test/cli.js cli' };
  }
  // 再试 @playwright/cli（可能全局安装）
  const cliJs = path.join(cwd, 'node_modules', '@playwright', 'cli', 'playwright-cli.js');
  if (fs.existsSync(cliJs)) {
    return { command: process.execPath, prefix: [cliJs], how: 'node @playwright/cli/playwright-cli.js' };
  }
  // 全局安装位置（npm 全局 node_modules）
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, '..', '@playwright', 'cli', 'playwright-cli.js');
    if (fs.existsSync(p)) return { command: process.execPath, prefix: [p], how: p };
  }
  const localBin = path.join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright-cli.cmd' : 'playwright-cli');
  const exe = findExecutable('playwright-cli', process.env, cwd);
  if (exe || fs.existsSync(localBin)) {
    // 兜底：只能用 shim，此时必须开 shell（Windows 下 .cmd 无法直接 spawn）
    return {
      command: exe || localBin,
      prefix: [],
      how: exe || localBin,
      needsShell: process.platform === 'win32',
    };
  }
  return null;
}

/** 版本查询（用于版本感知的规则提示）。 */
export async function playwrightVersion(cwd) {
  const r = resolvePlaywrightRunner(cwd);
  if (!r) return null;
  const res = await runToFiles({
    command: r.command,
    args: [...r.prefix, '--version'],
    cwd,
    logDir: path.join(cwd, '.playwright-artifacts', 'logs'),
    logName: 'version',
    timeoutMs: 60_000,
  });
  const m = /Version\s+(\d+\.\d+\.\d+)/i.exec(`${res.stdout}${res.stderr}`);
  return m ? m[1] : null;
}

/**
 * 跑 Playwright 用例。
 * @param {object} o { cwd, args, env, timeoutMs, logDir }
 */
export async function runPlaywright({ cwd, args = [], env = {}, timeoutMs = 600_000, logDir }) {
  const r = resolvePlaywrightRunner(cwd);
  if (!r) {
    return {
      ok: false,
      reason: 'NOT_INSTALLED',
      message: `在 ${cwd} 下找不到 Playwright（既没有 node_modules/@playwright/test/cli.js，`
        + '也没有 node_modules/.bin/playwright）。请先在该项目执行：npm i -D @playwright/test && npx playwright install',
    };
  }
  const res = await runToFiles({
    command: r.command,
    args: [...r.prefix, 'test', ...args],
    cwd,
    env,
    timeoutMs,
    logDir: logDir || path.join(cwd, 'test-results', 'logs'),
    logName: 'playwright-test',
  });
  return { ok: res.code === 0, runner: r.how, ...res };
}

/**
 * 找本次执行产出的 Playwright JSON 报告。
 *
 * 只认「结构像报告」的文件（含 suites + stats），且 mtime 不早于 sinceMs ——
 * 否则一次没产出报告的执行会把上次的旧报告当成结论，这正是「不报错但结论错」的陷阱。
 * 报告目录里的 trend-*.json（多报告趋势）和 cases-*.json（Excel 编排）不含 suites/stats，会被正确跳过。
 *
 * @param {string} cwd 项目根
 * @param {number} [sinceMs] 只认这个时间点之后落盘的文件（默认 0 = 不限）
 * @returns {string|null} 报告绝对路径
 */
export function findPlaywrightReport(cwd, sinceMs = 0) {
  const dirs = [
    path.join(cwd, '.playwright-artifacts', 'reports'),
    path.join(cwd, 'test-results'),
    path.join(cwd, 'playwright-report'),
  ];
  const found = [];
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.mtimeMs < sinceMs) continue;
        found.push({ full, mtime: st.mtimeMs });
      } catch { /* 读不到就跳过，不影响其它候选 */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  for (const f of found) {
    try {
      const j = JSON.parse(fs.readFileSync(f.full, 'utf8'));
      if (j && typeof j === 'object' && j.suites !== undefined && j.stats !== undefined) return f.full;
    } catch { /* 不是 JSON 或不是报告，看下一个 */ }
  }
  return null;
}

export default { runToFiles, runPlaywright, resolvePlaywrightRunner, resolveCliRunner, findExecutable, playwrightVersion, findPlaywrightReport };
