// 分析引擎断言：A-I 九个模块的口径、脱敏与工具接线。
// 覆盖：消息归类 / n-gram 词频 / 时间桶与回复间隔 / 期间报告 / 社交关系 / 情绪趋势 /
//       任务抽取与 ICS / 财务流水与金额脱敏 / 记忆卡片与问答 / 内容分析实体与 QA /
//       团队决策与风险 / 风控线索与 PII 打码 / 渲染落盘 / MCP 工具接线。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "analytics-test-"));
process.env.WECHAT_AI_HOME = ROOT;

let passed = 0, failed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (e) { failed += 1; fails.push(name + " :: " + (e?.message ?? e)); console.log("  ✗ " + name + " :: " + (e?.message ?? e)); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ?? "不相等") + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m ?? "断言失败"); };

const core = await import(new URL("../lib/analytics/core.mjs", import.meta.url).href);
const report = await import(new URL("../lib/analytics/report.mjs", import.meta.url).href);
const social = await import(new URL("../lib/analytics/social.mjs", import.meta.url).href);
const sentiment = await import(new URL("../lib/analytics/sentiment.mjs", import.meta.url).href);
const tasks = await import(new URL("../lib/analytics/tasks.mjs", import.meta.url).href);
const finance = await import(new URL("../lib/analytics/finance.mjs", import.meta.url).href);
const memory = await import(new URL("../lib/analytics/memory.mjs", import.meta.url).href);
const content = await import(new URL("../lib/analytics/content.mjs", import.meta.url).href);
const signals = await import(new URL("../lib/signals.mjs", import.meta.url).href);
const team = await import(new URL("../lib/analytics/team.mjs", import.meta.url).href);
const risk = await import(new URL("../lib/analytics/risk.mjs", import.meta.url).href);
const render = await import(new URL("../lib/analytics/render.mjs", import.meta.url).href);

const now = Date.now();
const H = 3600000;
let seq = 0;
const msg = (chat, sender, hoursAgo, contentText, isOwner = false, extra = {}) => ({
  id: `m${++seq}`,
  session_name: chat,
  session_kind: extra.kind ?? (/群/.test(chat) ? "group" : "private"),
  sender,
  is_owner: isOwner,
  ts: now - hoursAgo * H,
  day: new Date(now - hoursAgo * H).toISOString().slice(0, 10),
  content: contentText,
  links: extra.links ?? [],
  attachments: extra.attachments ?? [],
});

// =====================================================================================
console.log("1) core：消息归类 / 分词 / 时间桶 / 回复间隔 / 脱敏");

await t("消息类型归类覆盖 8 类", async () => {
  eq(core.classifyMessage(msg("A", "甲", 1, "普通文本")), "text");
  eq(core.classifyMessage(msg("A", "甲", 1, "看这张", false, { attachments: [{ kind: "image", marker: "[图片]" }] })), "image");
  eq(core.classifyMessage(msg("A", "甲", 1, "[语音]")), "voice");
  eq(core.classifyMessage(msg("A", "甲", 1, "方案.pdf 在这里")), "file");
  eq(core.classifyMessage(msg("A", "甲", 1, "给你转了 100 元")), "transfer");
  eq(core.classifyMessage(msg("A", "甲", 1, "发个红包庆祝")), "redpacket");
  eq(core.classifyMessage(msg("A", "甲", 1, "看这个 https://example.com/x", false, { links: ["https://example.com/x"] })), "link");
  eq(core.classifyMessage(msg("A", "甲", 1, "共享实时位置")), "location");
});

await t("typeBreakdown 给 counts + ratio", async () => {
  const r = core.typeBreakdown([msg("A", "甲", 1, "你好"), msg("A", "甲", 2, "发红包")]);
  eq(r.total, 2);
  eq(r.counts.text, 1);
  eq(r.counts.redpacket, 1);
  eq(r.ratio.text, 50);
});

await t("n-gram 词频：高频词出现且停用词不霸榜", async () => {
  const msgs = [];
  for (let i = 0; i < 6; i += 1) msgs.push(msg("群A", "甲", i, "项目报价需要确认一下项目报价"));
  const terms = core.termFreq(msgs, { limit: 5, minCount: 2 });
  ok(terms.length > 0, "应有词频结果");
  ok(terms.some((x) => x.term.includes("报价") || x.term.includes("项目")), "应命中 报价/项目：" + JSON.stringify(terms));
  ok(!terms.some((x) => x.term === "的了" || x.term === "一下"), "停用词不应上榜：" + JSON.stringify(terms));
});

await t("termFreq 长词优先：覆盖比例边界与嵌套链（轮13 语义锁）", async () => {
  // 甲乙(4) 被 甲乙丙(3) 覆盖：3 >= 4×0.75 恰在边界 → 删；甲乙丙(3) 被 甲乙丙丁(3) 嵌套覆盖 → 删；
  // 丁甲乙(3) 只被 丙丁甲乙(3) 异位覆盖 → 同样删；四个 4 字词无更长覆盖 → 全留。
  const terms = core.termFreq([msg("群A", "甲", 1, "甲乙丙丁甲乙丙丁甲乙丙丁甲乙")], { minCount: 2, limit: 30 });
  eq(terms.map((x) => x.term).sort(), ["丁甲乙丙", "丙丁甲乙", "乙丙丁甲", "甲乙丙丁"]);
  ok(terms.every((x) => x.count >= 2), "计数应保留：" + JSON.stringify(terms));
});

await t("termFreq：被 minCount 裁掉的长词不参与覆盖", async () => {
  const terms = core.termFreq([msg("群A", "甲", 1, "甲乙丙甲乙甲乙")], { minCount: 2, limit: 30 });
  eq(terms.map((x) => x.term), ["甲乙"]);
  eq(terms[0].count, 3);
});

await t("口头禅：重复短句被识别", async () => {
  const msgs = ["好的", "好的", "好的", "收到，明天发你"].map((c, i) => msg("A", "乙", i, c));
  const cps = core.catchphrases(msgs, { minCount: 3 });
  eq(cps[0].text, "好的");
  eq(cps[0].count, 3);
});

await t("时间桶 + 连续天数 + 回复间隔", async () => {
  const msgs = [
    msg("A", "甲", 1, "在吗"), msg("A", "我", 0.5, "在的", true),
    msg("A", "甲", 25, "昨天的事"), msg("A", "我", 24, "收到", true),
    msg("A", "甲", 49, "前天"),
  ];
  const hours = core.hourBuckets(msgs);
  eq(hours.reduce((a, b) => a + b.count, 0), 5);
  const streak = core.activityStreaks(msgs);
  ok(streak.longest_streak_days >= 3, "三天都有消息，连续天数应 >=3：" + streak.longest_streak_days);
  const rep = core.replyIntervals(msgs);
  ok(rep.mine.count >= 2, "我方回复样本 >=2");
  ok(rep.mine.median_minutes != null, "应有中位回复间隔");
});

await t("maskPii：手机号/身份证/卡号/验证码打码", async () => {
  const s = core.maskPii("手机 13812345678 证件 110101199001011234 卡 6222021234561234 验证码 667788 密码 abcdefgh");
  ok(!s.includes("13812345678"), "手机号未脱敏：" + s);
  ok(!s.includes("199001011234"), "身份证未脱敏：" + s);
  ok(!s.includes("6222021234561234"), "卡号未脱敏：" + s);
  ok(!s.includes("667788"), "验证码未脱敏：" + s);
  ok(!s.includes("abcdefgh"), "密码未脱敏：" + s);
});

// =====================================================================================
console.log("2) A 期间报告");

await t("期间报告：统计/排行/洞察齐全", async () => {
  const msgs = [];
  for (let i = 0; i < 40; i += 1) msgs.push(msg("客户群-测试", i % 2 ? "张三" : "我", i, i % 2 ? "项目报价需要确认" : "好的，明天给方案", i % 2 === 0));
  for (let i = 0; i < 10; i += 1) msgs.push(msg("李四", "李四", i, "在吗，帮忙看下", false));
  const r = report.periodReport(msgs, { sinceMs: now - 100 * H, untilMs: now });
  eq(r.total_messages, 50);
  eq(r.self_messages, 20);
  eq(r.received_messages, 30);
  ok(r.top_groups.length >= 1 && r.top_groups[0].name === "客户群-测试", "群排行：" + JSON.stringify(r.top_groups.slice(0, 2)));
  ok(r.top_contacts[0].name === "李四", "联系人排行");
  ok(r.insights.length >= 5 && r.insights.length <= 10, "洞察 5-10 条，实际 " + r.insights.length);
  ok(r.insights.every((i) => i.confidence), "洞察应带置信度");
  ok(Array.isArray(r.active_hours) && r.active_hours.length === 24, "24 小时桶");
  ok(r.caliber, "应说明统计口径");
});

