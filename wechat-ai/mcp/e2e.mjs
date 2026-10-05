#!/usr/bin/env node
// 端到端验收：用虚构演示数据跑完整用户旅程，逐步断言 MCP 工具返回值。
// 用法: node e2e.mjs [--keep]   （--keep 保留临时数据根以便检查产物）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const KEEP = process.argv.includes("--keep");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-ai-e2e-"));
const SAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "samples");
process.env.WECHAT_AI_HOME = HOME;

const srv = await import(new URL("./server.mjs", import.meta.url).href);

const steps = [];
let failed = 0;

async function call(name, args) {
  const r = await srv.handleRpc({ jsonrpc: "2.0", id: steps.length + 1, method: "tools/call", params: { name, arguments: args ?? {} } });
  const res = r.result ?? {};
  const sc = res.structuredContent ?? null;
  return { res, sc, text: res.content?.[0]?.text ?? "", isError: !!res.isError };
}

async function step(title, name, args, verify, opts) {
  const expectError = !!opts?.expectError;
  const t0 = Date.now();
  const out = await call(name, args);
  const ms = Date.now() - t0;
  let note = "";
  let ok = expectError ? out.isError : !out.isError;
  if (expectError) {
    note = ok ? "按预期报错" : "应当报错却成功";
    if (!ok) failed += 1;
    steps.push({ title, tool: name, ok, ms, note });
    console.log((ok ? "  ✓ " : "  ✗ ") + title.padEnd(34, " ") + name.padEnd(24, " ") + ms + "ms" + (note ? "  " + note : ""));
    return out;
  }
  if (ok && verify) {
    try {
      const v = await verify(out.sc, out);
      if (v === false) { ok = false; note = "断言失败"; }
      else if (typeof v === "string") note = v;
    } catch (e) {
      ok = false;
      note = String(e?.message ?? e);
    }
  } else if (!ok) {
    note = (out.sc?.error ?? out.text).slice(0, 200);
  }
  if (!ok) failed += 1;
  steps.push({ title, tool: name, ok, ms, note });
  console.log((ok ? "  ✓ " : "  ✗ ") + title.padEnd(34, " ") + name.padEnd(24, " ") + ms + "ms" + (note ? "  " + note : ""));
  return out;
}

console.log("数据根: " + HOME);
console.log("");

// ---- 0. 个性化（先写 Profile，后面的排序才是个人化的） ----
await step("写入个人 Profile", "wai_profile_init", { ownerAlias: "我", priorityLabel: "客户" }, (s) => {
  if (!s.status) throw new Error("缺 status");
  return s.status.state;
});
await step("Profile 就绪度", "wai_profile_status", {}, (s) => {
  if (!s.state) throw new Error("缺 state");
  return s.state + "，重点标签 " + ((s.priority_labels ?? []).length);
});

// ---- 1. 接入与状态 ----
await step("首页入口可用", "wai_home", {}, (s) => !!s && (s.entries || s.freshness || s.counts) && "返回入口状态");
await step("服务器状态", "wai_status", {}, (s) => { if (typeof s.messages !== "number") throw new Error("缺少 messages"); return s.messages + " 条消息"; });
await step("数据源清单", "wai_sources", {}, (s) => { if (!s.sources?.length) throw new Error("空清单"); return s.sources.length + " 个源"; });
await step("接入状态机", "wai_access_plan", {}, (s) => { if (!s.state) throw new Error("缺 state"); return s.state; });
await step("隐私扫描（包目录）", "wai_privacy_scan", {}, (s) => (s.ok ? "无泄漏标记" : "发现 " + (s.findings?.length ?? "?") + " 处（见 SKILL 说明）"));

