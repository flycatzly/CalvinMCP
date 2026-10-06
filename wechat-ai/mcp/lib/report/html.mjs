// 旗舰交互式 HTML 报告：单文件、零外部依赖、CSP 加固、hash 路由 + 全局搜索。
import fs from "node:fs";
import path from "node:path";
import { ensureDir, atomicWrite, fmtLocal } from "../util.mjs";
import { mdToHtmlLite, sanitizeFragment, protectDocument } from "./security.mjs";

/** 已知的顶层路由顺序（缺失的分区不会出现在导航里） */
export const ROUTE_ORDER = ["overview", "groups", "contacts", "radar", "reports"];

/** 群聊关注级别选项 */
const GROUP_LEVELS = ["重点", "雷达观察", "关注", "低优先级", "排除候选"];

const GENERATED_NAMES = new Set(["wechat_daily_full.md", "wechat_daily_report.md"]);

export function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === "\"") return "&quot;";
    return "&#x27;";
  });
}

/**
 * 把报告里泄漏的 HTML 折叠标记还原成 Markdown 标题。
 * 供渲染器与打包器共用；不会保留任何 raw HTML。
 */
export function normalizeDetailsMarkdown(markdown) {
  let text = String(markdown ?? "");
  text = text.replace(/<details(?:\s+open)?[^>]*>\s*/gi, "");
  text = text.replace(/\s*<\/details>/gi, "");
  text = text.replace(/<summary>([\s\S]*?)<\/summary>/gi, (whole, inner) => {
    const value = String(inner).replace(/<\/?strong>/gi, "").replace(/\s+/g, " ").trim();
    if (value.includes("｜")) {
      const parts = value.split("｜");
      const title = parts.shift().trim();
      const note = parts.join("｜").trim();
      return "### " + title + (note ? "\n\n> " + note : "");
    }
    return "### " + value;
  });
  text = text.replace(/^##\s+(?:详细报告|报告路径)\s*\n[\s\S]*?(?=^##\s+|$)/gm, "");
  return text.trim();
}

/** 去掉首个 H1 */
export function stripFirstH1(markdown) {
  return String(markdown ?? "").replace(/^#\s+.+?\s*\n+/m, "").trim();
}

/** 解析相对链接指向的本地文件绝对路径 */
function resolveRelative(fromFile, href) {
  const clean = String(href ?? "").split("#")[0].split("?")[0];
  if (!clean) return "";
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  const base = path.dirname(path.resolve(fromFile));
  return path.resolve(base, decoded);
}

/**
 * 把净化后的 HTML 片段里的链接改写成站内路由。
 * 外部链接加 target/class；指向已知源文件的相对链接变成 #/<route>/<anchor>；其余相对链接去掉 href。
 */
export function rewriteHtmlLinks(fragment, options = {}) {
  const source = options.source ?? {};
  const sourcePages = options.sourcePages ?? new Map();
  const sourceFile = source.path ? path.resolve(source.path) : "";
  const route = source.route ?? "overview";
  return String(fragment ?? "").replace(/<a([^>]*?)href="([^"]+)"([^>]*)>/g, (whole, before, href, after) => {
    if (/^https?:\/\//i.test(href)) {
      return "<a" + before + "href=\"" + href + "\"" + after + " target=\"_blank\" class=\"original-link\">";
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return whole;
    if (href.startsWith("#")) {
      return "<a" + before + "href=\"#/" + route + "/" + href.slice(1) + "\"" + after + " class=\"internal-link\">";
    }
    const target = sourceFile ? sourcePages.get(resolveRelative(sourceFile, href)) : null;
    if (target) {
      const anchor = href.includes("#") ? href.split("#").slice(1).join("#") : "";
      const point = anchor ? target.sourceId + "-" + anchor : "source-" + target.sourceId;
      return "<a" + before + "href=\"#/" + target.route + "/" + point + "\"" + after + " class=\"internal-link\">";
    }
    const name = path.basename(String(href).split("#")[0]);
    if (GENERATED_NAMES.has(name) || name === "wechat_daily_report.html") {
      return "<a" + before + "href=\"#/overview\"" + after + " class=\"internal-link\">";
    }
    return "<a" + before + after + ">";
  });
}

/**
 * 把二级标题（没有二级时用三级）折叠成 details.key-group-card，首个默认展开。
 * 必须在净化之后调用：净化会去掉 class 属性。
 */
export function wrapKeyGroupSections(fragment) {
  const html = String(fragment ?? "");
  const level = /<h2\b/i.test(html) ? 2 : 3;
  const pattern = new RegExp("<h" + level + "(?:\\s+id=\"([^\"]+)\")?[^>]*>([\\s\\S]*?)</h" + level + ">", "gi");
  const matches = [...html.matchAll(pattern)];
  if (!matches.length) return html;
  const parts = [html.slice(0, matches[0].index)];
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : html.length;
    const anchor = match[1] || "key-group-" + (index + 1);
    const title = String(match[2]).trim();
    const body = html.slice(match.index + match[0].length, end).trim();
    parts.push(
      "<details class=\"key-group-card\" id=\"" + escapeText(anchor) + "\"" + (index === 0 ? " open" : "") + ">" +
      "<summary><span class=\"key-group-title\">" + title + "</span><span class=\"key-group-hint\">点击展开</span></summary>" +
      "<div class=\"key-group-body\">" + body + "</div></details>",
    );
  });
  return parts.join("");
}

