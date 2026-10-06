// Markdown 报告生成层：群聊日报、话题日报、联系人日报、简报与各类专题报告。
// 全部输出为中文 Markdown/CSV/JSON；只读本地数据，不发送任何微信消息。
import path from "node:path";
import {
  fmtLocal, fmtDay, toCsv, ensureDir, atomicWrite, writeJson, truncate, truncateOutsideUrl, clamp, uniq,
} from "../util.mjs";
import { loadConfig } from "../config.mjs";
import { maskPii, maskDeep } from "../analytics/core.mjs";
import { loadProfile, PUBLIC_FOCUS_AREAS, isOwnerName } from "../profile.mjs";
import { classifyChat, isLowValueChat } from "../signals.mjs";

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const MAX_ACTION_ROWS = 10;
const MAX_RADAR_LINKS = 15;

// ---------------------------------------------------------------------------
// 通用取值与文本工具
// ---------------------------------------------------------------------------

/** 保证拿到数组 */
function objPick(o, k) { const v = o?.[k]; return v && typeof v === "object" && !Array.isArray(v) ? v : null; }
function arr(value) {
  return Array.isArray(value) ? value : [];
}

/** 多字段名兼容取值：同一份数据可能来自上游中文列或本地英文结构 */
function pick(source, names, fallback = "") {
  if (!source || typeof source !== "object") return fallback;
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return fallback;
}

