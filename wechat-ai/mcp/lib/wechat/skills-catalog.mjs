// 内置技能目录：复刻微信流 Resources/Skills 随包发布的两个官方技能。
// 设计边界（与上游一致）：本模块只负责"把技能要求写成提示词、并把结构化外壳准备好"，
// 真正的推理、抓正文、OCR、语音转写都由调用方 Agent 完成——这里不假装已经做过。
import fs from "node:fs";
import path from "node:path";
import { paths, runDir, timestampSlug } from "../paths.mjs";
import { safeFileName, slugify } from "../util.mjs";

/** 技能清单版本（对应上游 catalog.json 的 schema_version） */
export const CATALOG_SCHEMA_VERSION = 1;

/** 技能 ID 规范：小写字母、数字与单个连字符，最长 64（Agent Skills 命名规范） */
export const SKILL_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 上游点号 ID → 规范 ID 的迁移表 */
export const LEGACY_SKILL_IDS = {
  "wechatbridge.wechat-article-extract": "wechat-article-extract",
  "wechatbridge.video-information-reading": "video-information-reading",
};

export function normalizeSkillId(id) {
  const raw = String(id ?? "").trim();
  return LEGACY_SKILL_IDS[raw] ?? raw;
}

export function isValidSkillId(id) {
  const s = String(id ?? "");
  return s.length > 0 && s.length <= 64 && SKILL_ID_RE.test(s);
}

/** 公共输出纪律：两个技能都要求"没有就说没有，不猜" */
const HONESTY_RULES = [
  "只使用输入内容里真实存在的文字；缺什么就写「未标注」「仅有链接，无法读取内容」，不要根据标题猜测正文。",
  "保持原文措辞，不做改写、评价或补全。",
  "保留原始链接、文件名与时间戳格式，不做换算。",
];

const ARTICLE_SKILL = {
  id: "wechat-article-extract",
  name: "公众号文章提取",
  version: "1.0.0",
  package: "wechat-article-extract",
  sourcePackage: "Resources/Skills/wechat-article-extract/SKILL.md",
  supportedAgents: ["codex", "claude-code", "doubao", "qwen-work", "workbuddy"],
  description:
    "从微信聊天记录导出内容中识别公众号文章链接或分享卡片，提取标题、公众号、发布时间、核心观点、关键数据、可执行结论与正文图片，并保留原文链接。",
  whenToUse:
    "当用户要求整理、摘录或归档聊天记录里的公众号文章，或群里一天分享多篇文章需要先摘要再决定是否深读时使用。",
  inputContract: {
    accepts: [
      "微信「合并转发」导出的聊天记录 ZIP，或其中解压出的文本、HTML 与图片附件",
      "已整理成 Markdown/纯文本的聊天片段",
    ],
    shapes: [
      "聊天记录里的 mp.weixin.qq.com 链接",
      "分享卡片（标题 + 公众号名 + 链接，可能带封面图）",
      "已随记录一起导出的文章正文或截图",
    ],
    required: ["至少一条公众号文章链接或分享卡片"],
  },
  outputContract: {
    sections: ["标题", "公众号（作者）", "发布时间", "核心观点", "关键数据", "可执行结论", "正文", "图片", "原文链接"],
    summaryTable: ["编号", "标题", "公众号", "是否有正文"],
    fallbacks: ["仅有链接，未含正文", "未标注", "跳过的其他链接"],
  },
  outline: [
    "## {n}. {标题}",
    "- 公众号（作者）：{名称或「未标注」}",
    "- 发布时间：{时间或「未标注」}",
    "- 原文链接：{完整 mp.weixin.qq.com URL}",
    "- 图片：{附件内原始文件名列表或「无」}",
    "",
    "### 核心观点",
    "- {逐条列出，每条一句话}",
    "",
    "### 关键数据",
    "- {数字、比例、金额、时间，注明出处或「无」}",
    "",
    "### 可执行结论",
    "- {读完这篇能立刻做什么，或「无明确结论」}",
    "",
    "### 正文",
    "{整理后的正文，或「仅有链接，未含正文」}",
    "",
    "（全部文章之后附汇总表：编号 / 标题 / 公众号 / 是否有正文；末尾列一行「跳过的其他链接」）",
  ].join("\n"),
  steps: [
    "扫描全部输入，找出公众号文章的链接与分享卡片，按出现顺序编号。",
    "逐篇提取标题、公众号、发布时间、正文、图片与原文链接。",
    "输入里没有正文时明确标注「仅有链接，无法读取正文」，不要编造内容。",
    "只处理公众号文章；普通网页、小程序卡片不算，但在汇总表末尾列一行「跳过的其他链接」。",
    "图片引用使用附件内的原始文件名，不复制、不重命名文件。",
  ],
  notes: [
    ...HONESTY_RULES,
    "抓取正文需要联网时，先说明这一步由你（Agent）执行；本工具不联网、不代抓。",
  ],
};

