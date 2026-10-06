#!/usr/bin/env node
/**
 * distribute.mjs — web-rpa-mcp「纯净分发版」+ 发版门禁（H19 横向铺开）
 *
 * 为什么需要它，而不是手工复制：
 *   手工复制一定会把产物带进去 —— runs/ 里的运行现场、logs/ 里的运行日志、
 *   node_modules、.git。这些进了分发版有几个具体坏处：
 *     · 体积暴涨，而且 node_modules 里的原生模块换平台就不兼容；
 *     · 上一轮的**失败现场**会跟着发出去（runs/ 报告可能含内部 URL、账号、页面数据）；
 *     · 全树哈希比对会因为多出来的产物而误报。
 *   所以判定规则写在脚本里，可复现、可审查。
 *
 * 判定规则（纯净包口径：无 node_modules、无任何 . 前缀文件/目录、无运行现场）：
 *   一律排除：任何 . 前缀的目录/文件（开发机基础设施，装机时按需生成）
 *   排除目录：node_modules、.git、logs、runs、test-results、dist、scratch、__pycache__
 *             （logs/ runs/ 是运行时现场目录，装机后由产品自动创建，不随包走）
 *   排除文件：日志文件、临时探查脚本（.probe / dbg / probe 开头）、备份文件
 *
 * 用法：
 *   node distribute.mjs [--out <目标目录>] [--force] [--no-verify] [--no-gate] [--gate-only]
 *
 * 复制后默认逐文件哈希自校验（无排除项泄漏 + 与源码字节一致），
 * 失败以退出码 2 结束 —— 「不验证不写盘」在分发环节同样成立。
 *
 * 自校验通过后自动跑「发版门禁」（加固 H19）：并发预检（有并发跑批就拒跑，防互踩假判）
 * → 把产物拷成一次性副本、在副本里跑
 * 家族验收（npm ci → selftest → tools → integration → live 68 链路实测）、终态哈希终查（门禁前后产物树
 * 哈希一致 + 纯净复扫）、副本验后整目录删除。
 * 发版 = 跑 distribute，门禁不可能忘。显式跳过：--no-gate（或环境变量
 * PV_SKIP_RELEASE_GATE=1 —— 嵌套防递归）；加固自检用 PV_GATE_SKIP_VERIFY=1：
 * 机械链路全走、只跳过验收命令。验收退出码 0=全绿、3=无失败但有诚实 SKIP（明示不冒充
 * 全绿，判过 —— 与 mysql-validate 无凭据 SKIP 同一口径）、其余=失败。门禁失败退出码 3。
 *
 * --gate-only：不构建 -clean，直接对本包源树跑同款门禁（一次性副本验收 + 终态哈希
 * 终查）—— 供 git-pub/copy-pure.mjs 在镜像前逐包把关。
 *
 * 默认目标：<发布版本>/web-rpa-mcp-clean
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflight, scanProcesses, sceneLine } from './verify/gate-preflight.mjs';
import { redactPath } from './mcp/lib/core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));       // <pkg>
const PROJECT_ROOT = HERE;
const PARENT = path.dirname(PROJECT_ROOT);
const PKG = path.basename(PROJECT_ROOT);

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--out') flags.out = argv[++i];
  else if (a.startsWith('--')) flags[a.slice(2)] = true;
}
const finish = (code, lines) => {
  console.log(typeof lines === 'string' ? lines : lines.join('\n'));
  process.exit(code);
};

/** 排除的目录名（任意层级） */
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git',
  'logs', 'runs',          // 运行时现场目录（报告/日志/证据），装机后自动创建
  'test-results', 'dist',
  'scratch',
  '__pycache__',   // Python 字节码：运行时再生成，且内嵌编译时路径
]);
/** 排除的文件名模式 */
const EXCLUDE_FILE_RES = [
  /\.log$/i,
  /\.tmp$/i,
  /^\.probe/i,
  /^probe\d*\.mjs$/i,
  /^dbg/i,
  /\.bak-/i,
  /\.pyc$/i,
  // 装机生成物（install.mjs「已存在则跳过」的落盘件）：随包发 = 把运行现场发出去
  /^web-rpa\.config\.json$/i,
  /^mcp-register\.example\.json$/i,
  /^accounts\.json$/i,   // 凭据文件：绝不入库、绝不入包（项目红线）
];