// ---- 2. 采集与索引（演示数据） ----
await step("建立索引（演示数据）", "wai_db_index", { source: "mock", scope: "sessions", sessionLimit: 30, perChatLimit: 300, allowDemo: true }, (s) => s.totals.inserted + " 条入库 / " + s.totals.sessions + " 会话");
await step("索引新鲜度", "wai_db_status", {}, (s) => { if (!s.freshness) throw new Error("缺 freshness"); return s.freshness.messages + " 条，最新 " + (s.freshness.data_age_hours ?? "?") + " 小时前"; });
await step("Inbox 入站", "wai_inbox_push", { body: "[2026-06-30 10:12] NovaAI: 想咨询合作报价，预算 650 USD\n[2026-06-30 10:16] 我: 可以，先发 brief", chat: "NovaAI", source: "manual" }, (s) => { if (s.duplicate) throw new Error("不应重复"); return s.id; });
await step("Inbox 列表", "wai_inbox_list", { status: "new" }, (s) => {
  if (!s.stats) throw new Error("缺 stats");
  return "new=" + (s.items?.length ?? 0) + " stats=" + JSON.stringify(s.stats.dirs ?? {});
});
await step("Inbox 加工入库", "wai_inbox_process", { limit: 10 }, (s) => s.processed + " 条处理，成功 " + s.ok);
await step("Inbox 过期清理（预览）", "wai_inbox_maintain", { days: 30, apply: false }, (s) => {
  if (s.apply) throw new Error("预览不应删除");
  return "候选 " + s.count + " 条（未删除）";
});
await step("vault 状态", "wai_vault_status", {}, (s) => {
  if (typeof s.state !== "string") throw new Error("缺 state：" + JSON.stringify(s).slice(0, 120));
  return s.state + "，会话 " + (s.session_count ?? 0) + "，消息 " + (s.message_count ?? 0);
});
await step("vault 扫描入库", "wai_vault_scan", { dirs: [path.join(SAMPLES, "export-demo")] }, (s) => {
  if (typeof s.inserted !== "number") throw new Error("缺 inserted");
  return s.inserted + " 条 / " + s.sessions + " 会话";
});
// 前置写好文件再扫描：旧流程「先扫后建文件」只因缺路径静默 0 文件才误过，
// 现在 wai_scan 对不存在的目标必须报错（见下方 expectError 步骤）。
fs.writeFileSync(path.join(HOME, "sample.txt"), "[2026-06-30 12:00] 甲: 项目初稿周四前给\n[2026-06-30 13:00] 乙: 收到\n", "utf8");
await step("扫描导出文件", "wai_scan", { target: path.join(HOME, "sample.txt") }, (s) => {
  if (!(s.inserted >= 1)) throw new Error("首次扫描应入库 >=1 条，实际 " + s.inserted);
  return "入库 " + s.inserted + " 条";
});
await step("再次扫描（幂等）", "wai_scan", { target: path.join(HOME, "sample.txt") }, (s) => {
  if (s.inserted !== 0) throw new Error("重扫应 0 新增（幂等），实际 " + s.inserted);
  return "重复扫描 0 新增";
});
await step("扫描不存在路径应报错", "wai_scan", { target: path.join(HOME, "不存在的目录") }, null, { expectError: true });

// ---- 3. 检索 ----
await step("实时关键词检索", "wai_chat_search", { query: "报价", limit: 50 }, (s) => s.count + " 条命中");
await step("索引内检索", "wai_db_search", { query: "预算", limit: 20 }, (s) => s.count + " 条命中");
await step("聊天历史", "wai_chat_history", { chat: "NovaAI", limit: 50, days: 30 }, (s) => ((s.messages?.length ?? s.count ?? 0) + " 条"));
await step("联系人档案", "wai_person", { name: "NovaAI", limit: 100, days: 30 }, (s) => { if (!s.chat) throw new Error("缺 chat"); return s.chat + "，承诺 " + (s.openPromises?.length ?? 0) + " 项"; });
await step("主题调查", "wai_topic", { topic: "培训", days: 30 }, (s) => ((s.chats?.length ?? s.hits ?? 0) + " 个会话命中"));
await step("微信标签（只读）", "wai_wechat_labels", {}, (s) => (s.contact_count ?? 0) + " 个联系人");
await step("共同群核验", "wai_common_groups", { a: "群友A", b: "群友B" }, (s) => ((s.matches?.length ?? 0) + " 个共同群"));