/** 群聊筛选视图：服务端渲染整块矩阵 */
export function renderGroupSelector(matrix) {
  const payload = matrix ?? {};
  const rows = Array.isArray(payload.groups) ? payload.groups : [];
  const dimensions = Array.isArray(payload.dimensions) && payload.dimensions.length
    ? payload.dimensions.map((item) => String(item))
    : [];
  const rowHtml = rows.map((row) => {
    if (!row || typeof row !== "object") return "";
    const group = String(row["群聊"] ?? "未命名群聊");
    const level = String(row["建议关注级别"] ?? "关注");
    const tags = dimensions.filter((label) => Boolean(row[label]));
    const tagHtml = tags.length
      ? tags.map((tag) => {
        const count = Number(row[tag + "消息数"] ?? 0);
        return "<span class=\"matrix-tag\">" + escapeText(tag) + (count ? " · " + count : "") + "</span>";
      }).join("")
      : "<span class=\"matrix-tag muted-tag\">无目标标签</span>";
    const options = GROUP_LEVELS.map((item) => "<option value=\"" + escapeText(item) + "\"" + (item === level ? " selected" : "") + ">" + escapeText(item) + "</option>").join("");
    return "<article class=\"matrix-row\" data-group-row data-group-name=\"" + escapeText(group.toLowerCase()) + "\" data-level=\"" + escapeText(level) + "\" data-tags=\"" + escapeText(tags.join(",")) + "\">" +
      "<div class=\"matrix-group\"><details class=\"matrix-detail\"><summary><strong>" + escapeText(group) + "</strong><span class=\"matrix-expand-hint\">展开</span></summary>" +
      "<div class=\"matrix-detail-body\"><p><b>群聊类型：</b>" + escapeText(String(row["群聊类型"] ?? "一般信息")) + "</p>" +
      "<p><b>主要主题：</b>" + escapeText(String(row["主要主题"] ?? "未识别")) + "</p>" +
      "<p><b>判断：</b>" + escapeText(String(row["判断依据"] ?? "")) + "</p></div></details></div>" +
      "<div class=\"matrix-activity\"><strong>" + escapeText(String(row["活跃度"] ?? "低")) + "</strong><span>" + escapeText(String(row["消息数"] ?? 0)) + " 条 / 有效 " + escapeText(String(row["有效讨论数"] ?? 0)) + "</span></div>" +
      "<div class=\"matrix-tags\">" + tagHtml + "</div>" +
      "<div class=\"matrix-reason\">" + escapeText(String(row["判断依据"] ?? "")) + "</div>" +
      "<label class=\"matrix-choice\"><span class=\"sr-only\">设置 " + escapeText(group) + " 的关注级别</span>" +
      "<select data-group-priority data-suggested=\"" + escapeText(level) + "\" data-group=\"" + escapeText(group) + "\">" + options + "</select></label>" +
      "</article>";
  }).join("");
  const basis = escapeText(String(payload.basis ?? "建议级别只针对本时段，不等于永久排除。"));
  const dimensionOptions = dimensions.map((tag) => "<option value=\"" + escapeText(tag) + "\">" + escapeText(tag) + "</option>").join("");
  return "<section class=\"source-document group-selector\" id=\"group-selection-matrix\" data-group-view=\"selector\">" +
    "<header class=\"source-title\"><p>群聊管理</p><h2>全部群聊筛选</h2><span class=\"selector-note\">" + basis + "</span></header>" +
    "<div class=\"matrix-toolbar\">" +
    "<label class=\"matrix-search\"><span class=\"sr-only\">搜索群名</span><input id=\"group-matrix-search\" type=\"search\" placeholder=\"搜索群名\"></label>" +
    "<label><span>关注级别</span><select id=\"group-level-filter\"><option value=\"all\">全部</option>" + GROUP_LEVELS.map((item) => "<option value=\"" + escapeText(item) + "\">" + escapeText(item) + "</option>").join("") + "</select></label>" +
    "<label><span>目标方向</span><select id=\"group-tag-filter\"><option value=\"all\">全部</option>" + dimensionOptions + "</select></label>" +
    "<button class=\"matrix-export\" id=\"group-selection-export\" type=\"button\">导出选择</button></div>" +
    "<div class=\"matrix-head\"><span>群聊（点击展开）</span><span>活跃度</span><span>相关方向</span><span>本时段判断</span><span>我的选择</span></div>" +
    "<div class=\"matrix-list\">" + rowHtml + "</div>" +
    "<p class=\"matrix-empty\" id=\"group-matrix-empty\" hidden>没有符合当前筛选条件的群聊。</p></section>";
}