/* 测试残件流程：套件/实测往 flows/ 落的 t-/int-/e2e-/live- 前缀流程（运行数据面残件）。
 * 发布包只带演示/真实流程——残件随包发等于把测试现场发给用户。
 * 只匹配 flows/ 直属条目（其它目录的同名文件不受影响）；排除动作在打包报告逐个列名，不静默丢。
 * 待确认：更严的白名单口径（只带 seed 演示流程）暂缓——前缀排除是保守面，真实流程名撞前缀才会误伤。 */
const TEST_FLOW_RE = /^(?:t-|int-|e2e-|live-)/;
const isTestFlowResidue = (rel, name) => rel === 'flows' && TEST_FLOW_RE.test(name);

function shouldSkip(name, isDir, rel = '') {
  // 发布规范：纯净包不含**任何** . 前缀内容 —— 开发机基础设施，不随包走。
  if (name.startsWith('.')) return true;
  if (isTestFlowResidue(rel, name)) return true;
  if (isDir) return EXCLUDE_DIRS.has(name);
  return EXCLUDE_FILE_RES.some((re) => re.test(name));
}

const stats = { files: 0, bytes: 0, skippedDirs: [], skippedFiles: 0, skippedFlows: [] };
const skippedDirSet = new Set();
const skippedFlowSet = new Set();

// count=false 供门禁一次性副本用：副本拷贝不进统计，报告里的文件数就是交付树的文件数
function copyTree(src, dst, rel = '', count = true) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (shouldSkip(e.name, e.isDirectory(), rel)) {
      if (count) {
        // 测试残件流程单列计数（逐个列名）：排除必须可见，不混进「散文件」一笔糊涂账
        if (isTestFlowResidue(rel, e.name)) skippedFlowSet.add(r);
        else if (e.isDirectory()) skippedDirSet.add(r);
        else stats.skippedFiles++;
      }
      continue;
    }
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      copyTree(s, d, r, count);
    } else if (e.isFile()) {
      fs.copyFileSync(s, d);
      if (count) {
        stats.files++;
        stats.bytes += fs.statSync(d).size;
      }
    }
    // 符号链接与其它类型直接跳过（分发版不该带软链）
  }
}

/* ---- 发版门禁（加固 H19）：一次性副本验收 + 终态哈希终查 ----
 * 为什么必须自动：交付树不能跑套件 —— 验收会往树里写运行痕迹（runs/ 报告、logs/、
 * 浏览器证据），跑脏交付树；流程靠人记就会忘，忘了就重蹈覆辙；所以门禁长在 distribute 收尾。
 * 机械链路：目标树 → 一次性副本（纯净过滤拷贝）→ 副本里跑验收（退出码 0/3=判过，
 * 3=诚实 SKIP 明示记录）→ 删副本 → 终态哈希终查（门禁前后目标树哈希一致 + 纯净复扫）。
 */
/* 判定面谓词（treeHash 与归因扫描共用同一份口径，永不漂移）：
 * 跳过 = 运行现场/装机生成物（shouldSkip 名单）与 flows/（运行时数据面，
 * MCP 工具随时增删、测试套件也会落 t-/int-/e2e-/live- 前缀残件）不参与「门禁把树跑脏」判定——
 * 否则任何无关活动都让终查假红（--gate-only 源树实测踩过：并发 e2e 落残件致哈希漂移，
 * 家族验收 5/5 全过仍判不可交付）。源码/文档中途改动仍判红：交付面变了就是不该发版。 */
const hashSkip = (name, isDir) => (isDir ? (name === 'flows' || shouldSkip(name, true)) : shouldSkip(name, false));