function num(value, fallback = 0) {
  if (value === "" || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 压缩空白，避免报告里出现换行破坏列表结构 */
function flat(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/** 截断到指定长度 */
function cut(value, limit = 160) {
  const text = flat(value);
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(1, limit - 1)) + "…";
}

/** 毫秒时间戳 -> 本地时间文本 */
function timeText(value) {
  if (value === undefined || value === null || value === "") return "未知";
  const n = Number(value);
  if (Number.isFinite(n) && Math.abs(n) > 1e11) return fmtLocal(new Date(n)) || "未知";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? flat(value) : fmtLocal(d);
}

/** 表格单元格转义 */
function cell(value) {
  return flat(value).replace(/\|/g, "\\|");
}

function outFile(outDir, name) {
  const dir = path.resolve(outDir || ".");
  ensureDir(dir);
  return path.join(dir, name);
}

/** privacy.redactOutputs（默认开）：报告落盘前统一脱敏；可显式设 false 关闭 */
function redactOn() {
  try { return loadConfig().privacy?.redactOutputs !== false; } catch { return true; }
}

/**
 * 报告正文/CSV 落盘边界：redactOutputs 开启时整体打码。
 * 回复草稿是"人要照发"的正文，用 { mask:false } 显式豁免。
 */
function writeText(file, content, { mask = true } = {}) {
  const body = content.endsWith("\n") ? content : content + "\n";
  atomicWrite(file, mask && redactOn() ? maskPii(body) : body);
  return file;
}

/** JSON 报告落盘边界：只打码字符串值，数字/布尔保留（机器消费不受影响） */
function writeJsonRedacted(file, payload) {
  return writeJson(file, redactOn() ? maskDeep(payload) : payload);
}

/** 去掉 Markdown 报告里可能残留的原始 details 标签（digest 明确禁止出现） */
function stripDetails(text) {
  return String(text ?? "").replace(/<\/?details[^>]*>/gi, "").replace(/<\/?summary[^>]*>/gi, "");
}

// ---------------------------------------------------------------------------
// 群聊日报
// ---------------------------------------------------------------------------

/** 附件占位或纯链接的噪声消息 */
function isNoiseContent(content, links) {
  const text = flat(content);
  if (!text) return true;
  if (/^\[(图片|文件|语音|视频|链接|表情|动画表情|位置|名片|image|file|voice|video|link)\]$/i.test(text)) return true;
  if (text.length <= 2) return true;
  if (arr(links).length && text.replace(/https?:\/\/\S+/g, "").trim().length <= 4) return true;
  return false;
}

/**
 * 把 signals.analyze 的 SessionRow 归一化为群聊日报行。
 * @param {object} session SessionRow
 * @param {Array<object>} messages 可选：窗口内消息（用于统计有效条数与附件）
 */
function groupRow(session, messages) {
  const name = String(pick(session, ["name", "chat", "群聊", "session_name"], "未命名群聊"));
  const list = messages.filter((m) => String(pick(m, ["session_name", "chat", "群聊"], "")) === name);
  const messageCount = num(pick(session, ["messages", "消息数", "msg_count"], list.length), list.length);
  const effective = list.length
    ? list.filter((m) => !isNoiseContent(pick(m, ["content", "内容"], ""), pick(m, ["links", "链接"], []))).length
    : messageCount;
  const lastTs = num(pick(session, ["last_ts", "最后时间戳"], 0));
  const lastMessage = list.length ? list[list.length - 1] : null;
  const topics = arr(pick(session, ["topics", "主要主题"], []));
  const signals = arr(pick(session, ["signals", "信号"], []));
  const amounts = arr(pick(session, ["amounts", "金额线索"], []));
  const text = list.map((m) => String(pick(m, ["content", "内容"], ""))).join("\n");
  return {
    name,
    kind: "group",
    messages: messageCount,
    // 优先用 signals.analyze 的上下文判定结果（已排除日报/纯加热/无意义消息），否则回退到噪声过滤
    effective: num(pick(session, ["effective"], null)) ?? Math.min(effective, Math.max(messageCount, effective)),
    senders: num(pick(session, ["senders", "发言人数"], 0)),
    lastTs,
    lastText: timeText(lastTs),
    lastSender: String(pick(session, ["last_sender", "最后发言人"], lastMessage ? pick(lastMessage, ["sender", "发言人"], "") : "")),
    topics,
    signals,
    amounts,
    deal_hits: num(pick(session, ["deal_hits", "商单信号数"], 0)),
    training_hits: num(pick(session, ["training_hits", "培训信号数"], 0)),
    project_hits: num(pick(session, ["project_hits", "项目合作信号数"], 0)),
    resource_hits: num(pick(session, ["resource_hits", "资源信号数"], 0)),
    priority: num(pick(session, ["priority", "优先级"], 0)),
    pending_reply: signals.includes("待回复"),
    low_value: Boolean(pick(session, ["low_value", "低价值"], false)) || isLowValueChat({ name, text }),
    entertainment: Boolean(pick(session, ["entertainment"], false)),
    actionable: objPick(session, "actionable") ?? {},
    recap_count: num(pick(session, ["recap_count"], 0)),
    boost_count: num(pick(session, ["boost_count"], 0)),
    attachments: list.filter((m) => /^\[(图片|文件|语音|视频|image|file|voice|video)\]$/i.test(flat(pick(m, ["content", "内容"], "")))).length,
    recaps: arr(pick(session, ["recaps", "群内已有日报"], [])),
  };
}

/** 群标签（对应上游 _group_digest_tags） */
function groupTags(row) {
  const tags = [];
  if (row.deal_hits) tags.push("商单");
  if (row.training_hits) tags.push("培训/项目");
  if (row.project_hits) tags.push("项目合作");
  if (row.resource_hits) tags.push("资源引荐");
  if (row.amounts.length) tags.push("含报价");
  if (row.pending_reply) tags.push("待回复");
  if (row.attachments) tags.push("附件待核实");
  if (!tags.length && row.low_value) tags.push("低价值");
  return uniq(tags);
}

/** 群行动原因（对应上游 group_digest_reasons） */
function groupReasons(row) {
  const reasons = [];
  if (row.deal_hits) reasons.push(row.deal_hits + " 条明确商单");
  if (row.training_hits) reasons.push(row.training_hits + " 条培训/项目需求");
  if (row.project_hits) reasons.push(row.project_hits + " 条项目合作");
  if (row.resource_hits) reasons.push(row.resource_hits + " 条资源引荐");
  if (row.amounts.length) reasons.push("金额线索 " + row.amounts.slice(0, 3).join("、"));
  if (row.pending_reply) reasons.push("存在待回复提问");
  if (!reasons.length && row.signals.length) reasons.push("信号：" + row.signals.join("、"));
  return uniq(reasons);
}

/** 群聊一句话总结 */
function groupSummary(row) {
  const topics = row.topics.slice(0, 3);
  const parts = [topics.length ? "主要围绕：" + topics.join("、") : "以日常信息同步为主"];
  const reasons = groupReasons(row);
  if (reasons.length) parts.push("检出：" + reasons.slice(0, 3).join("、"));
  else parts.push("暂未发现需要立即处理的明确事项");
  return parts.join("；") + "。";
}

/** 建议动作 */
function groupAction(row) {
  if (row.deal_hits && row.amounts.length) return "核对报价与交付排期，确认后回复发起人并记录承诺时间。";
  if (row.deal_hits) return "确认这条商单是否属于可承接范围，必要时私聊对接人。";
  if (row.training_hits) return "确认培训形式、课时与预算，先回复可交付的时间窗口。";
  if (row.project_hits) return "确认项目角色与分工，把下一步约定成明确日期。";
  if (row.pending_reply) return "先回复群内待答复的问题，再判断是否继续推进。";
  if (row.resource_hits) return "判断是否需要引荐或索取资料，避免只做旁观者。";
  return "本时段无需动作，保留记录即可。";
}

/** 是否达到行动门槛（对应上游 select_group_action_rows） */
function isActionRow(row) {
  return Boolean(row.deal_hits || row.training_hits || row.project_hits || row.pending_reply);
}

/** 是否值得进入正文 */
function isFocusRow(row) {
  if (row.low_value && !isActionRow(row)) return false;
  return isActionRow(row) || row.signals.length > 0 || row.priority >= 25 || row.deal_hits + row.training_hits + row.project_hits > 0;
}

function actionSortKey(row) {
  return [row.deal_hits ? 1 : 0, row.training_hits ? 1 : 0, row.project_hits ? 1 : 0, row.signals.length, row.priority, row.lastTs];
}

function compareRows(a, b) {
  const ka = actionSortKey(a);
  const kb = actionSortKey(b);
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return kb[i] - ka[i];
  }
  return String(b.name).localeCompare(String(a.name));
}

/** 跨群链接行 */
function linkRow(link) {
  const url = String(pick(link, ["url", "链接"], ""));
  const chats = arr(pick(link, ["chats", "相关群聊"], []));
  const probability = String(pick(link, ["probability", "商单判断"], "普通内容"));
  const heat = Boolean(pick(link, ["heat", "加热"], false));
  const hitsCount = num(pick(link, ["hits", "出现次数"], 0));
  const contexts = arr(pick(link, ["contexts", "证据"], []));
  const senders = arr(pick(link, ["senders", "发言人"], []));
  return {
    url,
    norm: String(pick(link, ["norm", "标准化链接"], url)),
    probability,
    heat,
    hits: hitsCount,
    chats,
    senders,
    firstTs: num(pick(link, ["first_ts", "首次出现"], 0)),
    lastTs: num(pick(link, ["last_ts", "最后出现"], 0)),
    reason: String(pick(link, ["note", "判断依据"], heat ? "存在付费加热/红包/三连等证据" : "多个群重复出现")),
    evidence: contexts.slice(0, 3).map((c) => String(pick(c, ["chat", "群聊"], "")) + "｜" + timeText(pick(c, ["ts", "时间"], 0)) + "｜" + String(pick(c, ["sender", "发言人"], "")) + "：" + truncateOutsideUrl(flat(pick(c, ["content", "内容"], "")), 120)),
  };
}

/** 商单雷达链接的单行格式 */
function radarLine(row) {
  const labels = [row.probability, row.chats.length + "群/" + row.hits + "次"];
  return "- **" + labels.join("｜") + "**：" + row.url + "  \n  出现群：" + (row.chats.join("、") || "未知");
}

/** 群聊价值矩阵维度：Profile 重点方向 + 自定义主题 */
function matrixDimensions(profile) {
  const focus = arr(profile?.intelligence_priorities?.focus_areas);
  const custom = Object.keys(profile?.intelligence_priorities?.custom_topics ?? {});
  const dims = uniq([...(focus.length ? focus : PUBLIC_FOCUS_AREAS), ...custom]).filter(Boolean);
  return dims.length ? dims : [...PUBLIC_FOCUS_AREAS];
}

function activityLevel(messages) {
  if (messages >= 300) return "极高";
  if (messages >= 100) return "高";
  if (messages >= 30) return "中";
  return "低";
}

/** 构建群聊筛选矩阵行（用「可行动信号」而非原始词命中，避免娱乐/闲聊群被误判为重点） */
function matrixRow(row, dimensions, links) {
  const text = [row.name, row.topics.join(" "), row.signals.join(" ")].join(" ");
  const dims = {};
  for (const dim of dimensions) dims[dim] = text.includes(dim);
  const chatLinks = links.filter((l) => l.chats.includes(row.name));
  const heatLinks = chatLinks.filter((l) => l.heat).length;
  const act = row.actionable ?? {};
  const business = Boolean(act["商单"] || act["培训"] || act["项目合作"]);
  const commercialName = /(商单|品牌|投放|渠道|资源|商务|合作|变现|出海|增长)/i.test(row.name);
  const entertainment = Boolean(row.entertainment || row.low_value);
  let level = "关注";
  let basis = "有单一方向相关信息，暂未形成明确行动";
  if (business || row.priority >= 60) {
    level = "重点";
    basis = "本时段出现可推进的商单、培训或项目信号";
  } else if (heatLinks || commercialName) {
    level = "雷达观察";
    basis = "属于商业资源群或出现付费加热，只看新增项目和跨群链接即可";
  } else if (entertainment || row.effective < 3) {
    level = "低优先级";
    basis = row.effective < 3 ? "本时段有效讨论太少，没有可读信息" : "以生活娱乐闲聊为主，没有可执行商业信号";
  } else if (Object.values(dims).filter(Boolean).length >= 2) {
    level = "关注";
    basis = "讨论与当前重点方向相关，暂未形成明确行动";
  }
  let type = "一般信息";
  if (business) type = "商业与合作";
  else if (heatLinks || commercialName) type = "商单雷达";
  else if (entertainment) type = "低价值娱乐/闲聊";
  else if (Object.values(dims).some(Boolean)) type = "目标方向相关";
  const signalsSummary = Object.entries(act).filter(([, n]) => n > 0).map(([k, n]) => k + (n > 1 ? "×" + n : "")).join("、");
  return {
    群聊: row.name,
    消息数: row.messages,
    有效讨论数: row.effective ?? row.effective_count ?? 0,
    发言人数: row.senders,
    活跃度: activityLevel(row.messages),
    相关方向: dimensions.filter((d) => dims[d]),
    付费加热链接数: heatLinks,
    群聊类型: type,
    建议关注级别: level,
    判断依据: basis,
    主要主题: row.topics.join("、") || "未识别",
    可行动信号: signalsSummary || undefined,
  };
}

/**
 * 渲染群聊日报全套产物。
 * @param {object} analysis signals.analyze 的结果
 * @param {{since?:string, until?:string, outDir:string, coverage?:object, links?:Array, editorial?:object}} options
 * @returns {object} 各产物的绝对路径
 */
export function renderGroupDaily(analysis, options = {}) {
  const source = analysis ?? {};
  const outDir = options.outDir ?? ".";
  const since = options.since ?? timeText(source?.window?.sinceMs);
  const until = options.until ?? timeText(source?.window?.untilMs);
  const coverage = options.coverage ?? source?.coverage_detail ?? null;
  const rawLinks = arr(options.links ?? source?.links);
  const allMessages = arr(source?.messages);
  const links = rawLinks.map(linkRow).filter((l) => l.url);
  const rows = arr(source?.sessions)
    .filter((s) => String(pick(s, ["kind", "类型"], "group")) === "group")
    .map((s) => groupRow(s, allMessages));

  const actionRows = rows.filter(isActionRow).sort(compareRows);
  const actionNames = new Set(actionRows.map((r) => r.name));
  const focusRows = rows.filter(isFocusRow).sort(compareRows);
  const noteworthy = rows.filter((r) => r.signals.length > 0 || r.deal_hits + r.training_hits + r.project_hits + r.resource_hits > 0).length;
  const highLinks = links.filter((l) => l.probability === "高概率商单");
  const suspectedLinks = links.filter((l) => l.probability === "疑似商单");

  // ---- group_daily_digest.md ----
  const lines = [
    "# 微信群聊日报",
    "",
    "> " + since + " 至 " + until + "｜覆盖 " + rows.length + " 个活跃群聊",
  ];
  if (coverage && num(pick(coverage, ["failed"], 0)) > 0) {
    lines.push(
      "> ⚠️ 读取成功 " + num(pick(coverage, ["succeeded"], 0)) + "/" + num(pick(coverage, ["requested"], 0)) +
      " 个群；" + num(pick(coverage, ["failed"], 0)) + " 个群读取失败，不能据此判断这些群没有新消息。",
    );
  }
  lines.push(
    "",
    "## 一眼结论",
    "",
    "- 需要处理或核实：**" + actionRows.length + "** 个群",
    "- 有重点讨论：**" + noteworthy + "** 个群",
    "- 跨群投放信号：高概率 **" + highLinks.length + "** 个，待核实 **" + suspectedLinks.length + "** 个",
    "- 阅读方式：先看行动清单，再看真正有信息增量的重点群聊；普通活跃群与纯加热接龙不进入正文。",
    "",
    "## 先处理这些",
    "",
  );
  if (!actionRows.length) {
    lines.push("当前窗口没有达到行动门槛的群聊线索。");
  }
  for (const row of actionRows.slice(0, MAX_ACTION_ROWS)) {
    const tags = groupTags(row).join(" / ") || "待核实";
    const reasons = groupReasons(row).join("；") || "存在需要核实的商业上下文";
    lines.push("- **" + row.name + "｜" + tags + "**：" + groupSummary(row) + " 原因：" + reasons + "。下一步：" + groupAction(row));
  }
  if (actionRows.length > MAX_ACTION_ROWS) {
    lines.push("- 另有 " + (actionRows.length - MAX_ACTION_ROWS) + " 个行动候选，可在下方按群展开。");
  }
  lines.push(
    "",
    "## 按群查看",
    "",
    "> 只收录与当前目标相关且有信息增量的群；每条直接保留群名、时间、发言人和必要链接。",
    "",
  );
  for (const row of focusRows) {
    const tags = groupTags(row).join(" / ") || "普通讨论";
    const reasons = groupReasons(row);
    lines.push(
      "### " + row.name,
      "",
      "> " + tags + "｜" + row.messages + " 条，有效 " + row.effective + " 条 / " + row.senders + " 人",
      "",
      "- **群聊总结**：" + groupSummary(row),
      "- **主要主题**：" + (row.topics.join("、") || "未识别"),
      "- **时间**：最后消息 " + row.lastText,
    );
    if (reasons.length) lines.push("- **值得关注**：" + reasons.join("；"));
    if (actionNames.has(row.name)) lines.push("- **建议动作**：" + groupAction(row));
    if (row.attachments) lines.push("- **附件**：" + row.attachments + " 个附件占位待核实，请回到原群确认内容。");
    if (row.recaps.length) {
      lines.push("", "### 群内已有日报", "");
      for (const recap of row.recaps.slice(0, 5)) {
        lines.push("- " + flat(pick(recap, ["时间", "time"], "")) + "｜" + flat(pick(recap, ["发言人", "sender"], "")) + "：" + cut(pick(recap, ["摘要", "content"], ""), 160));
      }
      lines.push("- 这些内容只作为二手参考，不参与本日报的主题、关键发言或商机判断。");
    }
    lines.push("");
  }
  lines.push(
    "## 商单雷达链接",
    "",
    "- 保留：高概率 " + highLinks.length + " 个，待核实 " + suspectedLinks.length + " 个。",
    "- 纯红包接龙不进入群聊总结；同一 URL 在这里仅出现一次。",
  );
  const seenUrls = new Set();
  for (const link of [...highLinks, ...suspectedLinks]) {
    if (seenUrls.has(link.norm) || seenUrls.size >= MAX_RADAR_LINKS) continue;
    seenUrls.add(link.norm);
    lines.push(radarLine(link));
  }
  if (!seenUrls.size) lines.push("- 本时段没有跨群重复投放链接。");
  const digestFile = writeText(outFile(outDir, "group_daily_digest.md"), stripDetails(lines.join("\n")));

  // ---- group_daily_appendix.md ----
  const appendix = [
    "# 微信群聊日报证据附录",
    "",
    "- 时间范围：" + since + " 至 " + until,
    "- 群聊：" + rows.length + " 个",
    "- 说明：本文件保留完整群级脉络，主日报只呈现需要行动或值得知道的内容。",
    "",
  ];
  for (const row of rows) {
    appendix.push(
      "## " + row.name,
      "",
      "- 消息：" + row.messages + " 条；有效消息：" + row.effective + " 条；发言人：" + row.senders + " 人；最后消息：" + row.lastText,
      "- 主题：" + (row.topics.join("、") || "未识别"),
      "- 最后发言人：" + (row.lastSender || "未识别"),
      "- 信号：" + (row.signals.join("、") || "无明显信号"),
      "- 建议动作：" + groupAction(row),
      "",
    );
    if (row.recaps.length) {
      appendix.push("### 群内已有日报", "");
      for (const recap of row.recaps) {
        appendix.push("- " + flat(pick(recap, ["时间", "time"], "")) + "｜" + flat(pick(recap, ["发言人", "sender"], "")) + "：" + cut(pick(recap, ["摘要", "content"], ""), 200));
      }
      appendix.push("", "> 上述日报已从主题与商机证据中排除，仅供交叉核验。", "");
    }
  }
  const appendixFile = writeText(outFile(outDir, "group_daily_appendix.md"), appendix.join("\n"));

  // ---- group_daily.csv / group_daily.json / coverage ----
  const csvRows = rows.map((row) => ({
    群聊: row.name,
    消息数: row.messages,
    有效消息数: row.effective,
    发言人数: row.senders,
    最后消息时间: row.lastText,
    最后发言人: row.lastSender,
    主要主题: row.topics.join("、"),
    商单信号数: row.deal_hits,
    培训项目信号数: row.training_hits,
    项目合作信号数: row.project_hits,
    资源信号数: row.resource_hits,
    重要信号数: row.signals.length,
    金额线索: row.amounts.join("、"),
    标签: groupTags(row).join("/"),
    是否行动候选: isActionRow(row) ? "是" : "否",
    建议动作: groupAction(row),
    优先级: row.priority,
  }));
  const csvCols = Object.keys(csvRows[0] ?? {
    群聊: "", 消息数: "", 有效消息数: "", 发言人数: "", 最后消息时间: "", 最后发言人: "",
    主要主题: "", 商单信号数: "", 培训项目信号数: "", 项目合作信号数: "", 资源信号数: "",
    重要信号数: "", 金额线索: "", 标签: "", 是否行动候选: "", 建议动作: "", 优先级: "",
  });
  const csvFile = writeText(outFile(outDir, "group_daily.csv"), toCsv(csvRows, csvCols));
  const jsonPayload = {
    since,
    until,
    groups: rows,
    cross_group_links: links,
  };
  if (allMessages.length) jsonPayload.messages = allMessages;
  const jsonFile = writeJsonRedacted(outFile(outDir, "group_daily.json"), jsonPayload);
  const coverageFile = writeJsonRedacted(outFile(outDir, "group_daily_coverage.json"), coverage ?? {
    requested: rows.length,
    succeeded: rows.length,
    failed: 0,
    failed_sessions: [],
  });

  // ---- cross_group_links.md / .csv ----
  const linkCsvRows = links.map((l) => ({
    链接: l.url,
    商单判断: l.probability,
    判断依据: l.reason,
    出现次数: l.hits,
    覆盖群数: l.chats.length,
    相关群聊: l.chats.join("、"),
    首次出现: timeText(l.firstTs),
    最后出现: timeText(l.lastTs),
  }));
  const linkCsvFile = writeText(
    outFile(outDir, "cross_group_links.csv"),
    toCsv(linkCsvRows, ["链接", "商单判断", "判断依据", "出现次数", "覆盖群数", "相关群聊", "首次出现", "最后出现"]),
  );
  const repeated = links.filter((l) => l.chats.length >= 2);
  const linkLines = [
    "# 跨群重复链接和机会聚合",
    "",
    "- 时间范围：" + since + " 至 " + until,
    "- 符合展示门槛：" + repeated.length + " 个",
    "- 跨群重复链接：" + repeated.length + " 个",
    "- 带商单/加热信号链接：" + links.filter((l) => l.heat).length + " 个",
    "",
    "## 链接清单",
    "",
  ];
  if (!repeated.length) linkLines.push("暂无跨群重复链接或带商单信号的链接。");
  for (const link of repeated.slice(0, 20)) {
    linkLines.push(radarLine(link), "  判断：" + link.reason);
  }
  const linkMdFile = writeText(outFile(outDir, "cross_group_links.md"), linkLines.join("\n"));

  // ---- group_selection_matrix.md / .csv / .json ----
  const profile = loadProfile();
  const dimensions = matrixDimensions(profile);
  const matrixRows = rows.map((row) => matrixRow(row, dimensions, links));
  const levelRank = { 重点: 4, 雷达观察: 3, 关注: 2, 低优先级: 1 };
  const activityRank = { 极高: 4, 高: 3, 中: 2, 低: 1 };
  matrixRows.sort((a, b) => (levelRank[b.建议关注级别] ?? 0) - (levelRank[a.建议关注级别] ?? 0)
    || (activityRank[b.活跃度] ?? 0) - (activityRank[a.活跃度] ?? 0)
    || b.消息数 - a.消息数);
  const matrixCols = ["群聊", "消息数", "有效讨论数", "发言人数", "活跃度", ...dimensions, "相关方向", "付费加热链接数", "群聊类型", "建议关注级别", "判断依据", "主要主题"];
  const matrixCsvRows = matrixRows.map((row) => ({ ...row, 相关方向: row.相关方向.join("/") }));
  const matrixCsvFile = writeText(outFile(outDir, "group_selection_matrix.csv"), toCsv(matrixCsvRows, matrixCols));
  const basis = "按本机个人 Profile 校准，当前重点：" + dimensions.join("、") + "。建议级别只针对本时段，不等于永久排除。";
  const matrixJsonFile = writeJsonRedacted(outFile(outDir, "group_selection_matrix.json"), {
    since,
    until,
    basis,
    dimensions,
    groups: matrixCsvRows,
  });
  const matrixLines = [
    "# 全部群聊价值矩阵",
    "",
    "> 时间范围：" + since + " 至 " + until + "。建议级别只描述本时段，不会自动写入永久排除名单。",
    "",
    "| 群聊 | 类型 | 活跃度 | 消息/有效讨论 | 相关方向 | 建议级别 | 判断依据 |",
    "|---|---|---:|---:|---|---|---|",
  ];
  for (const row of matrixRows) {
    matrixLines.push("| " + [
      cell(row.群聊), cell(row.群聊类型), cell(row.活跃度),
      cell(row.消息数 + "/" + row.有效讨论数),
      cell(row.相关方向.join(" / ") || "无"),
      cell(row.建议关注级别), cell(row.判断依据),
    ].join(" | ") + " |");
  }
  const matrixMdFile = writeText(outFile(outDir, "group_selection_matrix.md"), matrixLines.join("\n"));

  // ---- group_daily_editorial_packet.json ----
  const packet = options.editorial ?? buildGroupEditorialPacket(rows, { since, until, links, coverage });
  const editorialFile = writeJsonRedacted(outFile(outDir, "group_daily_editorial_packet.json"), packet);

  return {
    digest: digestFile,
    appendix: appendixFile,
    csv: csvFile,
    json: jsonFile,
    coverage: coverageFile,
    linksMd: linkMdFile,
    linksCsv: linkCsvFile,
    matrixMd: matrixMdFile,
    matrixCsv: matrixCsvFile,
    matrixJson: matrixJsonFile,
    editorial: editorialFile,
  };
}

/** 构建语义编辑输入包（供上层 Agent 做第二遍编辑） */
export function buildGroupEditorialPacket(rows, options = {}) {
  const since = options.since ?? "";
  const until = options.until ?? "";
  const links = arr(options.links);
  const actionRows = rows.filter(isActionRow).sort(compareRows);
  const discussions = rows
    .filter((row) => !row.low_value && (row.signals.length || row.deal_hits + row.training_hits + row.project_hits + row.resource_hits))
    .sort(compareRows)
    .slice(0, 36)
    .map((row) => ({
      群聊: row.name,
      时间段: row.lastText,
      结束时间: row.lastText,
      主题: row.topics,
      信号类型: row.signals,
      分数: row.priority,
      有实质讨论: row.effective > 0,
      具体信息: row.amounts.length ? "涉及金额线索：" + row.amounts.join("、") : "",
      围绕什么: groupSummary(row),
      值得关注: groupReasons(row).join("；") || "背景动态",
      证据消息: [],
    }));
  const highLinks = links.filter((l) => l.probability === "高概率商单");
  const suspectedLinks = links.filter((l) => l.probability === "疑似商单");
  return {
    schema_version: 3,
    用途: "供上层 Agent 做第二遍语义编辑；不是可直接交付给用户的日报",
    时间范围: { 开始: since, 结束: until },
    覆盖: {
      活跃群聊: rows.length,
      行动候选群聊: actionRows.length,
      讨论候选: discussions.length,
      高概率跨群链接: highLinks.length,
      待核实跨群链接: suspectedLinks.length,
    },
    编辑要求: [
      "同时生成话题日报 group_daily_topics.md 和重点群聊 group_daily_groups.md；group_daily_brief.md 只作兼容入口",
      "话题日报按真实项目、事件、问题或争议跨群归纳，标题必须点名真实项目或事件，不能写规则标签",
      "重点群聊只收录与当前用户目标直接相关且有信息增量的群，不列普通活跃群和无关娱乐群",
      "同一群内按讨论段合并原话；不要把证据摘录直接冒充群聊总结",
      "机会必须说明与当前用户的关系、可联系的人、下一步和证据等级",
      "同一链接或同一合作轮次只在跨群链接索引出现一次，群聊正文不重复 URL",
      "所有事实结论保留群聊、时间和发言人来源",
      "红包、接龙、三连、四连和纯加热话术只进入跨群商单雷达，不进入话题日报或重点群聊正文",
    ],
    行动候选: actionRows.slice(0, 15).map((row) => ({
      群聊: row.name,
      标签: groupTags(row),
      最后消息时间: row.lastText,
      摘要候选: {
        商单: row.deal_hits ? groupSummary(row) : "",
        培训或项目: row.training_hits || row.project_hits ? groupSummary(row) : "",
        关键发言: row.lastSender ? row.lastSender + "：" + cut(row.lastText, 60) : "",
      },
      建议动作候选: groupAction(row),
      附件核验提示: row.attachments ? row.attachments + " 个附件占位待核实" : "",
      群内已有日报: row.recaps.slice(0, 5),
      信号讨论: [],
      相关跨群链接: links
        .filter((l) => l.chats.includes(row.name) && (l.probability === "高概率商单" || l.probability === "疑似商单"))
        .slice(0, 8)
        .map((l) => ({ 链接: l.url, 商单判断: l.probability, 判断依据: l.reason, 覆盖群数: l.chats.length, 出现次数: l.hits, 相关群聊: l.chats.join("、"), 证据摘要: l.evidence.join("；") })),
    })),
    讨论候选: discussions,
    群内已有日报索引: rows.filter((row) => row.recaps.length).map((row) => ({ 群聊: row.name, 日报: row.recaps })),
    高概率跨群链接: highLinks.slice(0, 12),
    待核实链接: suspectedLinks.slice(0, 12),
  };
}

// ---------------------------------------------------------------------------
// 话题日报与重点群聊（由语义编辑包确定性渲染）
// ---------------------------------------------------------------------------

/** 规则标签黑名单：话题标题绝不能只用这些词 */
const GENERIC_LABELS = new Set([
  "AI", "产品", "模型", "商单", "培训", "项目", "合作", "赚钱", "出海", "Web3",
  "自媒体运营与增长", "B端AI赋能", "日常闲聊/信息同步", "日常闲聊", "信息同步",
  "其他", "链接", "资源", "活动", "招聘/外包", "赚钱/奖励", "红包", "接龙", "推广",
]);

const HEADLINE_STOP = new Set([
  "我们", "他们", "这个", "那个", "可以", "已经", "就是", "什么", "怎么", "因为", "所以",
  "如果", "但是", "然后", "现在", "今天", "明天", "一个", "没有", "需要", "进行", "问题",
  "内容", "东西", "时候", "自己", "大家", "老师", "朋友", "主要围绕", "暂未发现", "背景动态",
]);

/** 清理话题标题来源文本 */
function cleanHeadlineSource(value) {
  return flat(String(value ?? "")
    .replace(/https?:\/\/\S+/g, "链接")
    .replace(/[#*_>@]/g, " ")
    .replace(/\[(图片|文件|语音|视频|链接|表情)\]/g, " "));
}

/** 给候选标题打分：越像真实项目/事件越高 */
function scoreHeadline(text) {
  const value = flat(text);
  if (!value) return -99;
  let score = 0;
  if (/[「《“][^」》”]{2,}[」》”]/.test(value)) score += 3;
  if (/\d+\s*(月|日|号|期|人|条|万|元|课时|名额)/.test(value)) score += 2;
  if (/(品牌|投放|合作|报价|课程|培训|招募|项目|发布|排期|结算|预算|名额|需求|客户|渠道)/.test(value)) score += 2;
  if (value.length >= 8 && value.length <= 40) score += 1;
  if (GENERIC_LABELS.has(value)) score -= 5;
  if (value.startsWith("主要围绕") || value.startsWith("暂未发现")) score -= 4;
  return score;
}

/** 从讨论候选中提炼一个点名真实事件的标题 */
function headlineOf(item) {
  const sources = [
    pick(item, ["具体信息"], ""),
    pick(item, ["围绕什么"], ""),
    pick(item, ["值得关注"], ""),
    ...arr(pick(item, ["证据消息"], [])).map((e) => pick(e, ["内容", "content"], "")),
  ];
  let best = "";
  for (const raw of sources) {
    const text = cleanHeadlineSource(raw);
    if (!text) continue;
    const chunk = text.split(/[。！？；!?;]/)[0].trim() || text;
    const candidate = chunk.length >= 6 ? chunk : text;
    if (scoreHeadline(candidate) > scoreHeadline(best)) best = candidate;
  }
  if (!best) return "";
  const comma = best.search(/[，,、]/);
  if (comma >= 8) return best.slice(0, comma);
  return best.length > 30 ? best.slice(0, 30) : best;
}

/** 提取用于聚类的关键短语 */
function keyPhrases(text) {
  const out = new Set();
  const value = String(text ?? "");
  for (const m of value.matchAll(/[A-Za-z][A-Za-z0-9+#.-]{1,}/g)) {
    const token = m[0];
    if (token.length >= 2 && !HEADLINE_STOP.has(token.toLowerCase())) out.add(token);
  }
  for (const run of value.split(/[^\u4e00-\u9fff]+/)) {
    const seg = run.trim();
    if (seg.length < 2) continue;
    if (seg.length <= 8) out.add(seg);
    else {
      out.add(seg.slice(0, 8));
      out.add(seg.slice(0, 4));
    }
  }
  for (const stop of HEADLINE_STOP) out.delete(stop);
  return [...out];
}

/** 按关键短语把讨论聚类成跨群话题 */
function clusterDiscussions(discussions, maxTopics = 6) {
  const items = discussions.map((item) => {
    const headline = headlineOf(item);
    return {
      item,
      headline,
      group: String(pick(item, ["群聊"], "未命名群聊")),
      phrases: keyPhrases(headline + " " + String(pick(item, ["值得关注"], ""))),
    };
  });
  const clusters = [];
  const used = new Set();
  while (clusters.length < maxTopics) {
    const counts = new Map();
    items.forEach((entry, index) => {
      if (used.has(index)) return;
      for (const phrase of new Set(entry.phrases)) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    });
    let best = "";
    let bestCount = 0;
    for (const [phrase, count] of counts) {
      if (count > bestCount || (count === bestCount && phrase.length > best.length)) {
        best = phrase;
        bestCount = count;
      }
    }
    if (!best || bestCount < 2) break;
    const members = [];
    items.forEach((entry, index) => {
      if (used.has(index) || !entry.phrases.includes(best)) return;
      used.add(index);
      members.push(entry);
    });
    clusters.push({ title: topicTitle(best, members), members });
  }
  items.forEach((entry, index) => {
    if (used.has(index)) return;
    used.add(index);
    clusters.push({ title: entry.headline || (entry.group + " 的本时段讨论"), members: [entry] });
  });
  return clusters;
}

/** 话题标题：优先使用能点名真实项目/事件的关键短语 */
function topicTitle(phrase, members) {
  const headline = members.map((m) => m.headline).find((h) => h && !GENERIC_LABELS.has(h)) ?? "";
  if (phrase && phrase.length >= 3 && !GENERIC_LABELS.has(phrase)) {
    return headline && headline.length > phrase.length && headline.includes(phrase) ? headline : phrase;
  }
  return headline || "本时段跨群讨论";
}

/** 证据行格式：[群名｜时间｜发言人] */
function evidenceLine(group, time, sender, content) {
  const who = sender ? "｜" + sender : "";
  return "- [" + (group || "未知群聊") + "｜" + (time || "时间未知") + who + "] " + cut(content, 160);
}

function groupRelation(tags) {
  const list = arr(tags);
  if (list.includes("商单")) return "群里正在找可交付的合作方，属于可变现关系，需要主动确认。";
  if (list.includes("培训/项目")) return "对方在找讲师或项目执行，属于可承接的合作关系。";
  if (list.includes("项目合作")) return "存在共同推进的项目角色，需要确认分工。";
  if (list.includes("资源引荐")) return "偏资源交换关系，先判断是否值得投入时间。";
  return "信息同步关系，暂不需要主动投入。";
}

function groupVerdict(item) {
  const action = flat(pick(item, ["建议动作候选"], ""));
  if (action) return action;
  return "暂不需要行动，仅在后续需要时回查。";
}

function groupConclusion(item) {
  // 摘要候选是对象 {商单,培训或项目,关键发言}：必须先下钻再取「关键发言」；
  // pick 是平面键查找，pick(item, ["摘要候选", "关键发言"]) 第一个名字命中就返回整个对象，flat 会拼出 [object Object]
  const summary = objPick(item, "摘要候选");
  const key = flat(pick(summary ?? item, ["关键发言"], ""));
  if (/(但是|不过|不同意|有分歧|待定|不确定|纠结|再确认|还没定)/.test(key)) {
    return "群内存在待确认的分歧：" + cut(key, 120);
  }
  if (key) return "目前只有过程讨论，尚未形成明确结论：" + cut(key, 120);
  return "目前只有过程讨论，尚未形成明确结论。";
}

/**
 * 渲染话题日报与重点群聊两份编辑产物。
 * @param {object} packet group_daily_editorial_packet.json 的结构
 * @param {{outDir:string, since?:string, until?:string}} options
 * @returns {{topics:string, groups:string}} 两个文件的绝对路径
 */
export function renderGroupEditorial(packet, options = {}) {
  const data = packet ?? {};
  const outDir = options.outDir ?? ".";
  const range = data["时间范围"] ?? {};
  const since = options.since ?? String(pick(range, ["开始"], ""));
  const until = options.until ?? String(pick(range, ["结束"], ""));
  const actionItems = arr(data["行动候选"]);
  const discussions = arr(data["讨论候选"]);
  const highLinks = arr(data["高概率跨群链接"]);
  const suspected = arr(data["待核实链接"]);

  const enriched = discussions.map((item) => ({ ...item, headline: headlineOf(item) }));
  enriched.sort((a, b) => num(pick(b, ["分数"], 0)) - num(pick(a, ["分数"], 0)));
  const clusters = clusterDiscussions(enriched, 6);

  // ---- group_daily_topics.md ----
  const topics = [
    "# 话题日报",
    "",
    "> " + since + " 至 " + until + "｜按真实项目与事件跨群归纳",
    "",
    "## 今天最重要的事",
    "",
  ];
  const ranked = enriched.filter((item) => item.headline).slice(0, 5);
  if (!ranked.length) topics.push("本时段没有形成需要单独点名的重要事件，详见下方分类。");
  ranked.forEach((item, index) => {
    const group = String(pick(item, ["群聊"], "未命名群聊"));
    topics.push((index + 1) + ". **" + item.headline + "**（" + group + "｜" + flat(pick(item, ["时间段", "结束时间"], "时间未知")) + "）：" + cut(pick(item, ["围绕什么"], ""), 130));
  });

  topics.push("", "## 大家主要在聊什么", "");
  const topicCount = Math.min(6, Math.max(3, clusters.length));
  for (const cluster of clusters.slice(0, topicCount)) {
    topics.push("### " + cluster.title, "");
    for (const member of cluster.members) {
      const item = member.item;
      const group = String(pick(item, ["群聊"], "未命名群聊"));
      const body = member.headline || flat(pick(item, ["围绕什么"], ""));
      topics.push("- **" + group + "｜" + flat(pick(item, ["时间段", "结束时间"], "时间未知")) + "**：" + cut(body, 150));
      const attention = flat(pick(item, ["值得关注"], ""));
      if (attention) topics.push("  - 关注：" + cut(attention, 120));
    }
    topics.push("");
  }
  if (!clusters.length) topics.push("本时段没有可归纳的跨群讨论。", "");

  topics.push("## 商单、培训与合作", "");
  if (!actionItems.length && !highLinks.length && !suspected.length) {
    topics.push("本时段没有达到门槛的商单、培训或合作线索。");
  }
  for (const item of actionItems.slice(0, 10)) {
    const tags = arr(pick(item, ["标签"], [])).join(" / ") || "待核实";
    const summary = flat(pick(item["摘要候选"] ?? {}, ["商单"], "")) || flat(pick(item["摘要候选"] ?? {}, ["培训或项目"], "")) || "存在需要核实的商业上下文";
    topics.push("- **" + String(pick(item, ["群聊"], "未命名群聊")) + "｜" + tags + "**：" + cut(summary, 130) + " 下一步：" + groupVerdict(item));
    for (const link of arr(pick(item, ["相关跨群链接"], [])).slice(0, 2)) {
      topics.push("  - 链接：" + String(pick(link, ["链接"], "")) + "（" + String(pick(link, ["商单判断"], "待核实")) + "，" + num(pick(link, ["覆盖群数"], 0)) + " 群）");
    }
  }
  if (highLinks.length) {
    topics.push("", "**高概率跨群投放**：" + highLinks.map((l) => String(pick(l, ["链接"], ""))).filter(Boolean).join("、"));
  }
  if (suspected.length) {
    topics.push("", "**待核实投放**：" + suspected.map((l) => String(pick(l, ["链接"], ""))).filter(Boolean).join("、"));
  }

  topics.push("", "## 今天可以不看", "");
  const skip = enriched.filter((item) => !item.headline || GENERIC_LABELS.has(item.headline)).slice(0, 8);
  if (!skip.length) {
    topics.push("- 本时段没有明显的纯噪声群，低价值内容已在机器初筛中折叠。");
  }
  for (const item of skip) {
    topics.push("- **" + String(pick(item, ["群聊"], "未命名群聊")) + "**：以日常信息同步为主，暂不需要投入。");
  }
  const topicsFile = writeText(outFile(outDir, "group_daily_topics.md"), topics.join("\n"));

  // ---- group_daily_groups.md ----
  const byGroup = new Map();
  for (const item of actionItems) {
    const group = String(pick(item, ["群聊"], "未命名群聊"));
    if (!byGroup.has(group)) byGroup.set(group, { action: item, discussions: [] });
    else byGroup.get(group).action = item;
  }
  for (const item of enriched) {
    const group = String(pick(item, ["群聊"], "未命名群聊"));
    if (!byGroup.has(group)) byGroup.set(group, { action: null, discussions: [] });
    byGroup.get(group).discussions.push(item);
  }
  const groupLines = [
    "# 重点群聊",
    "",
    "> " + since + " 至 " + until + "｜共 " + byGroup.size + " 个值得点名的群聊",
    "",
  ];
  if (!byGroup.size) groupLines.push("本时段没有与当前目标直接相关的群聊。");
  for (const [group, entry] of byGroup) {
    const action = entry.action;
    const first = entry.discussions[0] ?? null;
    const tags = action ? arr(pick(action, ["标签"], [])) : [];
    groupLines.push("## " + group, "");
    const happened = first ? (first.headline || flat(pick(first, ["围绕什么"], ""))) : flat(pick(action?.["摘要候选"] ?? {}, ["关键发言"], ""));
    groupLines.push("- **发生了什么**：" + (happened ? cut(happened, 160) : "本时段以日常信息同步为主，没有形成可点名的讨论。"));
    groupLines.push("- **已有结论或分歧**：" + (action ? groupConclusion(action) : "尚未形成结论，需要回到原群查看上下文。"));
    groupLines.push("- **与用户的关系**：" + groupRelation(tags));
    groupLines.push("- **是否需要行动**：" + (action ? groupVerdict(action) : "暂不需要行动，仅在需要时回查。"));
    const evidence = [];
    if (action) {
      const time = flat(pick(action, ["最后消息时间"], "时间未知"));
      const key = flat(pick(action["摘要候选"] ?? {}, ["关键发言"], ""));
      if (key) evidence.push(evidenceLine(group, time, "", key));
    }
    for (const item of entry.discussions.slice(0, 3)) {
      const time = flat(pick(item, ["时间段", "结束时间"], "时间未知"));
      const body = item.headline || flat(pick(item, ["围绕什么"], ""));
      if (body) evidence.push(evidenceLine(group, time, "", body));
    }
    if (evidence.length) groupLines.push("- 证据：", ...evidence.map((line) => "  " + line));
    else groupLines.push("- 证据：[ " + group + "｜本时段｜无明确发言 ]");
    groupLines.push("");
  }
  const groupsFile = writeText(outFile(outDir, "group_daily_groups.md"), groupLines.join("\n"));
  return { topics: topicsFile, groups: groupsFile };
}

// ---------------------------------------------------------------------------
// 重点联系人私聊日报
// ---------------------------------------------------------------------------

const CONTACT_ACK_RE = /^(?:(?:好(?:的|呀|滴)?|收到|明白|嗯+|没问题|可以|谢谢(?:老师)?|辛苦(?:老师)?了?|不客气)[呀啊哈啦~～，,、。！!\s]*)+$/i;
const CONTACT_REQUEST_RE = /请问|麻烦|方便|能否|可以吗|怎么|多少|什么时候|哪天|确认一下|回复一下|发我|给我|报价|预算|费用|价格|brief|排期|初稿|二稿|终稿|审核|修改|结算|付款|发票|invoice|payment|\?|？/i;

/** 回复方向建议 */
function contactDirection(content) {
  const text = String(content ?? "");
  if (/结算|付款|打款|发票|invoice|payment/i.test(text)) return "先核对发布与结算材料，直接回复缺什么、何时可以补齐。";
  if (/审核|修改|反馈|初稿|二稿|终稿/i.test(text)) return "直接确认修改范围和下一版时间，不重复介绍背景。";
  if (/报价|预算|费用|价格|多少/i.test(text)) return "先回答报价问题；只补问缺失的交付形式、授权范围和排期。";
  if (/brief|需求|素材|卖点/i.test(text)) return "确认已收到需求，集中列出待确认项并给出下一节点。";
  if (/排期|时间|什么时候|哪天|发布/i.test(text)) return "给明确可执行日期；暂时不能确认时，说明最晚何时回准信。";
  if (CONTACT_REQUEST_RE.test(text)) return "先直接回答对方最后一个问题，再补一句明确的下一步。";
  return "承接对方最新内容并推进到下一节点；没有新信息时不要为了回复而回复。";
}

/** 归一化联系人日报行 */
function contactRow(row) {
  const name = String(pick(row, ["联系人", "chat", "name"], "未命名联系人"));
  const lastTime = pick(row, ["最后时间", "last_ts", "last_time"], 0);
  const lastContent = String(pick(row, ["最后消息", "last_content", "content"], ""));
  const fromOwner = Boolean(pick(row, ["最后是否本人", "last_from_owner"], false));
  let status = flat(pick(row, ["状态", "status"], ""));
  if (!status) {
    if (fromOwner) status = "等待对方";
    else if (CONTACT_ACK_RE.test(flat(lastContent))) status = "无需立即回复";
    else if (CONTACT_REQUEST_RE.test(lastContent)) status = "待回复";
    else status = "留意";
  }
  const advice = flat(pick(row, ["回复建议", "reply_direction", "advice"], "")) || contactDirection(lastContent);
  return {
    name,
    role: String(pick(row, ["角色", "role"], "未分类联系人")),
    status,
    messages: num(pick(row, ["消息数", "messages", "count"], 0)),
    lastTimeText: timeText(lastTime),
    lastSender: String(pick(row, ["最后发言人", "last_sender", "sender"], "")),
    lastContent: cut(lastContent, 220),
    advice,
    promise: pick(row, ["历史承诺", "promise", "open_promise"], null),
    opportunity: pick(row, ["商机", "opportunity"], null),
    recent: arr(pick(row, ["最近消息", "recent"], [])),
    commercial: num(pick(row, ["商业消息数", "commercial_messages"], 0)),
  };
}

/**
 * 渲染重点联系人私聊日报。
 * @param {Array<object>} rows 联系人行（兼容上游中文列与本地英文结构）
 * @param {{since?:string, until?:string, outDir:string, scope?:string}} options
 * @returns {{digest:string, json:string}} 两个产物的绝对路径
 */
export function renderContactDaily(rows, options = {}) {
  const outDir = options.outDir ?? ".";
  const scope = options.scope ?? loadProfile()?.contact_daily?.scope ?? "hybrid";
  const since = options.since ?? "";
  const until = options.until ?? "";
  const contacts = arr(rows).map(contactRow);
  const statusRank = { 待兑现: 5, 待回复: 4, 等待对方: 3, 留意: 2, 无需立即回复: 1 };
  contacts.sort((a, b) => (statusRank[b.status] ?? 0) - (statusRank[a.status] ?? 0)
    || num(pick(b.opportunity ?? {}, ["priority", "优先级"], 0)) - num(pick(a.opportunity ?? {}, ["priority", "优先级"], 0))
    || b.messages - a.messages);
  const counts = { 待兑现: 0, 待回复: 0, 等待对方: 0, 留意: 0, 无需立即回复: 0 };
  for (const row of contacts) counts[row.status] = (counts[row.status] ?? 0) + 1;

  const lines = [
    "# 重点联系人私聊日报",
    "",
    "> " + since + " 至 " + until + "｜覆盖 " + contacts.length + " 个重点联系人",
    "",
    "## 一眼结论",
    "",
    "- 待兑现：**" + counts["待兑现"] + "** 个",
    "- 待回复：**" + counts["待回复"] + "** 个",
    "- 等待对方：**" + counts["等待对方"] + "** 个",
    "- 留意：**" + counts["留意"] + "** 个",
    "- 无需立即回复：**" + counts["无需立即回复"] + "** 个",
    "",
    "## 先处理这些",
    "",
  ];
  const pending = contacts.filter((row) => row.status === "待兑现" || row.status === "待回复");
  if (!pending.length) lines.push("当前窗口没有检出待兑现承诺或明确待回复的重点联系人。");
  for (const row of pending.slice(0, 12)) {
    const stage = row.opportunity ? "；商机阶段：" + String(pick(row.opportunity, ["stage", "阶段"], "未知")) : "";
    lines.push("- **" + row.name + "｜" + row.role + "**：" + (row.lastContent || "无可用内容") + stage + " 回复方向：" + row.advice);
  }
  lines.push("", "## 按联系人查看", "", "> 点击联系人展开最近消息和当前商机。", "");
  for (const row of contacts) {
    lines.push(
      "<details>",
      "<summary><strong>" + row.name + "</strong>｜" + row.role + "｜" + row.status + "｜" + row.messages + " 条</summary>",
      "",
      "- **最后消息**：" + row.lastTimeText + (row.lastSender ? "｜" + row.lastSender : "") + "：" + (row.lastContent || "无"),
      "- **回复建议**：" + row.advice,
    );
    if (row.opportunity) {
      lines.push("- **当前商机**：#" + String(pick(row.opportunity, ["id"], "?")) + "｜" + String(pick(row.opportunity, ["stage", "阶段"], "未知")) + "｜" + String(pick(row.opportunity, ["next_action", "下一步"], "待人工确认")));
    }
    if (row.promise) {
      lines.push("- **未兑现承诺**：" + flat(pick(row.promise, ["时间", "time"], "")) + "｜" + cut(pick(row.promise, ["内容", "content"], ""), 160) + "｜" + flat(pick(row.promise, ["下一步", "action"], "完成后向对方同步结果")));
    }
    lines.push("", "### 最近消息", "");
    if (!row.recent.length) lines.push("- 本时段没有可展开的最近消息。");
    for (const message of row.recent.slice(-6)) {
      lines.push("- **" + timeText(pick(message, ["ts", "time", "时间"], 0)) + "｜" + String(pick(message, ["sender", "发言人"], "")) + "**：" + cut(pick(message, ["content", "内容"], ""), 220));
    }
    lines.push("", "</details>", "");
  }
  lines.push("## 说明", "");
  if (scope === "priority_labels_only") {
    const labels = arr(loadProfile()?.labels?.priority);
    lines.push("- 本报告仅覆盖 Profile 重点标签：" + (labels.join("、") || "尚未设置") + "。未打这些标签的联系人不进入重点联系人页。");
  } else {
    lines.push("- 本报告覆盖个人 Profile 重点标签、开放商机、双向商业对话，或命中个人自定义重点主题的私聊。");
  }
  lines.push(
    "- 微信标签不自动等同于真实角色；具体身份仍需查看原始聊天核实。",
    "- 回复建议是方向，不会发送微信；金额、排期和承诺必须人工确认。",
  );
  const digest = writeText(outFile(outDir, "contact_daily_digest.md"), lines.join("\n"));
  const json = writeJsonRedacted(outFile(outDir, "contact_daily.json"), { since, until, scope, contacts });
  return { digest, json };
}

// ---------------------------------------------------------------------------
// 个人情报简报
// ---------------------------------------------------------------------------

/** 判断两个窗口的覆盖是否可比 */
function coverageComparable(current, previous) {
  const currentChats = num(current.chats, 0);
  const previousChats = num(previous.chats, 0);
  const currentMessages = num(current.messages, 0);
  const previousMessages = num(previous.messages, 0);
  if (!currentMessages || !previousMessages) return false;
  const chatRatio = Math.max(currentChats, previousChats) / Math.max(1, Math.min(currentChats, previousChats));
  const messageRatio = Math.max(currentMessages, previousMessages) / Math.max(1, Math.min(currentMessages, previousMessages));
  return chatRatio <= 3 && messageRatio <= 10;
}

function signed(value) {
  const n = Math.round(num(value, 0));
  return n >= 0 ? "+" + n : String(n);
}

/**
 * 渲染简报 brief.md。
 * @param {object} analysis signals.analyze 的结果
 * @param {{since?:string, until?:string, previous?:object, outDir:string, now?:Date, hours?:number, freshnessHours?:number}} options
 * @returns {string} brief.md 绝对路径
 */
export function renderBrief(analysis, options = {}) {
  const source = analysis ?? {};
  const outDir = options.outDir ?? ".";
  const now = options.now instanceof Date ? options.now : new Date();
  const sinceMs = num(source?.window?.sinceMs, now.getTime() - 24 * HOUR_MS);
  const untilMs = num(source?.window?.untilMs, now.getTime());
  const since = options.since ?? timeText(sinceMs);
  const until = options.until ?? timeText(untilMs);
  const hours = num(options.hours, Math.max(1, Math.round((untilMs - sinceMs) / HOUR_MS)));
  const sessions = arr(source.sessions);
  const currentMessages = num(source?.coverage?.messages, arr(source.messages).length);
  const currentChats = num(source?.coverage?.sessions, sessions.length);
  const previous = {
    messages: num(pick(options.previous ?? {}, ["messages", "消息数"], 0), 0),
    chats: num(pick(options.previous ?? {}, ["chats", "会话数"], 0)),
  };
  const hasPrevious = Boolean(options.previous);
  const freshnessRaw = options.freshnessHours ?? source.freshness_hours ?? pick(source.freshness ?? {}, ["data_age_hours"], null);
  const freshness = freshnessRaw === null || freshnessRaw === undefined ? null : num(freshnessRaw, 0);

  let changeLine;
  if (freshness !== null && freshness > 2) {
    changeLine = "- 变化：当前窗口尚未完整刷新，暂不解读环比；原始计数为消息 " + signed(currentMessages - previous.messages) + "、会话 " + signed(currentChats - previous.chats);
  } else if (!hasPrevious || !coverageComparable({ messages: currentMessages, chats: currentChats }, previous)) {
    changeLine = "- 变化：两个窗口的会话/消息覆盖差异过大，暂不解读环比；原始计数为消息 " + signed(currentMessages - previous.messages) + "、会话 " + signed(currentChats - previous.chats);
  } else {
    changeLine = "- 变化：消息 " + signed(currentMessages - previous.messages) + "；会话 " + signed(currentChats - previous.chats);
  }

  let freshnessNote;
  if (freshness === null) freshnessNote = "无法判断数据新鲜度。";
  else if (freshness > 2) freshnessNote = "⚠️ 最新索引距现在约 " + freshness.toFixed(1) + " 小时，涉及‘现在/最新’的判断应先刷新。";
  else freshnessNote = "最新索引距现在约 " + freshness.toFixed(1) + " 小时。";

  const lines = [
    "# 微信个人情报简报｜近 " + hours + " 小时",
    "",
    "- 当前窗口：" + since + " 至 " + until,
    "- 消息：" + currentMessages + " 条；会话：" + currentChats + " 个",
    "- 前一窗口：" + previous.messages + " 条；会话：" + previous.chats + " 个",
    changeLine,
    "- 数据新鲜度：" + freshnessNote,
    "",
    "## 待回复",
    "",
  ];
  const pendingReplies = arr(source.pendingReplies);
  if (!pendingReplies.length) lines.push("未检出明确待回复会话。");
  for (const item of pendingReplies.slice(0, 10)) {
    const kindLabel = String(pick(item, ["kind", "类型"], "private")) === "group" ? "群聊" : "私聊";
    lines.push("- **" + String(pick(item, ["chat", "会话"], "未知会话")) + "｜" + timeText(pick(item, ["ts", "时间"], 0)) + "｜" + kindLabel + "**：" + cut(pick(item, ["content", "内容"], ""), 160) + "（" + flat(pick(item, ["reason", "原因"], "")) + "）");
  }

  lines.push("", "## 待兑现承诺", "");
  const openPromises = arr(source.promises).filter((p) => !p.delivered);
  if (!openPromises.length) lines.push("当前窗口未检出尚无完成证据的明确承诺。");
  for (const item of openPromises.slice(0, 10)) {
    lines.push("- **" + String(pick(item, ["chat", "会话"], "未知会话")) + "｜" + timeText(pick(item, ["ts", "时间"], 0)) + "**：" + cut(pick(item, ["content", "内容"], ""), 160) + "；状态：" + String(pick(item, ["state", "状态"], "待兑现")) + (item.overdue ? "（已逾期）" : "") + "；下一步：完成这项承诺并向对方同步结果。");
  }

  const opportunities = arr(source.opportunities);
  const brandDeals = arr(source.brandDeals);
  const trainings = arr(source.trainings);
  const tracked = opportunities.length
    ? opportunities
    : [...brandDeals, ...trainings].filter((row) => pick(row, ["record_type"], "") === "opportunity" || num(pick(row, ["qualification"], 0)) >= 60);
  const candidates = opportunities.length
    ? arr(source.candidates)
    : [...brandDeals, ...trainings].filter((row) => !tracked.includes(row));

  lines.push("", "## 已确认或正在推进", "");
  if (!tracked.length) lines.push("当前窗口没有已人工分流且正在推进的商业机会。");
  for (const row of tracked.slice(0, 10)) {
    const follow = pick(row, ["next_follow_up", "跟进日期"], "");
    const stage = String(pick(row, ["stage", "阶段"], "")) || arr(pick(row, ["hits"], [])).slice(0, 2).join("、") || "推进中";
    const amount = arr(pick(row, ["amounts", "金额"], [])).join("、") || "未提及";
    lines.push("- **" + String(pick(row, ["chat", "会话"], "")) + "｜" + (String(pick(row, ["title", "标题"], "")) || String(pick(row, ["chat", "会话"], ""))) + "**：" + stage + "；把握度 " + String(pick(row, ["confidence", "置信度"], "中概率")) + "；金额 " + amount + (follow ? "；跟进 " + String(follow) : ""));
  }

  lines.push("", "## 待审核候选", "");
  if (!candidates.length) lines.push("当前窗口没有达到审核门槛的新候选。");
  else lines.push("> 以下内容尚未确认，不等于真实商单；确认后才进入正式合作管线。");
  for (const row of candidates.slice(0, 8)) {
    lines.push("- **" + String(pick(row, ["chat", "会话"], "")) + "**：" + String(pick(row, ["confidence", "置信度"], "待核实")) + "；命中：" + (arr(pick(row, ["hits"], [])).slice(0, 4).join("、") || "无") + "；需要人工判断是否推进。");
  }

  lines.push("", "## 重点私聊", "");
  const privateRows = sessions.filter((s) => String(pick(s, ["kind", "类型"], "private")) !== "group").slice(0, 6);
  if (!privateRows.length) lines.push("当前窗口暂无私聊。");
  for (const row of privateRows) {
    lines.push("- **" + String(pick(row, ["name", "会话"], "")) + "**：" + num(pick(row, ["messages", "消息数"], 0)) + " 条，商机命中 " + num(pick(row, ["deal_hits"], 0)) + " 条；最后由 " + String(pick(row, ["last_sender", "最后发言人"], "未知")) + " 发出；信号：" + (arr(pick(row, ["signals"], [])).join("、") || "无"));
  }

  lines.push("", "## 重点群聊", "");
  const groupRows = sessions.filter((s) => String(pick(s, ["kind", "类型"], "private")) === "group").slice(0, 6);
  if (!groupRows.length) lines.push("当前窗口暂无群聊。");
  for (const row of groupRows) {
    lines.push("- **" + String(pick(row, ["name", "群聊"], "")) + "**：" + num(pick(row, ["messages", "消息数"], 0)) + " 条 / " + num(pick(row, ["senders", "发言人数"], 0)) + " 人；主题：" + (arr(pick(row, ["topics"], [])).slice(0, 3).join("、") || "未识别") + "；信号：" + (arr(pick(row, ["signals"], [])).join("、") || "无"));
  }

  lines.push("", "## 主题变化", "");
  const topicCounts = new Map();
  for (const row of sessions) {
    for (const topic of arr(pick(row, ["topics"], []))) topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
  }
  if (!topicCounts.size) lines.push("暂无预设主题命中。");
  else {
    const top = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    lines.push("- " + top.map(([topic, count]) => topic + " " + count + " 个会话").join("；"));
  }

  lines.push("", "## 附件核验队列", "");
  const attachmentRe = /^\[(图片|文件|语音|视频|image|file|voice|video)\]$/i;
  const attachments = arr(source.messages).filter((m) => attachmentRe.test(flat(pick(m, ["content", "内容"], ""))));
  if (!attachments.length) lines.push("当前窗口没有待核验附件占位。");
  else {
    const seen = new Set();
    const unique = [];
    for (const item of [...attachments].reverse()) {
      const chat = String(pick(item, ["session_name", "chat", "群聊"], ""));
      if (seen.has(chat)) continue;
      seen.add(chat);
      unique.push(item);
      if (unique.length >= 5) break;
    }
    if (attachments.length > unique.length) lines.push("> 共 " + attachments.length + " 个附件占位；这里只列最近的 " + unique.length + " 个会话。");
    for (const item of unique) {
      lines.push("- **" + timeText(pick(item, ["ts", "时间"], 0)) + "｜" + String(pick(item, ["session_name", "chat", "群聊"], "")) + "｜" + String(pick(item, ["sender", "发言人"], "")) + "**：" + flat(pick(item, ["content", "内容"], "")));
    }
  }
  return writeText(outFile(outDir, "brief.md"), lines.join("\n"));
}

// ---------------------------------------------------------------------------
// 行动清单、待分流、联系人、回复建议与主题检索
// ---------------------------------------------------------------------------

const OPPORTUNITY_STATUS = { new: "待分流", active: "推进中", waiting: "等待对方", paused: "暂缓", won: "已成交", lost: "未成交" };
const OPPORTUNITY_RECORD = { candidate: "待审核候选", opportunity: "已确认商机", deal: "已确认商机" };
const OPPORTUNITY_CONFIDENCE = { high: "高概率", medium: "中概率", low: "待核实" };

/** 金额字段可能是字符串或数组 */
function amountText(value) {
  const list = arr(value).map((item) => flat(item)).filter(Boolean);
  if (list.length) return list.join("、");
  return flat(value);
}

/** 商机行的统一渲染 */
function opportunityLines(rows) {
  const lines = [];
  for (const row of arr(rows)) {
    if (!row || typeof row !== "object") continue;
    const id = pick(row, ["id", "编号"], "?");
    const title = String(pick(row, ["title", "标题"], "")) || String(pick(row, ["chat", "会话"], "未命名"));
    const status = OPPORTUNITY_STATUS[String(pick(row, ["status", "状态"], "new"))] ?? String(pick(row, ["status", "状态"], "待分流"));
    const record = OPPORTUNITY_RECORD[String(pick(row, ["record_type", "记录类型"], "candidate"))] ?? "待审核候选";
    const confidence = OPPORTUNITY_CONFIDENCE[String(pick(row, ["confidence", "置信度"], "medium"))] ?? "待核实";
    const stage = String(pick(row, ["stage", "阶段"], "未识别"));
    const type = String(pick(row, ["opportunity_type", "商机类型"], "商机"));
    const priority = num(pick(row, ["priority", "优先级"], 0));
    const amount = amountText(pick(row, ["amount", "amounts", "金额"], ""));
    const follow = String(pick(row, ["next_follow_up", "跟进日期"], ""));
    lines.push("- **#" + id + "｜" + title + "**：" + status + " / " + record + " / " + confidence + " / " + stage + " / " + type + "，优先级 " + priority
      + (amount ? "，预算/报价：" + amount : "") + (follow ? "，跟进：" + follow : ""));
    lines.push("  - 下一步：" + (String(pick(row, ["next_action", "下一步"], "")) || "待人工确认"));
    const evidenceCount = num(pick(row, ["evidence_count", "证据数"], arr(pick(row, ["evidence"], [])).length), 0);
    lines.push("  - 最后信号：" + (String(pick(row, ["last_signal_time", "最后信号"], "")) || "未知") + "；证据 " + evidenceCount + " 条");
    const reasons = String(pick(row, ["qualification_reasons", "晋级依据"], ""));
    if (reasons) lines.push("  - 晋级依据：" + cut(reasons, 160));
    const notes = String(pick(row, ["notes", "备注"], ""));
    if (notes) lines.push("  - 备注：" + cut(notes.split("\n").slice(-1)[0], 160));
  }
  return lines;
}

/** 今日行动的紧迫度评分 */
function urgencyScore(row, now) {
  let score = num(pick(row, ["priority", "优先级"], 0)) * 10;
  const follow = String(pick(row, ["next_follow_up", "跟进日期"], ""));
  if (follow) {
    const due = new Date(follow).getTime();
    if (Number.isFinite(due)) {
      const days = (due - now.getTime()) / DAY_MS;
      if (days <= 0) score += 40;
      else if (days <= 3) score += 20;
      else if (days <= 7) score += 8;
    }
  }
  const stage = String(pick(row, ["stage", "阶段"], ""));
  if (/结算|付款|发票|invoice|payment/i.test(stage)) score += 15;
  if (String(pick(row, ["record_type", "记录类型"], "")) === "candidate") score -= 10;
  if (/逾期|overdue/i.test(String(pick(row, ["status", "状态"], "")))) score += 30;
  return score;
}

/**
 * 渲染今日行动清单。
 * @param {Array<object>} items 商机行
 * @param {{outDir:string, now?:Date, limit?:number}} options
 * @returns {string} today.md 绝对路径
 */
export function renderToday(items, options = {}) {
  const outDir = options.outDir ?? ".";
  const now = options.now instanceof Date ? options.now : new Date();
  const limit = num(options.limit, 10);
  const rows = arr(items).slice().sort((a, b) => urgencyScore(b, now) - urgencyScore(a, now)).slice(0, limit);
  const lines = [
    "# 微信个人情报库｜今日行动",
    "",
    "- 生成时间：" + fmtLocal(now),
    "- 条目：" + rows.length + " 个（按紧迫度排序，最多 " + limit + " 条）",
  ];
  if (!rows.length) {
    lines.push("", "今天没有到期跟进或待处理商机。");
  } else {
    lines.push("- 说明：先处理到期跟进和待结算，再用 triage <ID> <决定> 更新结果。", "");
    lines.push(...opportunityLines(rows));
  }
  return writeText(outFile(outDir, "today.md"), lines.join("\n"));
}

/**
 * 渲染待分流情报清单。
 * @param {Array<object>} rows 商机候选行
 * @param {{outDir:string, limit?:number}} options
 * @returns {string} inbox.md 绝对路径
 */
export function renderInboxRows(rows, options = {}) {
  const outDir = options.outDir ?? ".";
  const limit = num(options.limit, 20);
  const list = arr(rows).slice(0, limit);
  const lines = [
    "# 微信个人情报库｜待分流情报",
    "",
    "- 待分流：" + list.length + " 个",
    "- 分流决定：pursue 推进、wait 等待、pause 暂缓、ignore 忽略、won 成交、lost 未成交。",
    "",
  ];
  if (!list.length) lines.push("当前没有需要人工分流的候选。");
  else lines.push(...opportunityLines(list));
  return writeText(outFile(outDir, "inbox.md"), lines.join("\n"));
}

const PERSON_PROMISE_RE = /我(?:会|来|可以|今晚|明天|之后|稍后|回头).{0,32}(?:整理|确认|回复|发|给|做|改|补|推进|安排|加热|转发|联系|提交|发布|完成|跟进|回传)|(?:整理好|写好|改好|确认后).{0,16}(?:发你|给你|回复你)/;
const PERSON_REQUEST_RE = /请问|麻烦|方便|能否|可以吗|什么时候|确认一下|发我|给我|回复|报价|预算|价位|价格|费用|多少钱|怎么收费|brief|排期/;
const PERSON_COMMERCIAL_RE = /合作|商单|推广|投放|品牌|报价|预算|brief|排期|发布|审核|结算|付款|培训|讲师|授课|工作坊|咨询|项目|招募|佣金|返佣|campaign|sponsor|invoice|payment/i;

/**
 * 渲染单个联系人的情报档案。
 * @param {object} dossier {chat, messages[], opportunities[], total, self_promises[], partner_requests[], commercial[]}
 * @param {{outDir:string}} options
 * @returns {string} person.md 绝对路径
 */
export function renderPerson(dossier, options = {}) {
  const outDir = options.outDir ?? ".";
  const data = dossier ?? {};
  const name = String(pick(data, ["chat", "name", "联系人", "会话"], "未知联系人"));
  const messages = arr(pick(data, ["messages", "消息", "最近消息"], []))
    .slice()
    .sort((a, b) => num(pick(a, ["ts", "time"], 0)) - num(pick(b, ["ts", "time"], 0)));
  const isSelf = (m) => Boolean(pick(m, ["is_owner", "是否本人"], false)) || isOwnerName(pick(m, ["sender", "发言人"], ""));
  const selfPromises = arr(pick(data, ["self_promises", "我答应过的事项"], [])).length
    ? arr(pick(data, ["self_promises", "我答应过的事项"], []))
    : messages.filter((m) => isSelf(m) && PERSON_PROMISE_RE.test(String(pick(m, ["content", "内容"], "")))).slice(-5);
  const partnerRequests = arr(pick(data, ["partner_requests", "对方近期要求"], [])).length
    ? arr(pick(data, ["partner_requests", "对方近期要求"], []))
    : messages.filter((m) => !isSelf(m) && PERSON_REQUEST_RE.test(String(pick(m, ["content", "内容"], "")))).slice(-5);
  const commercial = arr(pick(data, ["commercial", "商业相关时间线"], [])).length
    ? arr(pick(data, ["commercial", "商业相关时间线"], []))
    : messages.filter((m) => PERSON_COMMERCIAL_RE.test(String(pick(m, ["content", "内容"], "")))).slice(-8);
  const opportunities = arr(pick(data, ["opportunities", "开放商机"], []));
  const latest = messages[messages.length - 1] ?? null;
  const direction = latest ? (isSelf(latest) ? "我最后发出" : "对方最后发来") : "未知";
  let nextAction = String(pick(data, ["next_action", "当前建议"], ""));
  if (!nextAction) {
    nextAction = direction === "对方最后发来" ? "先回复对方最后一条消息" : "人工查看最近上下文";
    const first = opportunities[0];
    if (first && pick(first, ["next_action", "下一步"], "")) nextAction = String(pick(first, ["next_action", "下一步"], ""));
  }

  const lines = [
    "# 微信联系人情报：" + name,
    "",
    "- 已索引消息：" + num(pick(data, ["total", "已索引消息"], messages.length), messages.length) + " 条；本次分析最近 " + messages.length + " 条",
    "- 时间范围：" + (messages.length ? timeText(pick(messages[0], ["ts", "time"], 0)) + " 至 " + timeText(pick(latest, ["ts", "time"], 0)) : "无"),
    "- 最后消息方向：" + direction,
    "- 开放商机：" + opportunities.length + " 个",
    "- 当前建议：" + nextAction,
    "",
    "## 开放商机",
    "",
  ];
  if (!opportunities.length) lines.push("暂无已确认的开放商机。");
  for (const row of opportunities) {
    const follow = pick(row, ["next_follow_up", "跟进日期"], "");
    const amount = amountText(pick(row, ["amount", "amounts", "金额"], ""));
    lines.push("- **#" + String(pick(row, ["id"], "?")) + "｜" + String(pick(row, ["stage", "阶段"], "未识别")) + "｜优先级 " + num(pick(row, ["priority", "优先级"], 0)) + "**："
      + (String(pick(row, ["next_action", "下一步"], "")) || "待人工确认") + (follow ? "；跟进 " + String(follow) : "") + (amount ? "；金额 " + amount : ""));
  }

  lines.push("", "## 我答应过的事项", "");
  if (!selfPromises.length) lines.push("未检出明确承诺；仍需结合上下文人工确认。");
  for (const row of [...selfPromises].reverse()) {
    lines.push("- **" + timeText(pick(row, ["ts", "time"], 0)) + "**：" + cut(pick(row, ["content", "内容"], ""), 220));
  }

  lines.push("", "## 对方近期要求", "");
  if (!partnerRequests.length) lines.push("未检出明确要求。");
  for (const row of [...partnerRequests].reverse()) {
    lines.push("- **" + timeText(pick(row, ["ts", "time"], 0)) + "｜" + String(pick(row, ["sender", "发言人"], "")) + "**：" + cut(pick(row, ["content", "内容"], ""), 220));
  }

  lines.push("", "## 商业相关时间线", "");
  if (!commercial.length) lines.push("暂无明显商业信号。");
  for (const row of commercial) {
    lines.push("- **" + timeText(pick(row, ["ts", "time"], 0)) + "｜" + String(pick(row, ["sender", "发言人"], "")) + "**：" + cut(pick(row, ["content", "内容"], ""), 220));
  }

  lines.push("", "## 最近上下文", "");
  if (!messages.length) lines.push("暂无本地索引消息。");
  for (const row of messages.slice(-12)) {
    lines.push("- **" + timeText(pick(row, ["ts", "time"], 0)) + "｜" + String(pick(row, ["sender", "发言人"], "")) + "**：" + cut(pick(row, ["content", "内容"], ""), 220));
  }
  return writeText(outFile(outDir, "person.md"), lines.join("\n"));
}

/**
 * 渲染本地回复草稿。
 * @param {object} draft {chat, recommended, relationship, intent, reply_needed, owner_sent_last, closure, style, chat_style, opportunity, promises[], latest_incoming, style_days}
 * @param {{outDir:string}} options
 * @returns {string} reply.md 绝对路径
 */
export function renderReply(draft, options = {}) {
  const outDir = options.outDir ?? ".";
  const data = draft ?? {};
  const name = String(pick(data, ["chat", "name", "联系人"], "未知联系人"));
  const recommended = String(pick(data, ["recommended", "draft", "草稿", "建议发"], ""));
  const relationship = String(pick(data, ["relationship", "关系"], "未知关系"));
  const intent = String(pick(data, ["intent", "意图"], "general"));
  const ownerSentLast = Boolean(pick(data, ["owner_sent_last"], false));
  const closure = Boolean(pick(data, ["closure"], false));
  const replyNeeded = Boolean(pick(data, ["reply_needed"], Boolean(recommended)));
  const styleDays = num(pick(data, ["style_days"], 30), 30);
  const style = pick(data, ["style", "global_style"], {}) ?? {};
  const chatStyle = pick(data, ["chat_style"], {}) ?? {};
  const latest = pick(data, ["latest_incoming", "最近对方"], null);

  const lines = [
    "# 微信回复建议：" + name,
    "",
    "> 只生成本地草稿，不会发送、转发或操作微信。发送前核对事实、金额、日期和承诺。",
    "",
    "## 建议",
    "",
  ];
  if (ownerSentLast) {
    lines.push("不用再回。你已经发过消息，等对方下一条。");
  } else if (closure) {
    lines.push("不用特意回；熟人可以补一个表情。");
  } else if (recommended) {
    lines.push("> " + recommended);
  } else {
    lines.push("暂时没有需要回复的消息。");
  }
  lines.push(
    "",
    "## 判断",
    "",
    "- " + relationship + " · " + intent + " · " + (replyNeeded ? "需要回复" : "无需追发"),
    "- 最近对方：" + (latest ? timeText(pick(latest, ["ts", "time"], 0)) + "｜" + cut(pick(latest, ["content", "内容"], ""), 120) : "未找到"),
    "- 近 " + styleDays + " 天个人习惯：" + num(pick(style, ["pct_le20"], 0), 0) + "% 的私聊不超过 20 字；默认只给一条短回复。",
  );
  if (num(pick(chatStyle, ["messages"], 0), 0)) {
    lines.push("- 本会话习惯：样本 " + num(pick(chatStyle, ["messages"], 0), 0) + " 条；常用确认词 " + (String(pick(chatStyle, ["preferred_ack"], "")) || "无明显偏好") + "。");
  }
  const opportunity = pick(data, ["opportunity", "商机"], null);
  if (opportunity) {
    lines.push("- 商机：#" + String(pick(opportunity, ["id"], "?")) + "｜" + String(pick(opportunity, ["stage", "阶段"], "未识别")) + "｜" + (String(pick(opportunity, ["next_action", "下一步"], "")) || "待确认"));
  }
  const promises = arr(pick(data, ["promises", "承诺"], []));
  if (promises.length && replyNeeded) {
    lines.push("- 注意已有承诺：" + cut(pick(promises[promises.length - 1], ["content", "内容"], ""), 100));
  }
  return writeText(outFile(outDir, "reply.md"), lines.join("\n"), { mask: false }); // 回复草稿：人要照发的正文，不做落盘打码
}

const TOPIC_EXPANSIONS = {
  培训: ["培训", "讲师", "授课", "工作坊", "课程", "教练"],
  赚钱: ["赚钱", "变现", "收入", "报价", "预算", "佣金", "付费", "项目合作"],
  商单: ["商单", "品牌合作", "推广", "投放", "campaign", "sponsor", "brief"],
  结算: ["结算", "付款", "打款", "到账", "发票", "invoice", "payment"],
};

/** 主题词扩展（与上游口径一致） */
export function expandTopicTerms(topic, extraKeywords = []) {
  const terms = [];
  for (const value of [topic, ...arr(extraKeywords)]) {
    const cleanValue = String(value ?? "").trim();
    if (!cleanValue) continue;
    for (const term of TOPIC_EXPANSIONS[cleanValue] ?? [cleanValue]) {
      if (!terms.some((item) => item.toLowerCase() === term.toLowerCase())) terms.push(term);
    }
  }
  return terms;
}

/**
 * 渲染跨会话主题检索报告。
 * @param {object} topicData {topic, extra_keywords[], since, messages[], chats, ranked[]}
 * @param {{outDir:string}} options
 * @returns {string} topic.md 绝对路径
 */
export function renderTopic(topicData, options = {}) {
  const outDir = options.outDir ?? ".";
  const data = topicData ?? {};
  const topic = String(pick(data, ["topic", "主题"], "未命名主题"));
  const terms = arr(pick(data, ["terms", "检索词"], [])).length
    ? arr(pick(data, ["terms", "检索词"], []))
    : expandTopicTerms(topic, pick(data, ["extra_keywords", "extras"], []));
  const messages = arr(pick(data, ["messages", "命中消息"], []));
  const byChat = new Map();
  for (const message of messages) {
    const chat = String(pick(message, ["session_name", "chat", "群聊", "会话"], "未知会话"));
    if (!byChat.has(chat)) byChat.set(chat, []);
    byChat.get(chat).push(message);
  }
  const ranked = arr(pick(data, ["ranked", "重点会话"], [])).length
    ? arr(pick(data, ["ranked", "重点会话"], []))
    : [...byChat.entries()].map(([chat, list]) => ({
      chat,
      messages: list,
      kind: String(pick(list[0], ["session_kind", "kind", "类型"], "")) || classifyChat(chat),
      commercial: list.filter((m) => PERSON_COMMERCIAL_RE.test(String(pick(m, ["content", "内容"], "")))).length,
    }));
  const chatCount = num(pick(data, ["chats", "涉及会话"], byChat.size), byChat.size);

  const lines = [
    "# 微信主题情报：" + topic,
    "",
    "- 检索词：" + (terms.join("、") || topic),
    "- 时间起点：" + (String(pick(data, ["since", "时间起点"], "")) || "不限"),
    "- 命中消息：" + messages.length + " 条；涉及会话：" + chatCount + " 个",
    "",
    "## 重点会话",
    "",
  ];
  if (!ranked.length) lines.push("暂无命中。");
  for (const entry of ranked) {
    const list = arr(pick(entry, ["messages", "消息"], [])).slice().sort((a, b) => num(pick(a, ["ts", "time"], 0)) - num(pick(b, ["ts", "time"], 0)));
    const chat = String(pick(entry, ["chat", "会话"], "未知会话"));
    const kindLabel = String(pick(entry, ["kind", "类型"], "private")) === "group" ? "群聊" : "私聊";
    const commercial = num(pick(entry, ["commercial", "商业相关"], 0), list.filter((m) => PERSON_COMMERCIAL_RE.test(String(pick(m, ["content", "内容"], "")))).length);
    lines.push("### " + chat + "｜" + kindLabel + "｜" + list.length + " 条｜商业相关 " + commercial + " 条｜最后 " + (list.length ? timeText(pick(list[list.length - 1], ["ts", "time"], 0)) : "未知"), "");
    for (const message of list.slice(-3)) {
      lines.push("- **" + timeText(pick(message, ["ts", "time"], 0)) + "｜" + String(pick(message, ["sender", "发言人"], "")) + "**：" + cut(pick(message, ["content", "内容"], ""), 200));
    }
    lines.push("");
  }
  return writeText(outFile(outDir, "topic.md"), lines.join("\n"));
}

// ---------------------------------------------------------------------------
// 入口页、聊天记录、共同群、复联雷达、商机管线与索引
// ---------------------------------------------------------------------------

/**
 * 渲染情报库入口页。
 * @param {object} state {latest_message, freshness, messages, open_opportunities, due_opportunities, inbox}
 * @param {{outDir:string, now?:Date}} options
 * @returns {string} home.md 绝对路径
 */
export function renderHome(state, options = {}) {
  const outDir = options.outDir ?? ".";
  const now = options.now instanceof Date ? options.now : new Date();
  const data = state ?? {};
  // homeState 的现行形状：freshness 是对象（freshnessLabel 才是给人看的文本）、计数在 counts 里；
  // 此前按旧扁平形状 String(pick(["freshness"])) 直接把对象拼成 [object Object]（契约测试内容层扫描捕获）。
  // 旧扁平形状（latest_message/messages/... 直挂顶层）仍兼容。
  const fresh = objPick(data, "freshness");
  const counts = objPick(data, "counts") ?? {};
  const triage = objPick(data, "triage") ?? {};
  const latest = flat(pick(data, ["latest_message", "最新索引"], "")) || flat(pick(fresh, ["last_message_at"], "")) || "无";
  const freshness = flat(pick(data, ["freshnessLabel", "新鲜度"], "")) || flat(pick(fresh, ["last_message_at"], "")) || "暂无索引";
  const totalMessages = num(counts.messages ?? pick(data, ["messages", "本地消息"], 0));
  const openOpportunities = num(counts.opportunities_open ?? pick(data, ["open_opportunities", "高优先级推进中"], 0));
  const dueOpportunities = num(counts.opportunities_due ?? pick(data, ["due_opportunities", "今日到期"], 0));
  const inboxCount = num(counts.inbox ?? pick(data, ["inbox", "待分流"], 0));
  const note = flat(pick(data, ["note"], ""));

  const lines = [
    "# 微信个人情报库｜入口",
    "",
    "- 最新索引：" + latest + "（" + freshness + "）",
    "- 本地消息：" + totalMessages + " 条",
    "- 高优先级推进中：" + openOpportunities + " 个；今日到期：" + dueOpportunities + " 个；近 24 小时待分流：" + inboxCount + " 个",
    "- 页面生成时间：" + fmtLocal(now),
    "",
    "## 五个入口",
    "",
    "1. **今日总览**：看近 24 小时变化、待回复、重点私聊和群聊。",
    "   工具：brief --hours 24",
    "2. **主题搜索**：跨群聊和私聊找一个主题，不受日报日期限制。",
    "   工具：topic <主题> --days 7",
    "3. **联系人**：查看双方要求、个人承诺、开放商机和最近上下文。",
    "   工具：person <联系人> --refresh",
    "4. **回复建议**：基于最近消息和商机状态生成草稿，必须人工确认后自行发送。",
    "   工具：reply <联系人>",
    "5. **商单雷达**：查看今日行动、待分流候选和完整商机管线。",
    "   工具：today / inbox / opportunities",
    "",
    "## 信息分流",
    "",
    "- **立即处理**：" + dueOpportunities + " 个已到期跟进；优先运行 today。",
    "- **值得关注**：近 24 小时有 " + inboxCount + " 个高优先级待分流候选；运行 inbox。",
    "- **仅供存档**：本时段归档 " + num(triage["仅供存档"]) + " 条，其余消息保留在本地索引，可通过 topic、person 或 db-search 按需检索。",
  ];
  if (note) lines.splice(lines.indexOf("## 五个入口"), 0, "> 提示：" + note, "");
  return writeText(outFile(outDir, "home.md"), lines.join("\n"));
}

/**
 * 渲染单个会话的聊天记录。
 * @param {Array<object>} rows 消息行
 * @param {{chat?:string, outDir:string, query?:string}} options
 * @returns {string} chat_history.md 绝对路径
 */
export function renderChatHistory(rows, options = {}) {
  const outDir = options.outDir ?? ".";
  const list = arr(rows).slice().sort((a, b) => num(pick(a, ["ts", "time"], 0)) - num(pick(b, ["ts", "time"], 0)));
  const chat = String(options.chat ?? pick(list[0] ?? {}, ["session_name", "chat", "会话"], "未知会话"));
  const lines = [
    "# 微信聊天记录：" + chat,
    "",
    "- 消息数：" + list.length,
    "- 时间范围：" + (list.length ? timeText(pick(list[0], ["ts", "time"], 0)) + " 至 " + timeText(pick(list[list.length - 1], ["ts", "time"], 0)) : "无"),
  ];
  if (options.query) lines.push("- 关键词：" + options.query);
  lines.push("");
  if (!list.length) lines.push("没有符合条件的消息。");
  for (const message of list) {
    lines.push("- **" + timeText(pick(message, ["ts", "time"], 0)) + "｜" + String(pick(message, ["sender", "发言人"], "")) + "**：" + cut(pick(message, ["content", "内容"], ""), 320));
  }
  return writeText(outFile(outDir, "chat_history.md"), lines.join("\n"));
}

/**
 * 渲染跨会话搜索结果（wai_chat_search 的 out 产物）。
 * 与 renderChatHistory 的差别：标题是检索而非会话记录，每条命中带会话归属
 * （search 可跨群命中，只显示发送者会丢证据上下文）。
 * @param {Array<object>} rows 命中消息行（含 session_name/chat、sender、ts、content）
 * @param {{query?:string, chat?:string, source?:string, outDir:string}} options
 * @returns {string} chat_search.md 绝对路径
 */
export function renderChatSearch(rows, options = {}) {
  const outDir = options.outDir ?? ".";
  const list = arr(rows).slice().sort((a, b) => num(pick(a, ["ts", "time"], 0)) - num(pick(b, ["ts", "time"], 0)));
  const lines = [
    "# 微信搜索结果：" + String(options.query ?? ""),
    "",
    "- 命中消息：" + list.length + " 条",
    "- 检索范围：" + (options.chat ? "会话「" + options.chat + "」" : "全部会话"),
  ];
  if (options.source) lines.push("- 数据源：" + String(options.source));
  lines.push(
    "- 时间范围：" + (list.length ? timeText(pick(list[0], ["ts", "time"], 0)) + " 至 " + timeText(pick(list[list.length - 1], ["ts", "time"], 0)) : "无"),
    "",
  );
  if (!list.length) lines.push("没有符合条件的消息。");
  for (const message of list) {
    lines.push("- **" + timeText(pick(message, ["ts", "time"], 0)) + "｜" + String(pick(message, ["session_name", "chat"], "未知会话")) + "｜" + String(pick(message, ["sender", "发言人"], "")) + "**：" + cut(pick(message, ["content", "内容"], ""), 320));
  }
  return writeText(outFile(outDir, "chat_search.md"), lines.join("\n"));
}

/**
 * 渲染共同群报告。
 * @param {object} data {contacts[], groups_scanned, matches[{display_name, chatroom_id, members[], messages[]}], since, until}
 * @param {{outDir:string}} options
 * @returns {string} common_groups.md 绝对路径
 */
export function renderCommonGroups(data, options = {}) {
  const outDir = options.outDir ?? ".";
  const payload = data ?? {};
  const matches = arr(pick(payload, ["matches", "命中共同群"], []));
  const contacts = arr(pick(payload, ["contacts", "联系人"], []));
  const contactNames = contacts.map((c) => String(pick(c, ["display_name", "name", "昵称"], ""))).filter(Boolean).join("、");
  const lines = [
    "# 微信共同群",
    "",
    "- 联系人：" + (contactNames || "未指定"),
    "- 扫描群聊：" + num(pick(payload, ["groups_scanned", "扫描群聊"], 0)) + " 个",
    "- 命中共同群：" + matches.length + " 个",
    "- 时间范围：" + (String(pick(payload, ["since", "开始"], "")) || "不限") + " 至 " + (String(pick(payload, ["until", "结束"], "")) || "不限"),
    "",
  ];
  if (!matches.length) lines.push("没有找到同时包含这些联系人的群聊。");
  for (const match of matches) {
    const members = arr(pick(match, ["members", "匹配成员"], [])).map((m) => String(pick(m, ["display_name", "name", "昵称"], ""))).filter(Boolean);
    const messages = arr(pick(match, ["messages", "消息"], []));
    lines.push(
      "## " + String(pick(match, ["display_name", "群名"], "未命名群聊")),
      "",
      "- 群 ID：" + String(pick(match, ["chatroom_id", "群ID"], "未知")),
      "- 匹配成员：" + (members.join("、") || "未知"),
      "- 时间范围内消息：" + messages.length + " 条",
      "",
    );
    for (const message of messages.slice(-30)) {
      lines.push("- **" + timeText(pick(message, ["ts", "time"], 0)) + "｜" + String(pick(message, ["sender", "发言人"], "")) + "**：" + cut(pick(message, ["content", "内容"], ""), 240));
    }
    lines.push("");
  }
  return writeText(outFile(outDir, "common_groups.md"), lines.join("\n"));
}

const REACTIVATION_BANDS = ["今天优先看", "待交接跟进", "等待区", "纯佣低优先级", "我方主动放弃"];
const REACTIVATION_BAND_BONUS = { 今天优先看: 40, 待交接跟进: 25, 等待区: 10, 纯佣低优先级: 0, 我方主动放弃: -10 };

/** 复联优先级分数 */
function reactivationScore(row) {
  const inactive = num(pick(row, ["inactive_days", "沉默天数"], 0));
  const messages = num(pick(row, ["messages", "消息数"], 0));
  const owners = num(pick(row, ["owner_messages", "我方消息数"], 0));
  const band = String(pick(row, ["band", "复联类型"], "等待区"));
  let score = Math.min(40, inactive) + Math.min(20, Math.round(messages / 5)) + Math.min(10, owners) + (REACTIVATION_BAND_BONUS[band] ?? 0);
  if (pick(row, ["closing"], false)) score -= 10;
  return clamp(Math.round(score), 0, 100);
}

/** 可发话术 */
function reactivationOpening(row) {
  const band = String(pick(row, ["band", "复联类型"], "等待区"));
  if (band === "待交接跟进") return "您好，之前对接的同事可能已经调整，想确认下现在这块由谁负责？我这边可以把之前的合作情况同步一份。";
  if (band === "纯佣低优先级") return "好久没联系，最近有没有预算制的合作项目？如果有合适的可以优先想到我。";
  if (band === "我方主动放弃") return "之前因为条件不太合适先搁置了，如果现在需求有变化，我们可以再聊一次。";
  if (band === "今天优先看") return "好久没联系，最近在忙什么？看到之前提到的新一批计划，想确认下时间点。";
  return "好久没联系，最近有合适的机会可以随时找我。";
}

/** 跟进日期与状态 */
function followUpState(row, today) {
  const date = String(pick(row, ["suggested_follow_up", "建议跟进日期"], "")).slice(0, 10);
  if (!date) return { date: "", state: "未排期" };
  return { date, state: date <= today ? "已到期" : "未到期" };
}

/**
 * 渲染品牌方复联雷达报告与候选 CSV。
 * @param {object} data {bands, all, inactive_days, immediate, labels[], since}
 * @param {{outDir:string, now?:Date}} options
 * @returns {{report:string, csv:string}} 两个产物的绝对路径
 */
export function renderReactivation(data, options = {}) {
  const outDir = options.outDir ?? ".";
  const now = options.now instanceof Date ? options.now : new Date();
  const payload = data ?? {};
  const rows = arr(pick(payload, ["all", "候选"], []));
  const labels = arr(pick(payload, ["labels", "标签范围"], []));
  const inactiveDays = num(pick(payload, ["inactive_days", "沉默阈值"], 21), 21);
  const since = String(pick(payload, ["since", "分析起点"], ""));
  const today = fmtDay(now);
  const upcomingEnd = fmtDay(new Date(now.getTime() + 14 * DAY_MS));
  const counts = new Map();
  for (const row of rows) {
    const band = String(pick(row, ["band", "复联类型"], "等待区"));
    counts.set(band, (counts.get(band) ?? 0) + 1);
  }
  const priorityRows = rows
    .filter((row) => followUpState(row, today).state === "已到期" && String(pick(row, ["band", "复联类型"], "")) !== "我方主动放弃")
    .sort((a, b) => reactivationScore(b) - reactivationScore(a));

  const lines = [
    "# 品牌方复联雷达",
    "",
    "- 生成时间：" + fmtLocal(now),
    "- 标签范围：" + (labels.join("、") || "全部联系人"),
    "- 分析起点：" + (since || "不限"),
    "- 复联沉默阈值：" + inactiveDays + " 天",
    "- 覆盖联系人：" + rows.length + " 个",
  ];
  for (const band of REACTIVATION_BANDS) lines.push("- " + band + "：" + (counts.get(band) ?? 0) + " 个");
  lines.push("", "## 今天优先看", "");
  if (!priorityRows.length) lines.push("今天没有到期的高优先级复联对象。");
  for (const row of priorityRows.slice(0, MAX_ACTION_ROWS)) {
    const band = String(pick(row, ["band", "复联类型"], "等待区"));
    const follow = followUpState(row, today);
    const inactive = num(pick(row, ["inactive_days", "沉默天数"], 0));
    lines.push("### " + String(pick(row, ["chat", "联系人"], "未知联系人")) + "｜" + band + "｜分数 " + reactivationScore(row), "");
    lines.push("- 状态：最后聊天 " + timeText(pick(row, ["last_ts", "最后聊天"], 0)) + "，沉默 " + inactive + " 天，消息 " + num(pick(row, ["messages", "消息数"], 0)) + " 条");
    if (follow.date) lines.push("- 跟进日期：" + follow.date + "（" + follow.state + "）");
    lines.push("- 阶段：" + band + "；" + (String(pick(row, ["reason", "复联原因"], "")) || "长期未联系"));
    lines.push("- 建议：" + (String(pick(row, ["suggested_action", "建议动作"], "")) || "先确认对方当前需求，再决定是否推进。"));
    const evidence = String(pick(row, ["note", "证据摘要", "reason"], ""));
    if (evidence) lines.push("- 证据：" + cut(evidence, 160));
    lines.push("- 可发：" + reactivationOpening(row), "");
  }
  if (priorityRows.length > MAX_ACTION_ROWS) {
    lines.push("另有 " + (priorityRows.length - MAX_ACTION_ROWS) + " 个已到期候选保留在 CSV，本报告不继续展开。", "");
  }

  const upcoming = rows
    .filter((row) => {
      const follow = followUpState(row, today);
      return follow.state === "未到期" && follow.date && follow.date <= upcomingEnd;
    })
    .sort((a, b) => followUpState(a, today).date.localeCompare(followUpState(b, today).date) || reactivationScore(b) - reactivationScore(a));
  lines.push("## 接下来 14 天", "");
  if (!upcoming.length) lines.push("未来 14 天没有已排定的跟进提醒。", "");
  for (const row of upcoming.slice(0, MAX_ACTION_ROWS)) {
    const follow = followUpState(row, today);
    lines.push("- **" + follow.date + "｜" + String(pick(row, ["chat", "联系人"], "未知联系人")) + "**：" + String(pick(row, ["band", "复联类型"], "等待区")) + "。" + (String(pick(row, ["suggested_action", "建议动作"], "")) || "按约定时间跟进。"));
  }

  lines.push("", "## 暂缓/低优先级", "");
  const rest = rows.filter((row) => !priorityRows.includes(row) && !upcoming.includes(row));
  if (!rest.length) lines.push("没有暂缓或低优先级对象。");
  for (const row of rest.slice(0, MAX_RADAR_LINKS)) {
    lines.push("- **" + String(pick(row, ["chat", "联系人"], "未知联系人")) + "**：" + String(pick(row, ["band", "复联类型"], "等待区")) + "，最后聊天 " + timeText(pick(row, ["last_ts", "最后聊天"], 0)) + "。"
      + (String(pick(row, ["suggested_action", "建议动作"], "")) || "暂不需要动作。"));
  }
  if (rest.length > MAX_RADAR_LINKS) lines.push("- 另有 " + (rest.length - MAX_RADAR_LINKS) + " 个低优先级对象仅保留在 CSV。");

  const report = writeText(outFile(outDir, "reactivation_report.md"), lines.join("\n"));
  const csvRows = rows.map((row) => {
    const follow = followUpState(row, today);
    const band = String(pick(row, ["band", "复联类型"], "等待区"));
    return {
      联系人: String(pick(row, ["chat", "联系人"], "")),
      复联类型: band,
      分数: reactivationScore(row),
      沉默天数: num(pick(row, ["inactive_days", "沉默天数"], 0)),
      最后聊天时间: timeText(pick(row, ["last_ts", "最后聊天"], 0)),
      最后一条方向: String(pick(row, ["last_sender", "最后发言人"], "")),
      消息数: num(pick(row, ["messages", "消息数"], 0)),
      我方消息数: num(pick(row, ["owner_messages", "我方消息数"], 0)),
      建议跟进日期: follow.date,
      跟进状态: follow.state,
      建议动作: String(pick(row, ["suggested_action", "建议动作"], "")),
      证据摘要: cut(pick(row, ["note", "reason", "证据摘要"], ""), 160),
      可发话术: reactivationOpening(row),
    };
  });
  const csv = writeText(outFile(outDir, "reactivation_candidates.csv"), toCsv(csvRows, ["联系人", "复联类型", "分数", "沉默天数", "最后聊天时间", "最后一条方向", "消息数", "我方消息数", "建议跟进日期", "跟进状态", "建议动作", "证据摘要", "可发话术"]));
  return { report, csv };
}

/**
 * 渲染完整商机管线。
 * @param {Array<object>} rows 商机行
 * @param {{outDir:string, title?:string}} options
 * @returns {string} opportunities.md 绝对路径
 */
export function renderOpportunities(rows, options = {}) {
  const outDir = options.outDir ?? ".";
  const title = String(options.title ?? "微信商机管线");
  const list = arr(rows);
  const lines = ["# " + title, "", "- 商机条目：" + list.length + " 个", ""];
  if (!list.length) lines.push("暂无符合条件的商机。");
  else lines.push(...opportunityLines(list));
  return writeText(outFile(outDir, "opportunities.md"), lines.join("\n"));
}

/**
 * 渲染 Markdown 站点导航索引。
 * @param {string} title 站点标题
 * @param {Array<object>} pages [{filename, title, description, navLabel, route}]
 * @param {{outDir:string, now?:Date}} options
 * @returns {string} index.md 绝对路径
 */
export function renderIndex(title, pages, options = {}) {
  const outDir = options.outDir ?? ".";
  const now = options.now instanceof Date ? options.now : new Date();
  const list = arr(pages);
  const lines = [
    "# " + String(title ?? "微信个人情报库"),
    "",
    "> 生成时间：" + fmtLocal(now) + "｜" + list.length + " 个阅读分区｜内容按主题拆分，不纵向拼成长文。",
    "",
    "## 阅读入口",
    "",
  ];
  for (const page of list) {
    const file = String(pick(page, ["filename", "文件"], ""));
    const label = String(pick(page, ["title", "标题"], "")) || String(pick(page, ["navLabel", "简称"], file));
    const description = String(pick(page, ["description", "描述"], ""));
    lines.push("- [" + label + "](" + file + ")" + (description ? "：" + description : ""));
  }
  if (!list.length) lines.push("- 本轮没有可用的 Markdown 分区。");
  lines.push(
    "",
    "## 阅读说明",
    "",
    "- 所有微信读取均为本地只读，报告不会自动发送消息。",
    "- 回复建议只是草稿，必须人工确认后自行发送。",
    "- 机器初筛与证据附录保留在本地运行目录，不作为主要阅读入口。",
  );
  return writeText(outFile(outDir, "index.md"), lines.join("\n"));
}