await t("样本不足要标注", async () => {
  const r = report.periodReport([msg("A", "甲", 1, "hi")], { sinceMs: now - H, untilMs: now });
  eq(r.period.sample_note, "样本不足");
});

// =====================================================================================
console.log("3) B 社交关系");

await t("社交关系：主动发起 / 双向性 / 群核心 / 桥梁", async () => {
  const msgs = [];
  // 王五：总是主动找我（5 段对话，每段间隔 5 小时）
  for (let i = 0; i < 5; i += 1) msgs.push(msg("王五", "王五", i * 5, "在吗，有个事"));
  // 赵六：我总主动（4 段）
  for (let i = 0; i < 4; i += 1) msgs.push(msg("赵六", "我", i * 6 + 1, "在吗", true));
  // 群：钱七跨两个群活跃
  for (let i = 0; i < 6; i += 1) msgs.push(msg("群A", "钱七", i, "同步一下进展"));
  for (let i = 0; i < 6; i += 1) msgs.push(msg("群B", "钱七", i, "这边也同步"));
  for (let i = 0; i < 3; i += 1) msgs.push(msg("群B", "路人甲", i, "收到"));
  const r = social.socialGraph(msgs, { sinceMs: now - 200 * H, untilMs: now });
  ok(r.who_contacts_me_most[0]?.name === "王五", "对方主动最多应是王五：" + JSON.stringify(r.who_contacts_me_most.slice(0, 2)));
  ok(r.who_i_contact_most[0]?.name === "赵六", "我主动最多应是赵六");
  ok(r.bridge_members.some((b) => b.sender === "钱七" && b.group_count >= 2), "钱七应是跨群桥梁：" + JSON.stringify(r.bridge_members));
  const gb = r.group_network.find((g) => g.group === "群B");
  ok(gb.core_members.some((c) => c.sender === "钱七"), "群B 核心成员应含钱七");
  ok(r.bidirectional.length >= 2, "应有私聊双向性");
  ok(r.caliber, "应说明口径");
});

// =====================================================================================
console.log("4) C 情绪趋势");

await t("情绪趋势：正负比例 / 否定翻转 / 压力源 / 风险时段", async () => {
  const day = new Date().toISOString().slice(0, 10);
  const msgs = [
    msg("A", "甲", 1, "今天很开心，项目顺利"),
    msg("A", "我", 2, "太棒了，恭喜", true),
    msg("A", "甲", 3, "烦死了，加班到十点，压力好大"),
    msg("A", "甲", 4, "不开心，真的不开心"),
    msg("A", "甲", 5, "焦虑，明天还要考试"),
    msg("A", "甲", 6, "好累，想哭"),
    msg("A", "我", 7, "别担心，加油", true),
  ];
  const r = sentiment.sentimentTrend(msgs, { sinceMs: now - 10 * H, untilMs: now });
  ok(r.messages_scored === 7, "评分消息数：" + r.messages_scored);
  ok(r.positive_ratio > 0, "应有正向");
  ok(r.negative_ratio > 0, "应有负向");
  const negRow = r.daily_sentiment[0];
  ok(negRow.negative >= 3, "当日负面应 >=3：" + JSON.stringify(negRow));
  ok(r.stress_topics.some((s) => s.topic === "工作" || s.topic === "学业" || s.topic === "健康"), "压力源应命中：" + JSON.stringify(r.stress_topics.map((s) => s.topic)));
  ok(r.high_risk_periods.length >= 1, "应有需关注时段");
  ok(r.conflict_words.length >= 0 && r.comfort_words.length >= 1, "安慰词应命中");
  ok(/不是心理或医疗诊断/.test(r.limitations), "必须声明非医疗诊断");
});

await t("否定翻转：「不开心」计为负面", async () => {
  const s = sentiment.scoreOf("不开心");
  ok(s.score < 0, "否定应翻转，实际 " + s.score);
});

await t("sentiment 共享正则的状态无关 + 金值语义锁（轮16）", async () => {
  // 金值由实现独立推导（%TEMP%/wai-anal-gold16.mjs）；/g 共享正则不得有跨调用状态。
  eq(sentiment.scoreOf("不开心"), { score: -1, conflict: [], comfort: [] });
  eq(sentiment.scoreOf("超开心"), { score: 1.4, conflict: [], comfort: [] });
  eq(sentiment.scoreOf("开心开心开心开心开心开心开心"), { score: 1.5, conflict: [], comfort: [] }); // clamp ±1.5
  eq(sentiment.scoreOf("不难过"), { score: 1, conflict: [], comfort: [] }); // 否定翻转压过负向词
  eq(sentiment.scoreOf("吵架 吵架 投诉 投诉 骗子 拉黑 绝交 对骂").conflict, ["吵", "吵", "投诉", "投诉", "骗子"]); // 前 5 截断
  eq(sentiment.scoreOf("抱抱 辛苦了 加油 放心 没关系 会好的 理解你").comfort, ["抱抱", "辛苦了", "加油", "放心", "没关系"]);
  // 状态无关：A/B/A 交错 50 轮后输出逐位不变（共享 /g 不得累积 lastIndex）
  const A = "开心开心开心", B = "吵架 投诉 骗子 拉黑";
  const first = [JSON.stringify(sentiment.scoreOf(A)), JSON.stringify(sentiment.scoreOf(B))];
  for (let i = 0; i < 50; i++) { sentiment.scoreOf(B); sentiment.scoreOf(A); }
  eq([JSON.stringify(sentiment.scoreOf(A)), JSON.stringify(sentiment.scoreOf(B))], first, "交错调用后输出应不变");
  // STRESS 首命中 break + 聚合计数金值
  const list = [
    { id: "a", ts: 1700000000000, content: "加班 缺钱" },
    { id: "b", ts: 1700000001000, content: "缺钱 失眠" },
    { id: "c", ts: 1700000002000, content: "难过 不开心" },
  ];
  const r = sentiment.sentimentTrend(list, { now: new Date(1700000000000) });
  eq(r.stress_topics.map((x) => [x.topic, x.hits]), [["工作", 1], ["金钱", 1]]); // 加班+缺钱 只记 工作
  eq(r.messages_scored, 3);
  eq(r.negative_ratio, 0.6667);
  eq(r.avg_score, -0.833);
  eq(sentiment.sentimentTrend(list, { now: new Date(1700000000000) }), r, "整链重复调用应深等价（entries 提升后循环无状态）");
});

// =====================================================================================
console.log("5) D 任务与日程");

await t("任务抽取：类型 / 截止 / 状态 / 方向 / ICS", async () => {
  const msgs = [
    msg("项目群-测试", "我", 2, "明天下午三点开会评审初稿", true),
    msg("项目群-测试", "甲", 26, "记得周五前把合同发我"),
    msg("项目群-测试", "我", 27, "好的，我来整理", true),
    msg("项目群-测试", "我", 28, "合同已经发你了", true),
    msg("项目群-测试", "乙", 30, "上周说的材料还没给"),
  ];
  const r = tasks.taskExtract(msgs, { now: new Date(now) });
  ok(r.tasks.length >= 2, "应抽到 >=2 项任务，实际 " + r.tasks.length);
  const meeting = r.tasks.find((x) => x.kind === "会议");
  ok(meeting, "应识别会议：" + JSON.stringify(r.tasks.map((x) => x.kind)));
  ok(meeting.due, "会议应有日期");
  ok(r.tasks.some((x) => x.direction === "我答应别人"), "应区分我答应");
  ok(r.tasks.some((x) => x.direction === "别人答应我"), "应区分别人答应");
  ok(r.ics.includes("BEGIN:VCALENDAR") && r.ics.includes("DTSTART"), "ICS 结构");
  ok(r.caliber, "应说明口径");
});

await t("已完成状态由后续完成词判定", async () => {
  const msgs = [
    msg("A", "我", 5, "明天记得发周报", true),
    msg("A", "我", 4, "周报已经发你了", true),
  ];
  const r = tasks.taskExtract(msgs, { now: new Date(now) });
  ok(r.tasks.length >= 1, "应有任务");
  eq(r.tasks[0].status, "已完成", JSON.stringify(r.tasks));
});

// =====================================================================================
console.log("6) E 财务记录");

