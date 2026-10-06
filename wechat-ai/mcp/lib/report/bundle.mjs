// 报告打包层：发现 Markdown 源文件、分页、写 Markdown 站点、渲染旗舰 HTML。
import fs from "node:fs";
import path from "node:path";
import { ensureDir, atomicWrite, readJson, fmtLocal } from "../util.mjs";
import { renderFlagship, normalizeDetailsMarkdown, stripFirstH1, escapeText } from "./html.mjs";

/** 由本工具生成的聚合文件，不能作为输入源再次收录 */
const GENERATED_NAMES = new Set(["wechat_daily_full.md", "wechat_daily_report.md"]);

/** Markdown 站点目录名 */
const MARKDOWN_SITE_DIR = "wechat-report";

/** 已知文件 -> 标题 / 类别 / 优先级 / 是否默认折叠 */
const SOURCE_RULES = [
  ["final_report.md", "执行结论", "overview", 10, false],
  ["brief.md", "跨报告行动总览", "overview", 12, false],
  ["action_overview.md", "行动与商机机器总览", "internal", 79, true],
  ["group-daily/group_daily_topics.md", "话题日报", "groups", 20, false],
  ["group-daily/group_daily_groups.md", "重点群聊", "groups", 21, false],
  ["group-daily/group_daily_brief.md", "群聊日报", "groups", 22, false],
  ["contact-daily/contact_daily_brief.md", "重点联系人日报", "contacts", 30, false],
  ["group-daily/cross_group_links.md", "商单信号雷达", "radar", 40, false],
  ["group-daily/group_daily_appendix.md", "群聊证据附录", "internal", 80, true],
  ["group-daily/group_daily_digest.md", "群聊机器初筛", "internal", 81, true],
  ["group-daily/group_selection_matrix.md", "全部群聊价值矩阵", "internal", 82, true],
  ["contact-daily/contact_daily_digest.md", "私信机器初筛", "internal", 82, true],
];

/** 按文件名回退匹配：允许把「单个报告目录」（如 group-daily-20261003-0725/）直接打包 */
const BASENAME_RULES = new Map();
for (const rule of SOURCE_RULES) {
  const name = rule[0].split("/").pop();
  if (!BASENAME_RULES.has(name)) BASENAME_RULES.set(name, rule);
}

/** 顶层分区定义：route / 文件名 / 标题 / 导航简称 / 描述 / 字形 / 优先级 */
const PAGE_SPECS = [
  ["overview", "index.md", "综合行动报告", "综合行动", "先看结论、优先行动、正在推进的商机和覆盖范围。", "●", 10],
  ["groups", "groups.md", "群聊日报", "群聊日报", "在话题、重点群聊和全部群聊筛选之间切换；建议级别只针对本时段。", "#", 20],
  ["contacts", "contacts.md", "重点联系人", "重点联系人", "查看品牌方、中间人和自媒体博主的待回复、等待与复联。", "◎", 30],
  ["radar", "radar.md", "商单信号雷达", "信号雷达", "每个标准化链接只出现一次，用于判断哪些品牌正在集中投放。", "↗", 40],
  ["reports", "reports.md", "专题分析报告", "专题分析", "期间/关系/情绪/任务/财务/记忆/内容/团队/风控与复联等完整分析报告。", "▤", 50],
];

/** 源文件 id：相对路径 slug */
function slug(value) {
  const text = String(value ?? "").toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "-").replace(/^-+|-+$/g, "");
  return text || "section";
}

/** 取首个 H1 作为标题（去掉链接与强调标记） */
function markdownTitle(text, fallback) {
  const match = /^#\s+(.+?)\s*$/m.exec(String(text ?? ""));
  if (!match) return fallback;
  const value = match[1].replace(/\[([^\]]+)]\([^)]+\)/g, "$1").replace(/[#*_\x60]/g, "").trim();
  return value || fallback;
}

function ruleFor(relativePath) {
  for (const rule of SOURCE_RULES) {
    if (rule[0] === relativePath) return rule;
  }
  return null;
}

/** 递归收集 Markdown 文件（跳过点文件、点目录与生成目录） */
function collectMarkdown(root) {
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === MARKDOWN_SITE_DIR) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      found.push(full);
    }
  };
  walk(root);
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * 发现报告目录下的全部 Markdown 源文件。
 * @param {string} reportDir 报告目录
 * @returns {Array<{path:string, relativePath:string, sourceId:string, title:string, kind:string, priority:number, collapsed:boolean}>}
 */