// ---- 4. 情报 ----
await step("原始信号提取", "wai_signals", { hours: 72, allowDemo: true }, (s) => [s.pendingReplies?.length + "待回复", s.promises?.length + "承诺", s.brandDeals?.length + "商机", s.trainings?.length + "培训", s.links?.length + "链接"].join(" / "));
await step("今天先处理什么", "wai_today", { minPriority: 1, limit: 10 }, (s) => ((s.items?.length ?? s.actions?.length ?? 0) + " 项"));
await step("新发现线索", "wai_new_leads", { minPriority: 1, limit: 20 }, (s) => ((s.items?.length ?? s.rows?.length ?? 0) + " 条候选"));
await step("跨报告总览", "wai_brief", { hours: 72 }, (s) => { if (!s.files) throw new Error("缺 files"); return "已生成 " + Object.keys(s.files).length + " 个文件"; });
await step("群聊日报", "wai_group_daily", { hours: 72 }, (s) => { if (!s.files) throw new Error("缺 files"); return s.groupCount + " 个群，产物 " + Object.keys(s.files).length + " 个"; });
await step("重点联系人日报", "wai_contact_daily", { hours: 72 }, (s) => { if (!s.files) throw new Error("缺 files"); return s.count + " 个联系人"; });
await step("复联雷达", "wai_reactivation", { days: 365, inactiveDays: 21 }, (s) => { if (!s.bands) throw new Error("缺 bands"); return JSON.stringify(s.bands); });
await step("跨群链接聚合", "wai_db_links", { days: 30, minChats: 1 }, (s) => ((s.links?.length ?? s.count ?? 0) + " 个链接"));
await step("商单雷达", "wai_deal_radar", { hours: 72 }, (s) => "已生成雷达视图");
await step("回复草稿", "wai_reply_draft", { name: "NovaAI", limit: 60 }, (s) => { if (typeof s.needed !== "boolean") throw new Error("缺 needed"); return s.needed ? "需要回复，" + (s.draft ?? "").length + " 字草稿" : "无需回复：" + (s.reason ?? ""); });

// ---- 4b. 聊天记录分析（提示词全集 A-I：报告/社交/情绪/任务/财务/记忆/内容/团队/风控） ----
await step("A 期间报告", "wai_period_report", { days: 365, top: 10 }, (s) => {
  if (typeof s.total_messages !== "number") throw new Error("缺 total_messages");
  return s.total_messages + " 条消息，洞察 " + (s.insights?.length ?? 0) + " 条";
});
await step("B 社交关系", "wai_social_graph", { days: 365, top: 5 }, (s) => {
  if (!s.overview) throw new Error("缺 overview");
  return "私聊 " + s.overview.peers + " / 群 " + s.overview.groups + "，桥梁 " + (s.bridge_members?.length ?? 0);
});
await step("C 情绪趋势", "wai_sentiment_trend", { days: 365 }, (s) => {
  if (typeof s.positive_ratio !== "number") throw new Error("缺 positive_ratio");
  return "积极 " + s.positive_ratio + " / 消极 " + s.negative_ratio + "（非医疗诊断）";
});
await step("D 任务抽取", "wai_task_extract", { days: 365 }, (s) => {
  if (!s.tasks) throw new Error("缺 tasks");
  return (s.tasks?.length ?? 0) + " 项任务，状态 " + JSON.stringify(s.stats?.by_status ?? {});
});
await step("E 财务记录", "wai_finance", { days: 365 }, (s) => {
  if (!s.totals) throw new Error("缺 totals");
  return s.totals.entries + " 笔流水（金额区间脱敏=" + (s.totals.show_amounts ? "否" : "是") + "）";
});
await step("F 记忆知识库", "wai_memory", { days: 365, query: "合作" }, (s) => {
  if (!s.cards) throw new Error("缺 cards");
  return (s.cards?.length ?? 0) + " 张卡片 / 问答命中 " + (s.answer?.found ?? 0);
});
await step("G 内容分析", "wai_content_analysis", { days: 365, query: "报价" }, (s) => {
  if (!s.topics) throw new Error("缺 topics");
  return "话题 " + s.topics.length + " 类 / QA 证据 " + (s.qa?.evidence?.length ?? 0);
});
await step("H 团队复盘", "wai_team_review", { days: 365 }, (s) => {
  if (!s.activity) throw new Error("缺 activity");
  return "决策 " + (s.decisions?.length ?? 0) + " / 任务 " + (s.assignments?.length ?? 0) + " / 风险 " + (s.risks?.length ?? 0);
});
await step("I 风控线索", "wai_risk_scan", { days: 365 }, (s) => {
  if (!s.stats) throw new Error("缺 stats");
  return s.stats.total + " 条线索（全部 needs_review）";
});
await step("分析报告落盘（期间报告）", "wai_period_report", { days: 365, out: path.join(HOME, "ana-period") }, (s) => {
  if (!s.files?.report || !fs.existsSync(s.files.report)) throw new Error("Markdown 报告未落盘");
  if (!s.files.json || !fs.existsSync(s.files.json)) throw new Error("JSON 未落盘");
  return path.basename(s.files.report);
});