await t("财务：金额解析 / 方向 / 月度 / 默认脱敏", async () => {
  const msgs = [
    msg("王五", "我", 2, "给你转了 1500 元尾款", true),
    msg("王五", "王五", 3, "收到，感谢"),
    msg("群A", "李四", 26, "发个红包 200 元庆祝"),
    msg("王五", "我", 50, "收到你 800 元还款", true),
    msg("王五", "王五", 51, "还有 3000 元没还，欠着"),
    msg("购物群", "我", 70, "买了 320 元的书", true),
  ];
  const r = finance.financeLedger(msgs, { now: new Date(now) });
  ok(r.entries.length >= 4, "流水条数：" + r.entries.length);
  ok(r.entries.every((e) => e.amount === undefined), "默认不应给精确金额");
  ok(r.entries.every((e) => e.amount_band), "默认应给金额区间");
  ok(r.entries.some((e) => e.type === "红包"), "红包类型");
  ok(r.entries.some((e) => e.direction === "我付" && e.amount_band), "我付方向");
  ok(r.entries.some((e) => e.direction === "我收"), "我收方向");
  ok(r.monthly.length >= 1, "月度统计");
  ok(r.categories.some((c) => c.category === "购物" || c.category === "其他"), "类别统计");
  ok(r.suspicious.length >= 1, "应有未还/大额线索");
  ok(/不提供任何投资/.test(r.caliber), "必须声明不提供投资建议");
});

await t("showAmounts=true 才给精确金额；金额解析正确", async () => {
  eq(finance.parseAmounts("3000 元")[0].value, 3000);
  eq(finance.parseAmounts("1.5万")[0].value, 15000);
  eq(finance.parseAmounts("一万元")[0].value, 10000);
  eq(finance.parseAmounts("650 USD")[0].currency, "USD");
  const r = finance.financeLedger([msg("A", "我", 1, "给你转了 1500 元", true)], { showAmounts: true });
  eq(r.entries[0].amount, 1500);
});

// =====================================================================================
console.log("7) F 记忆与知识库");

await t("知识卡片：决策/文件/地点/链接 + 时间线 + 来源", async () => {
  const msgs = [
    msg("项目群-测试", "我", 2, "最终决定采用方案A", true),
    msg("项目群-测试", "甲", 20, "方案文档.pdf 已发你"),
    msg("项目群-测试", "乙", 22, "我们在创新大厦一楼开会"),
    msg("项目群-测试", "丙", 24, "参考这个 https://example.com/spec", false, { links: ["https://example.com/spec"] }),
  ];
  const r = memory.memoryCards(msgs, { now: new Date(now) });
  ok(r.cards.some((c) => c.kind === "决策"), "决策卡片：" + JSON.stringify(r.cards.map((c) => c.kind)));
  ok(r.cards.some((c) => c.kind === "文件"), "文件卡片");
  ok(r.cards.some((c) => c.kind === "地点" && c.location), "地点卡片");
  ok(r.cards.some((c) => c.kind === "链接"), "链接卡片");
  ok(r.cards.every((c) => c.source_msg_ids.length > 0), "每张卡片都要有来源 msg_id");
  ok(r.timeline.length === r.cards.length, "时间线与卡片同源");
  ok(r.caliber, "应说明口径");
});

await t("记忆问答：命中给证据，未命中不编造", async () => {
  const msgs = [msg("A", "甲", 2, "方案A的报价是 650 元")];
  const hit = memory.memoryAnswer(msgs, "报价");
  ok(hit.found === 1, "应命中 1 条，实际 " + hit.found);
  ok(hit.timeline[0].msg_id, "证据带 msg_id");
  const miss = memory.memoryAnswer(msgs, "量子引力波实验结论");
  eq(miss.found, 0);
  ok(/不臆测|没有找到/.test(miss.answer), "未命中要明说：" + miss.answer);
});

// =====================================================================================
console.log("8) G 内容分析");

await t("内容分析：话题 / 意图 / 实体 / 摘要 / 问答", async () => {
  const msgs = [
    msg("项目群-测试", "甲", 2, "项目需求确认一下，预算 650 USD，报价单发我", false, { id: undefined }),
    msg("项目群-测试", "我", 3, "好的，明天给报价", true),
    msg("项目群-测试", "乙", 4, "请问什么时候上线？"),
    msg("项目群-测试", "丙", 5, "北京创新大厦的会议室已订"),
  ];
  const r = content.contentAnalysis(msgs, { now: new Date(now) });
  ok(r.topics.some((x) => x.topic === "工作" || x.topic === "商务"), "话题聚类：" + JSON.stringify(r.topics.map((x) => x.topic)));
  ok(r.intents.counts["询问"] >= 1, "意图识别询问：" + JSON.stringify(r.intents.counts));
  ok(r.entities.amount.length >= 1, "金额实体：" + JSON.stringify(r.entities.amount));
  ok(r.entities.location.length >= 1, "地点实体：" + JSON.stringify(r.entities.location));
  ok(r.entities.person.length >= 1, "人物实体");
  ok(r.summary.bullets.length >= 1, "抽取式摘要");
  const qa = content.answerQuestion(msgs, "报价");
  ok(qa.evidence.length >= 1, "问答命中");
  ok(qa.evidence.every((e) => e.msg_id), "问答证据带 msg_id");
  const none = content.answerQuestion(msgs, "火星探测器着陆");
  eq(none.evidence.length, 0);
  ok(/没有找到/.test(none.answer), "无命中不编造");
});

await t("话题聚类：单遍分桶的多话题命中与计数语义（轮14 语义锁）", async () => {
  const m1 = msg("群A", "甲", 1, "项目排期确认，合作报价发一下"); // 工作+商务
  const m2 = msg("群A", "甲", 2, "项目方案交付一下");
  const m3 = msg("群A", "甲", 3, "合作报价单呢");
  const m4 = msg("群A", "甲", 4, "今天天气不错");
  const rows = content.topicClusters([m1, m2, m3, m4], { minHits: 2 });
  eq(rows.map((r) => r.topic).sort(), ["商务", "工作"]);
  const work = rows.find((r) => r.topic === "工作");
  const biz = rows.find((r) => r.topic === "商务");
  eq(work.hits, 2);
  eq(work.share, 0.5);
  eq(work.top_terms, [{ term: "项目", count: 2 }]); // minCount:2 只留跨消息重复词
  eq(work.sample.map((s) => s.msg_id), [m1.id, m2.id]); // hits 顺序 = 消息顺序
  eq(biz.hits, 2);
  eq(biz.top_terms, [{ term: "合作报价", count: 2 }]);
  eq(biz.sample.map((s) => s.msg_id), [m1.id, m3.id]); // 多话题消息在每个命中桶独立计数
});

await t("实体预筛门是必要条件：活正则源的每个关键词必过门，纯寒暄不过（轮15）", async () => {
  const fragOf = (re) => [...re.source.matchAll(/\((?:\?:)?([^()]*)\)/g)]
    .flatMap((m) => m[1].split("|"))
    .map((f) => f.replace(/\?$/, ""))
    .filter((f) => f && !/[[\]\\^$*+?{}|()/]/.test(f));
  const quiet = "哈哈哈哈今天天气不错收到嗯嗯"; // 不含任何门字符（对全部族逐一验证）
  for (const [name, re] of Object.entries(content.ENTITY_RES)) {
    const gate = content.keywordGate(re);
    ok(gate, name + " 应能派生门（解析失败会 fail-open 丢优化）");
    if (name === "AT_RE") {
      ok(gate.test("@"), "@ 必过门");
    } else {
      const frags = fragOf(re);
      ok(frags.length >= 10, name + " 关键词解析数异常：" + frags.length);
      for (const f of frags) ok(gate.test(f), name + " 关键词「" + f + "」必过门（否则会漏匹配）");
    }
    ok(!gate.test(quiet), name + " 纯寒暄应被门拒绝：" + quiet);
  }
});

