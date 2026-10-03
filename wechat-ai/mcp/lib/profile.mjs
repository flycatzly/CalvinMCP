// 个人 Profile（与上游 wechat-intelligence-hub profile v2 对齐，可互相导入）
import fs from "node:fs";
import { ensureHome, paths } from "./paths.mjs";
import { readJson, writeJson } from "./util.mjs";

export const PROFILE_VERSION = 2;

export const PUBLIC_FOCUS_AREAS = [
  "AI", "赚钱", "培训", "商单", "出海", "产品", "Web3", "自媒体运营与增长", "合作", "B端AI赋能",
];

export function defaultProfile() {
  return {
    profile_version: PROFILE_VERSION,
    owner_aliases: [],
    owner_social_handles: [],
    labels: { priority: [], commercial: [], creator: [], reactivation: [] },
    contact_daily: { scope: "hybrid" },
    project_chat_terms: ["初稿", "终稿", "对接群", "交付群", "合作群", "项目群"],
    reply_style: { history_days: 30, minimum_chat_messages: 5 },
    group_recap_senders: {},
    group_recap_time_windows: {},
    context: { setup_status: "needs_context", personal_documents: [], current_plan_documents: [] },
    intelligence_priorities: {
      focus_areas: [...PUBLIC_FOCUS_AREAS],
      priority_keywords: [],
      deprioritize_keywords: [],
      custom_topics: {},
    },
  };
}

let _p = null;

export function loadProfile({ reload = false } = {}) {
  if (_p && !reload) return _p;
  ensureHome();
  const file = paths().profile;
  let prof = readJson(file, null);
  if (!prof || typeof prof !== "object") {
    // 损坏时先备份再重建
    try {
      if (fs.existsSync(file)) fs.renameSync(file, `${file}.corrupt-${Date.now()}.bak`);
    } catch { /* ignore */ }
    prof = defaultProfile();
    writeJson(file, prof);
  } else {
    const d = defaultProfile();
    prof = {
      ...d,
      ...prof,
      labels: { ...d.labels, ...(prof.labels || {}) },
      reply_style: { ...d.reply_style, ...(prof.reply_style || {}) },
      context: { ...d.context, ...(prof.context || {}) },
      intelligence_priorities: { ...d.intelligence_priorities, ...(prof.intelligence_priorities || {}) },
      contact_daily: { ...d.contact_daily, ...(prof.contact_daily || {}) },
    };
  }
  _p = prof;
  return prof;
}

export function saveProfile(prof) {
  const file = paths().profile;
  writeJson(file, prof);
  _p = prof;
  return file;
}

export function profilePath() {
  return paths().profile;
}

/** profile-init：写入本人别名、重点标签、个人文档与计划文档 */
export function initProfile({ ownerAlias, ownerAliases, personalDoc, planDoc, priorityLabel, priorityLabels, force = false } = {}) {
  const existing = fs.existsSync(paths().profile);
  const prof = existing ? loadProfile({ reload: true }) : defaultProfile();
  const aliasList = [
    ...(ownerAliases ?? []),
    ...(ownerAlias ? [ownerAlias] : []),
  ].filter(Boolean);
  if (aliasList.length) prof.owner_aliases = [...new Set([...(prof.owner_aliases ?? []), ...aliasList])];
  const pl = [...(priorityLabels ?? []), ...(priorityLabel ? [priorityLabel] : [])].filter(Boolean);
  if (pl.length) prof.labels.priority = [...new Set([...(prof.labels.priority ?? []), ...pl])];
  if (personalDoc) prof.context.personal_documents = [...new Set([...(prof.context.personal_documents ?? []), personalDoc])];
  if (planDoc) prof.context.current_plan_documents = [...new Set([...(prof.context.current_plan_documents ?? []), planDoc])];
  const docs = [...(prof.context.personal_documents ?? []), ...(prof.context.current_plan_documents ?? [])];
  const present = docs.filter((d) => d && fs.existsSync(d));
  prof.context.setup_status = present.length ? "ready" : "needs_context";
  prof.context.updated_at = new Date().toISOString();
  if (force) prof.forced_at = new Date().toISOString();
  saveProfile(prof);
  return prof;
}

/** 供 profile-status 使用的就绪度评估 */
export function profileStatus() {
  const prof = loadProfile({ reload: true });
  const docs = [...(prof.context.personal_documents ?? []), ...(prof.context.current_plan_documents ?? [])];
  const present = docs.filter((d) => d && fs.existsSync(d));
  const missing = docs.filter((d) => d && !fs.existsSync(d));
  const hasOwner = (prof.owner_aliases ?? []).length > 0;
  const hasPriority = (prof.labels.priority ?? []).length > 0;
  let state = "ready";
  if (!hasOwner && !present.length) state = "needs_context";
  else if (!hasOwner || !present.length) state = "partial";
  return {
    state,
    owner_aliases: prof.owner_aliases ?? [],
    priority_labels: prof.labels.priority ?? [],
    commercial_labels: prof.labels.commercial ?? [],
    creator_labels: prof.labels.creator ?? [],
    reactivation_labels: prof.labels.reactivation ?? [],
    documents: docs,
    documents_present: present,
    documents_missing: missing,
    focus_areas: prof.intelligence_priorities?.focus_areas ?? [],
    personalization_note: state === "ready"
      ? "已按个人目标排序"
      : "尚未个性化：报告仍可生成，但排序未结合个人目标",
    path: paths().profile,
  };
}

/** 生成准备清单（没有个人文档时） */
export function onboardingChecklist() {
  return [
    "一份「个人说明 / 人生使用说明书」：你是谁、在做什么、擅长什么、不做什么。",
    "一份「当前计划 / OKR / 本月重点」：本季度最重要的 3 件事与关键合作。",
    "2–5 个微信标签名称（示例：客户 / 同行 / 渠道 / 供应商 / 品牌方）——只读列出即可，不要自动改微信标签。",
    "本人微信昵称（用于区分「我」和对方，reply 草稿必需）。",
    "把上述文档路径交给 profile-init，例如：--personal-doc \"D:\\me\\个人说明.md\" --plan-doc \"D:\\me\\本月计划.md\"",
  ];
}

export function ownerAliases() {
  const prof = loadProfile();
  return (prof.owner_aliases ?? []).filter(Boolean);
}

/** 判断发送者是否是本人 */
export function isOwnerName(sender) {
  const s = String(sender ?? "").trim();
  if (!s) return false;
  if (/^(我|自己|本人|me|Me|ME)$/.test(s)) return true;
  return ownerAliases().some((a) => a && (s === a || s.includes(a)));
}