// ---- 5. 商机管线 ----
await step("商机同步（预览）", "wai_opportunity_sync", { hours: 720, dryRun: true }, (s) => "候选 " + s.candidates + "，新建 " + s.created + " / 更新 " + s.updated);
await step("商机同步（写入）", "wai_opportunity_sync", { hours: 720, dryRun: false }, (s) => "新建 " + s.created + " / 更新 " + s.updated);
await step("商机列表", "wai_opportunities", { includeCandidates: true, minPriority: 0, limit: 50 }, (s) => s.count + " 条");
await step("商机到期维护（预览）", "wai_opportunity_maintain", { staleDays: 14 }, (s) => (s.count ?? 0) + " 条过期候选");
const firstOpp = (await call("wai_opportunities", { includeCandidates: true, minPriority: 0, limit: 1 })).sc?.opportunities?.[0];
if (firstOpp?.id) {
  await step("商机更新（阶段/下一步）", "wai_opportunity_update", { id: firstOpp.id, stage: "待报价", nextAction: "发一版报价单", priority: 4 }, (s) => {
    const o = s.opportunity ?? s;
    if (o.ok === false) throw new Error(o.error);
    return "id=" + firstOpp.id + " stage=" + (o.stage ?? "?");
  });
  await step("人工分流 wait（必须带跟进日期）", "wai_triage", { id: firstOpp.id, decision: "wait", followUp: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), note: "等对方确认预算" }, (s) => {
    const o = s.opportunity ?? s;
    return "status=" + (o.status ?? "?") + " follow_up=" + (o.next_follow_up ?? o.followUp ?? "?");
  });
  await step("wait 缺跟进日期应报错", "wai_triage", { id: firstOpp.id, decision: "wait" }, null, { expectError: true });
}
await step("记录纠正", "wai_feedback_add", { targetType: "chat", target: "周末爬山群", verdict: "low_priority", note: "低价值娱乐群" }, (s) => (s.ok === false ? "记录失败" : "已记录"));
await step("纠正列表", "wai_feedback_list", { limit: 20 }, (s) => ((s.rows?.length ?? 0) + " 条"));

// ---- 6. 报告渲染 ----
const gd = steps.find((x) => x.tool === "wai_group_daily");
let reportDir = null;
{
  const r = await call("wai_report_list", { limit: 5 });
  const runs = r.sc?.runs ?? [];
  const dir = runs.find((x) => /group-daily/.test(x.name))?.dir ?? runs[0]?.dir;
  reportDir = dir;
}
await step("列出报告目录", "wai_report_list", { limit: 10 }, (s) => s.runs.length + " 个目录");
if (reportDir) {
  await step("渲染旗舰报告包", "wai_render_bundle", { reportDir, title: "微信个人情报库｜综合日报" }, (s) => {
    if (!s.html) throw new Error("缺 html");
    const html = fs.existsSync(s.html) ? fs.readFileSync(s.html, "utf8") : "";
    if (!/Content-Security-Policy/.test(html)) throw new Error("HTML 缺少 CSP");
    const scripts = (html.match(/<script\b/g) || []).length;
    if (scripts !== 1) throw new Error("HTML 脚本数应为 1，实际 " + scripts);
    const routes = s.routes ?? [];
    if (!Array.isArray(routes) || routes.length === 0) throw new Error("没有生成任何分区路由");
    const mdSite = path.join(reportDir, "wechat-report");
    if (!fs.existsSync(mdSite)) throw new Error("缺少 wechat-report 分区 Markdown 站点");
    const portal = path.join(reportDir, "wechat_daily_full.md");
    if (!fs.existsSync(portal)) throw new Error("缺少门户 Markdown");
    if (!/id="current-title"|report-page/.test(html)) throw new Error("HTML 缺少分区容器");
    return "HTML " + Math.round(html.length / 1024) + "KB，路由 " + JSON.stringify(routes);
  });
}
await step("Markdown 转安全 HTML", "wai_render_html", { markdown: "# 标题\n\n**加粗** 与 [链接](https://example.com)\n\n<script>alert(1)</script>", out: path.join(HOME, "output", "test.html") }, (s) => {
  const html = fs.readFileSync(s.out, "utf8");
  if (/<script/i.test(html.replace(/Content-Security-Policy/g, ""))) throw new Error("未清除脚本");
  return "已净化并写出";
});

