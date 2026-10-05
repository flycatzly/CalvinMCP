/**
 * plancache.js — nl_test_goal 的计划缓存（进程内、小容量、短 TTL）
 *
 * 解决什么：LLM 规划是整条智能体线里最慢的一步（本地 Ollama 实测秒级到分钟级）。
 * 同一个目标在一段时间内反复跑（CI 里同一 goal 多次触发、调试时反复验同一场景）
 * 时，规划结果不会变——变的只有页面。所以缓存的是「规划产物」，
 * 执行与断言永远全量真跑（证据时间戳是新鲜的）。
 *
 * 三条硬边界（与 nl-agent.md 的口径一致）：
 *   1) 失效口径宁严勿宽：指纹 = goal + url + provider + model，任一变即失效。
 *      页面在变，TTL 只是兜底，不是「缓存 5 分钟内绝对安全」的承诺。
 *   2) 命中只省规划，绝不省执行：命中返回的是**计划**，不是结果；
 *      executePlan 照常一步步真跑、真断言、真落盘。
 *   3) 只缓存成功的 LLM 计划：LLM 不可用时的 fallback 骨架不缓存——
 *      下一次调用必须重试 LLM（模型可能已经起来了）；不合法的计划也不缓存。
 *
 * 隐私：key 是 goal/url/provider/model 的 sha256（目标原文不落盘不进日志）；
 * 值只存归一化后的计划步骤；整个缓存只活在进程内存里，进程退出即消失。
 */
import { createHash } from 'node:crypto';

/** TTL：5 分钟。页面会在变，长 TTL 是拿正确性换省时 —— 不换。 */
export const PLAN_CACHE_TTL_MS = 300_000;
/** 容量：8 条。超过即 FIFO 淘汰最旧 —— 缓存是热身，不是档案库。 */
export const PLAN_CACHE_CAPACITY = 8;
/** 计划缓存三态（单一源）：hit=命中复用 / miss=查了没中 / skip=没查（llm=off）。
 *  报告字段 planCache、观测日志 cache= 字段、log_summary 聚合都从这里取合法值 ——
 *  三处各写一份枚举，漂移只是时间问题。 */
export const PLAN_CACHE_STATES = ['hit', 'miss', 'skip'];

/** 计划缓存指纹。JSON 序列化后再哈希，避免多行 goal 与分隔符的拼串碰撞。 */
export function planFingerprint({ goal, url, provider, model }) {
  return createHash('sha256')
    .update(JSON.stringify([String(goal), String(url), String(provider), String(model)]))
    .digest('hex');
}

/**
 * 创建计划缓存实例。
 * @param {object} [o]
 * @param {number} [o.ttlMs]     存活毫秒（默认 300000）
 * @param {number} [o.capacity]  容量上限（默认 8，FIFO 淘汰）
 * @param {Function} [o.now]     时钟（默认 Date.now；测试注入假时钟）
 */
export function createPlanCache({ ttlMs = PLAN_CACHE_TTL_MS, capacity = PLAN_CACHE_CAPACITY, now = Date.now } = {}) {
  const map = new Map(); // fp -> { steps, provider, model, at }
  return {
    /** 命中返回 { steps, provider, model, ageMs }；未命中/过期返回 null（过期即淘汰）。 */
    get(fp) {
      const e = map.get(fp);
      if (!e) return null;
      const age = now() - e.at;
      if (age >= ttlMs) {
        map.delete(fp);
        return null;
      }
      return { steps: e.steps, provider: e.provider, model: e.model, ageMs: age };
    },
    /** 写入并做容量淘汰。同 key 重写视为刷新（移到最新）。 */
    set(fp, { steps, provider, model }) {
      if (map.has(fp)) map.delete(fp);
      map.set(fp, { steps, provider, model, at: now() });
      while (map.size > capacity) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
      }
    },
    get size() {
      return map.size;
    },
  };
}

export default { planFingerprint, createPlanCache, PLAN_CACHE_TTL_MS, PLAN_CACHE_CAPACITY, PLAN_CACHE_STATES };
