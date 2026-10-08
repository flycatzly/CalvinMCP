/**
 * cli.js — Playwright CLI 模式：把「执行结果」落盘，而不是灌进上下文
 *
 * 为什么要有这一层（第三篇文章的核心论点）：
 *   真正贵的不是多写几条用例，而是把完整页面状态反复灌进模型。
 *   旧状态一直累积，后面的断言、截图、失败定位全被挤掉了；
 *   官方基准里一个标准多步骤会话能冲到 87000 多 Token，点一次按钮可能就烧掉几千。
 *   换成「快照存 YAML、截图存 PNG、Trace 存独立文件，Agent 按需去读」，
 *   同样流程省下四倍多，长流程才不容易中途撞墙。
 *
 * 所以本模块的硬约定：**任何产出一律先落盘，返回值只给路径与摘要**（不返回全文）。
 *   快照 → .playwright-artifacts/snapshots/<session>-<n>.md
 *   截图 → .playwright-artifacts/screenshots/<session>-<n>.png
 *   trace → .playwright-artifacts/traces/
 *   日志 → .playwright-artifacts/logs/
 *
 * 另一条团队约定也在这里落地：**调试用 --headed，回归默认无头**，
 * 免得有人把有头窗口带进夜间回归。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runToFiles, resolveCliRunner, stripKnownNoise } from './runner.js';
// 通道配置决策的唯一源在 skill 树（setup-cli-config.mjs / install.mjs 共用）：
// 自愈必须与安装期做同一套决策，两处各写一份必然漂移。
import { decideCliConfig, pickChannel, buildCliConfig } from '../../skill/playwright-verify/scripts/cli-config.mjs';

/** 产出目录约定：证据落盘到约定目录，不散在临时路径。 */
export const ARTIFACT_DIRS = {
  root: '.playwright-artifacts',
  snapshots: '.playwright-artifacts/snapshots',
  screenshots: '.playwright-artifacts/screenshots',
  traces: '.playwright-artifacts/traces',
  logs: '.playwright-artifacts/logs',
  reports: '.playwright-artifacts/reports',
  state: '.playwright-artifacts/state',
};

export function ensureArtifactDirs(cwd) {
  const made = {};
  for (const [k, rel] of Object.entries(ARTIFACT_DIRS)) {
    const abs = path.join(cwd, rel);
    fs.mkdirSync(abs, { recursive: true });
    made[k] = abs;
  }
  return made;
}

/**
 * 允许通过 MCP 透传的 CLI 子命令白名单。
 *
 * 为什么用白名单而不是全放行：CLI 有上百个子命令，全放行固然灵活，
 * 但会绕开「产出必须落盘」这条约束（例如直接 snapshot 就会把整棵可访问性树
 * 返回进上下文，正是我们想避免的那件事）。白名单保证落盘约束不被绕过，
 * 同时覆盖了真实工作流所需的全部动作。
 */
export const CLI_ALLOWLIST = new Set([
  // 核心交互
  'open', 'goto', 'close', 'close-all', 'kill-all', 'list', 'type', 'click', 'dblclick',
  'fill', 'hover', 'select', 'check', 'uncheck', 'press', 'drag', 'drop', 'upload',
  'go-back', 'go-forward', 'reload', 'resize', 'find', 'eval', 'generate-locator', 'highlight',
  // 落盘与证据
  'snapshot', 'screenshot', 'pdf', 'tracing-start', 'tracing-stop', 'video-start', 'video-stop',
  'console', 'requests', 'request', 'request-headers', 'request-body', 'response-headers', 'response-body',
  'recording-start', 'recording-stop',
  // 会话与状态
  'state-load', 'state-save', 'cookie-list', 'cookie-get', 'cookie-set', 'cookie-delete', 'cookie-clear',
  'localstorage-list', 'localstorage-get', 'localstorage-set', 'localstorage-delete', 'localstorage-clear',
  'sessionstorage-list', 'sessionstorage-get', 'sessionstorage-set', 'sessionstorage-delete', 'sessionstorage-clear',
  'tab-list', 'tab-new', 'tab-close', 'tab-select', 'delete-data',
  // 网络与仿真
  'route', 'route-list', 'unroute', 'network-state-set',
  'set-color-scheme', 'set-reduced-motion', 'set-forced-colors', 'set-contrast', 'set-media',
  'clear-color-scheme', 'clear-reduced-motion', 'clear-forced-colors', 'clear-contrast', 'clear-media',
]);

