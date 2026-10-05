// 分析报告渲染：把 9 个分析结果写成 Markdown + JSON 落盘。
// 落盘安全：落盘边界统一再过一遍脱敏（privacy.redactOutputs，默认开）；
// 路径由 server 层做「不得写进仓库」门禁。
import path from "node:path";
import { atomicWrite, ensureDir, writeJson, truncate, fmtLocal } from "../util.mjs";
import { loadConfig } from "../config.mjs";
import { maskPii, maskDeep } from "./core.mjs";

const TITLES = {
  period: "微信聊天分析｜年度/月度报告",
  social: "微信聊天分析｜社交关系",
  sentiment: "微信聊天分析｜情绪趋势",
  tasks: "微信聊天分析｜任务与日程",
  finance: "微信聊天分析｜财务记录",
  memory: "微信聊天分析｜记忆与知识库",
  content: "微信聊天分析｜内容分析",
  team: "微信聊天分析｜团队复盘",
  risk: "微信聊天分析｜风控线索",
};

/**
 * 渲染一个分析结果到 outDir。
 * @returns {{out:string, files:{report:string,json:string}}}
 */
export function renderAnalytics(kind, result, { outDir, title } = {}) {
  const dir = String(outDir ?? "");
  ensureDir(dir);
  let redact = true;
  try { redact = loadConfig().privacy?.redactOutputs !== false; } catch { redact = true; }
  const md = (RENDERERS[kind] ?? renderGeneric)(result);
  const head = `# ${title ?? TITLES[kind] ?? "微信聊天分析"}\n\n> 生成时间：${fmtLocal(new Date())} · 只读分析 · 证据已脱敏 · 结论以证据为准\n\n`;
  const body = head + md + "\n";
  const report = atomicWrite(path.join(dir, `${kind}_report.md`), redact ? maskPii(body) : body);
  const json = writeJson(path.join(dir, `${kind}.json`), redact ? maskDeep(result ?? {}) : (result ?? {}));
  return { out: report, files: { report, json } };
}

function table(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((c) => String(c ?? "").replace(/\|/g, "\\|")).join(" | ")} |`).join("\n");
  return [head, sep, body].filter(Boolean).join("\n");
}

function evidenceLine(e) {
  return `- \`${e.msg_id ?? "-"}\` ${e.time ?? "-"} · ${e.sender ?? "-"} · ${e.chat ?? "-"}：${e.text ?? ""}`;
}

