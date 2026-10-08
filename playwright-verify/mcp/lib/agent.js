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
import { tryHealStep, isLikelyLocatorFailure, HEALABLE_ACTS, createHealLlmBudget, DEFAULT_HEAL_LLM_BUDGET } from './heal.js';

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

/** 步骤结果 → 人话摘要行。自愈过的步骤带上标记（报告口径：失效步骤被自动适配要可见）。 */
function stepLine(s) {
  const mark = s.ok ? (s.healed ? 'PASS↻' : 'PASS') : 'FAIL';
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
 * @param {number} [o.healLlmBudget] 自愈第二层 LLM 调用预算（整次运行共享，默认 2，0=不问 LLM）
 * @param {Function} [o.runStep]     测试注入点（默认走 runCli）
 * @returns {Promise<{steps:Array, stopped:boolean, reason?:string, healLlm:{budget:number, used:number}}>}
 */
/**
 * 执行计划。支持两种模式：
 *  - cliBatch: 传入 cli_batch 兼容函数，所有步骤打包一次投出去，
 *    再从返回结果里逐条检视（fail-fast）；适用于多步 UI 测试的中间产物跨步骤累积。
 *  - runStep: 单步执行器覆写（默认 defaultRunStep），每个动作步单独调 runCli。
 * 两种模式互斥：传了 cliBatch 则忽略 runStep。
 *
 * @param {object} p
 * @param {object[]} p.steps              计划步骤
 * @param {string}  p.cwd               工作目录
 * @param {string}  p.session           会话名
 * @param {boolean} p.headed            有头/无头
 * @param {number}  p.healLlmBudget    自愈 LLM 预算
 * @param {Function} p.runStep          单步执行器（默认 defaultRunStep）
 * @param {Function} p.cliBatch          cli_batch 兼容函数：({steps,cwd,session,headed}) => Promise<StepResult[]>
 */
/**
 * 计划步骤 → CLI 位置参数映射（单一源）。
 * click 的 CLI 第二位置参数是鼠标键（left|right|middle）——绝不把 value 当 button 传出去；
 * runStep 与 cliBatch 两条执行路径共用本函数，禁止再各自写一份映射（曾漂移出回归：
 * 带 value 的 click 步在 cliBatch 路径每次必炸在 button 参数上）。
 */
export function stepCliArgs(step) {
  if (step.act === 'fill') return [step.target, step.value];
  if (step.act === 'click') return [step.target];
  if (step.act === 'goto') return [step.target || step.value];
  if (step.act === 'press') return [step.value || step.target];
  return [];
}

/**
 * 断言判定（单一源）：只判定计划给定的期望是否在快照文本里，不重写、不放宽。
 * runStep 与 executePlan(cliBatch) 两条执行路径共用 —— 判定语义曾分叉（cliBatch 只看
 * snapshot 命令是否成功、不看快照内容，断言永远「成立」），这里钉死同一份判定
 * 与同一份失败文案（「断言不成立，不放宽」为 e2e 钉死文案）。
 */
export function judgeExpectation(step, snap) {
  const text = snap && fs.existsSync(snap) ? fs.readFileSync(snap, 'utf8') : '';
  const needle = step.value || step.target || '';
  const found = text.toLowerCase().includes(needle.toLowerCase());
  return {
    ok: found,
    detail: found ? `页面包含「${needle}」` : `页面不包含「${needle}」（断言不成立，不放宽）`,
    evidence: snap,
  };
}

export async function executePlan({ steps, cwd, session, headed = false, healLlmBudget, runStep, cliBatch } = {}) {
  // 一次运行一个自愈预算实例：没有总闸的话每步都能烧一次 LLM
  const healBudget = createHealLlmBudget(healLlmBudget ?? DEFAULT_HEAL_LLM_BUDGET);

  // 步骤执行器：模式一「自愈后重跑剩余步」与模式二逐步执行共用同一实现（语义不分叉）
  const exec = runStep || defaultRunStep;

  // 模式一：cli_batch 批量执行（所有步骤一次投出，结果逐条检视）
  if (cliBatch) {
    const allResults = await cliBatch({ steps, cwd, session, headed });
    const results = [];
    for (let i = 0; i < allResults.length; i++) {
      const r = allResults[i];
      const step = steps[i];
      // 自愈门（只救 HEALABLE_ACTS 的定位类失败）；tryHealStep 内部自行管理 LLM 预算
      if (!r.ok && HEALABLE_ACTS.has(step.act) && isLikelyLocatorFailure(`${r.detail || ''}`)) {
        const healedStart = Date.now();
        const healed = await tryHealStep({ step, cwd, session, headed, llmBudget: healBudget });
        if (healed.ok) {
          // tryHealStep 契约：自愈成功时已用新 ref **重试过该步** —— 这里只收编结果，
          // 不再重放（r24 曾误用不存在的 healed.ref 再放一次 defaultRunStep，
          // 重放打字面量 "undefined" 必炸，还借 continue 绕过了 fail-fast）。
          results.push({
            ok: true, healed: true, healedFrom: healed.healedFrom, healedTo: healed.healedTo, via: healed.via,
            act: step.act, target: step.target, value: step.value, durationMs: Date.now() - healedStart,
            detail: healed.detail, evidence: healed.evidence,
          });
          // 自愈重试真的动了页面（点击这下是自愈后才点上的）—— 后续步骤的批量结果
          // 是对着「没点上」的旧页面算的（断言证据比自愈快照还旧），必须作废。
          // 剩余步骤改为逐步真跑（与模式二同源 exec）：断言照常按快照内容判定、不放宽。
          for (let j = i + 1; j < steps.length; j++) {
            const s = steps[j];
            const rr = await exec({ step: s, cwd, session, headed, healBudget });
            results.push(rr);
            if (!rr.ok) {
              return { steps: results, stopped: true, reason: rr.detail || `${s.act} 失败`, healLlm: { budget: healBudget.limit, used: healBudget.used } };
            }
          }
          return { steps: results, stopped: false, healLlm: { budget: healBudget.limit, used: healBudget.used } };
        }
        // 自愈失败：保留原结果并 fail fast
        results.push({ ok: false, act: step.act, target: step.target, value: step.value,
          detail: `${r.detail}（自愈未成功：${healed.detail}）`,
          evidence: healed.evidence || r.evidence, healedTried: true, healWhy: healed.why });
        return { steps: results, stopped: true, reason: results[results.length - 1].detail, healLlm: { budget: healBudget.limit, used: healBudget.used } };
      }
      // 与 runStep 同源的两条语义（曾分叉出回归）：
      //   1) 结果形状：结果必须带 act/target/value —— verdictOf/report 靠 act 认断言步，
      //      缺 act 时「全动作步无断言」误判 Blocked；
      //   2) 断言判定：expect_* 的 ok 以「快照内容是否包含期望」为准，不是命令是否成功。
      let out = { ...r, act: step.act, target: step.target, value: step.value };
      if ((step.act === 'expect_text' || step.act === 'expect_visible') && r.ok) {
        out = { ...judgeExpectation(step, r.evidence), act: step.act, target: step.target, value: step.value };
      }
      results.push(out);
      if (!out.ok) {
        return { steps: results, stopped: true, reason: out.detail || `${step.act} 失败`, healLlm: { budget: healBudget.limit, used: healBudget.used } };
      }
    }
    return { steps: results, stopped: false, healLlm: { budget: healBudget.limit, used: healBudget.used } };
  }

  // 模式二：逐步执行（默认）
  const results = [];
  for (const step of steps) {
    const r = await exec({ step, cwd, session, headed, healBudget });
    results.push(r);
    if (!r.ok) {
      return { steps: results, stopped: true, reason: r.detail || `${step.act} 失败`, healLlm: { budget: healBudget.limit, used: healBudget.used } };
    }
  }
  return { steps: results, stopped: false, healLlm: { budget: healBudget.limit, used: healBudget.used } };
}

/** 默认步骤执行器：计划动作 → playwright-cli 会话动作（证据走既有落盘约定）。 */
export async function defaultRunStep({ step, cwd, session, headed, healBudget }) {
  const started = Date.now();
  const done = (extra) => ({
    act: step.act, target: step.target, value: step.value,
    durationMs: Date.now() - started, ...extra,
  });

  switch (step.act) {
    case 'goto': {
      const r = await runCli({ cwd, session, subcommand: 'open', args: stepCliArgs(step), headed });
      return done({ ok: r.ok, detail: r.summary, evidence: r.logFiles?.stdout, exitCode: r.exitCode });
    }
    case 'click':
    case 'fill': {
      const args = stepCliArgs(step);
      const r = await runCli({ cwd, session, subcommand: step.act, args, headed });
      if (r.ok) return done({ ok: true, detail: r.summary, evidence: r.logFiles?.stdout, exitCode: r.exitCode });

      // 自愈门（文章一的差异化能力）：只救「定位类失败」的动作步。
      // 边界钉死：expect_* 断言永不进这道门（HEALABLE_ACTS 不含断言）——
      // 自愈只解决「怎么找到它」，不改变「判定什么」；断言失败永远如实红。
      if (HEALABLE_ACTS.has(step.act) && isLikelyLocatorFailure(`${r.summary || ''} ${r.stderrTail || ''}`)) {
        const healed = await tryHealStep({ step, cwd, session, headed, llmBudget: healBudget });
        if (healed.ok) {
          return done({
            ok: true, healed: true, healedFrom: healed.healedFrom, healedTo: healed.healedTo,
            via: healed.via,
            detail: healed.detail, evidence: healed.evidence,
          });
        }
        return done({
          ok: false, healTried: true, healWhy: healed.why,
          detail: `${r.summary}（自愈未成功：${healed.detail}）`,
          evidence: healed.evidence || r.logFiles?.stdout, exitCode: r.exitCode,
        });
      }
      return done({ ok: r.ok, detail: r.summary, evidence: r.logFiles?.stdout, exitCode: r.exitCode });
    }
    case 'press': {
      const r = await runCli({ cwd, session, subcommand: 'press', args: stepCliArgs(step), headed });
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
      if (!r.ok) return done({ ok: false, detail: `快照失败：${r.summary}`, evidence: r.logFiles?.stdout });
      return done(judgeExpectation(step, snap));
    }
    default:
      return done({ ok: false, detail: `未知动作 ${step.act}（白名单外不该出现在执行阶段）` });
  }
}

/**
 * 组装 JSON Pass/Fail 报告（CI 挂门禁就看 verdict）。
 * 字段口径固定：goal / url / source / verdict / steps / problems / generatedAt。
 * healedCount / healedSteps 是自愈线的**增量字段**（旧消费方不受影响）——
 * 文章报告口径要求「失效步骤被自动适配的情况」可核对，业务问题仍走 problems。
 * healLlmBudget / healLlmUsed 同为增量字段：二级自愈烧了几次 LLM 要可审计。
 */
export function buildReport({ goal, url, source, plan, stepResults = [], problems = [], startedAt, healLlm, planCache } = {}) {
  const healedSteps = stepResults.filter((s) => s.healed)
    .map((s) => ({ act: s.act, healedFrom: s.healedFrom, healedTo: s.healedTo, via: s.via }));
  return {
    goal,
    url,
    source, // 'llm' | 'fallback'
    // 计划缓存口径（增量字段，旧消费方不受影响）：'hit'=命中缓存（只省规划，执行仍全量真跑）、
    // 'miss'=本次现场规划（llm 或 fallback）、'skip'=调用方指定 llm=off。
    planCache: planCache || 'miss',
    verdict: verdictOf(stepResults),
    steps: stepResults,
    problems,
    healedCount: healedSteps.length,
    healedSteps,
    ...(healLlm ? { healLlmBudget: healLlm.budget, healLlmUsed: healLlm.used } : {}),
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