/** 这些子命令的产出必须写到我们的约定目录（否则会灌进上下文）。 */
const MUST_REDIRECT = {
  snapshot: { flag: '--filename', dir: 'snapshots', ext: '.md' },
  screenshot: { flag: '--filename', dir: 'screenshots', ext: '.png' },
  pdf: { flag: '--filename', dir: 'screenshots', ext: '.pdf' },
};

/** 计数器：让同一会话的产物按序号命名，序号只用于「可读」，不承担唯一性。 */
function nextSeq(dir, session, ext) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${session}-`) && f.endsWith(ext)) {
        // 兼容两种命名：旧的 `s-3.png` 与新的 `s-3-<uniq>.png`
        const m = /-(\d+)(?:-|\.)/.exec(f);
        if (m) n = Math.max(n, Number(m[1]));
      }
    }
  } catch { /* 目录不存在 */ }
  return n + 1;
}

/**
 * 取一个**必然唯一**的产物路径：`<session>-<序号>-<时间戳+随机码><扩展名>`。
 *
 * 走过的弯路（值得记下来，因为它很隐蔽）：
 *   第一版是「扫目录算序号」，并发时两次调用算出同一个序号 → 后写的覆盖前写的证据。
 *   第二版改成「用 open(path,'wx') 抢占，抢到就删掉占位文件」——**反而更糟**：
 *   占位文件被自己删掉后，下次 nextSeq 扫目录看不到任何文件，又算出序号 1，
 *   于是**永远返回同一个名字**（实测 4 次全是 uniq-x-1.png）。
 *
 * 结论：不靠「抢占 + 状态文件 + 跨进程协调」那套，改用**构造即唯一** ——
 * 序号保留可读性，唯一性由时间戳 + 随机码保证。无需锁、无需状态文件、跨进程也安全。
 * 序号仍会被保留，所以文件名依然能看出「这是本会话第几次快照」。
 */
function claimPath(dir, session, ext) {
  const seq = nextSeq(dir, session, ext);
  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return path.join(dir, `${session}-${seq}-${uniq}${ext}`);
}

/** 清理 session 名，避免路径穿越。 */
export function safeSession(s) {
  return String(s || 'default').replace(/[^\w.-]/g, '_').slice(0, 60) || 'default';
}

/**
 * 执行一条 playwright-cli 命令。
 *
 * @param {object} o
 * @param {string} o.cwd              项目根目录
 * @param {string} o.session          会话名（多标签/多流程隔离）
 * @param {string} o.subcommand       子命令，如 'open'
 * @param {string[]} o.args           子命令参数
 * @param {boolean} [o.headed]        调试用有头模式；回归默认无头
 * @param {boolean} [o.json]          用 --json 拿结构化输出
 * @param {number}  [o.timeoutMs]
 * @returns {Promise<object>}
 */
/**
 * 超时收割会话：runToFiles 超时时客户端进程已被整树收掉，但 playwright-cli 的 daemon
 * 是 detached+unref 的设计，**不会**跟着走 —— daemon 连浏览器一起留在机器上
 * （实测孤儿 chrome-headless-shell 整棵树就是这么来的）。失败路径没人收，这里必须收。
 *
 * 两段式，只收**本会话**，绝不碰别人：
 *   1) 先优雅 close（限时 15s）—— daemon 还活着时秒关，不影响 --parallel 兄弟会话；
 *   2) close 也超时/失败 → daemon 已经卡死（典型：渲染器冻结、管道不回），
 *      按会话名**定点**强杀 cliDaemon 进程树（含其浏览器子进程）。
 * 绝不用 close-all / kill-all 当兜底：那是全机收割，会把并发兄弟套件的活会话一起带走
 * （并行假失败的踩踏面之一）。会话名已过 safeSession，通配/正则字符不参与匹配。
 */
const REAP_SKIP = new Set(['list', 'close-all', 'kill-all']);

async function reapSession(cli, cwd, sess, { hardOnly = false, logDir } = {}) {
  if (!hardOnly) {
    const graceful = await runToFiles({
      command: cli.command,
      args: [...cli.prefix, `-s=${sess}`, 'close'],
      cwd,
      timeoutMs: 15_000,
      logDir,
      logName: `reap-${sess}-close`,
      shell: !!cli.needsShell,
    });
    if (!graceful.timedOut && graceful.code === 0) return;
  }
  hardKillSession(sess);
}

/** 定点强杀某会话的 daemon 树（连同它的浏览器子进程）。 */
function hardKillSession(sess) {
  if (process.platform === 'win32') {
    // 扫命令行找 `cliDaemon.js <sess>`（带参数边界，不误伤名字更长的兄弟会话），taskkill /T /F 连树收。
    const script = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -like \'node*\''
      + ` -and ($_.CommandLine -like '*cliDaemon.js ${sess}'`
      + ` -or $_.CommandLine -like '*cliDaemon.js ${sess} --*') }`
      + ' | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }';
    try {
      spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
        { windowsHide: true, stdio: 'ignore', timeout: 20_000 });
      return;
    } catch { /* 落到下面兜底 */ }
  }
  const esc = sess.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    spawnSync('pkill', ['-f', `cliDaemon\\.js ${esc}( |$)`],
      { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
  } catch { /* 收割尽力而为 */ }
}

/**
 * 浏览器通道环境适配（纯函数）：部分机器的 Defender 会拦 ms-playwright 缓存里**新下载的**
 * chromium 二进制（spawn UNKNOWN / 沙箱 0x5 拒绝访问），此时可用系统自带的 msedge 通道：
 * 设 PVMCP_CLI_BROWSER=msedge。只在会话创建点 open 注入 —— 通道是会话属性，
 * 后续命令附着到既有会话；环境不设则零变化（默认 chromium 语义不变）。
 */
export function browserChannelFlags(subcommand, env = process.env) {
  const v = String(env.PVMCP_CLI_BROWSER || '').trim();
  if (!v) return [];
  return subcommand === 'open' ? ['--browser', v] : [];
}

export async function runCli(o) {
  const {
    cwd, session = 'default', subcommand, args = [], headed = false,
    json = true, timeoutMs = 120_000, extraFlags = [],
  } = o;

  // 早退失败也必须给 summary：调用方（步骤 detail、工具文本）统一读 summary，
  // 只给 message 会把失败原因吞成空 detail（实测：CLI 未安装时 goto 步骤 detail 为空）。
  if (!CLI_ALLOWLIST.has(subcommand)) {
    const message = `子命令 ${subcommand} 不在白名单内。可用子命令见 cli-mode.md 的命令表。`;
    return {
      ok: false,
      reason: 'SUBCOMMAND_NOT_ALLOWED',
      message,
      summary: message,
    };
  }

  const dirs = ensureArtifactDirs(cwd);
  const sess = safeSession(session);
  const artifacts = {};
  // 选项一律排在位置参数**之前**：`open [url]` / `screenshot [target]` 这类命令若把
  // --filename/--headed 放在位置参数之后，参数解析可能把后面当成位置参数吞掉。
  const optionArgs = [];
  const positionalArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a.startsWith('--')) {
      optionArgs.push(a);
      // 带值的选项：把它的值一起搬过去
      const takesValue = /^--(filename|depth|browser|config|device|profile|type|idle-timeout|pattern|min-level)$/.test(a);
      if (takesValue && i + 1 < args.length) optionArgs.push(String(args[++i]));
    } else {
      positionalArgs.push(a);
    }
  }

  // 强制落盘：注入 --filename，不让内容回到上下文
  const redirect = MUST_REDIRECT[subcommand];
  // 落盘是硬约束：**调用方不得自带 --filename 把产物写到约定目录之外**。
  // 旧实现只检查 `includes('--filename')`（整串精确匹配），于是 `--filename=/tmp/x` 这种
  // `--flag=value` 形式匹配不上 → 我们再注入一个 --filename → 出现重复 flag，
  // 后者生效 ⇒ 产物落到 /tmp，约定目录里什么都没有，而返回值仍然报"成功"。
  // 这不是小事：证据落盘是「回译要附截图」「失败现场可归档」的前提，被绕过等于证据丢了。
  // 处理方式：一旦发现调用方自带（任何形式），直接拒绝并说明理由，而不是悄悄改写它的意图。
  // 顺序约束：参数校验必须在「CLI 装没装」检查**之前** —— 否则没装 CLI 的机器上
  // 这道守门根本不生效（返回 CLI_NOT_INSTALLED 而不是拒绝越权参数），守门就变成了
  // 「装了 CLI 才守门」。守门先于能力检查，环境无关。
  const smuggled = optionArgs.find((a) => /^--filename(?:=|$)/.test(a));
  if (redirect && smuggled) {
    const message = `不接受调用方指定 --filename（收到 ${smuggled}）。`
      + `产物必须落到约定的证据目录：${dirs[redirect.dir]}。`
      + '这是为了让失败现场可归档、可被回译时附上；如需自定义目录，请改配置而不是绕过它。';
    return {
      ok: false,
      reason: 'ARTIFACT_PATH_NOT_ALLOWED',
      session: sess,
      subcommand,
      message,
      summary: message,
    };
  }

  const cli = resolveCliRunner(cwd);
  if (!cli) {
    const message = '找不到 playwright-cli。请先执行：npm i -g @playwright/cli@latest 并运行 playwright-cli install';
    return {
      ok: false,
      reason: 'CLI_NOT_INSTALLED',
      message,
      summary: message,
      hint: 'npm install -g @playwright/cli@latest && playwright-cli --version && playwright-cli install',
    };
  }

  if (redirect) {
    const fname = claimPath(dirs[redirect.dir], sess, redirect.ext);
    optionArgs.push(redirect.flag, fname);
    artifacts[redirect.dir === 'snapshots' ? 'snapshot' : 'file'] = fname;
  }
  if (subcommand === 'snapshot' && !optionArgs.includes('--depth')) {
    // 限制深度，避免一次拉出整棵可访问性树撑爆上下文
    optionArgs.push('--depth', '12');
  }
  optionArgs.push(...browserChannelFlags(subcommand));

  // 顺序：会话 → 子命令 → 选项 → 位置参数 → 全局选项
  const finalArgs = [`-s=${sess}`, subcommand, ...optionArgs, ...positionalArgs];
  if (headed) finalArgs.push('--headed');
  if (json) finalArgs.push('--json');
  finalArgs.push(...extraFlags);

  const res = await runToFiles({
    command: cli.command,
    args: [...cli.prefix, ...finalArgs],
    cwd,
    timeoutMs,
    logDir: dirs.logs,
    logName: `cli-${sess}-${subcommand}`,
    shell: !!cli.needsShell,
  });

  // 超时 ≠ 只有客户端死了：daemon 还挂着，必须一并收（见 reapSession 注释）。
  // close 自己超时说明 daemon 已卡死 → 直接定点强杀；其余业务子命令先试优雅 close。
  // CLI_ERROR 分支**不**收：失败现场要留给调用方处置（截图/归档），漏网由
  // 测试入口与 verify-all 的收尾 kill-all 兜底。
  if (res.timedOut && !REAP_SKIP.has(subcommand)) {
    try {
      await reapSession(cli, cwd, sess, {
        hardOnly: subcommand === 'close' || subcommand === 'delete-data',
        logDir: dirs.logs,
      });
    } catch { /* 收割尽力而为，不影响判定 */ }
  }

  // 若 CLI 自己把产物写到了别处，这里把它找出来（--filename 是我们给的绝对路径）
  const parsedJson = tryParseJson(res.stdout);
  const extraFiles = collectNewArtifacts(res.stdout, cwd);

  // 判定 = 退出码 + 超时 + **证据面**，仍然不看 stderr 有没有内容。
  // stderr 豁免的原因：playwright-cli 会把「daemonPid: 47172」这类正常信息写到 stderr，
  // 把它当失败会让健康检查误报 —— 一次冤枉就够把门禁的可信度废掉。
  // 证据面（H26）的原因：退出码 0 只说明进程活着回来，不说明活干了。
  // 裸 `process.exit(0)` 的假 CLI 此前能骗出「快照已落盘」的整套假绿 ——
  // 摘要声称落盘、文件根本不存在（r36 咬合实录 + r37 复现台双证）。
  // 判据全用结构事实（文件在场/非空/魔数/快照 ref 标记/自报 isError 信封），
  // 不用措辞匹配 —— 措辞一改就误红，结构事实不会。
  const evidence = judgeRunEvidence({ subcommand, artifacts, parsedJson });
  const ok = res.code === 0 && !res.timedOut && evidence.ok;
  const summary = ok
    ? summarizeCliOutput(subcommand, parsedJson, res.stdout, res.stderr, artifacts)
    : (res.code === 0 && !res.timedOut
      ? `执行失败（退出码 0，但证据不成立）：${evidence.detail}`
      : `执行失败（退出码 ${res.code}${res.timedOut ? '，已超时' : ''}）：${extractRootCause(res.stderr, res.stdout)}`);

  return {
    ok,
    reason: res.timedOut ? 'TIMEOUT'
      : (res.code !== 0 ? 'CLI_ERROR' : (evidence.ok ? 'OK' : evidence.reason)),
    session: sess,
    subcommand,
    exitCode: res.code,
    durationMs: res.durationMs,
    runner: cli.how,
    headed,
    artifacts: { ...artifacts, ...extraFiles },
    logFiles: { stdout: res.stdoutFile, stderr: res.stderrFile },
    // 只回摘要，不回全文 —— 这是省 Token 的关键
    summary,
    stdoutTail: lastLines(res.stdout, 12),
    stderrTail: lastLines(res.stderr, 12),
  };
}

/**
 * 成功判定的证据面（H26）：退出码 0 不等于活干了。
 *
 * 三条判据全是**结构事实**，刻意不用措辞匹配（措辞一改就误红）：
 *   1) CLI 自报失败信封（isError:true）优先于产物检查 —— 产品层的失败宣告不能被吞；
 *   2) 强制落盘的子命令（snapshot/screenshot/pdf）必须产物在场且非空；
 *   3) 产物形状对得上：png/pdf 魔数、快照含 `ref=eN` 标记（快照的产出物就是 ref，
 *      没有 ref 的快照等于这一步没干活 —— cli_session 的 fill/click 只收 ref）。
 * 不在强制落盘清单里的子命令（open/close/click/…）保持退出码契约：它们没有
 * 「产物」这种客观证据可查，硬造证据只会带来误红。
 */
export function judgeRunEvidence({ subcommand, artifacts, parsedJson }) {
  if (parsedJson && parsedJson.isError === true) {
    return {
      ok: false,
      reason: 'CLI_REPORTED_ERROR',
      detail: `CLI 自报失败：${String(parsedJson.error || '(信封无 error 字段)')}`,
    };
  }
  const redirect = MUST_REDIRECT[subcommand];
  if (!redirect) return { ok: true };
  const claimed = redirect.dir === 'snapshots' ? artifacts?.snapshot : artifacts?.file;
  if (!claimed) {
    return { ok: false, reason: 'ARTIFACT_MISSING', detail: `${subcommand} 未声明产物路径（必须落盘到约定证据目录）` };
  }
  let buf;
  try {
    buf = fs.readFileSync(claimed);
  } catch {
    return { ok: false, reason: 'ARTIFACT_MISSING', detail: `声称已落盘但文件不存在：${claimed}` };
  }
  if (buf.length === 0) {
    return { ok: false, reason: 'ARTIFACT_MISSING', detail: `产物文件为空：${claimed}` };
  }
  if (subcommand === 'screenshot' && !buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return { ok: false, reason: 'ARTIFACT_SHAPE', detail: `截图产物缺 PNG 魔数（不是真截图）：${claimed}` };
  }
  if (subcommand === 'pdf' && buf.subarray(0, 4).toString('latin1') !== '%PDF') {
    return { ok: false, reason: 'ARTIFACT_SHAPE', detail: `PDF 产物缺 %PDF 魔数（不是真 PDF）：${claimed}` };
  }
  if (subcommand === 'snapshot' && !/ref=e\d+/.test(buf.toString('utf8'))) {
    return { ok: false, reason: 'ARTIFACT_SHAPE', detail: `快照产物未见 ref=eN 标记（不是真快照）：${claimed}` };
  }
  return { ok: true };
}

function tryParseJson(text) {
  const t = (text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* 可能前面有杂讯 */ }
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(t.slice(i, j + 1)); } catch { return null; }
  }
  return null;
}

function lastLines(text, n) {
  if (!text) return '';
  // 先剔除已知噪声（如 Playwright worker 强加 FORCE_COLOR 触发的 Node 警告），
  // 再取尾部 —— 否则噪声会把真正的失败原因挤出只看尾部几行的诊断视野。
  const lines = stripKnownNoise(text).split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}

/**
 * 从 CLI 失败输出里提取**根因行**（不是噪声行）。
 *
 * 为什么不能只取尾部几行：daemon 失败时 playwright-cli 把真实原因写在
 * `[PlaywrightError: Chromium distribution 'chrome' is not found ...]`（stderr 中段），
 * 后面跟着几十行 Node 堆栈，尾部只剩 `daemonPid: 18264` —— 按尾部取摘要等于
 * 把根因让位给堆栈，排障的人拿到摘要还是得去翻日志文件（H20 钉住这个行为）。
 * 优先级：PlaywrightError（产品层根因）> 首个 `Error:` 行 > 尾部 3 行（原行为兜底）。
 */
export function extractRootCause(stderr, stdout) {
  const text = `${stderr || ''}\n${stdout || ''}`;
  const pw = /\[?PlaywrightError:[ \t]*([^\]\r\n]+)/.exec(text);
  const generic = /^[ \t]*Error:[ \t]*([^\r\n]+)/m.exec(text);
  // JSON 信封里的 error 字段（探针实录：点击失效选择器时 stdout 是
  // `"isError": true, "error": "Error: \"#submit-btn\" does not match any elements."`，
  // Error: 不在行首，旧的两档正则都够不着 → 根因被尾部噪声顶掉）。
  // 档位插在 PlaywrightError 之后、行首 Error 之前，不动 H20 既有三档的判定顺序。
  const envelope = /"error":\s*"((?:[^"\\]|\\.)+)"/.exec(text);
  const picked = (pw && pw[1]) || (envelope && envelope[1]) || (generic && generic[1]) || null;
  if (!picked) return lastLines(stderr || stdout, 3);
  let hint = '';
  // 已知模式：CLI 没有通道配置（.playwright/cli.config.json）时回退自己的默认通道，
  // 机器上没装该浏览器就是这个错。直接给出修法，省一次「看不懂摘要去翻日志」。
  const browser = /Chromium distribution '([^']+)' is not found/.exec(picked);
  if (browser) {
    hint = ` —— 浏览器通道「${browser[1]}」未安装。修法：`
      + `node skill/playwright-verify/scripts/setup-cli-config.mjs 按本机生成通道配置`
      + `（Windows 默认 msedge），或 npx playwright install ${browser[1]}`;
  }
  return `${picked.trim()}${hint}`;
}

/** 从 CLI 输出里捡出它自己落盘的文件路径（截图/快照等）。 */
function collectNewArtifacts(stdout, cwd) {
  const found = {};
  const re = /(?:saved|written|to)\s*[:=]?\s*["']?([^"'\n]*\.(?:png|jpe?g|webp|md|zip|pdf|json))["']?/gi;
  let m;
  let i = 0;
  while ((m = re.exec(stdout || '')) !== null) {
    const p = m[1].trim();
    if (!p) continue;
    found[`cliFile${i++}`] = path.isAbsolute(p) ? p : path.join(cwd, p);
  }
  return found;
}

/** 按子命令给出「人话摘要」——同事要的是结论，不是一串日志。 */
function summarizeCliOutput(subcommand, json, stdout, stderr, artifacts) {
  switch (subcommand) {
    case 'open':
    case 'goto':
      return json?.result?.url ? `已打开 ${json.result.url}` : '已打开页面';
    case 'snapshot':
      return `快照已落盘：${artifacts.snapshot || '(见 artifacts)'}（如需内容请按需读取该文件，不要整棵读进上下文）`;
    case 'screenshot':
      return `截图已落盘：${artifacts.file || '(见 artifacts)'}`;
    case 'tracing-start':
      return '已开始录制 trace';
    case 'tracing-stop':
      return `trace 已停止（产物见 .playwright-artifacts/traces/）`;
    case 'click':
    case 'fill':
    case 'type':
    case 'press':
    case 'select':
    case 'check':
    case 'uncheck':
    case 'hover':
      return '操作已完成';
    case 'console':
      return '已取回控制台消息';
    case 'requests':
      return '已取回网络请求清单';
    default:
      return json ? '命令已完成（结构化输出见 logFiles）' : '命令已完成';
  }
}

/**
 * 浏览器缺失类失败签名（三种都是真机实测过的形态）：
 *   1) Chromium distribution 'X' is not found —— 通道/发行版未安装（配置缺失回落默认时最常见）
 *   2) Browser "X" is not installed; expected executable at ... —— 缓存被清后的真实报错
 *      （伴随 daemon 退出码 1，旧正则只认 1) 3) 时这条会被漏掉）
 *   3) Executable doesn't exist at ... —— launchOptions.executablePath 指向已删路径
 * 归入同一处置通道：这是「环境缺浏览器」不是「命令/用例坏了」，修法是装浏览器或换通道。
 */
const BROWSER_MISSING_RE = new RegExp(
  "Chromium distribution '([^']+)' is not found"
  + '|Browser "([^"]+)" is not installed'
  + "|Executable doesn't exist at",
  'i',
);

/** 命中浏览器缺失类失败返回 { kind, dist, excerpt }，未命中返回 null（纯函数，可钉）。 */
export function matchBrowserMissing(text) {
  const m = BROWSER_MISSING_RE.exec(String(text || ''));
  if (!m) return null;
  const head = m[0].toLowerCase();
  const kind = head.startsWith('chromium distribution')
    ? 'distribution-not-found'
    : head.startsWith('browser ') ? 'browser-not-installed' : 'executable-missing';
  return { kind, dist: m[1] || m[2] || null, excerpt: m[0].trim().split('\n')[0] };
}

function browserMissingHint(missing, configFile) {
  const dist = missing.dist || '(默认 chromium)';
  return `\n\n诊断：本机缺少 CLI 需要的浏览器 —— ${missing.excerpt}\n`
    + '两条修法（任选）：\n'
    + `  1) 装它：npx playwright install ${dist === '(默认 chromium)' ? 'chromium' : dist}\n`
    + '  2) 或改用本机已有的浏览器通道：编辑 .playwright/cli.config.json，'
    + '把 browser.browserName 设为 "chromium" 且 launchOptions.channel 设为 "msedge"，'
    + '或者直接删掉该文件让它回落到默认 chromium。\n'
    + `（配置文件：${configFile}）`;
}

/** 读现有通道配置；缺失/坏 JSON 一律归 null（= 决策矩阵的 missing-or-broken）。 */
function readCliConfig(cwd) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, '.playwright', 'cli.config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 验收「最小闭环」：能开页面、能拿快照、能截图。
 * 建议当成团队的第一条验收 —— 这三步过了，CLI 就能进测试仓库当执行器。
 *
 * 失败时把「缺什么」说清楚，尤其是最常见的两种：
 *   - CLI 没装
 *   - 浏览器没装 / 配置指定的 channel 在本机不存在（例如 config 里写了 chrome 而本机只有 msedge）
 * 后者的报错原文是 `Chromium distribution 'chrome' is not found at ...`，
 * 直接把它翻成人话并给出两条修法，比让人去读堆栈快得多。
 *
 * 浏览器缺失类失败还会走**通道配置自愈闭环**（方向 1）：按决策矩阵（cli-config.mjs
 * 唯一源）判 regenerate 才重写配置（机器生成的陈旧 executablePath 钉/缺失/跨平台），
 * 再重试一轮最小闭环；手工配置（含显式 executablePath 意图）只给指引绝不自动重写。
 * 全程如实标注 autoHeal 字段 —— 自愈是透明的，不是把失败藏起来。
 */
export async function cliHealthCheck({ cwd, session = 'healthcheck' }) {
  const url = 'data:text/html,<html lang="zh"><body><h1>健康检查</h1><button>按钮</button></body></html>';
  const configFile = path.join(cwd, '.playwright', 'cli.config.json');

  const attempt = async () => {
    const steps = [];
    const open = await runCli({ cwd, session, subcommand: 'open', args: [url] });
    steps.push({ step: 'open', ok: open.ok, summary: open.summary, artifacts: open.artifacts });
    if (!open.ok) {
      // 失败≠没开：open 失败时 daemon/浏览器多半已经拉起来了。不收就漏在这里。
      // 尽力而为地关掉，但**不进 steps** —— 返回形状（步骤数与内容）是已测契约。
      try { await runCli({ cwd, session, subcommand: 'close', args: [], timeoutMs: 15_000 }); } catch { /* 尽力而为 */ }
      return { steps, open };
    }
    const snap = await runCli({ cwd, session, subcommand: 'snapshot', args: [] });
    steps.push({ step: 'snapshot', ok: snap.ok, summary: snap.summary, artifacts: snap.artifacts });
    const shot = await runCli({ cwd, session, subcommand: 'screenshot', args: [] });
    steps.push({ step: 'screenshot', ok: shot.ok, summary: shot.summary, artifacts: shot.artifacts });
    const close = await runCli({ cwd, session, subcommand: 'close', args: [] });
    steps.push({ step: 'close', ok: close.ok, summary: close.summary });
    return { steps, open };
  };

  const first = await attempt();
  if (first.open.ok) {
    const ok = first.steps.every((s) => s.ok);
    return {
      ok,
      steps: first.steps,
      verdict: ok ? 'CLI 最小闭环通过：能开页面、能拿快照、能截图' : 'CLI 最小闭环未通过，请先修复失败的那一步',
    };
  }

  const firstMsg = first.open.summary || 'CLI 最小闭环第一步就失败了';
  const raw = `${first.open.stderrTail || ''}\n${first.open.summary || ''}`;
  const missing = matchBrowserMissing(raw);
  if (!missing) {
    return { ok: false, steps: first.steps, reason: first.open.reason, message: firstMsg };
  }

  // 浏览器缺失类：通道配置自愈闭环（决策矩阵唯一源 → 可重写才重写 → 重试一轮）
  const decision = decideCliConfig({ cfg: readCliConfig(cwd), platform: process.platform });
  const autoHeal = {
    triggered: true,
    signature: missing.kind,
    dist: missing.dist,
    decision: decision.action,
    reason: decision.reason,
    rewritten: false,
    retried: false,
    recovered: false,
  };
  if (decision.action !== 'regenerate') {
    // 手工配置（显式意图）不自动重写 —— 重生成会把用户调过的 launchOptions 抹掉。
    return {
      ok: false,
      steps: first.steps,
      reason: first.open.reason,
      message: `${firstMsg}\n（现有通道配置是手工配置，按约定不自动重写）${browserMissingHint(missing, configFile)}`,
      remediation: missing.excerpt,
      autoHeal,
    };
  }

  try {
    const { channel, source } = pickChannel({ platform: process.platform });
    const config = buildCliConfig({ platform: process.platform, arch: process.arch, channel, source });
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    autoHeal.rewritten = true;
  } catch (e) {
    return {
      ok: false,
      steps: first.steps,
      reason: first.open.reason,
      message: `${firstMsg}\n（自愈重写通道配置失败：${e.message}）${browserMissingHint(missing, configFile)}`,
      remediation: missing.excerpt,
      autoHeal,
    };
  }

  autoHeal.retried = true;
  const second = await attempt();
  autoHeal.recovered = second.open.ok && second.steps.every((s) => s.ok);
  if (autoHeal.recovered) {
    return {
      ok: true,
      steps: second.steps,
      verdict: 'CLI 最小闭环通过：能开页面、能拿快照、能截图'
        + `（首次失败后已自动重写通道配置并重试通过：${decision.reason}）`,
      autoHeal,
    };
  }
  const secondMsg = second.open.summary || '重试仍未通过';
  return {
    ok: false,
    steps: second.steps,
    reason: second.open.reason,
    message: `首次失败：${firstMsg}\n已自动重写通道配置（${decision.reason}）并重试，仍失败：${secondMsg}`
      + browserMissingHint(missing, configFile),
    remediation: missing.excerpt,
    autoHeal,
  };
}

export default { runCli, cliHealthCheck, matchBrowserMissing, judgeRunEvidence, ensureArtifactDirs, ARTIFACT_DIRS, CLI_ALLOWLIST, safeSession };