export function discoverReportSources(reportDir) {
  const root = path.resolve(String(reportDir ?? "."));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("找不到报告目录：" + root);
  }
  const dualGroupReport = ["group_daily_topics.md", "group_daily_groups.md"]
    .some((name) => fs.existsSync(path.join(root, "group-daily", name)));
  const used = new Set();
  const sources = [];
  for (const full of collectMarkdown(root)) {
    const relativePath = path.relative(root, full).split(path.sep).join("/");
    if (GENERATED_NAMES.has(path.basename(full))) continue;
    if (dualGroupReport && relativePath === "group-daily/group_daily_brief.md") continue;
    let text = "";
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      text = "";
    }
    const rule = ruleFor(relativePath) ?? BASENAME_RULES.get(path.basename(relativePath));
    const title = rule ? rule[1] : markdownTitle(text, path.basename(full, ".md").replace(/_/g, " "));
    // 未知来源不再落 "other" 被 buildPages 静默丢弃（F11：枚举进 sources 却不渲染、搜索也搜不到），
    // 统一归入 "reports" 分区可见展示；只有显式 internal 规则才刻意不进阅读站。
    const kind = rule ? rule[2] : "reports";
    const priority = rule ? rule[3] : 60;
    const collapsed = rule ? rule[4] : true;
    const base = slug(relativePath.replace(/\.md$/i, ""));
    let sourceId = base;
    let suffix = 2;
    while (used.has(sourceId)) {
      sourceId = base + "-" + suffix;
      suffix += 1;
    }
    used.add(sourceId);
    sources.push({ path: full, relativePath, sourceId, title, kind, priority, collapsed, markdown: text });
  }
  return sources.sort((a, b) => a.priority - b.priority || a.relativePath.localeCompare(b.relativePath));
}

/**
 * 按顶层分区切分源文件：只有非空类别才会成为分区。
 * @param {Array} sources discoverReportSources 的结果
 */
export function buildPages(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const pages = [];
  for (const spec of PAGE_SPECS) {
    const [route, filename, title, navLabel, description, glyph, priority] = spec;
    const pageSources = list.filter((source) => source.kind === route);
    if (!pageSources.length) continue;
    pages.push({ route, filename, title, navLabel, description, glyph, priority, sources: pageSources });
  }
  return pages;
}

/** Markdown 站内导航行 */
function markdownNavigation(pages, currentRoute) {
  return pages.map((page) => {
    const label = page.route === currentRoute ? "**" + page.navLabel + "**" : page.navLabel;
    return "[" + label + "](" + page.filename + ")";
  }).join(" · ");
}

/** 取得 sourceMap 里某个绝对路径对应的页文件名 */
function pageFilenameOf(sourceMap, absolutePath) {
  const entry = sourceMap instanceof Map ? sourceMap.get(absolutePath) : sourceMap ? sourceMap[absolutePath] : null;
  if (!entry) return "";
  if (typeof entry === "string") return entry;
  return String(entry.filename ?? "");
}

/**
 * 改写 Markdown 链接：外部链接与锚点不动，站内相对链接映射到站点文件名。
 * @param {string} markdown Markdown 文本
 * @param {{sourceMap?:Map|object, markdownDir?:string, source?:object, sourceFile?:string}} options
 */
export function rewriteMarkdownLinks(markdown, options = {}) {
  const sourceMap = options.sourceMap ?? new Map();
  const markdownDir = path.resolve(String(options.markdownDir ?? "."));
  const baseFile = options.source?.path ?? options.sourceFile ?? path.join(markdownDir, "source.md");
  return String(markdown ?? "").replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (whole, marker, label, href) => {
    if (/^(https?|mailto):/i.test(href)) return whole;
    if (href.startsWith("#")) return whole;
    const hashIndex = href.indexOf("#");
    const rawPath = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
    const fragment = hashIndex >= 0 ? href.slice(hashIndex + 1) : "";
    if (!rawPath) return whole;
    let decoded = rawPath;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      decoded = rawPath;
    }
    const absolute = path.resolve(path.dirname(path.resolve(baseFile)), decoded);
    const filename = pageFilenameOf(sourceMap, absolute);
    if (filename) return marker + "[" + label + "](" + filename + (fragment ? "#" + fragment : "") + ")";
    const name = path.basename(absolute);
    if (GENERATED_NAMES.has(name)) return marker + "[" + label + "](index.md" + (fragment ? "#" + fragment : "") + ")";
    if (name === "wechat_daily_report.html") return marker + "[" + label + "](../wechat_daily_report.html#/overview)";
    const relative = path.relative(markdownDir, absolute).split(path.sep).join("/");
    return marker + "[" + label + "](" + relative + (fragment ? "#" + fragment : "") + ")";
  });
}