const treeHash = (dir) => {
  const h = createHash('sha256');
  const walk = (d, rel = '') => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(p);
      if (hashSkip(name, st.isDirectory())) continue;
      if (st.isDirectory()) walk(p, r);
      else { h.update(r); h.update(fs.readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex').slice(0, 16);
};

/* ---- 终查判红归因（只读报告，永不影响判定）：门禁窗口内写树文件分组点名 ----
 * 红因从「人工 find -newermt 归因」变报告自解释：
 *  运行现场/数据面残写（不判红类）= 判定面谓词会跳过的路径（flows/、runs/、.work 等）；
 *  交付面变更（真红类）= 进入树哈希的路径——判红时这些就是嫌疑变更。
 * 清单逐条走 redactPath（日志脱敏红线）；扫描失败只降级为「归因不可用」，绝不改判。 */
const ATTR_CAP = 20;
function scanWindowWrites(dir, windowStart, rel = '', out = { benign: [], red: [] }) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const p = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;              // 与 copyTree 同口径：软链不入包也不判
    if (st.isDirectory()) { scanWindowWrites(p, windowStart, r, out); continue; }
    if (!st.isFile()) continue;
    if (!(st.mtimeMs >= windowStart)) continue;
    // 路径任一段命中判定面谓词即「不判红类」：与 treeHash 的实际走树完全同口径
    const segs = r.split('/');
    const skipped = segs.some((seg, i) => hashSkip(seg, i < segs.length - 1));
    (skipped ? out.benign : out.red).push(r);
  }
  return out;
}

function attributionLines(target, windowStart, hashChanged, purityDirty = []) {
  try {
    const { benign, red } = scanWindowWrites(target, windowStart);
    benign.sort(); red.sort();
    const fmt = (arr) => (arr.length <= ATTR_CAP
      ? arr.map(redactPath).join('、')
      : arr.slice(0, ATTR_CAP).map(redactPath).join('、') + `…（其余 ${arr.length - ATTR_CAP} 个省略）`);
    const lines = [];
    // 红因分述（纯净面）：判红来源=包内排除面残件——哈希按设计看不见它们，红因与「窗口写树」
    // 维度无关；两类红因并存时各自解释（「不判红类」仅指不参与哈希判红），紧挨判红结论不误读。
    if (purityDirty.length) lines.push(`  归因·红因（纯净复扫）= 包内排除面残件（哈希按设计不可见，与窗口写树无关）: ${fmt([...purityDirty].sort())}`);
    if (!benign.length && !red.length) { lines.push('  归因: 门禁窗口内写树 0 个'); return lines; }
    if (!red.length) { lines.push(`  归因: 门禁窗口内写树 ${benign.length} 个，全部为运行现场/数据面残写（不判红类）`); return lines; }
    // 判定面内写树：判红时是嫌疑变更；判绿时是「写入同内容/仅触碰」（treeHash 按内容+相对名判，不含 mtime）
    lines.push(`  归因·交付面变更（真红类）${red.length} 个${hashChanged ? '——判红嫌疑变更' : '——内容未变（触碰/同内容写入），不判红'}: ${fmt(red)}`);
    if (benign.length) lines.push(`  归因·运行现场/数据面残写（不判红类）${benign.length} 个: ${fmt(benign)}`);
    return lines;
  } catch (e) {
    return ['  归因: 不可用（窗口扫描失败：' + redactPath(String(e && e.message ? e.message : e)).slice(0, 120) + '）——不影响判定'];
  }
}