await t("实体预筛门双路径逐项等价：全关键词正例 + 负例/脏数据（轮15）", async () => {
  // 测试内「无门参考实现」= 改前形态（push 入数组 → 事后 dedupe，含 time 死字段），
  // 与产品（预筛门 + 直建 dedupe 映射）在夹具上必须逐项一致——同时锁门与聚合两条改动。
  const reference = (messages, { ref = new Date(), limit = 40 } = {}) => {
    const times = [], locations = [], persons = [], amounts = [], orgs = [], events = [];
    const push = (arr, value, m) => {
      if (!value) return;
      arr.push({ value, msg_id: m?.id ?? null, time: m?.ts ? new Date(m.ts).toISOString() : null });
    };
    for (const m of messages) {
      const text = String(m?.content ?? "");
      if (!text) continue;
      for (const t of signals.extractDueDates(text, m?.ts ? new Date(m.ts) : ref)) push(times, t.text, m);
      for (const a of signals.extractAmounts(text)) push(amounts, a, m);
      for (const mm of text.matchAll(/(?:地址[:：]?\s*)?(?:[一-龥]{2,10}(?:路|街|道|巷|弄|大道|大街)\d{0,4}号?|[一-龥]{2,12}(?:大厦|大楼|广场|中心|园区|产业园|酒店|宾馆|咖啡厅?|餐厅|书店|医院|学校|地铁站?|机场|火车站|高铁站|体育馆|公园|商场|超市))/g)) push(locations, mm[0], m);
      for (const mm of text.matchAll(/[一-龥]{2,12}?(?:有限公司|股份公司|科技|集团|银行|医院|大学|学院|事务所|工作室|研究院|工作室|政府|支行|分行|基金会|协会|委员会|工作室)/g)) push(orgs, mm[0], m);
      for (const mm of text.matchAll(/(会议|例会|评审会|发布会|上线|开工|奠基|签约|验收|交付|试讲|培训|团建|聚餐|婚礼|面试|考试|答辩|出差|旅行|搬家|年会|展会|沙龙|直播)/g)) push(events, mm[0], m);
      for (const mm of text.matchAll(/@([一-龥A-Za-z0-9_\-]{2,20})/g)) push(persons, mm[1], m);
      for (const mm of text.matchAll(/(王|李|张|刘|陈|杨|赵|黄|周|吴|徐|孙|胡|朱|高|林|何|郭|马)(?:总|工|老师|医生|经理|主任|校长|教授|律师|师傅|同学|哥|姐|姐夫|阿姨|叔叔)/g)) push(persons, mm[0], m);
      if (!m.is_owner && m.sender) push(persons, m.sender, m);
    }
    const dedupe = (arr) => {
      const seen = new Map();
      for (const e of arr) {
        const row = seen.get(e.value) ?? { value: e.value, count: 0, msg_ids: [] };
        row.count += 1;
        if (row.msg_ids.length < 5 && e.msg_id) row.msg_ids.push(e.msg_id);
        seen.set(e.value, row);
      }
      return [...seen.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh")).slice(0, limit);
    };
    return {
      time: dedupe(times), location: dedupe(locations), person: dedupe(persons),
      amount: dedupe(amounts), org: dedupe(orgs), event: dedupe(events),
      caliber: "实体按正则与既有日期/金额抽取器提取；人名包含发送者昵称与 @提及，可能重复计数；不编造未出现实体。",
    };
  };
  const fragOf = (re) => [...re.source.matchAll(/\((?:\?:)?([^()]*)\)/g)]
    .flatMap((m) => m[1].split("|"))
    .map((f) => f.replace(/\?$/, ""))
    .filter((f) => f && !/[[\]\\^$*+?{}|()/]/.test(f));
  const fixtures = [];
  const add = (c, isOwner = false, sender = "成员") => fixtures.push(msg("夹具群", sender, fixtures.length + 1, c, isOwner));
  for (const [name, re] of Object.entries(content.ENTITY_RES)) {
    if (name === "AT_RE") { add("@王总 请看 @小李 的方案"); continue; }
    for (const f of fragOf(re)) add("张三说这个" + f + "的事情明天处理");
  }
  for (const c of ["", " ", "{脏数据", "总", "@", "123", "好的收到", "哈哈哈哈", "王李张刘", "路街道巷弄大道大厦门口", "预算 5000 元要下周三给答复"]) add(c);
  for (const c of ["李总和王老师明天到场评审会", "他们公司是某某科技有限公司", "北京创新大厦的会议室"]) add(c, true, "我");
  const ref = new Date(now);
  eq(content.entityTable(fixtures, { ref }), reference(fixtures, { ref }), "gated 与无门参考逐项等价");
  const r = content.entityTable(fixtures, { ref });
  ok(r.location.length >= 1, "地点类有产出（弱信号防护）：" + JSON.stringify(r.location));
  ok(r.org.length >= 1, "组织类有产出：" + JSON.stringify(r.org));
  ok(r.event.length >= 1, "事件类有产出：" + JSON.stringify(r.event));
  ok(r.person.length >= 1, "人物类有产出：" + JSON.stringify(r.person));
  ok(r.time.length >= 1, "时间类有产出：" + JSON.stringify(r.time));
  ok(r.amount.length >= 1, "金额类有产出：" + JSON.stringify(r.amount));
});

await t("实体表 dedupe 语义：msg_ids 前 5 上限（同值同消息重复入列）、无 id 计数不入列、limit 截断（轮15）", async () => {
  // 金值由旧算法独立路径推导（%TEMP%/wai-anal-gold15.mjs）：王总 9 次命中（7 有 id + 无/空 id 各 1），
  // 同消息双命中 d3 在 msg_ids 重复入列；第 6 个 id 起只计数；李总/张总同计数按 zh 序。
  const fix = [
    { id: "d1", content: "王总好" },
    { id: "d2", content: "王总在吗" },
    { id: "d3", content: "王总 王总" }, // 同值同消息多次：count 累加且 msg_ids 重复入列
    { id: "d4", content: "王总辛苦" },
    { id: "d5", content: "王总英明" },
    { id: "d6", content: "王总威武" }, // 第 6 个 id：msg_ids 已满 5，只计数
    { content: "王总早" }, // 无 id：计数不入列
    { id: "", content: "王总好" }, // 空 id：falsy 不入列
    { id: "o1", content: "李总好" },
    { id: "o2", content: "张总好" },
  ];
  const ref = new Date(1700000000000);
  const r = content.entityTable(fix, { ref });
  eq(r.person, [
    { value: "王总", count: 9, msg_ids: ["d1", "d2", "d3", "d3", "d4"] },
    { value: "李总", count: 1, msg_ids: ["o1"] },
    { value: "张总", count: 1, msg_ids: ["o2"] },
  ]);
  eq(r.time, []); eq(r.location, []); eq(r.amount, []); eq(r.org, []); eq(r.event, []);
  eq(content.entityTable(fix, { ref, limit: 2 }).person, [
    { value: "王总", count: 9, msg_ids: ["d1", "d2", "d3", "d3", "d4"] },
    { value: "李总", count: 1, msg_ids: ["o1"] },
  ]);
});

await t("话题聚类：top_terms 的 minCount/长词优先/limit 与 minHits 边界（轮14 语义锁）", async () => {
  const chain = () => [msg("群A", "甲", 1, "项目排期甲乙丙丁甲乙丙丁甲乙丙丁甲乙"), msg("群A", "甲", 2, "项目排期甲乙丙丁甲乙丙丁甲乙丙丁甲乙")];
  const top = content.topicClusters(chain(), { minHits: 2, topTerms: 5 })[0].top_terms;
  eq(top.length, 5);
  eq(top.slice(0, 4).map((x) => x.term).sort(), ["丁甲乙丙", "丙丁甲乙", "乙丙丁甲", "甲乙丙丁"]);
  eq(top.slice(0, 4).map((x) => x.count), [6, 6, 6, 4]); // 计数降序
  eq(top[4].count, 2);
  ok(!top.some((x) => x.term === "项目" || x.term === "排期"), "长词优先应裁掉被覆盖短词：" + JSON.stringify(top));
  const top1 = content.topicClusters(chain(), { minHits: 2, topTerms: 1 })[0].top_terms;
  eq(top1.length, 1);
  eq(top1[0].count, 6);
  ok(["丙丁甲乙", "甲乙丙丁", "乙丙丁甲"].includes(top1[0].term), "limit 截断：" + JSON.stringify(top1));
  const few = [msg("群A", "甲", 1, "看电影去吗"), msg("群A", "甲", 2, "吃饭了")];
  eq(content.topicClusters(few, { minHits: 2 }).map((r) => r.topic), []);
  eq(content.topicClusters(few, { minHits: 1 }).map((r) => r.topic).sort(), ["娱乐", "餐饮"]);
});

await t("词频×话题共享单遍：与 termFreq/topicClusters 分函数逐字段等价（轮17）", async () => {
  const fixtures = [
    msg("群A", "甲", 1, "项目排期确认，合作报价发一下"),
    msg("群A", "甲", 2, "项目方案交付一下"),
    msg("群A", "甲", 3, "合作报价单呢"),
    msg("群A", "甲", 4, "今天天气不错"),
    msg("群A", "甲", 5, ""),
    { id: "nocontent" },
    msg("群A", "乙", 6, null),
    msg("群A", "乙", 7, "OK ok 混合 mixed 项目 123"),
  ];
  // 等价锁：共享单遍 = 分函数之和（多组 limit 与 minHits/topTerms 透传）
  for (const limit of [1, 5, 60]) {
    const fused = content.keywordsAndTopics(fixtures, { limit });
    eq(fused.keywords, core.termFreq(fixtures, { limit }), "keywords 与 termFreq 等价，limit=" + limit);
    eq(fused.topics, content.topicClusters(fixtures), "topics 与 topicClusters 等价，limit=" + limit);
  }
  eq(content.keywordsAndTopics(fixtures, { minHits: 1, topTerms: 2 }).topics,
    content.topicClusters(fixtures, { minHits: 1, topTerms: 2 }), "minHits/topTerms 透传等价");
  // 金值语义锁（防两侧同步漂移；金值经探针实测推导，含 CJK_UNIT_RE 与 n-gram 的双计口径）
  const g = content.keywordsAndTopics(fixtures, { limit: 5 });
  eq(g.keywords, [
    { term: "项目", count: 3 }, { term: "合作报价", count: 2 },
    { term: "今天天", count: 2 }, { term: "ok", count: 2 },
  ]);
  eq(g.topics.map(({ topic, hits, share, top_terms }) => ({ topic, hits, share, top_terms })), [
    { topic: "工作", hits: 3, share: 0.375, top_terms: [{ term: "项目", count: 3 }, { term: "ok", count: 2 }] },
    { topic: "商务", hits: 2, share: 0.25, top_terms: [{ term: "合作报价", count: 2 }] },
  ]);
  // contentAnalysis 改接共享单遍后各块口径不变
  const r = content.contentAnalysis(fixtures, { top: 5, now: new Date(now) });
  eq(r.keywords, core.termFreq(fixtures, { limit: 5 }), "contentAnalysis.keywords 等价");
  eq(r.topics, content.topicClusters(fixtures), "contentAnalysis.topics 等价");
  eq(r.catchphrases, core.catchphrases(fixtures, { limit: 15 }), "catchphrases 口径不变");
  eq(r.emojis, core.emojiTop(fixtures, { limit: 5 }), "emojis 口径不变");
});

// 轮18-② 语义金值：期望值在改动 content.mjs 之前用 node 探针从旧实现导出（%TEMP% wai-anal-gold18.mjs），
// 锁定选句语义：打分四则（数字+1/英文+0.5/关键词+1.5/疑问-0.5/礼貌前缀-2）、问句 ？ 被切分吃掉不罚分、
// 前 10 字去重留高分（g6 胜 g5）、<8 字短消息（g4）与非文本（g7）剔除。
await t("轮18：抽取式摘要 bullets 语义金值（分数/去重/剔除逐位锁定）", async () => {
  const G = [
    { id: "g1", session_name: "群A", sender: "甲", is_owner: false, ts: now - 8 * H, content: "会议时间确认一下，2026-06-30 上线" },
    { id: "g2", session_name: "群A", sender: "我", is_owner: true, ts: now - 7 * H, content: "好的，明天给报价" },
    { id: "g3", session_name: "群A", sender: "乙", is_owner: false, ts: now - 6 * H, content: "请问什么时候上线？" },
    { id: "g4", session_name: "群A", sender: "丙", is_owner: false, ts: now - 5 * H, content: "嗯嗯好的收到" },
    { id: "g5", session_name: "群A", sender: "丁", is_owner: false, ts: now - 4 * H, content: "项目排期确认一下这个事情到底怎么安排" },
    { id: "g6", session_name: "群A", sender: "戊", is_owner: false, ts: now - 3 * H, content: "项目排期确认一下这个事情到底怎么安排吗" },
    { id: "g7", session_name: "群A", sender: "己", is_owner: false, ts: now - 2 * H, content: "[图片]" },
    { id: "g8", session_name: "群A", sender: "庚", is_owner: false, ts: now - 1 * H, content: "API 文档我更新完了，需要你 review 一下接口设计文档" },
  ];
  const r = content.extractiveSummary(G, { now: new Date(now), maxBullets: 8 });
  eq(r.bullets.map((b) => [b.text, b.score, b.msg_id, b.sender, b.chat]), [
    ["API 文档我更新完了，需要你 review 一下接口设计文档", 4.55, "g8", "庚", "群A"],
    ["会议时间确认一下，2026-06-30 上线", 3.6, "g1", "甲", "群A"],
    ["项目排期确认一下这个事情到底怎么安排吗", 3.45, "g6", "戊", "群A"],
    ["请问什么时候上线？", 1.9, "g3", "乙", "群A"],
    ["好的，明天给报价", -0.1, "g2", "我", "群A"],
  ], "五条 bullets 的文本/分数/来源逐位锁定（g5 前 10 字撞 g6 被去重、g4 短句、g7 图片剔除）");
  eq(r.method, "抽取式（按信息密度打分选句），不是生成式改写；只保留原句片段，不扩写结论。");
});

// 轮18 等价锁：classifyMessage 每条恰一次的 kinds 预分类通道，与逐条 classify 通道逐位一致
const kinds8 = [
  msg("群F", "甲", 1, "好的，明天给报价单"),
  msg("群F", "乙", 2, "[图片]"),
  msg("群F", "丙", 3, "[语音 12s]"),
  msg("群F", "丁", 4, "季度报告.docx 已上传"),
  msg("群F", "戊", 5, "红包来了"),
  msg("群F", "己", 6, "给你转 500 元"),
  msg("群F", "庚", 7, "https://example.com/spec"),
  msg("群F", "辛", 8, "我到了，在创新大厦"),
  msg("群F", "壬", 9, "嗯"),
];

await t("轮18：kinds 预分类与逐条 classifyMessage 逐位等价（summary 共享通道）", async () => {
  eq(content.extractiveSummary(kinds8, { now: new Date(now) }),
    content.extractiveSummary(kinds8, { now: new Date(now), kinds: kinds8.map((m) => core.classifyMessage(m)) }),
    "整批 kinds 通道与逐条通道等价（8 种类型 + 短消息跳过分支）");
  for (const m of kinds8) {
    eq(content.extractiveSummary([m], { now: new Date(now) }),
      content.extractiveSummary([m], { now: new Date(now), kinds: [core.classifyMessage(m)] }),
      "单条 kinds 通道等价：" + core.classifyMessage(m));
  }
});

await t("F4：type_breakdown 与 core.typeBreakdown 同形，JSON 往返保留 counts", async () => {
  const r = content.contentAnalysis(kinds8, { now: new Date(now) });
  eq(r.type_breakdown, core.typeBreakdown(kinds8), "type_breakdown 与 core.typeBreakdown 同形同口径");
  // 序列化锁：MCP textResult 与 content.json 都走 JSON.stringify，Map 会在这里丢成 {}
  const rt = JSON.parse(JSON.stringify(r.type_breakdown));
  ok(rt.counts && rt.counts.image === 1 && rt.counts.link === 1 && rt.counts.file === 1
    && rt.counts.redpacket === 1 && rt.counts.transfer === 1 && rt.counts.location === 1
    && rt.counts.voice === 1 && rt.counts.text === 2, "JSON 往返保留 counts：" + JSON.stringify(rt.counts));
  ok(rt.total === kinds8.length, "JSON 往返保留 total：" + rt.total);
  ok(Object.keys(rt.ratio).length === 8, "ratio 键齐全：" + JSON.stringify(rt.ratio));
});

await t("轮19：typeBreakdown 单调 hoist 与双调原式逐位等价（全 8 类/空/单条/翻倍）", async () => {
  // 测试内「双调原式」= 改前形态（counts[k]=… 前后各调一次 classifyMessage）；hoist 后输出逐位不变
  const doubleCall = (messages) => {
    const counts = { text: 0, image: 0, voice: 0, file: 0, transfer: 0, redpacket: 0, link: 0, location: 0 };
    for (const m of messages) counts[core.classifyMessage(m)] = (counts[core.classifyMessage(m)] ?? 0) + 1;
    const total = messages.length || 0;
    const ratio = {};
    for (const [k, v] of Object.entries(counts)) ratio[k] = total ? Math.round((v / total) * 1000) / 10 : 0;
    return { counts, ratio, total };
  };
  for (const [label, arr] of [["全8类", kinds8], ["空", []], ["单条", kinds8.slice(0, 1)], ["翻倍", kinds8.concat(kinds8)]]) {
    eq(core.typeBreakdown(arr), doubleCall(arr), "hoist 等价（" + label + "）");
  }
  eq(Object.values(core.typeBreakdown(kinds8).counts).filter((v) => v > 0).length, 8,
    "夹具覆盖全部 8 类：" + JSON.stringify(core.typeBreakdown(kinds8).counts));
});

await t("轮19：A-I 输出 JSON 形态审计 + render JSON 往返（Map/Set/Date/BigInt 不得直入 JSON 链路）", async () => {
  // F4 家族回归锁：Map→{}、Set→{}、Date→ISO、数组 undefined→null 都会在 JSON.stringify 静默变形；
  // 对象键的 undefined 值是金额脱敏的设计形态（amount 不返回），不算问题。
  const issues = [];
  const walk = (v, p, inArray) => {
    if (v === null) return;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean") return;
    if (t === "undefined") { if (inArray) issues.push(p + " → undefined 数组元素（JSON 变 null）"); return; }
    if (t === "bigint" || t === "function" || t === "symbol") { issues.push(p + " → " + t); return; }
    if (v instanceof Map) { issues.push(p + " → Map（JSON 丢成 {}）"); return; }
    if (v instanceof Set) { issues.push(p + " → Set（JSON 丢成 {}）"); return; }
    if (v instanceof Date) { issues.push(p + " → Date（跨 JSON 形变，需先 toISOString）"); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, p + "[" + i + "]", true)); return; }
    if (t === "object") { for (const [k, x] of Object.entries(v)) walk(x, p + "." + k, false); return; }
    issues.push(p + " → " + t);
  };
  const src = kinds8.concat([
    msg("审计群", "甲", 2, "预算 5000 元下周三给答复，@王总 确认一下"),
    msg("审计群", "我", 3, "好的，明天给报价", true),
    msg("审计群", "乙", 4, "稳赚不赔高回报，验证码 123456 发我"),
    msg("审计群", "丙", 5, "明天下午三点开会讨论上线，王老师参加"),
    msg("审计群", "丁", 6, "转 3000 元到卡号 6222021234567890"),
    msg("审计群", "戊", 7, "这个方案不行，返工重做"),
  ]);
  const ref = new Date(now);
  const outputs = {
    period: report.periodReport(src, { sinceMs: now - 100 * H, untilMs: now }),
    social: social.socialGraph(src, { sinceMs: now - 100 * H, untilMs: now }),
    sentiment: sentiment.sentimentTrend(src, { sinceMs: now - 100 * H, untilMs: now }),
    tasks: tasks.taskExtract(src, { now: ref }),
    finance: finance.financeLedger(src, { now: ref }),
    memory: memory.memoryCards(src, { now: ref }),
    content: content.contentAnalysis(src, { now: ref }),
    team: team.teamReview(src, { now: ref }),
    risk: risk.riskScan(src, { now: ref }),
  };
  for (const [name, v] of Object.entries(outputs)) walk(v, name, false);
  eq(issues, [], "引擎输出 JSON 形态审计");
  // renderAnalytics 落盘（maskDeep + writeJsonRedacted）再读回：round-trip 后仍须干净
  for (const [name, v] of Object.entries(outputs)) {
    const files = render.renderAnalytics(name, v, { outDir: path.join(ROOT, "audit-" + name) });
    if (files?.files?.json && fs.existsSync(files.files.json)) {
      walk(JSON.parse(fs.readFileSync(files.files.json, "utf8")), name + ".json", false);
    }
  }
  eq(issues, [], "render JSON 往返形态审计");
});

