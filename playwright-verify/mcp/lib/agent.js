/**
 * agent.js — 智能体线的执行与守门（nl_test_goal 的下半段）
 *
 * 上半段（nlplan.js）把目标翻译成计划；本模块负责三件事：
 *   1) 守门：危险目标与生产地址在**动手之前**拒绝（「禁止做什么」是代码，不是文档口号）。
 *   2) 执行：计划步骤映射到 playwright-cli 会话动作，每步产出证据（快照/截图路径），
 *      步骤失败立即停 —— 失败后的步骤结果没有意义，继续跑只会把现场搅浑。
 *   3) 报告：输出机器可读的 JSON Pass/Fail（文章「下一步行动建议」里的断言集成口径），
 *      CI 只看 verdict 字段就能挂门禁。
 *
 * 与硬规则的关系：
 *   - 不自动改断言：这里的 expect_* 由计划给出，执行器只判定成立与否，绝不「放宽到能过」。
 *   - 默认只允许 test/staging：生产地址必须显式 confirmProd=true（独立审批的留痕参数）。
 *   - 不碰真实资金与生产数据：目标文本命中危险意图直接拒绝，连浏览器都不会打开。
 */
import fs from 'node:fs';
import path from 'node:path';

import { runCli, ARTIFACT_DIRS } from './cli.js';
import { verdictOf } from './nlplan.js';

/**
 * 危险意图拒绝清单。命中即拒绝，不做「可能只是比喻」的放行 ——
 * 误拒一次的代价是人改个措辞；漏拒一次的代价是不可逆操作。
 * 覆盖：真实资金、破坏性数据命令、生产数据操作、对外发送、批量对外。
 */
export const DANGEROUS_GOAL_PATTERNS = [
  { re: /真实(资金|支付|转账|汇款|付款)|真实.{0,6}(下单|交易)/, why: '涉及真实资金的操作一律不可自动化执行' },
  { re: /(删除|清空|清库|删库|销毁|drop|truncate|delete\s+from|rm\s+-rf)/i, why: '破坏性数据操作不可自动化执行' },
  { re: /(生产|线上|prod(?:uction)?)[^。]{0,12}(库|数据|表|环境|删除|清空|变更|发布|部署)|(库|数据|表|环境)[^。]{0,8}(生产|线上|prod)/i, why: '生产数据与生产环境操作要走独立审批，不在智能体线范围内' },
  { re: /(发送|群发|外发)[^。]{0,6}(邮件|短信|消息|通知)|发(真实)?(邮件|短信)/, why: '对外发送消息不可自动化执行（测试环境的模拟通知除外）' },
  { re: /(爬取|抓取)[^。]{0,8}(全站|所有页面|整个站点)|批量(注册|下单|发帖)/, why: '批量对外操作不做 —— 这是滥用面，不是测试面' },
];

/**
 * 资金类动词单独一层，带「测试语境豁免」：
 *   转账/支付/下单这些词在测试目标里高频出现（「走一遍下单流程，确认状态为待支付」），
 *   无条件拒绝会把正常测试目标误伤；但资金动作不该出现在无语境的指令里。
 *   口径：出现资金动词、且目标里**没有任何测试/演练语境词**才拒绝，
 *   并在拒绝文案里告诉人怎么写才能过 —— 拒绝要给出路，否则只是把人挡在门外。
 */
const MONEY_VERBS = /(转账|汇款|提现|充值|支付|付款|退款|下单|购买)/;
const TEST_CONTEXT = /(测试|staging|stage|演练|模拟|沙箱|sandbox|test|演示|验收)/i;

/** 目标文本危险意图检查。通过返回 {ok:true}，否则 {ok:false, why, pattern}。 */
export function assertGoalAllowed(goal) {
  const text = String(goal || '');
  for (const p of DANGEROUS_GOAL_PATTERNS) {
    if (p.re.test(text)) return { ok: false, why: p.why, pattern: String(p.re) };
  }
  if (MONEY_VERBS.test(text) && !TEST_CONTEXT.test(text)) {
    return {
      ok: false,
      why: '资金类操作（转账/支付/下单等）只有在明确的测试/演练语境下才可自动化执行 —— '
        + '请在目标里注明「测试环境 / 演练 / 测试数据」，或改为只验证展示与状态。',
      pattern: 'MONEY_VERBS',
    };
  }
  if (!text.trim()) return { ok: false, why: '目标为空' };
  return { ok: true };
}

/**
 * 目标地址检查：
 *   - 只放行 http/https（LangChain NavigateTool 同款约束：挡住 file:// 与其它协议）；
 *   - 生产域名启发式命中时必须 confirmProd=true 才放行（独立审批的显式留痕）。
 */
export function assertTargetAllowed(url, { confirmProd = false } = {}) {
  let u;
  try { u = new URL(String(url)); } catch {
    return { ok: false, why: `不是合法 URL：${url}` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, why: `只允许 http/https（收到 ${u.protocol}//）。本地文件与其它协议一律不放行。` };
  }
  const host = u.hostname.toLowerCase();
  const looksProd = /(^|[.-])(prod|production|prd)([.-]|$)/.test(host) || /-prod\./.test(host);
  if (looksProd && !confirmProd) {
    return {
      ok: false,
      why: `目标主机 ${host} 看起来是生产。默认只允许 test/staging；生产验证走独立审批 —— `
        + '审批后显式传 confirmProd=true 才会执行。',
    };
  }
  return { ok: true, confirmUsed: looksProd && confirmProd === true };
}