/** 旗舰版样式表：亮/暗两套 CSS 变量 */
const FLAGSHIP_CSS = [
  ":root{color-scheme:light;--chrome:#20242a;--chrome-2:#2a3037;--canvas:#eef1f4;--paper:#ffffff;--paper-2:#f6f8fa;--ink:#171b20;--muted:#69737e;--faint:#8b949e;--line:#dce1e6;--line-strong:#cbd1d8;--green:#168c72;--green-soft:#e8f5f1;--blue:#3975c5;--coral:#d96552;--amber:#a56d13;--shadow:0 12px 32px rgba(28,39,49,.06);}",
  "html[data-theme=dark]{color-scheme:dark;--chrome:#14181d;--chrome-2:#1d232a;--canvas:#171b20;--paper:#21262c;--paper-2:#282e35;--ink:#edf1f5;--muted:#afb7c0;--faint:#848e98;--line:#39414a;--line-strong:#4a535e;--green:#75d9c0;--green-soft:#213d37;--blue:#7aa9ea;--coral:#ee806f;--amber:#e8b45f;--shadow:0 18px 48px rgba(0,0,0,.28);}",
  "*{box-sizing:border-box;}",
  "html,body{margin:0;min-height:100%;}",
  "html{scroll-behavior:smooth;}",
  "body{background:var(--canvas);color:var(--ink);font:14px/1.72 Inter,-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"PingFang SC\",\"Microsoft YaHei\",sans-serif;letter-spacing:0;}",
  "button,input,select{font:inherit;letter-spacing:0;}button,select{cursor:pointer;}",
  "a{color:var(--green);text-underline-offset:3px;overflow-wrap:anywhere;}a:hover{color:var(--blue);}",
  ".sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}",
  ".app{min-height:100vh;}",
  ".chrome{position:fixed;inset:0 0 auto 0;z-index:30;height:64px;display:flex;align-items:stretch;gap:8px;padding:0 24px;background:var(--chrome);color:#c8ced6;}",
  ".brand{min-width:236px;display:flex;align-items:center;gap:10px;color:#fff;font-weight:800;}",
  ".brand-mark{width:26px;height:26px;display:grid;place-items:center;border-radius:5px;background:#75d9c0;color:#10241f;font-size:12px;font-weight:900;}",
  ".route-tabs{display:flex;align-items:stretch;overflow-x:auto;}",
  ".nav-item{display:flex;align-items:center;gap:7px;min-height:64px;padding:0 17px;border-bottom:3px solid transparent;color:#c8ced6;text-decoration:none;font-size:13px;white-space:nowrap;}",
  ".nav-item:hover{color:#fff;}",
  ".nav-item.active{border-color:#75d9c0;background:var(--chrome-2);color:#fff;}",
  ".nav-glyph{width:14px;display:grid;place-items:center;color:#8f99a4;font-size:10px;}",
  ".nav-item.active .nav-glyph{color:#75d9c0;}",
  ".chrome-meta{margin-left:auto;display:flex;align-items:center;gap:8px;color:#8f99a4;font-size:11px;}",
  ".fresh-dot{display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:#72d29f;}",
  ".workspace{min-width:0;padding-top:64px;}",
  ".location-bar{position:sticky;top:64px;z-index:25;min-height:54px;display:flex;align-items:center;gap:13px;padding:8px 30px;border-bottom:1px solid var(--line-strong);background:color-mix(in srgb,var(--paper-2) 94%,transparent);backdrop-filter:blur(18px);}",
  ".crumbs{min-width:236px;color:var(--muted);font-size:11px;}.crumbs strong{color:var(--ink);}",
  ".search-wrap{position:relative;width:min(470px,42vw);margin:0 auto;}",
  ".search-input{width:100%;height:34px;padding:0 58px 0 11px;border:1px solid var(--line-strong);border-radius:6px;background:color-mix(in srgb,var(--paper) 88%,transparent);color:var(--ink);outline:none;}",
  ".search-input:focus{border-color:var(--green);box-shadow:0 0 0 3px color-mix(in srgb,var(--green) 15%,transparent);}",
  ".key{position:absolute;right:8px;top:7px;padding:1px 5px;border:1px solid var(--line);border-radius:4px;color:var(--faint);font-size:9px;}",
  ".toolbar{display:flex;gap:7px;}",
  ".icon-button{width:32px;height:32px;padding:0;border:1px solid var(--line-strong);border-radius:6px;background:var(--paper);color:var(--muted);}",
  ".icon-button:hover{border-color:var(--green);color:var(--green);}",
  ".mobile-routes{display:none;}",
  ".report-page{padding:26px 30px 64px;}.report-page[hidden]{display:none!important;}",
  ".page-head{max-width:1080px;margin:0 auto 25px;display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding-bottom:22px;border-bottom:1px solid var(--line-strong);}",
  ".overline{margin:0 0 5px;color:var(--green);font-size:10px;font-weight:800;text-transform:uppercase;}",
  ".page-head h1{margin:0;font-size:30px;line-height:1.24;}.page-head p:not(.overline){margin:7px 0 0;color:var(--muted);font-size:12px;}",
  ".page-stat{min-width:74px;padding-left:13px;border-left:2px solid var(--coral);}.page-stat strong{display:block;font-size:18px;line-height:1.2;}.page-stat span{color:var(--faint);font-size:9px;}",
  ".page-content{max-width:1080px;margin:0 auto;}",
  ".source-document{min-width:0;padding:22px 24px 28px;border:1px solid var(--line);background:var(--paper);box-shadow:var(--shadow);}",
  ".source-document+.source-document{margin-top:16px;}",
  ".source-document[data-group-view][hidden]{display:none!important;}",
  ".view-switcher{max-width:1080px;margin:0 auto 16px;display:inline-flex;border:1px solid var(--line-strong);background:var(--paper);}",
  ".view-button{min-width:132px;padding:8px 16px;border:0;border-right:1px solid var(--line);background:transparent;color:var(--muted);}",
  ".view-button:last-child{border-right:0;}.view-button.active{background:var(--chrome);color:#fff;font-weight:700;}",
  ".source-origin{margin:0 0 18px;color:var(--faint);font:10px/1.5 \"SFMono-Regular\",Consolas,monospace;}",
  ".source-title{margin-bottom:20px;}.source-title p{margin:0 0 4px;color:var(--coral);font-size:9px;font-weight:800;text-transform:uppercase;}.source-title h2{margin:0;font-size:22px;}.source-title code{display:inline-block;margin-top:5px;color:var(--faint);font-size:9px;}",
  ".markdown-body{max-width:860px;color:var(--ink);}",
  ".markdown-body h2{margin:32px 0 12px;font-size:20px;line-height:1.35;}.markdown-body h2:first-child{margin-top:0;}",
  ".markdown-body h3{margin:25px 0 9px;font-size:16px;}.markdown-body h4{margin:20px 0 7px;font-size:14px;}.markdown-body p{margin:10px 0;}",
  ".markdown-body ul,.markdown-body ol{padding-left:22px;}.markdown-body li{margin:7px 0;}",
  ".markdown-body>ul>li,.markdown-body>ol>li{margin:8px 0;padding:6px 0;border-bottom:1px dashed var(--line);}",
  ".markdown-body blockquote{margin:15px 0;padding:11px 14px;border-left:3px solid var(--green);background:var(--green-soft);color:var(--muted);}.markdown-body blockquote p{margin:0;}",
  ".markdown-body code{padding:2px 5px;border-radius:3px;background:var(--paper-2);color:var(--coral);font-family:\"SFMono-Regular\",Consolas,monospace;font-size:.9em;}",
  ".markdown-body pre{overflow:auto;padding:15px;border:1px solid var(--line);border-radius:6px;background:#171a17;color:#eef0ea;}.markdown-body pre code{padding:0;background:transparent;color:inherit;}",
  ".markdown-body table{width:100%;display:block;overflow-x:auto;border-collapse:collapse;}",
  ".markdown-body th,.markdown-body td{padding:8px 10px;border:1px solid var(--line);text-align:left;white-space:nowrap;}.markdown-body th{background:var(--paper-2);}",
  ".markdown-body hr{border:0;border-top:1px solid var(--line);margin:22px 0;}",
  ".original-link::after{content:\" ↗\";font-size:.78em;color:var(--faint);}",
  ".key-group-card{margin:0;border-top:1px solid var(--line);background:transparent;}",
  ".key-group-card:last-child{border-bottom:1px solid var(--line);}",
  ".key-group-card>summary{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:17px 2px;list-style:none;cursor:pointer;}",
  ".key-group-card>summary::-webkit-details-marker{display:none;}",
  ".key-group-card>summary::before{content:\"+\";width:22px;height:22px;flex:0 0 22px;display:grid;place-items:center;border:1px solid var(--line-strong);border-radius:4px;color:var(--muted);font-weight:800;}",
  ".key-group-card[open]>summary::before{content:\"−\";color:var(--green);border-color:var(--green);}",
  ".key-group-title{order:2;flex:1;font-size:17px;font-weight:800;}",
  ".key-group-hint{order:3;color:var(--faint);font-size:10px;}",
  ".key-group-card[open] .key-group-hint{color:var(--green);}",
  ".key-group-body{padding:0 34px 20px;}",
  ".group-selector{padding-bottom:20px;}",
  ".selector-note{display:block;max-width:860px;color:var(--muted);font-size:11px;}",
  ".matrix-toolbar{display:flex;align-items:flex-end;gap:9px;margin:0 0 14px;padding:12px;border:1px solid var(--line);background:var(--paper-2);}",
  ".matrix-toolbar label{display:grid;gap:4px;color:var(--faint);font-size:9px;font-weight:700;}",
  ".matrix-toolbar input,.matrix-toolbar select,.matrix-choice select{height:34px;border:1px solid var(--line-strong);border-radius:5px;background:var(--paper);color:var(--ink);padding:0 9px;}",
  ".matrix-search{flex:1;}.matrix-search input{width:100%;}",
  ".matrix-export{height:34px;padding:0 12px;border:1px solid var(--green);border-radius:5px;background:var(--green);color:#fff;font-weight:700;}",
  ".matrix-head,.matrix-row{display:grid;grid-template-columns:minmax(230px,1.35fr) 105px minmax(230px,1.25fr) minmax(210px,1.15fr) 122px;gap:14px;align-items:center;}",
  ".matrix-head{padding:8px 12px;border-bottom:1px solid var(--line-strong);color:var(--faint);font-size:9px;font-weight:800;}",
  ".matrix-row{padding:12px;border-bottom:1px solid var(--line);}",
  ".matrix-row[hidden]{display:none!important;}.matrix-row:hover{background:var(--paper-2);}",
  ".matrix-row[data-level=低优先级],.matrix-row[data-level=排除候选]{color:var(--muted);}",
  ".matrix-group{min-width:0;}",
  ".matrix-detail>summary{display:flex;align-items:center;gap:7px;list-style:none;cursor:pointer;}",
  ".matrix-detail>summary::-webkit-details-marker{display:none;}",
  ".matrix-detail strong{min-width:0;overflow-wrap:anywhere;}",
  ".matrix-expand-hint{flex:0 0 auto;color:var(--green);font-size:9px;font-weight:700;}",
  ".matrix-detail[open] .matrix-expand-hint{font-size:0;}.matrix-detail[open] .matrix-expand-hint::after{content:\"收起\";font-size:9px;}",
  ".matrix-detail-body{margin-top:8px;padding:8px 10px;border-left:2px solid var(--green);background:var(--green-soft);color:var(--muted);font-size:10px;}",
  ".matrix-detail-body p{margin:3px 0;}",
  ".matrix-activity{display:grid;}.matrix-activity strong{font-size:12px;}.matrix-activity span{color:var(--faint);font-size:9px;}",
  ".matrix-tags{display:flex;flex-wrap:wrap;gap:4px;}",
  ".matrix-tag{padding:2px 6px;border:1px solid color-mix(in srgb,var(--green) 35%,var(--line));border-radius:3px;background:var(--green-soft);color:var(--green);font-size:9px;font-weight:700;}",
  ".muted-tag{border-color:var(--line);background:var(--paper-2);color:var(--faint);}",
  ".matrix-reason{color:var(--muted);font-size:10px;line-height:1.55;}",
  ".matrix-choice select{width:100%;}",
  ".matrix-empty{padding:34px 12px;color:var(--muted);text-align:center;}",
  ".search-panel{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:60;width:min(560px,calc(100vw - 32px));max-height:min(620px,calc(100vh - 90px));overflow:auto;border:1px solid var(--line-strong);border-radius:8px;background:var(--paper);box-shadow:0 24px 70px rgba(17,22,18,.2);}",
  ".search-panel[hidden]{display:none;}",
  ".search-head{padding:11px 13px;border-bottom:1px solid var(--line);color:var(--muted);font-size:10px;}",
  ".search-result{display:block;padding:11px 13px;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none;}",
  ".search-result:hover{background:var(--paper-2);}",
  ".search-result strong{display:block;font-size:11px;}.search-result p{margin:3px 0 0;color:var(--muted);font-size:10px;line-height:1.55;}",
  ".search-empty{padding:28px 14px;color:var(--muted);text-align:center;}",
  ".bottom-nav{display:none;}",
  "@media print{.chrome,.location-bar,.mobile-routes,.bottom-nav,.toolbar,.view-switcher{display:none!important;}.workspace{padding-top:0;}.report-page{padding:0;}.report-page[hidden]{display:none!important;}.source-document{border:0;box-shadow:none;padding:0 0 18px;}.key-group-card{break-inside:avoid;}}",
  "@media (max-width:900px){",
  ".chrome{display:none;}.workspace{padding-top:0;padding-bottom:56px;}",
  ".location-bar{top:0;min-height:50px;padding:6px 13px;}.crumbs{min-width:0;flex:1;}",
  ".search-wrap{width:42px;margin:0;}.search-input{width:42px;padding:0;color:transparent;caret-color:transparent;}.search-input::placeholder{color:transparent;}",
  ".search-wrap::before{content:\"⌕\";position:absolute;z-index:2;left:13px;top:6px;color:var(--muted);pointer-events:none;font-size:16px;}",
  ".search-wrap:focus-within{position:fixed;inset:8px 12px auto;z-index:70;width:auto;}.search-wrap:focus-within .search-input{width:100%;padding:0 12px;color:var(--ink);caret-color:auto;}.search-wrap:focus-within .search-input::placeholder{color:var(--faint);}.key{display:none;}",
  ".mobile-routes{position:sticky;top:50px;z-index:20;display:flex;gap:3px;padding:7px 12px;overflow-x:auto;border-bottom:1px solid var(--line);background:var(--canvas);}",
  ".mobile-routes a{flex:0 0 auto;padding:5px 8px;border-bottom:2px solid transparent;color:var(--muted);text-decoration:none;font-size:10px;}.mobile-routes a.active{border-color:var(--green);color:var(--ink);font-weight:700;}",
  ".report-page{padding:20px 13px 38px;}.page-head{align-items:flex-start;margin-bottom:18px;padding-bottom:16px;}.page-head h1{font-size:24px;}.page-stat{min-width:58px;}",
  ".source-document{padding:18px 15px 22px;}.view-switcher{width:100%;}.view-button{flex:1;min-width:0;}",
  ".markdown-body{max-width:none;}.markdown-body h2{font-size:18px;}.markdown-body>ul>li,.markdown-body>ol>li{padding:7px 9px;}",
  ".key-group-body{padding-left:0;padding-right:0;}",
  ".matrix-toolbar{align-items:stretch;flex-direction:column;}.matrix-toolbar label,.matrix-export{width:100%;}",
  ".matrix-head{display:none;}.matrix-row{grid-template-columns:1fr 106px;gap:9px 12px;}",
  ".matrix-group,.matrix-tags,.matrix-reason{grid-column:1/-1;}.matrix-activity{grid-column:1;}.matrix-choice{grid-column:2;grid-row:2;}",
  ".search-panel{top:52px;left:12px;right:12px;transform:none;width:auto;}",
  ".bottom-nav{position:fixed;inset:auto 0 0;z-index:40;height:54px;display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--line-strong);background:color-mix(in srgb,var(--paper) 94%,transparent);backdrop-filter:blur(18px);}",
  ".bottom-nav a{display:grid;place-items:center;align-content:center;gap:1px;color:var(--muted);text-decoration:none;font-size:9px;}.bottom-nav a span{font-size:11px;}.bottom-nav a.active{color:var(--green);font-weight:800;}",
  "}",
];