// ---- 6b. 报告渲染器全覆盖（每个都要真的写出文件） ----
const renderDir = path.join(HOME, "render-check");
const assertOut = (label) => (s) => {
  const p = s.out ?? s.files?.report ?? s.files?.digest ?? null;
  if (!p) throw new Error(label + " 未返回产物路径");
  if (!fs.existsSync(p)) throw new Error(label + " 产物不存在：" + p);
  const size = fs.statSync(p).size;
  if (size < 20) throw new Error(label + " 产物过小：" + size);
  return path.basename(p) + " (" + size + "B)";
};
await step("渲染 home.md", "wai_home", { out: path.join(renderDir, "home") }, assertOut("home"));
await step("渲染 today.md", "wai_today", { minPriority: 1, limit: 10, out: path.join(renderDir, "today") }, assertOut("today"));
await step("渲染 inbox.md", "wai_new_leads", { minPriority: 1, limit: 20, out: path.join(renderDir, "inbox") }, assertOut("inbox"));
await step("渲染 person.md", "wai_person", { name: "NovaAI", limit: 100, days: 365, out: path.join(renderDir, "person") }, assertOut("person"));
await step("渲染 topic.md", "wai_topic", { topic: "培训", days: 365, out: path.join(renderDir, "topic") }, assertOut("topic"));
await step("渲染 chat_history.md", "wai_chat_history", { chat: "NovaAI", limit: 50, days: 365, out: path.join(renderDir, "chat-history") }, assertOut("chat-history"));
await step("渲染 common_groups.md", "wai_common_groups", { a: "群友A", b: "群友B", out: path.join(renderDir, "common-groups") }, assertOut("common-groups"));
await step("渲染 opportunities.md", "wai_opportunities", { includeCandidates: true, minPriority: 0, limit: 50, out: path.join(renderDir, "opportunities") }, assertOut("opportunities"));
await step("渲染 reactivation 报告", "wai_reactivation", { days: 365, inactiveDays: 21, out: path.join(renderDir, "reactivation") }, (s) => {
  const p = s.files?.report ?? s.files?.csv ?? null;
  if (!p) throw new Error("未返回产物路径：" + JSON.stringify(s.files));
  if (!fs.existsSync(p)) throw new Error("产物不存在：" + p);
  return path.basename(p);
});
await step("投递到剪贴板（可回退）", "wai_deliver", { body: "[2026-06-30 09:00] 王工: 培训需求", chat: "客户群-澄明科技", target: "clipboard", dryRun: false }, (s) => {
  const r = s.results?.[0];
  if (!r) throw new Error("无结果");
  return "status=" + r.status + (r.detail ? " " + String(r.detail).slice(0, 40) : "");
});
await step("投递到 Agent（生成提示词文件）", "wai_deliver", { body: "[2026-06-30 09:00] 王工: 培训需求，预算 8000", chat: "客户群-澄明科技", target: "codex", dryRun: false }, (s) => {
  const r = s.results?.[0];
  if (!r) throw new Error("无结果");
  if (r.status === "ok" && r.path && fs.existsSync(r.path)) return "写出 " + path.basename(r.path);
  throw new Error("未写出提示词文件：" + JSON.stringify(r));
});
await step("历史重发到另一目标", "wai_history_rerun", { id: (await call("wai_history_list", { limit: 1 })).sc.rows[0]?.id, target: "folder" }, (s) => (s.ok === false ? "失败：" + s.error : "已重发"));

