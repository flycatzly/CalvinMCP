/**
 * reap.mjs — 单跑收尾兜底：退出时无条件 kill-all，收割本机孤儿 daemon/浏览器。
 *
 * 为什么需要：playwright-cli 的 daemon 是 detached+unref 设计，会话没 close 就会
 * 连浏览器一起留在机器上（实测孤儿 chrome-headless-shell 挂了一整棵进程树）。
 * verify-all.mjs 结尾本来就有无条件 kill-all 兜底；但**单跑某条用例**的路径没有 ——
 * 任何失败/异常退出分支都可能漏会话。本模块给单测入口补上同一把扫帚：
 * 试用例自己逐个 close（只关自己开过的会话），这里是最后的全机兜底。
 *
 * 踩踏面约束：verify-all 用 --parallel 并发跑套件时，kill-all 是**全机**收割，
 * 会把兄弟套件的活会话一起杀掉（并行假失败的踩踏面之一）。所以子进程只在
 * 「不是被 verify-all 驱动」时装这把兜底 —— 看到 PWVERIFY_UNDER_HARNESS=1 就跳过，
 * 由 verify-all 的统一收尾负责。
 *
 * 实现约束：
 *   - process.on('exit') 阶段只剩同步代码能跑 → spawnSync；
 *   - kill-all 尽力而为，失败不影响判定；
 *   - 输出行不以 PASS/FAIL/SKIP 开头 —— 否则会被 verify-all 的 summarizeSuiteExit
 *     误计成断言行，触发计数对账（countDrift）假失败。
 */
import { spawnSync } from 'node:child_process';
import { resolveCliRunner } from '../lib/runner.js';

/**
 * 给单测入口装收尾兜底。返回是否已安装（无 CLI / 在 harness 下为 false）。
 * @param {string} cwd 项目根（解析 playwright-cli 用）
 * @param {{ label?: string }} [opts] label 只用于兜底日志行的归属标注
 */
export function installStandaloneReap(cwd, { label = 'standalone' } = {}) {
  if (process.env.PWVERIFY_UNDER_HARNESS) return false;
  const cli = resolveCliRunner(cwd);
  if (!cli) return false;
  process.on('exit', () => {
    try {
      const r = spawnSync(cli.command, [...cli.prefix, 'kill-all'], {
        cwd,
        timeout: 30_000,
        windowsHide: true,
        stdio: 'ignore',
      });
      process.stdout.write(`（${label} 收尾 kill-all：收割孤儿 daemon/浏览器，exit=${r.status ?? 'timeout'}）\n`);
    } catch {
      process.stdout.write(`（${label} 收尾 kill-all 未能执行，不影响判定）\n`);
    }
  });
  return true;
}