/** 浏览器端脚本：路由、搜索、群聊视图、主题、下载与打印 */
function flagshipScript(pageMetaJson, markdownJson, baseTitleJson) {
  return [
    "const pageMeta=" + pageMetaJson + ";",
    "const markdownByRoute=" + markdownJson + ";",
    "const baseTitle=" + baseTitleJson + ";",
    "const reportPages=Array.prototype.slice.call(document.querySelectorAll('.report-page'));",
    "const routeLinks=Array.prototype.slice.call(document.querySelectorAll('[data-route-link]'));",
    "const currentTitle=document.getElementById('current-title');",
    "const searchInput=document.getElementById('search-input');",
    "const searchPanel=document.getElementById('search-panel');",
    "const searchHead=document.getElementById('search-head');",
    "const searchResults=document.getElementById('search-results');",
    "const groupViewButtons=Array.prototype.slice.call(document.querySelectorAll('[data-group-view-button]'));",
    "const groupViews=Array.prototype.slice.call(document.querySelectorAll('[data-group-view]'));",
    "const groupRows=Array.prototype.slice.call(document.querySelectorAll('[data-group-row]'));",
    "const groupPrioritySelects=Array.prototype.slice.call(document.querySelectorAll('[data-group-priority]'));",
    "const validRoutes=pageMeta.map(function(page){return page.route;});",
    "function escapeHtml(value){return String(value).replace(/[&<>'\"]/g,function(ch){if(ch==='&'){return '&amp;';}if(ch==='<'){return '&lt;';}if(ch==='>'){return '&gt;';}if(ch==='\"'){return '&quot;';}return '&#39;';});}",
    "function parseRoute(){var raw=location.hash.indexOf('#/')===0?location.hash.slice(2):'';var parts=raw.split('/');var candidate=parts[0];var anchor=parts.slice(1).join('/');var route=validRoutes.indexOf(candidate)>=0?candidate:pageMeta[0].route;try{anchor=decodeURIComponent(anchor);}catch(error){anchor=parts.slice(1).join('/');}return {route:route,anchor:anchor};}",
    "function renderRoute(){var parsed=parseRoute();var meta=pageMeta.filter(function(page){return page.route===parsed.route;})[0]||pageMeta[0];",
    "reportPages.forEach(function(page){page.hidden=page.dataset.route!==parsed.route;});",
    "routeLinks.forEach(function(link){link.classList.toggle('active',link.dataset.routeLink===parsed.route);});",
    "if(currentTitle){currentTitle.textContent=meta.title;}document.title=meta.title+'｜'+baseTitle;",
    "if(location.hash.indexOf('#/')!==0){history.replaceState(null,'','#/'+parsed.route);}",
    "requestAnimationFrame(function(){if(parsed.anchor){var target=document.getElementById(parsed.anchor);if(target){target.scrollIntoView({behavior:'smooth',block:'start'});return;}}window.scrollTo(0,0);});}",
    "function setGroupView(view){var available=groupViewButtons.map(function(button){return button.dataset.groupViewButton;});var selected=available.indexOf(view)>=0?view:(available.indexOf('topics')>=0?'topics':available[0]);",
    "groupViewButtons.forEach(function(button){var active=button.dataset.groupViewButton===selected;button.classList.toggle('active',active);button.setAttribute('aria-selected',active?'true':'false');});",
    "groupViews.forEach(function(section){section.hidden=section.dataset.groupView!==selected;});",
    "if(selected){storageSet('wechat-group-view',selected);}}",
    "function storageGet(key){try{return localStorage.getItem(key);}catch(error){return null;}}",
    "function storageSet(key,value){try{localStorage.setItem(key,value);}catch(error){}}",
    "function savedGroupPriorities(){try{return JSON.parse(storageGet('wechat-group-priorities')||'{}');}catch(error){return {};}}",
    "function persistGroupPriorities(){var values={};groupPrioritySelects.forEach(function(select){values[select.dataset.group]=select.value;});storageSet('wechat-group-priorities',JSON.stringify(values));}",
    "function filterGroupRows(){var search=document.getElementById('group-matrix-search');var levelSelect=document.getElementById('group-level-filter');var tagSelect=document.getElementById('group-tag-filter');",
    "var query=(search?search.value:'').trim().toLowerCase();var level=levelSelect?levelSelect.value:'all';var tag=tagSelect?tagSelect.value:'all';var visible=0;",
    "groupRows.forEach(function(row){var select=row.querySelector('[data-group-priority]');var current=select?select.value:row.dataset.level;",
    "var match=(!query||row.dataset.groupName.indexOf(query)>=0)&&(level==='all'||current===level)&&(tag==='all'||row.dataset.tags.split(',').indexOf(tag)>=0);",
    "row.hidden=!match;if(match){visible+=1;}});",
    "var empty=document.getElementById('group-matrix-empty');if(empty){empty.hidden=visible!==0;}}",
    "function initGroupSelector(){if(!groupRows.length){return;}var saved=savedGroupPriorities();",
    "groupPrioritySelects.forEach(function(select){if(saved[select.dataset.group]){select.value=saved[select.dataset.group];}var row=select.closest('[data-group-row]');if(row){row.dataset.level=select.value;}",
    "select.addEventListener('change',function(){if(row){row.dataset.level=select.value;}persistGroupPriorities();filterGroupRows();});});",
    "var search=document.getElementById('group-matrix-search');if(search){search.addEventListener('input',filterGroupRows);}",
    "var levelSelect=document.getElementById('group-level-filter');if(levelSelect){levelSelect.addEventListener('change',filterGroupRows);}",
    "var tagSelect=document.getElementById('group-tag-filter');if(tagSelect){tagSelect.addEventListener('change',filterGroupRows);}",
    "var exportButton=document.getElementById('group-selection-export');",
    "if(exportButton){exportButton.addEventListener('click',function(){var selections=groupPrioritySelects.map(function(select){return {group:select.dataset.group,level:select.value,suggested:select.dataset.suggested,changed:select.value!==select.dataset.suggested};});",
    "var payload={schema_version:1,exported_at:new Date().toISOString(),note:'排除候选不会自动修改微信或配置；交给 Agent 审核后再写入个人 Profile。',selections:selections};",
    "var blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});var url=URL.createObjectURL(blob);var link=document.createElement('a');link.href=url;link.download='wechat-group-selection.json';link.click();URL.revokeObjectURL(url);});}",
    "filterGroupRows();}",
    "const searchIndex=[];",
    "reportPages.forEach(function(page){var route=page.dataset.route;var meta=pageMeta.filter(function(item){return item.route===route;})[0]||pageMeta[0];",
    "var nodes=page.querySelectorAll('.markdown-body h2,.markdown-body h3,.markdown-body h4,.markdown-body li,.markdown-body p,.markdown-body summary,.markdown-body blockquote');",
    "Array.prototype.forEach.call(nodes,function(node,index){var text=node.textContent.replace(/\\s+/g,' ').trim();if(text.length<4){return;}",
    "if(!node.id){node.id='search-'+route+'-'+index;}var heading=meta.title;",
    "if(node.matches('h2,h3,h4')){heading=text;}else{var details=node.closest('details');if(details){var summary=details.querySelector('summary');if(summary){heading=summary.textContent.replace(/\\s+/g,' ').trim();}}}",
    "searchIndex.push({route:route,anchor:node.id,pageTitle:meta.title,heading:heading,text:text});});});",
    "function runSearch(){var query=searchInput.value.trim().toLowerCase();if(!query){searchPanel.hidden=true;searchResults.innerHTML='';return;}",
    "var matches=searchIndex.filter(function(item){return item.text.toLowerCase().indexOf(query)>=0;}).slice(0,36);",
    "searchHead.textContent='全部分区找到 '+matches.length+' 条结果';",
    "if(matches.length){searchResults.innerHTML=matches.map(function(item){var snippet=item.text.length>150?item.text.slice(0,150)+'…':item.text;",
    "return '<a class=\"search-result\" href=\"#/'+item.route+'/'+encodeURIComponent(item.anchor)+'\"><strong>'+escapeHtml(item.pageTitle)+' · '+escapeHtml(item.heading)+'</strong><p>'+escapeHtml(snippet)+'</p></a>';}).join('');}else{searchResults.innerHTML='<div class=\"search-empty\">没有找到匹配内容</div>';}",
    "searchPanel.hidden=false;}",
    "window.addEventListener('hashchange',function(){renderRoute();searchPanel.hidden=true;});",
    "routeLinks.forEach(function(link){link.addEventListener('click',function(){if(parseRoute().route===link.dataset.routeLink){setTimeout(function(){window.scrollTo(0,0);},0);}});});",
    "groupViewButtons.forEach(function(button){button.addEventListener('click',function(){setGroupView(button.dataset.groupViewButton);});});",
    "searchInput.addEventListener('input',runSearch);",
    "searchInput.addEventListener('keydown',function(event){if(event.key==='Escape'){searchInput.value='';searchPanel.hidden=true;searchInput.blur();}});",
    "document.addEventListener('keydown',function(event){if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();searchInput.focus();}});",
    "document.addEventListener('click',function(event){var node=event.target;if(node&&node.closest&&(node.closest('.search-wrap')||node.closest('.search-panel'))){return;}searchPanel.hidden=true;});",
    "document.getElementById('download-button').addEventListener('click',function(){var route=parseRoute().route;var meta=pageMeta.filter(function(page){return page.route===route;})[0]||pageMeta[0];",
    "var blob=new Blob([markdownByRoute[route]||''],{type:'text/markdown;charset=utf-8'});var url=URL.createObjectURL(blob);var link=document.createElement('a');link.href=url;link.download=meta.filename;link.click();URL.revokeObjectURL(url);});",
    "document.getElementById('print-button').addEventListener('click',function(){window.print();});",
    "var savedTheme=storageGet('wechat-flagship-theme');if(savedTheme){document.documentElement.dataset.theme=savedTheme;}",
    "document.getElementById('theme-button').addEventListener('click',function(){var next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;storageSet('wechat-flagship-theme',next);});",
    "initGroupSelector();if(groupViews.length){setGroupView(storageGet('wechat-group-view')||'topics');}renderRoute();",
  ];
}