const VIDEO_SKILL = {
  id: "video-information-reading",
  name: "视频信息读取",
  version: "1.0.0",
  package: "video-information-reading",
  sourcePackage: "Resources/Skills/video-information-reading/SKILL.md",
  supportedAgents: ["codex", "claude-code", "doubao", "qwen-work", "workbuddy"],
  description:
    "从聊天记录里找出视频号、B 站、抖音、YouTube 链接或本地视频文件，整理主题、结论、论据、可行动项、待核实项与关键时间点，并保留来源。",
  whenToUse:
    "当用户要求解读、总结或归档聊天记录里的视频内容，或视频号分享卡片需要变成可检索笔记时使用。",
  inputContract: {
    accepts: ["聊天记录文本或 ZIP 导出", "视频平台链接、分享卡片、本地视频文件名或视频截图"],
    shapes: [
      "视频平台链接（视频号、B 站、抖音、YouTube 等）",
      "视频号/小程序分享卡片（标题 + 来源 + 封面图）",
      "随记录导出的本地视频文件（mp4 等）或视频截图",
    ],
    required: ["至少一条视频链接、分享卡片或视频附件"],
  },
  outputContract: {
    sections: ["来源", "标题", "链接或文件名", "时长", "主题", "结论", "论据", "可行动项", "待核实项", "摘要", "关键时间点"],
    summaryTable: ["编号", "标题", "来源", "是否有可读内容"],
    fallbacks: ["仅有链接，无法读取内容", "无时间信息", "未知", "跳过的其他附件"],
  },
  outline: [
    "## {n}. {标题}",
    "- 来源：{平台名称：视频号 / bilibili / 抖音 / 本地文件}",
    "- 链接或文件名：{完整 URL 或附件内文件名}",
    "- 时长：{已知时长或「未知」}",
    "",
    "### 主题",
    "{这条视频在讲什么，一句话}",
    "",
    "### 结论",
    "- {视频给出的结论，逐条列出}",
    "",
    "### 论据",
    "- {支撑结论的事实、数据、案例；注明来自字幕/转写/简介}",
    "",
    "### 可行动项",
    "- {看完可以立刻做的事，或「无」}",
    "",
    "### 待核实项",
    "- {视频里未证实、需要自己验证的说法，或「无」}",
    "",
    "### 摘要",
    "{基于附件里实际存在的文字信息归纳，或「仅有链接，无法读取内容」}",
    "",
    "### 关键时间点",
    "- {mm:ss} {话题}（没有字幕或转写时写「无时间信息」）",
    "",
    "（全部视频之后附汇总表：编号 / 标题 / 来源 / 是否有可读内容；末尾列一行「跳过的其他附件」）",
  ].join("\n"),
  steps: [
    "扫描全部输入，找出视频链接、分享卡片与视频文件，按出现顺序编号。",
    "逐条提取来源、标题、链接或文件名，以及输入中已经存在的简介、字幕、转写、截图文字。",
    "基于实际存在的文字写摘要；只有链接没有内容时标注「仅有链接，无法读取内容」。",
    "输入里有字幕或转写时标出关键时间点；没有就写「无时间信息」。",
    "只处理视频；图片和普通文件不算，但在汇总表末尾列一行「跳过的其他附件」。",
  ],
  notes: [
    ...HONESTY_RULES,
    "无法播放视频文件本身时如实说明，只整理附件中已有的文字信息。",
    "转录、OCR、语音识别由你（Agent）在本地或授权工具中完成；本工具不代做，也不声称已做完。",
  ],
};

/** 内置技能目录（与上游 Resources/Skills/catalog.json 一一对应） */
export const CATALOG = [ARTICLE_SKILL, VIDEO_SKILL];

/** 目录列表（浅拷贝，避免调用方改到常量内部结构） */
export function listSkills() {
  return CATALOG.map((s) => ({ ...s }));
}

/** 按 ID 取技能，未知返回 null（旧的微信流点号 ID 会自动迁移） */
export function getSkill(id) {
  const key = normalizeSkillId(id);
  const hit = CATALOG.find((s) => s.id === key) ?? null;
  return hit ? { ...hit } : null;
}