const RENDERERS = {
  period(r) {
    const lines = [];
    lines.push(`**时间范围**：${r.period?.label ?? "-"}　**总消息**：${r.total_messages}（我 ${r.self_messages} / 收 ${r.received_messages}）`);
    if (r.period?.sample_note) lines.push(`\n> ⚠️ ${r.period.sample_note}：结论仅供参考。\n`);
    if (r.type_breakdown) {
      lines.push("## 消息类型分布");
      lines.push(table(["类型", "条数", "占比%"], Object.entries(r.type_breakdown.counts).map(([k, v]) => [k, v, r.type_breakdown.ratio[k]])));
    }
    lines.push("## 活跃时段");
    lines.push(table(["小时", "条数"], r.active_hours.map((h) => [h.hour, h.count])));
    lines.push("\n" + table(["星期", "条数"], r.active_weekdays.map((w) => [w.label, w.count])));
    lines.push("## 高频联系人 Top");
    lines.push(table(["联系人", "消息", "我发", "对方发", "占比%"], r.top_contacts.map((c) => [c.name, c.messages, c.self, c.others, (c.share * 100).toFixed(1)])));
    if (r.top_groups?.length) {
      lines.push("## 群聊排行 Top");
      lines.push(table(["群", "消息", "占比%"], r.top_groups.map((g) => [g.name, g.messages, (g.share * 100).toFixed(1)])));
    }
    lines.push("## 关键词 / 口头禅 / 表情");
    lines.push(table(["关键词", "次数"], r.keywords.slice(0, 15).map((k) => [k.term, k.count])));
    if (r.catchphrases?.length) lines.push("\n" + table(["口头禅", "次数"], r.catchphrases.map((c) => [c.text, c.count])));
    if (r.emojis?.length) lines.push("\n" + table(["表情", "次数"], r.emojis.slice(0, 15).map((e) => [e.emoji, e.count])));
    lines.push("## 节奏与回复");
    lines.push(`- 最长连续聊天天数：**${r.activity?.longest_streak_days ?? 0}** 天；单日峰值：${r.activity?.peak_day?.count ?? 0} 条（${r.activity?.peak_day?.day ?? "-"}）`);
    lines.push(`- 最长静默：${r.activity?.longest_gap_hours ?? 0} 小时（${r.activity?.longest_gap ? r.activity.longest_gap.from + " ~ " + r.activity.longest_gap.to : "-"}）`);
    lines.push(`- 我回复间隔：中位 ${r.reply_interval?.mine?.median_minutes ?? "-"} 分钟 / 对方回我：中位 ${r.reply_interval?.theirs?.median_minutes ?? "-"} 分钟`);
    lines.push(`- 夜间消息（23-5 点）：${r.night_messages?.count ?? 0} 条（${((r.night_messages?.ratio ?? 0) * 100).toFixed(1)}%）`);
    if (r.relationship_trend?.length) {
      lines.push("## 关系趋势");
      lines.push(table(["会话", "趋势", "末月环比%"], r.relationship_trend.map((t) => [t.chat, t.trend, ((t.change ?? 0) * 100).toFixed(0)])));
    }
    lines.push("## 洞察");
    for (const i of r.insights ?? []) lines.push(`- ${i.text}（置信度：${i.confidence}）`);
    if (r.caliber) lines.push(`\n---\n*口径：${r.caliber}*`);
    return lines.join("\n");
  },

  social(r) {
    const lines = [];
    lines.push(`**会话**：私聊 ${r.overview?.peers ?? 0} / 群 ${r.overview?.groups ?? 0}　**消息**：${r.overview?.messages ?? 0}`);
    lines.push("## 谁主动联系我最多");
    lines.push(table(["对象", "对方主动段", "我主动段", "对方回我中位(分)"], (r.who_contacts_me_most ?? []).map((p) => [p.name, p.their_initiated, p.my_initiated, p.their_reply_median_minutes ?? "-"])));
    lines.push("## 我主动联系谁最多");
    lines.push(table(["对象", "我主动段", "对方主动段", "我回对方中位(分)"], (r.who_i_contact_most ?? []).map((p) => [p.name, p.my_initiated, p.their_initiated, p.my_reply_median_minutes ?? "-"])));
    lines.push("## 双向性");
    lines.push(table(["对象", "我发", "对方发", "平衡比", "标签"], (r.bidirectional ?? []).slice(0, 15).map((b) => [b.name, b.self_messages, b.other_messages, b.balance_ratio, b.label])));
    if (r.relationship_change?.length) {
      lines.push("## 关系变化");
      lines.push(table(["会话", "趋势", "末月环比%"], r.relationship_change.map((x) => [x.name, x.trend, ((x.change ?? 0) * 100).toFixed(0)])));
    }
    if (r.group_network?.length) {
      lines.push("## 群结构");
      for (const g of r.group_network.slice(0, 10)) {
        lines.push(`- **${g.group}**：${g.messages} 条 / ${g.active_senders} 人发言；核心：${g.core_members.map((c) => `${c.sender}(${c.count})`).join("、") || "-"}；边缘：${g.edge_members.map((c) => c.sender).join("、") || "-"}`);
      }
    }
    if (r.bridge_members?.length) {
      lines.push("## 信息桥梁（近似）");
      lines.push(table(["成员", "活跃群数", "群"], r.bridge_members.map((b) => [b.sender, b.group_count, b.groups.join("、")])));
    }
    if (r.clusters?.length) {
      lines.push("## 同群共现聚类（近似社群）");
      for (const c of r.clusters) lines.push(`- 社群 ${c.cluster}（${c.size} 人）：${c.members.slice(0, 10).join("、")}`);
    }
    if (r.interaction_notes?.length) {
      lines.push("## 互动模式线索（仅描述，不评判）");
      for (const n of r.interaction_notes.slice(0, 10)) lines.push(`- [${n.type}] ${n.chat}：${n.description}`);
    }
    if (r.caliber) lines.push(`\n---\n*口径：${r.caliber}*`);
    return lines.join("\n");
  },

  sentiment(r) {
    const lines = [];
    lines.push(`**评分消息**：${r.messages_scored}　**积极**：${(r.positive_ratio * 100).toFixed(1)}%　**消极**：${(r.negative_ratio * 100).toFixed(1)}%　**中性**：${(r.neutral_ratio * 100).toFixed(1)}%`);
    lines.push("\n> ⚠️ 这是文本情绪线索，**不是心理或医疗诊断**。\n");
    lines.push("## 每日情绪");
    lines.push(table(["日期", "消息", "积极", "消极", "得分"], (r.daily_sentiment ?? []).map((d) => [d.day, d.messages, d.positive, d.negative, d.score])));
    if (r.volatility_periods?.length) {
      lines.push("## 波动最大的日子");
      lines.push(table(["日期", "得分", "波动"], r.volatility_periods.map((v) => [v.day, v.score, v.swing])));
    }
    if (r.stress_topics?.length) {
      lines.push("## 压力源话题");
      lines.push(table(["话题", "命中", "占比%"], r.stress_topics.map((s) => [s.topic, s.hits, (s.ratio * 100).toFixed(1)])));
    }
    if (r.conflict_words?.length) {
      lines.push("## 冲突 / 安慰词");
      lines.push(table(["冲突词", "次数"], r.conflict_words.map((c) => [c.word, c.count])));
      if (r.comfort_words?.length) lines.push("\n" + table(["安慰词", "次数"], r.comfort_words.map((c) => [c.word, c.count])));
    }
    if (r.high_risk_periods?.length) {
      lines.push("## 需要关注的时段（线索）");
      for (const h of r.high_risk_periods) {
        lines.push(`- **${h.day}**（均分 ${h.score}）：${h.reasons.join("；")}`);
        for (const e of h.evidence ?? []) lines.push("  " + evidenceLine(e));
      }
    }
    if (r.night_negative_messages?.length) {
      lines.push("## 夜间负面消息（23-5 点）");
      for (const e of r.night_negative_messages.slice(0, 8)) lines.push(evidenceLine(e));
    }
    lines.push(`\n---\n*局限：${r.limitations}*`);
    return lines.join("\n");
  },

  tasks(r) {
    const lines = [];
    lines.push(`**任务**：${r.stats?.total ?? 0} 项　**状态**：${JSON.stringify(r.stats?.by_status ?? {})}`);
    lines.push("## 任务清单");
    lines.push(table(["#", "类型", "内容", "负责人", "截止", "状态", "置信度", "来源"], (r.tasks ?? []).map((t) =>
      [t.task_id, t.kind, t.title, `${t.owner}（${t.direction}）`, t.due ?? "需确认", t.status, t.confidence, t.source_msg_id ?? "-"])));
    if (!(r.tasks ?? []).length) lines.push("_当前窗口没有识别出任务。_");
    if (r.ics) {
      lines.push("\n## 日历建议（ICS 片段）");
      lines.push("```ics\n" + truncate(r.ics, 800) + "\n```");
    }
    if (r.caliber) lines.push(`\n---\n*口径：${r.caliber}*`);
    return lines.join("\n");
  },

  finance(r) {
    const lines = [];
    lines.push(`**流水**：${r.totals?.entries ?? 0} 笔　**方向明确的收入合计**：${r.totals?.income ?? 0}　**支出合计**：${r.totals?.expense ?? 0}${r.totals?.show_amounts ? "" : "（金额已按区间脱敏）"}`);
    lines.push("\n> 仅作记录与趋势，**不构成任何投资/借贷/理财建议**。\n");
    lines.push("## 流水");
    lines.push(table(["日期", "类型", "金额/区间", "方向", "对象", "类别", "状态", "来源"], (r.entries ?? []).map((e) =>
      [e.date ?? "-", e.type, e.amount ?? e.amount_band ?? "-", e.direction, e.counterparty, e.category, e.status, e.source_msg_id ?? "-"])));
    if (!(r.entries ?? []).length) lines.push("_当前窗口没有识别出资金往来。_");
    if (r.monthly?.length) {
      lines.push("## 月度收支");
      lines.push(table(["月份", "笔数", "收入", "支出", "净额"], r.monthly.map((m) => [m.month, m.count, m.income, m.expense, m.net])));
    }
    if (r.categories?.length) {
      lines.push("## 消费类别");
      lines.push(table(["类别", "笔数", "合计"], r.categories.map((c) => [c.category, c.count, c.amount])));
    }
    if (r.top_counterparties?.length) {
      lines.push("## 高频交易对象");
      lines.push(table(["对象", "笔数", "收入", "支出"], r.top_counterparties.map((p) => [p.name, p.count, p.income, p.expense])));
    }
    if (r.suspicious?.length) {
      lines.push("## 异常/可疑线索（需人工核对）");
      for (const s of r.suspicious.slice(0, 10)) lines.push(`- ${s.reason}`);
    }
    if (r.caliber) lines.push(`\n---\n*口径：${r.caliber}*`);
    return lines.join("\n");
  },

  memory(r) {
    const lines = [];
    lines.push(`**知识卡片**：${r.stats?.cards ?? 0} 张　**含地点**：${r.stats?.with_location ?? 0}　**含文件**：${r.stats?.with_files ?? 0}　**含链接**：${r.stats?.with_links ?? 0}`);
    lines.push("## 时间线");
    lines.push(table(["时间", "类型", "标题", "人", "地点", "来源"], (r.timeline ?? []).map((t) => [t.time ?? "-", t.kind, t.title, (t.people ?? []).join("、"), t.location ?? "-", (t.source_msg_ids ?? []).join(",")])));
    if (!(r.timeline ?? []).length) lines.push("_当前窗口没有识别出可沉淀的知识卡片。_");
    lines.push("\n## 知识卡片段落");
    for (const c of (r.cards ?? []).slice(0, 12)) {
      lines.push(`- **[${c.kind}] ${c.title}**（${c.time ?? "-"}）`);
      lines.push(`  ${c.summary}`);
      if (c.tags?.length) lines.push(`  标签：${c.tags.join(" / ")}`);
    }
    if (r.search_hint) lines.push(`\n*${r.search_hint}*`);
    if (r.caliber) lines.push(`\n---\n*口径：${r.caliber}*`);
    return lines.join("\n");
  },

  content(r) {
    const lines = [];
    lines.push(`**消息**：${r.total} 条`);
    lines.push("## 词频 Top");
    lines.push(table(["词", "次数"], (r.keywords ?? []).slice(0, 15).map((k) => [k.term, k.count])));
    if (r.catchphrases?.length) lines.push("\n## 口头禅\n" + table(["短句", "次数"], r.catchphrases.map((c) => [c.text, c.count])));
    if (r.topics?.length) {
      lines.push("## 话题聚类");
      lines.push(table(["话题", "命中", "占比%", "代表词"], r.topics.map((t) => [t.topic, t.hits, (t.share * 100).toFixed(1), (t.top_terms ?? []).slice(0, 3).map((x) => x.term).join("、")])));
    }
    if (r.intents) {
      lines.push("## 意图分布");
      lines.push(table(["意图", "条数", "占比%"], Object.entries(r.intents.counts).map(([k, v]) => [k, v, ((r.intents.ratio[k] ?? 0) * 100).toFixed(1)])));
    }
    if (r.entities) {
      lines.push("## 实体");
      for (const key of ["person", "time", "location", "amount", "org", "event"]) {
        const rows = r.entities[key] ?? [];
        if (rows.length) lines.push(`- **${key}**：${rows.slice(0, 8).map((e) => `${e.value}(${e.count})`).join("、")}`);
      }
    }
    if (r.summary?.bullets?.length) {
      lines.push("## 摘要（抽取式）");
      for (const b of r.summary.bullets) lines.push(`- ${b.text}　\`${b.msg_id ?? "-"}\``);
    }
    if (r.caliber) lines.push(`\n---\n*口径：${r.caliber}*`);
    return lines.join("\n");
  },

  team(r) {
    const lines = [];
    lines.push(`**范围**：${r.project ?? "未指定项目"}　**消息**：${r.window_messages} 条　${r.scope_note ?? ""}`);
    lines.push("## 参与度");
    lines.push(table(["成员", "消息", "占比%"], (r.activity?.participants ?? []).map((p) => [p.sender, p.count, (p.share * 100).toFixed(1)])));
    lines.push("\n回复节奏：我回对方中位 " + (r.activity?.reply_interval?.mine?.median_minutes ?? "-") + " 分钟");
    if (r.decisions?.length) {
      lines.push("## 决策日志");
      lines.push(table(["时间", "决策人", "内容", "生效"], r.decisions.map((d) => [d.time ?? "-", d.actor, d.text, d.effective ?? "-"])));
    }
    if (r.assignments?.length) {
      lines.push("## 任务分配");
      lines.push(table(["负责人", "内容", "截止", "状态", "来源"], r.assignments.map((a) => [a.assignee, a.text, a.due ?? "-", a.status, a.msg_id ?? "-"])));
    }
    if (r.risks?.length) {
      lines.push("## 风险提醒（仅提示，不直接定性）");
      for (const x of r.risks) lines.push(`- [${x.risk_type}/${x.level}] ${x.text}（${x.actor}，${x.msg_id ?? "-"}）`);
    }
    lines.push("## 服务质检");
    lines.push(`- 投诉线索 ${r.service_qc?.complaint_count ?? 0} 条；正向服务词 ${r.service_qc?.positive_signals ?? 0} 条；响应中位 ${r.service_qc?.response_minutes_median ?? "-"} 分钟。${r.service_qc?.note ?? ""}`);
    if (r.sales?.needs?.length) {
      lines.push("## 客户需求 / 异议");
      for (const n of r.sales.needs.slice(0, 8)) lines.push(`- 需求：${n.text}`);
      for (const o of (r.sales.objections ?? []).slice(0, 8)) lines.push(`- 异议：${o.text}`);
    }
    if (r.faq?.length) {
      lines.push("## FAQ（重复问题）");
      for (const f of r.faq) lines.push(`- ${f.question}…（×${f.count}）`);
    }
    if (r.caliber) lines.push(`\n---\n*口径：${r.caliber}*`);
    return lines.join("\n");
  },

  risk(r) {
    const lines = [];
    lines.push(`**扫描消息**：${r.scanned} 条　**线索**：${r.stats?.total ?? 0} 条　**分布**：${JSON.stringify(r.stats?.by_level ?? {})}`);
    lines.push("\n> ⚠️ 以下只是风险线索，**不是违法认定**；全部条目需人工复核。" + (r.goal ? `\n> 分析目标：${r.goal}` : ""));
    for (const x of r.risks ?? []) {
      lines.push(`\n### [${x.level}] ${x.type} · ${x.rule_id}`);
      lines.push(`- 描述：${x.description}`);
      lines.push(`- 会话：${x.chat}　发送者：${x.sender}　时间：${x.time ?? "-"}`);
      if (x.evidence_text) lines.push(`- 证据：${x.evidence_text}`);
      if (x.evidence_msg_ids?.length) lines.push(`- msg_id：${x.evidence_msg_ids.join(", ")}`);
      lines.push(`- 建议：${x.suggested_action}`);
      lines.push(`- 需人工复核：${x.needs_review ? "是" : "否"}`);
    }
    if (!(r.risks ?? []).length) lines.push("\n_当前窗口未命中风控规则。_");
    lines.push(`\n---\n*${r.disclaimer ?? ""}*\n*口径：${r.caliber ?? ""}*`);
    return lines.join("\n");
  },
};

function renderGeneric(result) {
  return "```json\n" + JSON.stringify(result ?? {}, null, 2) + "\n```";
}
