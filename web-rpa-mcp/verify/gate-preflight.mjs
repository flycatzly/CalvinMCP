// 发版门禁并发预检 —— 为什么需要：验收套件与其它跑批共享全局态（Windows 计划任务
// 名空间、浏览器/登录态、以及同仓库的 flows/、runs/、web-rpa.config.json），两轮测试
// 同时跑会互相污染出假红/假绿（2026-10-05 两次实锤：另一会话的 selftest/integration
// 并发导致 profile 锁连坐整组失败、超时用例被干扰出"不可能的绿"）。门禁结论不可信 =
// 说谎的门禁——宁可拒跑，也不产出假判。
//
// 口径：只判"当前这台机器上是否有并发执行"，两路信号：
//   1) 本仓库 .work/locks/ 下有活进程持有的流程锁（定时/手工/测试执行中）；
//   2) 机器上有测试套件进程在跑（node 命令行命中 selftest/integration/live-fulltest/
//      test/*.mjs 文件名）。锁文件损坏（无法判活）按问题处理——不能证明安全就拒跑，
//      消息里给出人工处置指引。
// 进程扫描拿不到（权限/平台差异）时只警告不拒跑：那是"看不见"，不是"有并发"。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { pidAlive, redactPath } from '../mcp/lib/core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 测试套件进程识别：文件名级匹配（自测/集成/实测 + test/ 下各套件）。
 *  边界含空白：`node.exe selftest.mjs`（cwd 起跑的裸文件名形态）也必须命中——实测抓到过。 */
export const TEST_PROC_RE = /(?:^|[\\\/\s"'])(?:selftest|integration|live-fulltest)\.mjs\b|(?:^|[\\\/\s"'])test[\\\/](?:unit|rules|e2e|tools|audit|mcp-protocol)\.mjs\b/i;

/** MCP 服务进程识别（server.mjs 常驻持有浏览器 profile）。快照口径只计数不点名：
 *  常驻属正常（各会话的 MCP 服务），与失败是否相关待确认；互踩实锤来自并发测试套件
 *  （2026-10-05 两轮：另一会话 selftest/integration 并发 → profile 锁连坐假红）。 */
export const SERVER_PROC_RE = /(?:^|[\\\/\s"'])server\.mjs\b/i;

/** 纯分类器（可注入数据，扫描器的唯一语义落点） */
export function classifyPreflight({ locks = [], processes = [], selfPid = process.pid, processScanFailed = false } = {}) {
  const problems = [];
  const warnings = [];
  for (const l of locks) {
    const pid = Number(l.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      problems.push(`锁文件损坏（无法判活）：流程「${l.flowId}」—— 若确认没有执行中任务，删除 .work/locks 下对应 .lock 文件后重跑`);
      continue;
    }
    if (pidAlive(pid)) {
      problems.push(`流程「${l.flowId}」正在执行（pid ${pid}，触发 ${l.trigger || '未知'}，开始于 ${l.at || '未知'}）`);
    }
  }
  for (const p of processes) {
    if (p.pid === selfPid) continue;
    if (TEST_PROC_RE.test(String(p.cmd || ''))) {
      problems.push(`另一测试进程正在运行（pid ${p.pid}）：${redactPath(String(p.cmd || '')).slice(0, 100)}`);
    }
  }
  if (processScanFailed) warnings.push('进程扫描不可用（平台/权限），只做了锁预检');
  return { ok: problems.length === 0, problems, warnings };
}

/** 扫本仓库 .work/locks/*.lock（坏文件也收进来，由分类器判"无法判活"） */
export function scanLocks(locksDir = path.join(HERE, '..', '.work', 'locks')) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(locksDir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.lock')) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(locksDir, n), 'utf8'));
      out.push({ flowId: rec.flowId || n.replace(/\.lock$/, ''), pid: rec.pid, trigger: rec.trigger, at: rec.at });
    } catch {
      out.push({ flowId: n.replace(/\.lock$/, ''), pid: null });
    }
  }
  return out;
}

/** 扫机器上的 node 进程命令行（测试套件都以 node 进程跑）；失败返回 null */
export function scanProcesses() {
  try {
    if (process.platform === 'win32') {
      // 只取 node.exe：CIM 全量遍历慢；非 node 的并发占用由锁预检兜底
      const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'],
        { encoding: 'utf8', timeout: 8000, windowsHide: true });
      return out.split('\n').map((l) => {
        const i = l.indexOf('\t');
        if (i < 0 || !l.trim()) return null;
        const pid = Number(l.slice(0, i).trim());
        return Number.isInteger(pid) ? { pid, cmd: l.slice(i + 1).trim() } : null;
      }).filter(Boolean);
    }
    const out = execFileSync('ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 8000 });
    return out.split('\n').map((l) => {
      const m = l.trim().match(/^(\d+)\s+(.*)$/);
      return m ? { pid: Number(m[1]), cmd: m[2] } : null;
    }).filter(Boolean);
  } catch {
    return null;
  }
}

/** 门禁入口：一次调用拿全部结论 */
export function preflight(opts = {}) {
  const procs = scanProcesses();
  return classifyPreflight({
    locks: scanLocks(opts.locksDir),
    processes: procs || [],
    processScanFailed: procs === null,
    selfPid: opts.selfPid,
  });
}

/** 步骤失败「并发现场」快照的纯分类器（可注入数据）：当下测试套件/MCP 服务进程 → 一行诊断。
 *  只读、绝不改判；命令行逐条 redactPath（日志脱敏红线）；仅在验收命令失败时显示（成功不加输出）。
 *  用途：家族假红（跨会话互踩）从人工 tasklist/CreationDate 定性变报告自解释。
 *  口径：点名并发测试套件（互踩假红的实锤来源）；常驻 MCP 服务只计数不点名——诊断坑位
 *  必须留给套件（v1.5.17 负向首跑实测：混排 pid 升序 + cap 5 会把唯一套件挤出画面）。 */
export function sceneLine({ processes = [], selfPid = process.pid, processScanFailed = false } = {}) {
  if (processScanFailed) return '快照不可用（进程扫描不可用——平台/权限差异）';
  const suites = [];
  let servers = 0;
  for (const p of processes) {
    if (p.pid === selfPid) continue;
    const cmd = String(p.cmd || '');
    if (TEST_PROC_RE.test(cmd)) suites.push({ pid: p.pid, cmd });
    else if (SERVER_PROC_RE.test(cmd)) servers += 1;
  }
  suites.sort((a, b) => a.pid - b.pid);
  if (!suites.length && !servers) return '无其它测试/服务进程在跑';
  if (!suites.length) return `无其它测试套件进程在跑（另有 ${servers} 个常驻 MCP 服务进程）`;
  const fmt = suites.slice(0, 5).map((h) => `[测试套件] pid ${h.pid} ${redactPath(h.cmd).slice(0, 80)}`);
  return `${suites.length} 个并发测试套件进程（互踩嫌疑，失败可能是假红）: ${fmt.join('；')}${suites.length > 5 ? `…（其余 ${suites.length - 5} 个省略）` : ''}${servers ? `；另有 ${servers} 个常驻 MCP 服务进程` : ''}`;
}