/** 步骤结果 → 人话摘要行。 */
function stepLine(s) {
  const mark = s.ok ? 'PASS' : 'FAIL';
  const what = [s.act, s.target, s.value].filter(Boolean).join(' ');
  return `  ${mark} ${what}${s.detail ? `　${s.detail}` : ''}${s.evidence ? `　证据: ${s.evidence}` : ''}`;
}

/**
 * 执行计划。每步一个结果；动作步失败或断言步不成立即停止（fail fast）。
 *
 * @param {object} o
 * @param {Array} o.steps            归一化后的计划步骤
 * @param {string} o.cwd             工作目录（证据落这里）
 * @param {string} o.session         CLI 会话名
 * @param {boolean} [o.headed]       调试用有头
 * @param {Function} [o.runStep]     测试注入点（默认走 runCli）
 * @returns {Promise<{steps:Array, stopped:boolean, reason?:string}>}
 */
export async function executePlan({ steps, cwd, session, headed = false, runStep } = {}) {
  const results = [];
  const exec = runStep || defaultRunStep;
  for (const step of steps) {
    const r = await exec({ step, cwd, session, headed });
    results.push(r);
    if (!r.ok) {
      // fail fast：失败后继续执行只会把现场搅浑，且后续步骤的 ok 不再有语义
      return { steps: results, stopped: true, reason: r.detail || `${step.act} 失败` };
    }
  }
  return { steps: results, stopped: false };
}

/** 默认步骤执行器：计划动作 → playwright-cli 会话动作（证据走既有落盘约定）。 */
export async function defaultRunStep({ step, cwd, session, headed }) {
  const started = Date.now();
  const done = (extra) => ({
    act: step.act, target: step.target, value: step.value,
    durationMs: Date.now() - started, ...extra,
  });

  switch (step.act) {
    case 'goto': {
      const r = await runCli({ cwd, session, subcommand: 'open', args: [step.target], headed });
      return done({ ok: r.ok, detail: r.summary, evidence: r.logFiles?.stdout, exitCode: r.exitCode });
    }
    case 'click': {
      const r = await runCli({ cwd, session, subcommand: 'click', args: [step.target], headed });
      return done({ ok: r.ok, detail: r.summary, evidence: r.logFiles?.stdout, exitCode: r.exitCode });
    }
    case 'fill': {
      const r = await runCli({ cwd, session, subcommand: 'fill', args: [step.target, step.value], headed });
      return done({ ok: r.ok, detail: r.summary, evidence: r.logFiles?.stdout, exitCode: r.exitCode });
    }
    case 'press': {
      const r = await runCli({ cwd, session, subcommand: 'press', args: [step.value], headed });
      return done({ ok: r.ok, detail: r.summary, evidence: r.logFiles?.stdout, exitCode: r.exitCode });
    }
    case 'screenshot': {
      const r = await runCli({ cwd, session, subcommand: 'screenshot', args: [], headed });
      return done({ ok: r.ok, detail: r.summary, evidence: r.artifacts?.file, exitCode: r.exitCode });
    }
    case 'expect_text':
    case 'expect_visible': {
      // 断言不重写、不放宽：只判定计划给定的期望是否成立，证据是快照落盘件。
      const r = await runCli({ cwd, session, subcommand: 'snapshot', args: [], headed });
      const snap = r.artifacts?.snapshot;
      const text = snap && fs.existsSync(snap) ? fs.readFileSync(snap, 'utf8') : '';
      const needle = step.value || step.target || '';
      const found = text.toLowerCase().includes(needle.toLowerCase());
      if (!r.ok) return done({ ok: false, detail: `快照失败：${r.summary}`, evidence: r.logFiles?.stdout });
      return done({
        ok: found,
        detail: found ? `页面包含「${needle}」` : `页面不包含「${needle}」（断言不成立，不放宽）`,
        evidence: snap,
      });
    }
    default:
      return done({ ok: false, detail: `未知动作 ${step.act}（白名单外不该出现在执行阶段）` });
  }
}

/**
 * 组装 JSON Pass/Fail 报告（CI 挂门禁就看 verdict）。
 * 字段口径固定：goal / url / source / verdict / steps / problems / generatedAt。
 */
export function buildReport({ goal, url, source, plan, stepResults = [], problems = [], startedAt }) {
  return {
    goal,
    url,
    source, // 'llm' | 'fallback'
    verdict: verdictOf(stepResults),
    steps: stepResults,
    problems,
    plan: plan ? plan.steps : [],
    startedAt: startedAt || null,
    generatedAt: new Date().toISOString(),
  };
}

/** 报告落盘到 .playwright-artifacts/reports/（与其它证据同一套约定目录）。 */
export function writeReport(cwd, report, tag = 'nl') {
  const dir = path.join(cwd, ARTIFACT_DIRS.reports);
  fs.mkdirSync(dir, { recursive: true });
  const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const file = path.join(dir, `${tag}-${uniq}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

export default { assertGoalAllowed, assertTargetAllowed, executePlan, defaultRunStep, buildReport, writeReport, DANGEROUS_GOAL_PATTERNS };
