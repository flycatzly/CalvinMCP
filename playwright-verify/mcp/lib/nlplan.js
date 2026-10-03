/**
 * nlplan.js — 自然语言目标 → 检查清单（纯函数层，不碰网络与浏览器）
 *
 * 这是「声明式测试」的翻译层：目标是人话，执行要机器步骤，中间必须有一份
 * **显式、可审、有限**的计划。三条纪律（都来自本项目既有教训）：
 *   1) 动作白名单：只会 goto/click/fill/press/expect_text/expect_visible/screenshot。
 *      白名单外的动作**拒绝并列出**，绝不静默丢弃 —— orchestrate_excel 对
 *      映射不了的步骤就是这么做的（宁可不做，不能猜错），这里是同一条纪律。
 *   2) LLM 不可用时降级为确定性骨架（goto + 抽取目标里的引号断言 + 截图），
 *      并在结果里如实标注 source: fallback —— 绝不假装是 LLM 规划的。
 *   3) 计划只描述「做什么、期望什么」，**不含断言实现**：
 *      「断言对不对」必须能被人工读懂，所以它永远以 expect_* 的形式显式出现在计划里。
 */

/** 动作白名单：每个动作的参数要求。 */
export const ACTS = {
  goto: { need: ['target'], desc: '打开 URL（只允许 http/https）' },
  click: { need: ['target'], desc: '点击元素（选择器或可见文本）' },
  fill: { need: ['target', 'value'], desc: '向输入框填值' },
  press: { need: ['value'], desc: '按键，如 Enter' },
  expect_text: { need: ['value'], desc: '断言页面可见文本包含该字符串' },
  expect_visible: { need: ['target'], desc: '断言元素可见' },
  screenshot: { need: [], desc: '截图落盘（证据）' },
};

export const PLAN_MAX_STEPS = 20;

/**
 * 组装发给 LLM 的消息。系统提示就是文章里的测试工程师人设 + 输出契约：
 * 先观察、逐步解释、只输出 JSON。
 */
export function buildPlanMessages({ goal, url, facts }) {
  const system = [
    '你是一名资深测试工程师，负责把测试目标拆解成最小、可判定的步骤清单。',
    '纪律：先观察（以下给的是页面事实），再规划；每一步只做一个动作；',
    '断言必须显式写成 expect_text / expect_visible，不允许用「大概没问题」这种表述；',
    '只输出一个 JSON 对象，不要输出任何解释文字、Markdown 代码块或注释。',
  ].join('\n');
  const user = [
    `测试目标：${goal}`,
    `入口地址：${url}`,
    facts ? `页面事实：${JSON.stringify(facts)}` : '页面事实：（执行时自会观察，先给出计划）',
    '',
    '输出契约（JSON）：{"steps":[{"act":"goto|click|fill|press|expect_text|expect_visible|screenshot","target":"选择器或URL","value":"填值/按键/断言文本"}]}',
    `动作白名单与参数要求：${JSON.stringify(Object.fromEntries(Object.entries(ACTS).map(([k, v]) => [k, v.need])))}`,
    '要求：第一步行必须是 goto；最后一行断言应能直接判定目标是否达成。',
  ].join('\n');
  return { system, user };
}

/**
 * 归一化 LLM（或人工）给出的计划。
 * 输入可以是对象或含 JSON 的文本。返回 {ok, steps, problems}：
 * problems 非空时 ok=false —— **有问题的计划不静默截断使用**，交回人确认。
 */
export function normalizePlan(input, { goal = '', url = '' } = {}) {
  const problems = [];
  let raw = input;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch {
      const m = /\{[\s\S]*\}/.exec(raw);
      if (!m) return { ok: false, steps: [], problems: ['计划不是 JSON，无法解析'] };
      try { raw = JSON.parse(m[0]); } catch (e) {
        return { ok: false, steps: [], problems: [`计划 JSON 解析失败：${e.message}`] };
      }
    }
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.steps) ? raw.steps : null;
  if (!list) return { ok: false, steps: [], problems: ['计划缺少 steps 数组'] };
  if (list.length === 0) return { ok: false, steps: [], problems: ['计划为空'] };
  if (list.length > PLAN_MAX_STEPS) {
    return { ok: false, steps: [], problems: [`计划 ${list.length} 步超过上限 ${PLAN_MAX_STEPS}，请拆成多次目标执行`] };
  }

  const steps = [];
  list.forEach((s, i) => {
    const n = i + 1;
    const act = String(s?.act || '').trim();
    const spec = ACTS[act];
    if (!spec) {
      problems.push(`第 ${n} 步动作「${act || '(空)'}」不在白名单，已拒绝（不做不错）`);
      return;
    }
    const step = {
      act,
      target: s.target !== undefined && s.target !== null ? String(s.target) : undefined,
      value: s.value !== undefined && s.value !== null ? String(s.value) : undefined,
      expect: s.expect !== undefined && s.expect !== null ? String(s.expect) : undefined,
    };
    for (const need of spec.need) {
      if (!step[need]) {
        problems.push(`第 ${n} 步（${act}）缺少参数 ${need}，已拒绝`);
        return;
      }
    }
    if (act === 'goto' && !/^https?:\/\//i.test(step.target)) {
      problems.push(`第 ${n} 步 goto 的地址不是 http/https：${step.target}（本地文件与其它协议一律不放行）`);
      return;
    }
    steps.push(step);
  });

  if (steps.length === 0 && problems.length === 0) problems.push('计划没有可执行步骤');
  // 有问题就不算「好计划」：部分可用也交回人确认，而不是挑着执行。
  return { ok: problems.length === 0, steps: problems.length === 0 ? steps : [], problems, goal, url };
}

/**
 * 确定性骨架：LLM 不可用时的降级计划。
 * 只保证「能到达 + 有证据」，并把目标里带引号的片段当作 expect_text ——
 * 抽不出来就不猜，如实写进 problems。
 */
export function fallbackPlan({ goal = '', url = '' } = {}) {
  const steps = [{ act: 'goto', target: url }];
  const problems = [];
  const quoted = [...String(goal).matchAll(/[“"「『']([^”"」』']{2,60})[”"」』']/g)].map((m) => m[1]);
  for (const q of [...new Set(quoted)].slice(0, 5)) {
    steps.push({ act: 'expect_text', value: q });
  }
  steps.push({ act: 'screenshot' });
  if (quoted.length === 0) {
    problems.push('LLM 不可用，骨架里没有可判定的断言（目标没有带引号的期望文本）——只能证明「到得了」，证明不了「对」');
  }
  return { ok: true, steps, problems, source: 'fallback' };
}

/**
 * 由步骤结果得出总体判定。语义刻意保守：
 *   只要有一条步骤失败 → Fail（目标未达成，不能说「大部分过了」）；
 *   一条可判定步骤都没有 → Blocked（到不了判定，而不是通过）。
 */
export function verdictOf(stepResults = []) {
  if (!stepResults.length) return 'Blocked';
  const decisive = stepResults.filter((s) => s.act?.startsWith('expect_'));
  if (stepResults.some((s) => s.ok === false)) return 'Fail';
  if (!decisive.length) return 'Blocked';
  return 'Pass';
}

export default { ACTS, PLAN_MAX_STEPS, buildPlanMessages, normalizePlan, fallbackPlan, verdictOf };