/** 组装单个分区的 Markdown 页面 */
function buildPageMarkdown(page, options) {
  const { pages, sourceMap, markdownDir, generatedAt } = options;
  const parts = [
    "# " + page.title,
    "",
    "> " + page.description + "｜生成时间：" + generatedAt,
    "",
    markdownNavigation(pages, page.route),
    "",
    "---",
    "",
  ];
  const multiple = page.sources.length > 1;
  for (const source of page.sources) {
    const text = normalizeDetailsMarkdown(rewriteMarkdownLinks(String(source.markdown ?? ""), {
      sourceMap,
      markdownDir,
      source,
    }));
    if (multiple) parts.push("## " + source.title, "", "> 来源：\x60" + source.relativePath + "\x60", "");
    parts.push(stripFirstH1(text), "");
  }
  parts.push("---", "", "[返回报告入口](../wechat_daily_full.md) · [打开交互版](../wechat_daily_report.html#/" + page.route + ")", "");
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * 写出 Markdown 站点与门户文件。
 * @param {string} reportDir 报告目录
 * @param {Array} pages buildPages 的结果
 * @param {{title?:string, generatedAt?:string, portalPath?:string}} options
 * @returns {object} route -> 页面 Markdown 内容
 */
export function writeMarkdownSite(reportDir, pages, options = {}) {
  const root = path.resolve(String(reportDir ?? "."));
  const markdownDir = path.join(root, MARKDOWN_SITE_DIR);
  ensureDir(markdownDir);
  const title = String(options.title ?? "微信个人情报库｜综合日报");
  const generatedAt = String(options.generatedAt ?? fmtLocal(new Date()));
  const list = Array.isArray(pages) ? pages : [];
  const expected = new Set(list.map((page) => page.filename));
  for (const file of fs.readdirSync(markdownDir)) {
    if (!file.endsWith(".md") || expected.has(file)) continue;
    try {
      fs.unlinkSync(path.join(markdownDir, file));
    } catch {
      /* 清理失败不影响本次生成 */
    }
  }
  const sourceMap = new Map();
  for (const page of list) {
    for (const source of page.sources) {
      if (source.path) sourceMap.set(path.resolve(source.path), { filename: page.filename, route: page.route });
    }
  }
  const markdownByRoute = {};
  for (const page of list) {
    const content = buildPageMarkdown(page, { pages: list, sourceMap, markdownDir, generatedAt });
    atomicWrite(path.join(markdownDir, page.filename), content);
    markdownByRoute[page.route] = content;
  }
  const portal = [
    "# " + title,
    "",
    "> 生成时间：" + generatedAt + "｜" + list.length + " 个阅读分区｜完整内容已按主题拆分，不再纵向拼成一篇长文。",
    "",
    "## 阅读入口",
    "",
    "- [打开旗舰版交互日报](wechat_daily_report.html)",
  ];
  for (const page of list) {
    portal.push("- [" + page.title + "](" + MARKDOWN_SITE_DIR + "/" + page.filename + ")：" + page.description);
  }
  portal.push(
    "",
    "## 阅读说明",
    "",
    "- 交互 HTML 只保留综合行动、群聊日报、重点联系人和商单信号雷达四个入口。",
    "- 群聊日报可切换话题视角、重点群视角和群聊筛选；Markdown 也按视角拆分。",
    "- 证据附录与机器初筛仍保留在本地运行目录，不作为阅读入口。",
    "- 所有微信读取均为本地只读，报告不会自动发送消息。",
    "- 回复建议只是本地草稿，必须人工确认后自行发送。",
    "",
  );
  const portalPath = path.resolve(String(options.portalPath ?? path.join(root, "wechat_daily_full.md")));
  ensureDir(path.dirname(portalPath));
  atomicWrite(portalPath, portal.join("\n"));
  return markdownByRoute;
}

/** 读取群聊筛选矩阵（不存在或结构不符时返回 null） */
function loadGroupMatrix(reportDir) {
  const payload = readJson(path.join(reportDir, "group-daily", "group_selection_matrix.json"), null);
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.groups)) return null;
  return payload;
}

/**
 * 完整打包：发现 -> 分页 -> 写 Markdown 站点 -> 渲染旗舰 HTML。
 * @param {string} reportDir 报告目录
 * @param {{out?:string, markdownOut?:string, title?:string}} options
 * @returns {{html:string, markdown:string, routes:string[], sources:Array}}
 */
export function renderBundle(reportDir, options = {}) {
  const root = path.resolve(String(reportDir ?? "."));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("找不到报告目录：" + root);
  }
  const title = String(options.title ?? "微信个人情报库｜综合日报");
  const generatedAt = fmtLocal(new Date());
  const sources = discoverReportSources(root);
  if (!sources.length) throw new Error("报告目录没有 Markdown 文件：" + root);
  const pages = buildPages(sources);
  if (!pages.length) throw new Error("报告目录没有可阅读的分区（缺少 final_report.md 等入口文件）：" + root);
  const portalPath = path.resolve(String(options.markdownOut ?? path.join(root, "wechat_daily_full.md")));
  const htmlPath = path.resolve(String(options.out ?? path.join(root, "wechat_daily_report.html")));
  const markdownByRoute = writeMarkdownSite(root, pages, { title, generatedAt, portalPath });
  renderFlagship({
    pages,
    markdownByRoute,
    title,
    outPath: htmlPath,
    groupsMatrix: loadGroupMatrix(root),
  });
  return {
    html: htmlPath,
    markdown: portalPath,
    routes: pages.map((page) => page.route),
    sources,
  };
}

/** 供上层工具使用的 HTML 转义（与渲染层一致） */
export { escapeText };

/** 折叠标记归一化由渲染层提供，这里保持同一实现，避免两份逻辑漂移 */
export { normalizeDetailsMarkdown };