function runGate(target, sourceMode = false) {
  const gateLines = [];
  let gateFailed = false;
  // 并发预检（加固 H20）：验收套件与其它跑批共享全局态（计划任务名空间/浏览器/同仓库
  // flows、runs、config），并发跑批会互相污染出假红假绿（实测两次实锤）——结论不可信
  // 就拒跑，绝不产出假判。只判"本机是否有并发执行"，与目标树无关。
  {
    const pf = preflight();
    gateLines.push('并发预检（防跑批互踩假判）: ' + (pf.ok ? '通过' : '发现并发执行，拒绝出结论'));
    for (const w of pf.warnings) gateLines.push('  警告: ' + w);
    for (const p of pf.problems) gateLines.push('  ' + p);
    if (!pf.ok) {
      gateLines.push('发版门禁: 失败 ❌（环境有并发执行，结果不可信；等它结束或停掉后再跑）');
      return { gateFailed: true, gateLines };
    }
  }
  const gateTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrrpa-gate-'));
  const gateCopy = path.join(gateTmp, 'pkg');
  const gateWindowStart = Date.now(); // 归因窗口起点：门禁窗口内写树 = 自此刻起 mtime 更新的文件
  const hashBefore = treeHash(target);
  gateLines.push('发版门禁: 一次性副本验收', `  副本: ${gateCopy}`);
  // 纯净复扫谓词 = copyTree 过滤谓词（shouldSkip，含 flows 残件规则）同一份口径，永不漂移。
  // 旧规则只抓「dot 前缀 + node_modules」：包里混进 logs/、runs/、accounts.json、*.log 等
  // 排除面残件时哈希按设计跳过它们、复扫又不认 = 双盲区脏包放行；过滤面失灵即复扫判红。
  const walkDirty = (d, acc, rel = '') => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (shouldSkip(e.name, e.isDirectory(), rel)) { acc.push(r); continue; }
      if (e.isDirectory()) walkDirty(path.join(d, e.name), acc, r);
    }
  };
  const step = (title, cmd, args, opts, accept) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000, ...opts });
    const ok = accept.includes(r.status);
    const note = ok ? (r.status === 3 ? '诚实 SKIP（exit 3，明示不冒充全绿，判过）' : '通过（exit 0）')
      : (r.status === null ? `失败（超时/无法启动: ${String(r.error && r.error.message)}）` : `失败（exit ${r.status}）`);
    gateLines.push(`  ${title}: ${note}`);
    if (!ok) {
      gateFailed = true;
      const ls = ((r.stdout || '') + (r.stderr || '')).split('\n').filter((l) => l.trim());
      gateLines.push(`    尾部: ${ls.slice(-3).map((l) => l.trim()).join(' ; ')}`);
      // 失败「并发现场」快照（只读诊断，try/catch 内绝不动 gateFailed）：把互踩假红
      // 从人工 tasklist 定性变报告自解释——只在失败时显示，成功不加输出
      try {
        const procs = scanProcesses();
        gateLines.push(`    并发现场: ${sceneLine({ processes: procs || [], processScanFailed: procs === null })}`);
      } catch (e) {
        gateLines.push('    并发现场: 快照不可用（' + redactPath(String(e && e.message ? e.message : e)).slice(0, 80) + '）');
      }
    }
  };
  // 用 node 直接跑 npm-cli.js，避免 shell 参数拼接（DEP0190）；找不到再退回 npm.cmd
  const npmCi = (cwd) => {
    const env = { ...process.env, PV_SKIP_RELEASE_GATE: '1' };
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const isWin = process.platform === 'win32';
    const title = 'npm ci（playwright 运行时）';
    if (fs.existsSync(npmCli)) {
      step(title, process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], { cwd, env, timeout: 900_000 }, [0]);
    } else {
      step(title, isWin ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'], { cwd, env, shell: isWin, timeout: 900_000 }, [0]);
    }
  };
  try {
    copyTree(target, gateCopy, '', false);
    // 副本纯净性在验收前钉死（过滤无泄漏）—— 验收会往副本写 node_modules/证据目录，之后再扫没有意义
    const copyDirty = [];
    walkDirty(gateCopy, copyDirty);
    gateLines.push(`  副本纯净复扫（验收前）: ${copyDirty.length ? '违例 ' + copyDirty.slice(0, 4).join('、') : '干净（过滤无泄漏）'}`);
    if (copyDirty.length) gateFailed = true;
    if (process.env.PV_GATE_SKIP_VERIFY) {
      gateLines.push('  验收命令: 跳过（PV_GATE_SKIP_VERIFY —— 机械自检用；真实发版必跑）');
    } else {
      // 家族验收：装依赖 → selftest → 工具面 → 全链路 → live 实测（缺浏览器/缺依赖时按统一诚实 SKIP 口径 exit 3 判过）
      const env = { ...process.env, PV_SKIP_RELEASE_GATE: '1' };
      const mcpDir = path.join(gateCopy, 'mcp');
      npmCi(mcpDir);
      // 套件契约：selftest/tools/integration 都从 mcp/ 起跑（README 调用姿势：
      // node test\integration.mjs —— runner CLI 用例按 process.cwd() 找 mcp/runner.mjs）；
      // live-fulltest 按 __dirname 定位包根（与 cwd 无关），黑盒走真实 MCP stdio 协议
      step('selftest 状态机自检', process.execPath, [path.join(mcpDir, 'selftest.mjs')], { cwd: mcpDir, env }, [0, 3]);
      step('tools 工具面 65 用例', process.execPath, [path.join(mcpDir, 'test', 'tools.mjs')], { cwd: mcpDir, env }, [0, 3]);
      step('integration 全链路', process.execPath, [path.join(mcpDir, 'test', 'integration.mjs')], { cwd: mcpDir, env, timeout: 900_000 }, [0, 3]);
      step('live 全流程实测 68 链路（真实 MCP stdio + 真实浏览器，覆盖 44 工具）', process.execPath, [path.join(gateCopy, 'verify', 'live-fulltest.mjs')], { cwd: mcpDir, env, timeout: 900_000 }, [0, 3]);
    }
  } finally {
    fs.rmSync(gateTmp, { recursive: true, force: true });
  }
  const copyGone = !fs.existsSync(gateCopy);
  gateLines.push(`  副本已删除: ${copyGone}`);
  if (!copyGone) gateFailed = true;
  const hashAfter = treeHash(target);
  const dirty = [];
  walkDirty(target, dirty);
  const hashOk = hashBefore === hashAfter;
  if (!hashOk) gateFailed = true;
  if (sourceMode) {
    // 源树口径（--gate-only）：dot 前缀/node_modules 属排除名单内开发机现场（.work、.git 等），
    // 拷贝时已剔除、不随包 —— 记「已知排除项」不判红；交付纯净由 --force 打包自校验与复扫保证
    gateLines.push(`  终态哈希终查: ${hashOk ? '0 不一致' : `树哈希变了 ${hashBefore} → ${hashAfter}`}；纯净复扫: 源树已知排除项 ${dirty.length} 项（${dirty.slice(0, 4).join('、') || '无'}，拷贝口径已剔除、不随包）`);
  } else {
    const pure = dirty.length === 0;
    gateLines.push(`  终态哈希终查: ${hashOk ? '0 不一致' : `树哈希变了 ${hashBefore} → ${hashAfter}`}；纯净复扫 ${pure ? '干净' : '违例 ' + dirty.slice(0, 4).join('、')}`);
    if (!pure) gateFailed = true;
  }
  // 归因输出：只读报告，try/catch 内绝不动 gateFailed —— 判定面口径与判定结果均不受影响
  // 纯净面红因只在真正判红的口径下分述（源树口径 dirty=已知排除项、不判红，不作红因）
  gateLines.push(...attributionLines(target, gateWindowStart, !hashOk, sourceMode ? [] : dirty));
  gateLines.push(`发版门禁: ${gateFailed ? '失败 ❌（发布包不可交付）' : '通过 ✅'}`);
  return { gateFailed, gateLines };
}