// 同一份源文件会被 countHeadings / 主循环 / fallbackMarkdown 各读一次；
// 按 mtime+size 缓存，渲染期内重复读取直接复用。
const _mdCache = new Map();

function readSourceMarkdown(source) {
  if (typeof source.markdown === "string") return source.markdown;
  const file = source.path;
  if (!file) return "";
  try {
    const st = fs.statSync(file);
    const key = `${file}|${st.mtimeMs}|${st.size}`;
    const hit = _mdCache.get(key);
    if (hit !== undefined) return hit;
    const text = fs.readFileSync(file, "utf8");
    if (_mdCache.size >= 64) _mdCache.clear();
    _mdCache.set(key, text);
    return text;
  } catch {
    return "";
  }
}

function sourceView(source, route) {
  const relative = String(source.relativePath ?? source.relative_path ?? "");
  if (relative.endsWith("group_daily_topics.md")) return "topics";
  if (relative.endsWith("group_daily_groups.md")) return "groups";
  if (route === "groups") return "topics";
  return "";
}

function renderSourceSection(page, source, fragment) {
  const multiple = Array.isArray(page.sources) && page.sources.length > 1;
  const sourceId = String(source.sourceId ?? source.source_id ?? "section");
  const relative = String(source.relativePath ?? source.relative_path ?? "");
  const view = sourceView(source, page.route);
  const heading = multiple
    ? "<header class=\"source-title\"><p>" + escapeText(page.navLabel ?? page.title ?? "报告") + "</p><h2>" + escapeText(source.title ?? relative) + "</h2><code>" + escapeText(relative) + "</code></header>"
    : "<p class=\"source-origin\">完整来源 · " + escapeText(relative) + "</p>";
  return "<section class=\"source-document\" id=\"source-" + escapeText(sourceId) + "\" data-source=\"" + escapeText(relative) + "\"" +
    (view ? " data-group-view=\"" + escapeText(view) + "\"" : "") + ">" + heading +
    "<div class=\"markdown-body\">" + fragment + "</div></section>";
}

