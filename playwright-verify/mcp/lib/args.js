/**
 * args.js — MCP 工具参数的规范化
 *
 * 为什么需要它（真踩过的坑）：
 *   MCP 客户端可能把布尔参数序列化成字符串。`"false"` 在 JS 里是**真值**，
 *   于是 `!!args.run` 把 `run: "false"` 判成「要执行」——
 *   用户明确说了不要跑，工具却真的启动了浏览器跑回归。
 *   这类「静默反转用户意图」的问题不会报错，只会做出与预期相反的动作，必须从根上堵住。
 *
 * 判定规则（**唯一的规则，所有布尔参数都走这里**）：
 *   真布尔          → 原样
 *   "true" / "1"    → true        （大小写不敏感，容忍前后空白）
 *   "false" / "0"   → false
 *   undefined/null  → 默认值
 *   其它任何值      → 抛错
 *
 * 为什么要抛错而不是「当成 falsy」：
 *   把一个看不懂的值静默当成 false，会让「用户以为开了、其实没开」；
 *   当成 true 又会让「用户以为没开、其实开了」。两种都是静默错。
 *   直接报错并说明收到什么、期望什么，才是唯一不会误导的处理方式。
 */

/**
 * 严格解析布尔参数。
 * @param {unknown} value
 * @param {string} name   参数名（用于报错信息）
 * @param {boolean} [dflt=false] value 缺失时的默认值
 * @returns {boolean}
 */
export function boolArg(value, name, dflt = false) {
  if (value === undefined || value === null) return dflt;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    throw new TypeError(`参数 ${name} 应为布尔值，收到数字 ${value}。请传 true 或 false。`);
  }
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    throw new TypeError(`参数 ${name} 应为布尔值，收到字符串 "${value}"。请传 true 或 false。`);
  }
  throw new TypeError(`参数 ${name} 应为布尔值，收到 ${typeof value}。请传 true 或 false。`);
}

/** 严格解析数字参数（容忍数字字符串，因为客户端也可能把数字序列化）。 */
export function numArg(value, name, dflt) {
  if (value === undefined || value === null) return dflt;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError(`参数 ${name} 应为数字，收到 ${value}（不是有限数）。`);
  }
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new TypeError(`参数 ${name} 应为数字，收到 ${JSON.stringify(value)}。`);
}

/** 严格解析整数参数（下标/计数/毫秒超时/步数上限这类）：浮点一律报错，绝不静默取整。
 *  实测教训（2026-10-04）：keyIndex=1.5 时每行都取不到键 → 静默零行 → 误报
 *  「COLLECT_EMPTY 站点没数据」——把调用方笔误怪给目标，误导性根因必须在参数层拦下；
 *  maxPages=2.5 会被循环当 3 页用，语义同样含糊。下标/计数没有小数的合法语义，
 *  毫秒超时同理（timeoutMs=0.5 曾被 `|| 默认值` 放行成 0.5ms 的真超时）。
 *  反例（设计行为，别「顺手统一」）：healLlmBudget 的 3.9→3 截断有钉 ——
 *  预算口径是「最多调 N 次」，截断不改变意图；与下标/超时的「取整即失效」不同类。 */
export function intArg(value, name, dflt) {
  const n = numArg(value, name, dflt);
  if (!Number.isInteger(n)) {
    throw new TypeError(`参数 ${name} 应为整数（不接受小数），收到 ${value}。`);
  }
  return n;
}

/** 严格解析字符串数组（容忍单个字符串，方便调用方少写一层括号）。 */
export function arrayArg(value, name) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === 'string')) {
      throw new TypeError(`参数 ${name} 应为字符串数组，其中含非字符串元素。`);
    }
    return value;
  }
  if (typeof value === 'string') return value.trim() ? [value] : [];
  throw new TypeError(`参数 ${name} 应为字符串数组，收到 ${typeof value}。`);
}

export default { boolArg, numArg, intArg, arrayArg };