await t("轮20：月度桶数值年月与 toISOString 键逐位等价（含扩展年/负年/排序/非法时间抛错）", async () => {
  // 旧参照 = 改前 toISOString().slice(0,7) 逐条取键；月度桶是 socialGraph 里该键的唯一消费点
  const ymdTs = (y, mo, d) => { const x = new Date(0); x.setUTCFullYear(y, mo, d); x.setUTCHours(0, 0, 0, 0); return x.getTime(); };
  const edgeTs = [0, 1, -1, Date.UTC(2026, 9, 5), Date.UTC(1970, 0, 1), Date.UTC(1999, 11, 31, 23, 59, 59),
    -86400000 * 365 * 200, 8.64e15, -8.64e15, 8.64e15 - 1, -8.64e15 + 1,
    Date.UTC(2000, 0, 1), Date.UTC(10000, 0, 1), ymdTs(-5, 0, 1), ymdTs(999, 11, 1), ymdTs(0, 0, 1)];
  const oldMonthly = (ms) => {
    const byMonth = new Map();
    for (const m of ms) { if (!m.ts) continue; const key = new Date(m.ts).toISOString().slice(0, 7); byMonth.set(key, (byMonth.get(key) ?? 0) + 1); }
    return [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([month, count]) => ({ month, count }));
  };
  // 每边界 ts 一个私聊会话（对方发起 → 进 who_contacts_me_most 全行，monthly 可见）；会话名避开 群/组/team/group
  const msgs = edgeTs.map((ts, i) => ({ id: "e" + i, session_name: "边聊" + i, session_kind: "private", sender: "甲", is_owner: false, ts, content: "边界 " + i }));
  const r = social.socialGraph(msgs, { sinceMs: -8.64e15, untilMs: 8.64e15, top: 50 });
  eq(r.who_contacts_me_most.length, edgeTs.length, "全部边界会话可见");
  for (const row of r.who_contacts_me_most) {
    const i = Number(row.name.replace("边聊", ""));
    eq(row.monthly, oldMonthly([msgs[i]]), "monthly 与旧 toISOString 键逐位等价：" + row.name);
  }
  const mix = [
    { id: "x1", session_name: "混月私聊", session_kind: "private", sender: "乙", is_owner: false, ts: Date.UTC(2026, 0, 10), content: "一月消息" },
    { id: "x2", session_name: "混月私聊", session_kind: "private", sender: "乙", is_owner: false, ts: Date.UTC(2026, 7, 10), content: "八月消息" },
    { id: "x3", session_name: "混月私聊", session_kind: "private", sender: "乙", is_owner: false, ts: Date.UTC(2026, 8, 10), content: "九月消息甲" },
    { id: "x4", session_name: "混月私聊", session_kind: "private", sender: "乙", is_owner: false, ts: Date.UTC(2026, 8, 11), content: "九月消息乙" },
    { id: "x5", session_name: "混月私聊", session_kind: "private", sender: "乙", is_owner: false, ts: Date.UTC(10000, 0, 1), content: "扩展年" },
    { id: "x6", session_name: "混月私聊", session_kind: "private", sender: "乙", is_owner: false, ts: ymdTs(-5, 0, 1), content: "负年" },
  ];
  const r2 = social.socialGraph(mix, { sinceMs: -8.64e15, untilMs: 8.64e15, top: 50 });
  const row2 = r2.who_contacts_me_most.find((x) => x.name === "混月私聊");
  eq(row2.monthly, oldMonthly(mix), "混月/扩展年/负年键排序逐位等价");
  ok(row2.trend === "升温" && row2.change === 1, "trend/change 口径不变：" + row2.trend + "/" + row2.change);
  // truthy 非法时间：与旧实现同款抛 RangeError（不是静默出 NaN 键）
  let threw = null;
  try { social.socialGraph([{ id: "b", session_name: "坏ts私聊", session_kind: "private", sender: "丙", is_owner: false, ts: "not-a-date", content: "x" }], {}); } catch (e) { threw = e; }
  ok(threw instanceof RangeError, "非法时间必须抛 RangeError：" + (threw?.constructor?.name ?? "未抛"));
});