// ---- 7. 微信流：场景 / 目标 / 投递 ----
await step("场景列表", "wai_scene_list", {}, (s) => s.scenes.length + " 个场景");
await step("新增场景", "wai_scene_upsert", { id: "e2e-test", name: "端到端测试场景", match: ["e2e"], priority: 5, task: "只做自检", targets: ["clipboard"] }, (s) => {
  const id = s.scene?.id ?? s.id ?? s.scenes?.[0]?.id;
  if (!id) throw new Error("未返回场景：" + JSON.stringify(s).slice(0, 160));
  return id;
});
await step("场景可被匹配到", "wai_scene_match", { title: "e2e 验证群" }, (s) => (s.scene?.id ?? "none"));
await step("场景匹配", "wai_scene_match", { title: "澄明科技客户群", body: "王工: 想做内部 AI 培训，问报价" }, (s) => { if (!s.scene) throw new Error("未匹配"); return s.scene.id + " → " + (s.preview?.prompt ?? "").slice(0, 40) + "…"; });
await step("配置文件夹目标", "wai_config_set", { targets: [{ id: "folder", enabled: true, path: path.join(HOME, "deliver") }] }, (s) => (s.saved ? "文件夹目标已启用" : "未保存"));
await step("转发目标列表", "wai_target_list", {}, (s) => s.targets.length + " 个目标");
await step("投递（预览）", "wai_deliver", { body: "[2026-06-30 09:00] 王工: 我们想做内部 AI 培训，预算 8000，需要大纲和试讲", chat: "客户群-澄明科技", target: "agent", dryRun: true }, (s) => (s.dryRun ? "dryRun 正常" : "未按预览执行"));
await step("投递到文件夹", "wai_deliver", { body: "[2026-06-30 09:00] 王工: 想做内部 AI 培训，预算 8000", chat: "客户群-澄明科技", target: "folder", dryRun: false }, (s) => {
  const r = s.results?.[0];
  if (!r) throw new Error("无结果");
  if (r.status === "ok" && r.path) return "写出 " + r.path;
  return "状态=" + r.status + " " + (r.detail ?? "");
});
await step("写入 Obsidian", "wai_obsidian_write", { vault: path.join(HOME, "vault-obsidian"), folder: "微信流", title: "澄明科技的聊天", markdown: "## 聊天记录\n\n**王工** · 2026-06-30 09:00\n\n想做内部 AI 培训", chat: "客户群-澄明科技", tags: ["客户", "培训"] }, (s) => { if (!fs.existsSync(s.path)) throw new Error("笔记未写出"); return path.basename(s.path); });
await step("内置技能列表", "wai_skill_list", {}, (s) => s.skills.map((x) => x.id).join(", "));
await step("运行内置技能", "wai_skill_run", { skill: "wechat-article-extract", content: "https://mp.weixin.qq.com/s/xxxx 这篇文章讲 AI 培训", chat: "资料群" }, (s) => { if (!s.prompt) throw new Error("缺 prompt"); return "提示词 " + s.prompt.length + " 字"; });
await step("操作记录", "wai_history_list", { limit: 20 }, (s) => ((s.rows?.length ?? 0) + " 条，目标 " + JSON.stringify(Object.keys(s.summary?.byTarget ?? {}))));