/* ---- --gate-only：只跑门禁（供 copy-pure.mjs 镜像前逐包把关）---- */
if (flags['gate-only']) {
  if (flags['no-gate'] || process.env.PV_SKIP_RELEASE_GATE) {
    finish(0, `发版门禁: 已跳过（${flags['no-gate'] ? '--no-gate 显式跳过' : 'PV_SKIP_RELEASE_GATE 嵌套防递归'}）`);
  }
  const { gateFailed, gateLines } = runGate(PROJECT_ROOT, true);
  finish(gateFailed ? 3 : 0, ['--gate-only: 对源树跑门禁（不构建 -clean）', `  源: ${PROJECT_ROOT}`, '', ...gateLines]);
}

/* ---- 安全检查：目标目录不能是源目录、也不能在源目录里面 ---- */
const OUT = path.resolve(String(flags.out || path.join(PARENT, `${PKG}-clean`)));
if (OUT === PROJECT_ROOT || OUT.startsWith(PROJECT_ROOT + path.sep)) {
  finish(2, `拒绝执行：目标目录不能在源目录内或等于源目录。\n  源: ${PROJECT_ROOT}\n  目标: ${OUT}`);
}
if (fs.existsSync(OUT)) {
  if (!flags.force) {
    finish(2, `目标已存在：${OUT}\n加 --force 覆盖（会先整体删除该目录）。`);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
}

copyTree(PROJECT_ROOT, OUT);
stats.skippedDirs = [...skippedDirSet].sort();
stats.skippedFlows = [...skippedFlowSet].sort();

/* ---- 复制后自校验（--verify，兑现「不验证不写盘」的承诺）----
 * 查两件事，都查实证不查感觉：
 *   1) 漏排泄漏：排除目录/文件模式名是否混进了分发版（复制规则写错了会在这里暴露）；
 *   2) 逐文件哈希：OUT 里每个文件与源码字节一致（复制截断/损坏会在这里暴露）。
 * 默认开启；--no-verify 显式跳过（比如只想快点看目录形状）。
 */
const verifySkipped = flags['no-verify'] === true;
const verifyIssues = [];
if (verifySkipped) {
  verifyIssues.push('(已按 --no-verify 跳过自校验)');
} else {
  const hash = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  const walkVerify = (dir, rel = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // 泄漏检查：被排除的名字不该出现在 OUT 的任何层级
        if (shouldSkip(e.name, true, rel)) { verifyIssues.push(`排除的目录混进分发版：${r}`); continue; }
        walkVerify(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (shouldSkip(e.name, false, rel)) { verifyIssues.push(`排除的文件混进分发版：${r}`); continue; }
        const src = path.join(PROJECT_ROOT, ...r.split('/'));
        if (!fs.existsSync(src)) { verifyIssues.push(`分发版多出源码没有的文件：${r}`); continue; }
        if (hash(path.join(dir, e.name)) !== hash(src)) verifyIssues.push(`与源码字节不一致：${r}`);
      }
    }
  };
  walkVerify(OUT);
}