await t("轮21：lazy row 语义锁（多规则同命同行一致 / 非命中零行 / 缺字段默认 / FAQ 取行字段）", async () => {
  // 多规则同命：一条消息命中 7 类规则时各列表的行共享字段必须逐位一致
  //（lazy 单次建行与 eager 同值；文本无空白/PII/超长，maskPii∘truncate∘replace 为恒等）
  const hitText = "决定采用这个方案，麻烦你负责整理交付，这个延期了，投诉一下，怎么部署？报价太贵了";
  const r1 = team.teamReview([
    msg("项目群L", "张三", 100, hitText),
    msg("项目群L", "李四", 90, "好的收到"),
  ], { now: new Date(1780000000000) });
  eq(r1.decisions.length, 1, "决策 1 行");
  eq(r1.assignments.length, 1, "分配 1 行");
  eq(r1.risks.length, 1, "风险 1 行");
  eq(r1.risks[0].risk_type, "延期", "RISK_RULES 首命中语义不变（延期先于冲突）");
  eq(r1.service_qc.complaints.length, 1, "投诉 1 行");
  eq(r1.sales.needs.length, 1, "需求 1 行");
  eq(r1.sales.objections.length, 1, "异议 1 行");
  const rows = [r1.decisions[0], r1.assignments[0], r1.risks[0], r1.service_qc.complaints[0], r1.sales.needs[0], r1.sales.objections[0]];
  for (const k of ["actor", "chat", "ts", "msg_id", "text"]) {
    const vals = rows.map((x) => x[k]);
    ok(vals.every((v) => JSON.stringify(v) === JSON.stringify(vals[0])), "同命各行 " + k + " 一致：" + JSON.stringify(vals));
  }
  eq(rows[0].text, hitText, "无空白/PII/超长文本原样入行");
  eq(r1.assignments[0].status, "待确认", "分配状态口径不变");
  ok(r1.assignments[0].assignee != null, "assignee 抽取仍在");
  eq(r1.service_qc.complaint_count, 1, "complaint_count 口径不变");
  // 非命中消息：lazy 不得漏出行（死分配只省构建，不省语义）
  const r2 = team.teamReview([msg("项目群M", "王五", 10, "好的没问题，明天再说")], { now: new Date(1780000000000) });
  for (const [n, v] of [["decisions", r2.decisions], ["assignments", r2.assignments], ["risks", r2.risks], ["complaints", r2.service_qc.complaints], ["needs", r2.sales.needs], ["objections", r2.sales.objections]]) {
    eq(v, [], "非命中零行：" + n);
  }
  eq(r2.window_messages, 1, "窗口计数不含丢弃行");
  // 缺字段消息（无 sender/id/ts）：默认值与 time=null 口径不变，且不抛错
  const r3 = team.teamReview([{ content: "怎么部署？" }], { now: new Date(1780000000000) });
  eq(r3.faq, [], "单条问题不构成 FAQ（count>=2）");
  // FAQ 从问题行取字段：同归一键两条 → count 2 / samples 2 且字段完整
  //（归一键只剥句末语气/标点、不剥「请问」，两条必须同前缀才合并——与既有 FAQ 口径一致）
  const r4 = team.teamReview([
    msg("项目群F", "赵六", 50, "请问怎么部署？"),
    msg("项目群F", "钱七", 40, "请问怎么部署呢？"),
    msg("项目群F", "孙八", 30, "好的收到"),
  ], { now: new Date(1780000000000) });
  eq(r4.faq.length, 1, "归一键把「请问怎么部署？」「请问怎么部署呢？」并为一条 FAQ");
  eq(r4.faq[0].count, 2, "FAQ 计数 2");
  eq(r4.faq[0].samples.length, 2, "FAQ 样本 2");
  for (const s of r4.faq[0].samples) {
    ok(s.actor && s.text && s.msg_id != null, "FAQ 样本字段完整（lazy 行字段不缺）：" + JSON.stringify({ actor: s.actor, hasText: !!s.text }));
  }
});