/** 技能要求的 Markdown 正文（对应上游 SKILL.md 的 输入/步骤/输出/注意） */
export function skillBody(skill) {
  const lines = [];
  lines.push("### 输入");
  for (const a of skill.inputContract.accepts) lines.push("- " + a);
  lines.push("", "可能的形态：");
  for (const s of skill.inputContract.shapes) lines.push("- " + s);
  lines.push("", "### 步骤");
  skill.steps.forEach((s, i) => lines.push(i + 1 + ". " + s));
  lines.push("", "### 输出");
  lines.push("按以下结构逐条输出，没有的信息写「无」：");
  for (const s of skill.outputContract.sections) lines.push("- " + s);
  lines.push("", "结构外壳：", "", "```markdown", skill.outline, "```");
  lines.push("", "### 注意");
  for (const n of skill.notes) lines.push("- " + n);
  return lines.join("\n");
}

/** 模板变量替换：未知变量原样保留；content 最后注入，避免内容里的 {{}} 被二次替换 */
function fillTemplate(template, vars) {
  let out = String(template);
  for (const [key, value] of Object.entries(vars)) {
    if (key === "content") continue;
    out = out.split("{{" + key + "}}").join(String(value ?? ""));
  }
  const body = String(vars.content ?? "");
  out = out.split("{{content}}").join(body);
  return out;
}

/**
 * 把用户选中的内容套进技能提示词。
 * @returns {{skill:object, prompt:string, expected:string}}
 */
export function buildSkillPrompt(skillId, content, { chat = "", title = "" } = {}) {
  const skill = getSkill(skillId);
  if (!skill) throw new Error("未知技能：" + String(skillId ?? "") + "（可用：" + CATALOG.map((s) => s.id).join("、") + "）");
  const text = String(content ?? "").trim();
  const head = [
    "# 任务：使用「" + skill.name + "」技能（" + skill.id + "）",
    "",
    "- 来源群名：" + (chat || "未标注"),
    "- 内容标题：" + (title || "未标注"),
    "- 处理时间：" + new Date().toLocaleString("zh-CN", { hour12: false }),
    "",
    "## 技能说明",
    "",
    skill.description,
    "",
    "## 适用场景",
    "",
    skill.whenToUse,
    "",
    "## 技能要求",
    "",
    skillBody(skill),
    "",
    "## 待处理内容",
    "",
    text || "（未提供内容）",
    "",
    "## 执行要求",
    "",
    "1. 严格按「技能要求」的输出结构作答；没有的信息写「无」或约定的回退文案。",
    "2. 只依据上面的待处理内容；需要联网抓取正文或需要转写音视频时，先说明这一步由你执行。",
    "3. 不要复述本提示词的说明文字，直接给结果。",
  ].join("\n");
  return { skill, prompt: head, expected: skill.outline };
}

/**
 * 本地生成技能提示词与结构化外壳（不做推理）。
 * @returns {{skillId:string, promptPath:string, prompt:string, summary:string, outlinePath:string, outDir:string}}
 */
export function runSkill(skillId, content, { chat = "", title = "", outDir = null } = {}) {
  const skill = getSkill(skillId);
  if (!skill) throw new Error("未知技能：" + String(skillId ?? "") + "（可用：" + CATALOG.map((s) => s.id).join("、") + "）");
  const dir = outDir ? path.resolve(outDir) : runDir("skill-" + skill.id, timestampSlug());
  fs.mkdirSync(dir, { recursive: true });
  const { prompt, expected } = buildSkillPrompt(skill.id, content, { chat, title });
  const stem = safeFileName(slugify(title || chat || "微信内容"), "微信内容");
  const promptPath = path.join(dir, stem + "." + skill.id + ".prompt.md");
  const outlinePath = path.join(dir, stem + "." + skill.id + ".outline.md");
  fs.writeFileSync(promptPath, prompt, "utf8");
  const summary = [
    "# 输出外壳：" + skill.name,
    "",
    "> 本文件只是结构化外壳。真正的推理（抓正文、读视频、OCR、语音转写）由接收提示词的 Agent 完成，",
    "> wechat-ai 不联网、不转写、不解析音视频，也不会假装已经做完这些步骤。",
    "",
    "用到的提示词：" + promptPath,
    "",
    expected,
    "",
  ].join("\n");
  fs.writeFileSync(outlinePath, summary, "utf8");
  return {
    skillId: skill.id,
    promptPath,
    prompt,
    summary,
    outlinePath,
    outDir: dir,
    expected,
    // 明确告知调用方：本地没有做任何模型推理
    inferredLocally: false,
  };
}

/** 技能目录落盘（可选，便于人工核对；默认写到输出目录） */
export function exportCatalog(file = null) {
  const target = file ?? path.join(paths().output, "skills-catalog.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = {
    schema_version: CATALOG_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    skills: CATALOG.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      when_to_use: s.whenToUse,
      version: s.version,
      package: s.package,
      supported_agents: s.supportedAgents,
    })),
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), "utf8");
  return target;
}