const mb = (stats.bytes / 1024 / 1024).toFixed(2);
const realIssues = verifyIssues.filter((s) => !s.startsWith('('));

/* ---- 收尾自动门禁 ---- */
let gateFailed = false;
const gateLines = [];
if (realIssues.length) {
  gateLines.push('发版门禁: 未跑（自校验失败，先修复制问题）');
} else if (flags['no-gate'] || process.env.PV_SKIP_RELEASE_GATE) {
  gateLines.push(`发版门禁: 已跳过（${flags['no-gate'] ? '--no-gate 显式跳过' : 'PV_SKIP_RELEASE_GATE 嵌套防递归'}）—— 交付树纯净性请另行保证`);
} else {
  const g = runGate(OUT);
  gateFailed = g.gateFailed;
  gateLines.push(...g.gateLines);
}

const lines = [
  '纯净分发版已生成',
  `  源:   ${PROJECT_ROOT}`,
  `  目标: ${OUT}`,
  `  文件: ${stats.files} 个（${mb} MB）`,
  '',
  `  排除的目录（${stats.skippedDirs.length} 类）:`,
  ...stats.skippedDirs.map((d) => `    - ${d}`),
  `  排除的散文件: ${stats.skippedFiles} 个（. 前缀 / *.log / 临时探查脚本 / 备份文件）`,
  `  排除的测试残件流程: ${stats.skippedFlows.length} 个（t-/int-/e2e-/live- 前缀，flows/ 运行数据面残件不随包）` +
    (stats.skippedFlows.length ? '：' + stats.skippedFlows.map((f) => f.replace(/^flows\//, '')).join('、') : ''),
  '',
  verifySkipped ? '  自校验: 跳过（--no-verify）'
    : realIssues.length === 0 ? `  自校验: 通过（${stats.files} 个文件哈希一致，无排除项泄漏）`
      : `  自校验: 失败（${realIssues.length} 项）`,
  ...realIssues.map((s) => `    ✗ ${s}`),
  '',
  '纯净发布包口径：**无 node_modules、无任何 . 前缀文件/目录、无 runs/logs 运行现场**（开发机残留已剔除）。',
  '解压 / 拷贝即可部署，运行时依赖由 install.mjs 自动装：',
  `  拷贝 "${OUT}" 到目标机器任意目录`,
  '  node install.mjs    # 环境检查 + 自动 npm ci（playwright）+ 自检 + 注册本地 MCP 客户端',
  '（执行类 / 浏览器类工具另需本机可用的浏览器 —— 缺失只影响对应工具，按统一诚实 SKIP 口径明示）',
  '',
  ...gateLines,
].join('\n');

// 自校验失败退出 2、门禁失败退出 3 —— 「不验证不写盘」在分发环节同样成立
finish(gateFailed ? 3 : realIssues.length ? 2 : 0, lines);