await t("轮22：日桶数值日键与 toISOString 键逐位等价（扩展年截断 ±YYYYYY-MM/负年/未知桶/排序/非法时间抛错）", async () => {
  // 旧参照 = 改前 toISOString().slice(0,10) 逐条取键；activity.by_day 是 teamReview 里该键的唯一消费点
  const ymdTs = (y, mo, d) => { const x = new Date(0); x.setUTCFullYear(y, mo, d); x.setUTCHours(0, 0, 0, 0); return x.getTime(); };
  const edgeTs = [0, 1, -1, Date.UTC(2026, 9, 5), Date.UTC(1970, 0, 1), Date.UTC(1999, 11, 31, 23, 59, 59),
    -86400000 * 365 * 200, 8.64e15, -8.64e15, 8.64e15 - 1, -8.64e15 + 1,
    Date.UTC(2000, 0, 1), Date.UTC(10000, 0, 1), ymdTs(-5, 0, 1), ymdTs(-5, 11, 31), ymdTs(999, 11, 1), ymdTs(0, 0, 1),
    ymdTs(10000, 0, 1), ymdTs(275760, 8, 13), ymdTs(-271821, 3, 20)];
  const oldByDay = (ms) => {
    const byDay = new Map();
    for (const m of ms) {
      const day = m.ts ? new Date(m.ts).toISOString().slice(0, 10) : "未知";
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, count]) => ({ day, count }));
  };
  // 每边界 ts 单独调用（by_day 是 base 全局聚合，逐例隔离才能锁到单键）
  for (const ts of edgeTs) {
    const m = { id: "e", session_name: "项目群边界", session_kind: "group", sender: "甲", is_owner: false, ts, content: "边界消息" };
    eq(team.teamReview([m], { now: new Date(1780000000000) }).activity.by_day, oldByDay([m]), "单键逐位等价：" + String(ts));
  }
  // 扩展年截断形态锚定：slice(0,10) 只留 ±YYYYYY-MM 10 字符，不是完整日键
  eq(team.teamReview([{ id: "x", session_name: "项目群截断", session_kind: "group", sender: "甲", ts: Date.UTC(10000, 0, 1), content: "a" }], { now: new Date(1780000000000) }).activity.by_day,
    [{ day: "+010000-01", count: 1 }], "扩展年键 = 10 字符截断 +010000-01");
  // falsy ts（含 0）全走「未知」桶并累计；空文本消息同样计入日桶（旧实现口径）
  const mix = [
    { id: "u1", session_name: "项目群混", session_kind: "group", sender: "甲", ts: 0, content: "零时间戳" },
    { id: "u2", session_name: "项目群混", session_kind: "group", sender: "甲", ts: null, content: "空时间" },
    { id: "u3", session_name: "项目群混", session_kind: "group", sender: "甲", content: "无时间字段" },
    { id: "u4", session_name: "项目群混", session_kind: "group", sender: "甲", ts: Date.UTC(2026, 0, 2), content: "" },
    { id: "u5", session_name: "项目群混", session_kind: "group", sender: "甲", ts: ymdTs(-5, 0, 1), content: "负年" },
    { id: "u6", session_name: "项目群混", session_kind: "group", sender: "甲", ts: Date.UTC(2026, 0, 1), content: "正常" },
    { id: "u7", session_name: "项目群混", session_kind: "group", sender: "甲", ts: Date.UTC(10000, 0, 1), content: "扩展年" },
    { id: "u8", session_name: "项目群混", session_kind: "group", sender: "甲", ts: Date.UTC(1999, 11, 31), content: "跨年" },
  ];
  const r = team.teamReview(mix, { now: new Date(1780000000000) });
  eq(r.activity.by_day, oldByDay(mix), "混排（未知/空文本/负年/扩展年/跨年）排序与计数逐位等价");
  eq(r.activity.by_day.find((x) => x.day === "未知").count, 3, "falsy ts（0/null/缺省）全进「未知」桶累计");
  // truthy 非法时间：与旧实现同款抛 RangeError（不是静默出 NaN 键）
  let threw = null;
  try { team.teamReview([{ id: "b", session_name: "项目群坏", session_kind: "group", sender: "丙", ts: "not-a-date", content: "x" }], { now: new Date(1780000000000) }); } catch (e) { threw = e; }
  ok(threw instanceof RangeError, "非法时间必须抛 RangeError：" + (threw?.constructor?.name ?? "未抛"));
});

// =====================================================================================
console.log("9) H 团队复盘");

await t("团队：决策 / 分配 / 风险 / FAQ", async () => {
  const msgs = [
    msg("项目群-测试", "张总", 2, "决定采用 v2 方案，下周上线"),
    msg("项目群-测试", "张总", 3, "请张三负责整理文档"),
    msg("项目群-测试", "张三", 26, "这个需求延期了，来不及"),
    msg("项目群-测试", "李四", 27, "请问怎么部署？"),
    msg("项目群-测试", "李四", 28, "请问怎么部署呢？"),
    msg("项目群-测试", "王五", 29, "客户投诉说太慢"),
  ];
  const r = team.teamReview(msgs, { projectName: "测试项目", now: new Date(now) });
  ok(r.decisions.length >= 1, "决策：" + JSON.stringify(r.decisions));
  ok(r.decisions[0].actor === "张总", "决策人");
  ok(r.assignments.length >= 1 && r.assignments[0].assignee.includes("张三"), "任务分配到张三：" + JSON.stringify(r.assignments));
  ok(r.risks.some((x) => x.risk_type === "延期"), "延期风险");
  ok(r.service_qc.complaint_count >= 1, "投诉线索");
  ok(r.faq.some((f) => f.count >= 2), "FAQ 需重复出现");
  ok(r.project === "测试项目", "项目名透传");
});

// =====================================================================================
console.log("10) I 风控线索");

await t("风控：诈骗/敏感信息/合规命中，证据打码，全部 needs_review", async () => {
  const msgs = [
    msg("陌生人", "陌生人", 1, "稳赚不赔，带你投资，高回报"),
    msg("陌生人", "陌生人", 2, "把验证码 889955 发我一下"),
    msg("陌生人", "陌生人", 3, "我的手机号 13812345678，身份证 110101199001011234"),
    msg("同事群", "同事", 4, "这笔走线下，私下转，别留记录"),
    msg("同事群", "同事", 5, "保证收益零风险，回扣另算"),
  ];
  const r = risk.riskScan(msgs, { now: new Date(now) });
  ok(r.risks.some((x) => x.type === "诈骗" && x.level === "高"), "诈骗高危：" + JSON.stringify(r.risks.map((x) => x.rule_id)));
  ok(r.risks.some((x) => x.rule_id === "pii.verify_code"), "验证码泄露");
  ok(r.risks.some((x) => x.rule_id === "pii.id_card"), "身份证泄露");
  ok(r.risks.some((x) => x.type === "合规"), "合规线索");
  ok(r.risks.some((x) => x.rule_id === "abn.private_transfer"), "异常行为");
  ok(r.risks.every((x) => x.needs_review === true), "全部需要人工复核");
  const allText = JSON.stringify(r);
  ok(!allText.includes("889955"), "证据里验证码应打码");
  ok(!allText.includes("13812345678"), "证据里手机号应打码");
  ok(!allText.includes("110101199001011234"), "证据里身份证应打码");
  ok(/不是违法\/诈骗认定/.test(r.disclaimer), "必须声明只是线索");
});