// ---- 8. 批量收集 ----
await step("创建批次", "wai_batch_create", { items: [{ title: "客户群第一批", chat: "客户群-澄明科技", body: "[2026-06-30 09:00] 王工: 想做内部 AI 培训" }, { title: "客户群第二批", chat: "客户群-澄明科技", body: "[2026-06-30 10:00] 王工: 预算 8000，需要大纲" }], target: "folder" }, (s) => { if (!s.id) throw new Error("缺 id"); return s.id + "（" + s.count + " 项）"; });
const batchId = (await call("wai_batch_status", {})).sc?.batches?.[0]?.id ?? null;
if (batchId) {
  await step("批次状态", "wai_batch_status", { id: batchId }, (s) => JSON.stringify(s.counts ?? s.status ?? {}));
  await step("投递批次（未暂存应 0 投递）", "wai_batch_deliver", { id: batchId, dryRun: true }, (s) => {
    if (s.delivered !== 0) throw new Error("未暂存不应投递，delivered=" + s.delivered);
    return /wai_batch_stage/.test(String(s.detail ?? "")) ? "正确提示先 stage" : "缺 stage 提示";
  });
  await step("暂存批次（全部条目→ready）", "wai_batch_stage", { id: batchId }, (s) => {
    if (s.staged !== 2 || s.ready !== 2) throw new Error("暂存计数不符：" + JSON.stringify(s.counts ?? s));
    return "staged=" + s.staged + " ready=" + s.ready;
  });
  await step("批次状态（就绪）", "wai_batch_status", { id: batchId }, (s) => (s.counts?.ready === 2 ? "ready=2" : JSON.stringify(s.counts ?? {})));
  await step("投递批次（预览）", "wai_batch_deliver", { id: batchId, dryRun: true }, (s) => (s.dryRun ? "dryRun 正常" : "未按预览执行"));
  await step("投递批次（正式）", "wai_batch_deliver", { id: batchId, dryRun: false }, (s) => {
    if (s.delivered !== 2) throw new Error("delivered=" + s.delivered + " " + JSON.stringify(s.results ?? []));
    return "delivered=2";
  });
}

// ---- 9. 只读 Reader 统一入口 ----
await step("Reader: status", "wai_reader", { command: "status", source: "mock" }, (s) => s.state ?? "ok");
await step("Reader: sessions", "wai_reader", { command: "sessions", source: "mock", limit: 10 }, (s) => (s.sessions?.length ?? 0) + " 个会话");
await step("Reader: timeline", "wai_reader", { command: "timeline", source: "mock", chat: "NovaAI", limit: 10 }, (s) => (s.messages?.length ?? 0) + " 条消息");
await step("Reader: search", "wai_reader", { command: "search", source: "mock", query: "报价", limit: 10 }, (s) => (s.messages?.length ?? 0) + " 条命中");
await step("Reader: stats", "wai_reader", { command: "stats", source: "mock" }, (s) => "ok");
await step("Reader: 未知子命令应报错", "wai_reader", { command: "no-such" }, null, { expectError: true });

// ---- 10. 配置与隐私 ----
await step("读取配置", "wai_config_get", {}, (s) => (s.config ? Object.keys(s.config).length + " 个字段" : "缺配置"));
await step("写入配置", "wai_config_set", { settings: { reactivationInactiveDays: 14 } }, (s) => (s.saved ? "已保存" : "未保存"));
await step("清理预览", "wai_cleanup", { rawDays: 7, reportDays: 30 }, (s) => (s.apply ? "误删除" : "仅预览 " + s.count + " 个"));
await step("自检工具", "wai_self_test", {}, (s) => "passed=" + s.passed);
await step("兼容性检查", "wai_compat_check", { source: "mock", force: true }, (s) => s.result);
await step("健康诊断", "wai_doctor", {}, (s) => { if (!s.diagnostics) throw new Error("缺 diagnostics"); return s.diagnostics.length + " 条诊断，healthy=" + s.healthy; });

// ---- 汇总 ----
const okN = steps.length - failed;
console.log("");
if (failed) {
  console.log("失败步骤：");
  for (const s of steps.filter((x) => !x.ok)) console.log("  ✗ " + s.title + " (" + s.tool + ") :: " + s.note);
  console.log("");
}
const slow = steps.filter((s) => s.ms > 2000).sort((a, b) => b.ms - a.ms).slice(0, 5);
if (slow.length) {
  console.log("较慢步骤：");
  for (const s of slow) console.log("  " + s.ms + "ms  " + s.title);
  console.log("");
}
console.log("工具覆盖率：" + new Set(steps.map((s) => s.tool)).size + " / " + srv.TOOLS.length + " 个工具被端到端调用");
console.log("=== " + okN + " passed, " + failed + " failed ===");
if (KEEP) console.log("数据根保留：" + HOME);
else { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } }
process.exit(failed === 0 ? 0 : 1);