function countHeadings(page) {
  let total = 0;
  for (const source of Array.isArray(page.sources) ? page.sources : []) {
    const text = readSourceMarkdown(source);
    total += (text.match(/^#{2,4}\s+/gm) ?? []).length;
  }
  return total;
}

function renderPageSection(page, sections) {
  const switcherViews = [];
  for (const source of Array.isArray(page.sources) ? page.sources : []) {
    const view = sourceView(source, page.route);
    if (view && switcherViews.indexOf(view) < 0) switcherViews.push(view);
  }
  const switcher = page.route === "groups" && switcherViews.length + (sections.selector ? 1 : 0) > 1
    ? "<div class=\"view-switcher\" role=\"tablist\" aria-label=\"群聊日报阅读方式\">" +
      "<button class=\"view-button\" type=\"button\" data-group-view-button=\"topics\" role=\"tab\" aria-selected=\"false\">话题日报</button>" +
      (switcherViews.indexOf("groups") >= 0 ? "<button class=\"view-button\" type=\"button\" data-group-view-button=\"groups\" role=\"tab\" aria-selected=\"false\">重点群聊</button>" : "") +
      (sections.selector ? "<button class=\"view-button\" type=\"button\" data-group-view-button=\"selector\" role=\"tab\" aria-selected=\"false\">群聊筛选</button>" : "") +
      "</div>"
    : "";
  return "<section class=\"report-page\" data-route=\"" + escapeText(page.route) + "\" hidden>" +
    "<header class=\"page-head\"><div><p class=\"overline\">WeChat intelligence report</p><h1>" + escapeText(page.title) + "</h1><p>" + escapeText(page.description ?? "") + "</p></div>" +
    "<div class=\"page-stat\"><strong>" + countHeadings(page) + "</strong><span>内容节点</span></div></header>" +
    switcher + "<div class=\"page-content\">" + sections.html + "</div></section>";
}

/** JSON 内嵌到 <script> 时转义尖括号，避免提前闭合脚本或影响脚本计数 */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** 从源文件内容拼出某分区的 Markdown（用于下载按钮的兜底） */
function fallbackMarkdown(page) {
  const parts = ["# " + String(page.title ?? "")];
  for (const source of Array.isArray(page.sources) ? page.sources : []) {
    const text = normalizeDetailsMarkdown(readSourceMarkdown(source));
    parts.push("", "## " + String(source.title ?? source.relativePath ?? ""), "", stripFirstH1(text));
  }
  return parts.join("\n").trim() + "\n";
}

/**
 * 渲染旗舰交互式 HTML（单文件、无外部依赖）。
 * @param {{pages:Array, markdownByRoute?:object, title?:string, outPath?:string, groupsMatrix?:object, now?:Date}} options
 * @returns {{html:string, outPath:(string|null), markdownByRoute:object, pageMeta:Array}}
 */
export function renderFlagship(options = {}) {
  const pages = Array.isArray(options.pages) ? options.pages : [];
  if (!pages.length) throw new Error("没有可渲染的报告分区，已取消生成旗舰 HTML。");
  const title = String(options.title ?? "微信个人情报库｜综合日报");
  const outPath = options.outPath ? path.resolve(options.outPath) : null;
  const groupsMatrix = options.groupsMatrix ?? null;
  const now = options.now instanceof Date ? options.now : new Date();
  const generatedAt = fmtLocal(now);
  const markdownByRoute = { ...(options.markdownByRoute && typeof options.markdownByRoute === "object" ? options.markdownByRoute : {}) };

  const sourcePages = new Map();
  for (const page of pages) {
    for (const source of Array.isArray(page.sources) ? page.sources : []) {
      if (source.path) {
        sourcePages.set(path.resolve(source.path), {
          route: page.route,
          sourceId: String(source.sourceId ?? source.source_id ?? "section"),
        });
      }
    }
  }

  const pageHtml = [];
  const pageMeta = [];
  const allUrls = new Set();
  let readingText = "";
  let sourceCount = 0;
  for (const page of pages) {
    const sources = Array.isArray(page.sources) ? page.sources : [];
    const chunks = [];
    const routeMarkdown = [];
    for (const source of sources) {
      sourceCount += 1;
      const sourceId = String(source.sourceId ?? source.source_id ?? "section");
      const markdown = stripFirstH1(normalizeDetailsMarkdown(readSourceMarkdown(source)));
      readingText += markdown + "\n";
      routeMarkdown.push(markdown);
      for (const url of markdown.match(/https?:\/\/[^\s<>()[\]"']+/g) ?? []) {
        allUrls.add(url.replace(/[.,;:!?，。；：！？]+$/, ""));
      }
      let fragment = mdToHtmlLite(markdown, { idPrefix: sourceId + "-", allowParent: true });
      fragment = rewriteHtmlLinks(fragment, { source: { path: source.path, route: page.route }, sourcePages });
      const relative = String(source.relativePath ?? source.relative_path ?? "");
      if (relative.endsWith("group_daily_groups.md")) fragment = wrapKeyGroupSections(fragment);
      chunks.push(renderSourceSection(page, source, fragment));
    }
    let selectorHtml = "";
    if (page.route === "groups" && groupsMatrix && Array.isArray(groupsMatrix.groups) && groupsMatrix.groups.length) {
      selectorHtml = renderGroupSelector(groupsMatrix);
      chunks.push(selectorHtml);
    }
    pageHtml.push(renderPageSection(page, { html: chunks.join(""), selector: Boolean(selectorHtml) }));
    if (!markdownByRoute[page.route]) markdownByRoute[page.route] = fallbackMarkdown(page);
    pageMeta.push({
      route: page.route,
      title: String(page.title ?? page.route),
      description: String(page.description ?? ""),
      filename: String(page.filename ?? (page.route + ".md")),
      navLabel: String(page.navLabel ?? page.title ?? page.route),
      glyph: String(page.glyph ?? ""),
    });
  }

  const navHtml = pageMeta.map((page) => "<a class=\"nav-item\" href=\"#/" + escapeText(page.route) + "\" data-route-link=\"" + escapeText(page.route) + "\">" +
    "<span class=\"nav-glyph\">" + escapeText(page.glyph) + "</span><span>" + escapeText(page.navLabel) + "</span></a>").join("");
  const mobileNavHtml = pageMeta.map((page) => "<a href=\"#/" + escapeText(page.route) + "\" data-route-link=\"" + escapeText(page.route) + "\">" + escapeText(page.navLabel) + "</a>").join("");
  const orderedRoutes = ROUTE_ORDER.filter((route) => pageMeta.some((page) => page.route === route));
  const bottomNavHtml = orderedRoutes.map((route) => {
    const page = pageMeta.find((item) => item.route === route);
    return "<a href=\"#/" + escapeText(route) + "\" data-route-link=\"" + escapeText(route) + "\"><span>" + escapeText(page.glyph) + "</span>" + escapeText(page.navLabel) + "</a>";
  }).join("");

  const chineseChars = (readingText.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinWords = (readingText.match(/\b[A-Za-z][A-Za-z0-9'-]*\b/g) ?? []).length;
  const readingMinutes = Math.max(1, Math.round(chineseChars / 500 + latinWords / 250));

  const script = flagshipScript(jsonForScript(pageMeta), jsonForScript(markdownByRoute), jsonForScript(title)).join("\n");
  const html = [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta name=\"color-scheme\" content=\"light dark\">",
    "<meta name=\"description\" content=\"微信个人情报库综合交互日报\">",
    "<title>" + escapeText(title) + "</title>",
    "<style>",
    ...FLAGSHIP_CSS,
    "</style>",
    "</head>",
    "<body>",
    "<div class=\"app\">",
    "<aside class=\"chrome\">",
    "<div class=\"brand\"><span class=\"brand-mark\">W</span><span>微信个人情报库</span></div>",
    "<nav class=\"route-tabs\" aria-label=\"报告分区\">" + navHtml + "</nav>",
    "<div class=\"chrome-meta\"><span class=\"fresh-dot\"></span>本地只读 · " + escapeText(generatedAt) + " · " + sourceCount + " 份源报告 · " + allUrls.size + " 个原链接 · 完整阅读约 " + readingMinutes + " 分钟</div>",
    "</aside>",
    "<div class=\"workspace\">",
    "<header class=\"location-bar\">",
    "<div class=\"crumbs\">微信个人情报库 / <strong id=\"current-title\">" + escapeText(pageMeta[0].title) + "</strong></div>",
    "<label class=\"search-wrap\"><span class=\"sr-only\">搜索完整报告</span><input class=\"search-input\" id=\"search-input\" type=\"search\" placeholder=\"搜索联系人、群聊、品牌、项目或链接\"><span class=\"key\">⌘K</span></label>",
    "<div class=\"toolbar\">",
    "<button class=\"icon-button\" id=\"download-button\" type=\"button\" title=\"下载当前分区 Markdown\" aria-label=\"下载当前分区 Markdown\">↓</button>",
    "<button class=\"icon-button\" id=\"print-button\" type=\"button\" title=\"打印当前分区\" aria-label=\"打印当前分区\">▣</button>",
    "<button class=\"icon-button\" id=\"theme-button\" type=\"button\" title=\"切换明暗主题\" aria-label=\"切换明暗主题\">◐</button>",
    "</div>",
    "</header>",
    "<nav class=\"mobile-routes\" aria-label=\"移动端报告目录\">" + mobileNavHtml + "</nav>",
    "<main>" + pageHtml.join("") + "</main>",
    "</div>",
    "</div>",
    "<div class=\"search-panel\" id=\"search-panel\" hidden><div class=\"search-head\" id=\"search-head\">输入关键词搜索全部分区</div><div id=\"search-results\"></div></div>",
    "<nav class=\"bottom-nav\" aria-label=\"常用分区\">" + bottomNavHtml + "</nav>",
    "<script>",
    script,
    "</" + "script>",
    "</body>",
    "</html>",
  ].join("\n");

  const secured = protectDocument(html);
  if (outPath) {
    ensureDir(path.dirname(outPath));
    atomicWrite(outPath, secured);
  }
  return { html: secured, outPath, markdownByRoute, pageMeta };
}