await t("风控 goal 过滤", async () => {
  const msgs = [
    msg("A", "甲", 1, "稳赚不赔，高回报"),
    msg("A", "甲", 2, "手机 13812345678"),
  ];
  const r = risk.riskScan(msgs, { goal: "诈骗" });
  ok(r.risks.every((x) => x.type === "诈骗" || x.rule_id.startsWith("scam")), "goal=诈骗 只留诈骗线索：" + JSON.stringify(r.risks.map((x) => x.rule_id)));
});

// =====================================================================================
console.log("11) 渲染落盘");

await t("renderAnalytics 写出 md+json 且报告无明文 PII", async () => {
  const msgs = [msg("陌生人", "陌生人", 1, "把验证码 889955 发我，手机 13812345678")];
  const r = risk.riskScan(msgs, {});
  const outDir = path.join(ROOT, "render-risk");
  const files = render.renderAnalytics("risk", r, { outDir });
  ok(fs.existsSync(files.files.report), "报告落盘");
  ok(fs.existsSync(files.files.json), "JSON 落盘");
  const md = fs.readFileSync(files.files.report, "utf8");
  ok(!md.includes("889955"), "报告不得含验证码明文");
  ok(!md.includes("13812345678"), "报告不得含手机号明文");
  ok(/风控线索/.test(md), "报告标题");
});

await t("期间报告渲染含表格与洞察", async () => {
  const msgs = [];
  for (let i = 0; i < 30; i += 1) msgs.push(msg("客户群-测试", i % 2 ? "甲" : "我", i, "项目报价确认", i % 2 === 0));
  const r = report.periodReport(msgs, { sinceMs: now - 100 * H, untilMs: now });
  const files = render.renderAnalytics("period", r, { outDir: path.join(ROOT, "render-period") });
  const md = fs.readFileSync(files.files.report, "utf8");
  ok(md.includes("| 类型 | 条数 | 占比% |"), "类型分布表");
  ok(md.includes("## 洞察"), "洞察段");
});

// =====================================================================================
console.log("12) MCP 工具接线（server.handleRpc）");

{
  const store = await import(new URL("../lib/store.mjs", import.meta.url).href);
  const db = store.store();
  const msgs = [];
  for (let i = 0; i < 30; i += 1) {
    msgs.push(msg("客户群-接线测试", i % 2 ? "张三" : "我", i, i % 2 ? "项目报价确认，预算 650 元" : "好的，明天给报价", i % 2 === 0));
  }
  msgs.push(msg("陌生人-接线测试", "陌生人", 1, "稳赚不赔高回报，验证码 123456 发我"));
  msgs.push(msg("客户群-接线测试", "我", 2, "给你转了 300 元定金", true));
  store.insertMessages(db, msgs, { source: "test" });
  const srv = await import(new URL("../server.mjs", import.meta.url).href);

  const call = (name, args) => srv.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } });

  await t("wai_period_report 接线", async () => {
    const r = await call("wai_period_report", { days: 30 });
    const sc = r.result.structuredContent;
    ok(!r.result.isError, "不应报错：" + JSON.stringify(sc).slice(0, 200));
    ok(sc.total_messages >= 31, "应读到索引消息：" + sc.total_messages);
    ok(sc.insights.length >= 1, "有洞察");
  });

  await t("wai_social_graph / wai_sentiment_trend / wai_content_analysis 接线", async () => {
    for (const name of ["wai_social_graph", "wai_sentiment_trend", "wai_content_analysis"]) {
      const r = await call(name, { days: 30 });
      ok(!r.result.isError, name + " 报错：" + JSON.stringify(r.result.structuredContent).slice(0, 200));
    }
  });

  await t("wai_task_extract / wai_finance / wai_memory / wai_team_review 接线", async () => {
    for (const name of ["wai_task_extract", "wai_finance", "wai_memory", "wai_team_review"]) {
      const r = await call(name, { days: 30 });
      ok(!r.result.isError, name + " 报错：" + JSON.stringify(r.result.structuredContent).slice(0, 200));
    }
  });

  await t("wai_risk_scan 接线 + out 落盘", async () => {
    const outDir = path.join(ROOT, "tool-risk");
    const r = await call("wai_risk_scan", { days: 30, out: outDir });
    const sc = r.result.structuredContent;
    ok(!r.result.isError, "不应报错：" + JSON.stringify(sc).slice(0, 200));
    ok(sc.risks.some((x) => x.type === "诈骗"), "工具应命中诈骗线索");
    ok(sc.files && fs.existsSync(sc.files.report), "out 落盘");
  });

  await t("分析工具 out 拒绝写进仓库目录", async () => {
    const { PKG_ROOT } = await import(new URL("../lib/paths.mjs", import.meta.url).href);
    const r = await call("wai_period_report", { days: 30, out: path.join(PKG_ROOT, "output-here") });
    ok(r.result.isError, "写仓库目录必须报错");
  });

  await t("金额默认脱敏在工具层同样生效", async () => {
    const r = await call("wai_finance", { days: 30 });
    const sc = r.result.structuredContent;
    ok(sc.entries.every((e) => e.amount === undefined), "工具默认不返回精确金额");
    const r2 = await call("wai_finance", { days: 30, showAmounts: true });
    ok(r2.result.structuredContent.entries.some((e) => typeof e.amount === "number"), "showAmounts=true 给精确值");
  });
}

// 轮19 语义金值：期望值在改 bumpTextInto（停用边位图预检）之前用 node 探针从旧实现导出
// （%TEMP% wai-gold19.mjs），改后 42 例 sha256 对拍逐位一致、本金值复核不变。锁死首尾停用字
// 裁剪（目的/的了/我们）、STOP_WORDS、CJK_UNIT 数量词（3天/500元/2小时/下周）、拉丁词小写
// 与标点切分——位图预检不得改变任何一条输出。
await t("轮19：词频/话题金值逐位锁（停用边位图预检前后语义不变）", async () => {
  const G = [
    { id: "g1", content: "项目排期评审会定在下周三" }, { id: "g2", content: "我们的合作报价单发我一下" },
    { id: "g3", content: "项目排期评审会定在下周三" }, { id: "g4", content: "的目的很清楚了" },
    { id: "g5", content: "3天500元2小时搞定" }, { id: "g6", content: "API文档和npm包版本" },
    { id: "g7", content: "项目，排期！评审？" }, { id: "g8", content: "好的[动画表情]收到" },
    { id: "g9", content: "啊" }, { id: "g10", content: "  " },
    { id: "g11", content: "项目排期评审需求方案交付上线客户汇报加班KPI" }, { id: "g12", content: "项目排期" },
    { id: "g13", content: "项目排期" }, { id: "g14", content: "我们项目排期" }, { id: "g15", content: "项目排期的了" },
  ];
  const S = (msg_id, text) => ({ msg_id, time: null, sender: "未知", chat: "未知会话", text });
  const EXP_KW = [
    { term: "项目排期", count: 7 }, { term: "目排期评", count: 3 }, { term: "排期评审", count: 3 },
    { term: "会定在下周", count: 2 }, { term: "评审会定", count: 2 }, { term: "下周三", count: 2 },
  ];
  const TOP_WORK = {
    topic: "工作", hits: 8, share: 0.5333, top_terms: EXP_KW.slice(0, 5),
    sample: [S("g1", "项目排期评审会定在下周三"), S("g3", "项目排期评审会定在下周三")],
  };
  const TOP_TECH = {
    topic: "技术", hits: 2, share: 0.1333, top_terms: [],
    sample: [S("g6", "API文档和npm包版本"), S("g11", "项目排期评审需求方案交付上线客户汇报加班KPI")],
  };
  const TOP_BIZ = { topic: "商务", hits: 1, share: 0.0667, top_terms: [], sample: [S("g2", "我们的合作报价单发我一下")] };
  const kw = content.keywordsAndTopics(G, { limit: 30, minCount: 2, maxN: 4, minHits: 2, topTerms: 5 });
  eq(kw.keywords, EXP_KW, "keywordsAndTopics.keywords 金值");
  eq(kw.topics, [TOP_WORK, TOP_TECH], "keywordsAndTopics.topics 金值");
  eq(core.termFreq(G, { limit: 30 }), EXP_KW, "termFreq 金值");
  eq(content.topicClusters(G, { minHits: 1, topTerms: 5, maxN: 4 }), [TOP_WORK, TOP_TECH, TOP_BIZ], "topicClusters 金值（minHits:1 含商务）");
});
console.log("\n" + "=".repeat(50));
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  console.log("");
}
console.log("=== " + passed + " passed, " + failed + " failed ===");
try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
