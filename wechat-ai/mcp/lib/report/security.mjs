// 报告安全边界：不可信片段的 HTML 白名单净化、URL 校验与文档级 CSP 加固。
// 与上游 wechat-intelligence-hub/report_security.py 行为对齐；零依赖，仅用 node: 内置模块。
import crypto from "node:crypto";

/** 允许保留的标签；未列入的标签只丢标签、保留内部文字 */
const ALLOWED_TAGS = new Set([
  "a", "p", "br", "hr", "strong", "b", "em", "i", "s", "del",
  "ul", "ol", "li", "blockquote", "pre", "code", "span", "div",
  "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody",
  "tfoot", "tr", "th", "td", "sup", "sub", "details", "summary",
]);

/** 连同内容一起删除的标签：脚本、样式、嵌入式文档、矢量/数学标记、模板 */
const CLEAN_CONTENT_TAGS = new Set(["script", "style", "iframe", "object", "svg", "math", "template"]);

/** 原始文本元素：内部内容不按 HTML 解析 */
const RAW_TEXT_TAGS = new Set(["script", "style"]);

/** 反引号（避免在源码里转义困扰） */
const CODE_TICK = String.fromCharCode(96);

/** 空元素：不输出闭合标签 */
const VOID_TAGS = new Set(["br", "hr"]);

/** 属性白名单：a 只留 href/title；* 只留 id；其余按标签放行 */
const ATTR_WHITELIST = {
  a: new Set(["href", "title"]),
  "*": new Set(["id"]),
  ol: new Set(["start"]),
  li: new Set(["value"]),
  th: new Set(["colspan", "rowspan"]),
  td: new Set(["colspan", "rowspan"]),
  details: new Set(["open"]),
};

/** 需要解码的常见命名实体（足以覆盖报告排版用到的实体） */
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };

/** 文本节点转义 */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    if (ch === ">") return "&gt;";
    if (ch === "\"") return "&quot;";
    return "&#x27;";
  });
}

/** 属性值转义（含换行归一，避免属性注入） */
function escapeAttr(value) {
  return escapeHtml(String(value ?? "").replace(/[\r\n\t]+/g, " "));
}

/** 实体解码：只处理数字实体与常见命名实体，其余原样保留 */
function decodeEntities(text) {
  return String(text ?? "").replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body.charAt(0) === "#") {
      const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : whole;
  });
}

/** 文本序列化：转义并保留不换行空格 */
function serializeText(text) {
  return escapeHtml(text).replace(/\u00a0/g, "&nbsp;");
}

/** 百分号解码：整段解码，失败时保留原样（与 Python unquote 的容错一致） */
function percentDecode(value) {
  return String(value ?? "").replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

/** urlsplit 子集：取出 scheme / 用户信息 / 主机名（不含端口） */
function splitUrl(value) {
  const raw = String(value ?? "");
  const match = SCHEME_RE.exec(raw);
  const scheme = match ? match[1] : "";
  const rest = match ? raw.slice(match[0].length) : raw;
  let netloc = "";
  if (rest.startsWith("//")) {
    const after = rest.slice(2);
    const cut = after.search(/[/?#]/);
    netloc = cut < 0 ? after : after.slice(0, cut);
  }
  let username = null;
  let password = null;
  let host = netloc;
  if (host) {
    const at = host.lastIndexOf("@");
    if (at >= 0) {
      const userinfo = host.slice(0, at);
      host = host.slice(at + 1);
      const colon = userinfo.indexOf(":");
      username = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
      password = colon >= 0 ? userinfo.slice(colon + 1) : null;
    }
  }
  let hostname = host;
  if (hostname.startsWith("[")) {
    const close = hostname.indexOf("]");
    hostname = close >= 0 ? hostname.slice(1, close) : hostname.slice(1);
  } else {
    const colon = hostname.indexOf(":");
    if (colon >= 0) hostname = hostname.slice(0, colon);
  }
  return { scheme, netloc, username, password, hostname: hostname.toLowerCase() };
}

/**
 * URL 安全校验：不安全返回 null，安全返回原值。
 * 拒绝：控制字符、反斜杠、协议相对地址、绝对路径、非 http/https scheme、带账号密码的 URL、越级相对路径（allowParent 为假时）。
 */
export function safeHref(value, options = {}) {
  const allowParent = options.allowParent === true;
  const raw = String(value ?? "").trim();
  const decoded = percentDecode(raw);
  for (const ch of decoded) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) return null;
  }
  if (decoded.includes("\\")) return null;
  if (decoded.startsWith("//") || decoded.startsWith("/")) return null;
  const parsed = splitUrl(raw);
  const decodedScheme = splitUrl(decoded).scheme.toLowerCase();
  if (parsed.scheme) {
    const scheme = parsed.scheme.toLowerCase();
    if (scheme !== "http" && scheme !== "https") return null;
    if (!parsed.hostname) return null;
    if (parsed.username !== null || parsed.password !== null) return null;
    return raw;
  }
  if (decodedScheme) return null;
  if (!allowParent && (decoded.startsWith("..") || decoded.includes("/../"))) return null;
  return raw;
}

/** 解析开始标签的属性列表（保序，去掉重复名） */
function parseAttrs(raw) {
  const attrs = [];
  const seen = new Set();
  const body = raw.replace(/^<[a-zA-Z][a-zA-Z0-9:-]*/, "").replace(/\/?>$/, "");
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+)))?/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const name = match[1].toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    const value = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : "";
    attrs.push({ name, value: decodeEntities(value) });
  }
  return attrs;
}

/** 容错分词：注释、声明、开始/结束标签、文本 */
function tokenize(html) {
  const source = String(html ?? "");
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const lt = source.indexOf("<", index);
    if (lt < 0) {
      tokens.push({ type: "text", value: source.slice(index) });
      break;
    }
    if (lt > index) tokens.push({ type: "text", value: source.slice(index, lt) });
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      const stop = end < 0 ? source.length : end + 3;
      tokens.push({ type: "comment" });
      index = stop;
      continue;
    }
    if (source.startsWith("<!", lt) || source.startsWith("<?", lt)) {
      const end = source.indexOf(">", lt + 2);
      const stop = end < 0 ? source.length : end + 1;
      tokens.push({ type: "decl" });
      index = stop;
      continue;
    }
    const match = /^<\/?([a-zA-Z][a-zA-Z0-9:-]*)/.exec(source.slice(lt));
    if (!match) {
      tokens.push({ type: "text", value: "<" });
      index = lt + 1;
      continue;
    }
    const name = match[1].toLowerCase();
    const closing = source.charAt(lt + 1) === "/";
    let cursor = lt + match[0].length;
    let quote = "";
    while (cursor < source.length) {
      const ch = source.charAt(cursor);
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === "\"" || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      cursor += 1;
    }
    if (cursor >= source.length) {
      tokens.push({ type: "text", value: source.slice(lt) });
      break;
    }
    const rawTag = source.slice(lt, cursor + 1);
    if (closing) {
      tokens.push({ type: "end", name });
      index = cursor + 1;
      continue;
    }
    tokens.push({ type: "start", name, attrs: parseAttrs(rawTag), selfClosing: /\/\s*>$/.test(rawTag) });
    index = cursor + 1;
    if (RAW_TEXT_TAGS.has(name)) {
      const close = new RegExp("</" + name + "\\s*>", "i");
      const tail = source.slice(index);
      const hit = close.exec(tail);
      if (hit) {
        if (hit.index > 0) tokens.push({ type: "text", value: tail.slice(0, hit.index) });
        tokens.push({ type: "end", name });
        index = index + hit.index + hit[0].length;
      } else {
        tokens.push({ type: "text", value: tail });
        index = source.length;
      }
    }
  }
  return tokens;
}

/** 构建元素树；不允许的标签透明处理（丢标签留内容），危险标签整段丢弃 */
function buildTree(tokens) {
  const root = { type: "root", children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "text") {
      if (!token.value) continue;
      top().children.push({ type: "text", value: decodeEntities(token.value) });
      continue;
    }
    if (token.type === "comment" || token.type === "decl") continue;
    if (token.type === "start") {
      if (CLEAN_CONTENT_TAGS.has(token.name)) {
        let depth = 1;
        for (let scan = index + 1; scan < tokens.length; scan += 1) {
          const probe = tokens[scan];
          if (probe.type === "start" && probe.name === token.name && !probe.selfClosing) depth += 1;
          else if (probe.type === "end" && probe.name === token.name) {
            depth -= 1;
            if (depth === 0) {
              index = scan;
              break;
            }
          }
        }
        continue;
      }
      if (!ALLOWED_TAGS.has(token.name)) continue;
      const node = { type: "el", name: token.name, attrs: token.attrs, children: [] };
      top().children.push(node);
      if (!token.selfClosing && !VOID_TAGS.has(token.name)) stack.push(node);
      continue;
    }
    if (token.type === "end") {
      for (let scan = stack.length - 1; scan >= 1; scan -= 1) {
        if (stack[scan].name === token.name) {
          stack.length = scan;
          break;
        }
      }
    }
  }
  return root;
}

/** 属性过滤：只保留白名单属性，href 必须通过 safeHref，id 必须命中前缀 */
function serializeAttrs(node, options) {
  const allowed = ATTR_WHITELIST[node.name] ?? null;
  const parts = [];
  let hasHref = false;
  for (const attr of node.attrs) {
    const byTag = allowed && allowed.has(attr.name);
    const byStar = ATTR_WHITELIST["*"].has(attr.name);
    if (!byTag && !byStar) continue;
    if (attr.name === "href") {
      const href = safeHref(attr.value, { allowParent: options.allowParent });
      if (href === null || href === "") continue;
      hasHref = true;
      parts.push(" href=\"" + escapeAttr(href) + "\"");
      continue;
    }
    if (attr.name === "id") {
      const value = String(attr.value ?? "");
      if (!options.idPrefix || !value.startsWith(options.idPrefix)) continue;
      parts.push(" id=\"" + escapeAttr(value) + "\"");
      continue;
    }
    parts.push(" " + attr.name + "=\"" + escapeAttr(attr.value) + "\"");
  }
  if (node.name === "a" && hasHref) parts.push(" rel=\"noopener noreferrer\"");
  return parts.join("");
}

function serializeNode(node, options) {
  if (node.type === "text") return serializeText(node.value);
  if (node.type === "root") return node.children.map((child) => serializeNode(child, options)).join("");
  const attrs = serializeAttrs(node, options);
  const inner = node.children.map((child) => serializeNode(child, options)).join("");
  if (VOID_TAGS.has(node.name)) return "<" + node.name + attrs + ">" + inner;
  return "<" + node.name + attrs + ">" + inner + "</" + node.name + ">";
}

/**
 * 白名单净化 HTML 片段。
 * @param {string} html 不可信片段
 * @param {{idPrefix?: string, allowParent?: boolean}} options idPrefix 为空时丢弃全部 id；allowParent 决定是否允许 ../ 相对链接
 */
export function sanitizeFragment(html, options = {}) {
  const idPrefix = typeof options.idPrefix === "string" ? options.idPrefix : "";
  const allowParent = options.allowParent === true;
  return serializeNode(buildTree(tokenize(html)), { idPrefix, allowParent });
}

/**
 * 文档加固：校验脚本结构，在 <meta charset="utf-8"> 之后注入 CSP 与 referrer 策略。
 * @param {string} html 完整文档
 * @param {{static?: boolean}} options static 为真时要求 0 个脚本，否则要求恰好 1 个内联脚本
 */
export function protectDocument(html, options = {}) {
  const staticMode = options.static === true;
  const doc = String(html ?? "");
  const scripts = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = re.exec(doc)) !== null) scripts.push(match[1]);
  const expected = staticMode ? 0 : 1;
  const opened = doc.match(/<script\b/gi) ?? [];
  if (scripts.length !== expected || opened.length !== expected) {
    throw new Error("报告脚本结构异常（要求恰好 " + expected + " 个内联脚本），拒绝输出 HTML。");
  }
  const anchors = doc.split("<meta charset=\"utf-8\">").length - 1;
  if (anchors !== 1) {
    throw new Error("缺少报告安全注入点（<meta charset=\"utf-8\"> 必须恰好出现一次），拒绝输出 HTML。");
  }
  let scriptPolicy = "'none'";
  if (!staticMode) {
    const digest = crypto.createHash("sha256").update(scripts[0], "utf8").digest("base64");
    scriptPolicy = "'sha256-" + digest + "'";
  }
  const policy =
    "default-src 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; " +
    "connect-src 'none'; img-src 'none'; media-src 'none'; form-action 'none'; " +
    "script-src " + scriptPolicy + "; style-src 'unsafe-inline'";
  const metas =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"" + escapeHtml(policy) + "\">\n" +
    "<meta name=\"referrer\" content=\"no-referrer\">";
  return doc.replace("<meta charset=\"utf-8\">", "<meta charset=\"utf-8\">\n" + metas);
}

// ---------------------------------------------------------------------------
// 零依赖 Markdown 子集渲染：标题 / 粗体 / 斜体 / 行内代码 / 代码块 / 列表 /
// 引用 / 表格 / 水平线 / 段落 / 链接与裸 URL。渲染结果一律经过 sanitizeFragment。
// ---------------------------------------------------------------------------

/** 行内渲染：先在原始文本上抽出链接（避免二次转义），再做强调与代码还原 */
function renderInline(text, options) {
  const source = String(text ?? "").replace(/\u0000/g, "");
  const codes = [];
  const stashed = [];
  const stash = (html) => {
    stashed.push(html);
    return "\u0001A" + (stashed.length - 1) + "\u0001";
  };
  const anchor = (label, href) => {
    const safe = safeHref(href, { allowParent: options.allowParent });
    if (safe === null) return null;
    const finalHref = options.rewriteHref ? options.rewriteHref(safe) : safe;
    if (!finalHref) return null;
    return stash("<a href=\"" + escapeAttr(finalHref) + "\">" + escapeHtml(label || safe) + "</a>");
  };
  let work = source.replace(/(\x60+)([\s\S]*?)\1/g, (whole, fence, body) => {
    codes.push(body);
    return "\u0001C" + (codes.length - 1) + "\u0001";
  });
  work = work.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+["'][^"']*["'])?\)/g, (_whole, label) => label || "图片");
  work = work.replace(/\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+["'][^"']*["'])?\)/g, (whole, label, href) => {
    const html = anchor(label, href);
    return html === null ? (label || href) : html;
  });
  work = work.replace(/(?<![\w(\uFF08\u3010])(https?:\/\/[^\s<>()\uFF08\uFF09\u3010\u3011"'\uFF0C\u3002\uFF1B\uFF01\uFF1F]+)/g, (whole, url) => {
    const html = anchor(url, url);
    return html === null ? url : html;
  });
  // 危险原始标记：按行内代码渲染（沿用已有的 code 占位机制，保证只转义一次）
  work = work.replace(/<(script|style|iframe|object|svg|math|template)\b[\s\S]*?<\/\1\s*>/gi, (m) => "\u0001C" + (codes.push(m) - 1) + "\u0001");
  work = work.replace(/<\/?(?:script|style|iframe|object|svg|math|template)\b[^>]*>/gi, (m) => "\u0001C" + (codes.push(m) - 1) + "\u0001");
  work = escapeHtml(work);
  work = work.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  work = work.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  work = work.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  work = work.replace(/(^|[\s\uFF08\u3010])_([^_]+)_(?=$|[\s\uFF09\u3011.,;:!?\u3002\uFF0C])/g, "$1<em>$2</em>");
  work = work.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  work = work.replace(/\u0001A(\d+)\u0001/g, (_whole, idx) => stashed[Number(idx)] ?? "");
  work = work.replace(/\u0001C(\d+)\u0001/g, (_whole, idx) => "<code>" + escapeHtml(codes[Number(idx)] ?? "") + "</code>");
  return work;
}
const FENCE_RE = /^\s*(?:\x60{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
const FENCE_END_RE = /^\s*(?:\x60{3,}|~{3,})\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;


/** 判断某行是否开启新块，用于段落收集 */
function isBlockStart(line) {
  return (
    FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) ||
    UL_RE.test(line) || OL_RE.test(line) || QUOTE_RE.test(line) ||
    /^\s*\|.*\|\s*$/.test(line)
  );
}

function splitTableRow(line) {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((cell) => cell.trim());
}

/** 块级渲染 */
function renderBlocks(lines, options) {
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (FENCE_RE.test(line)) {
      index += 1;
      const buffer = [];
      while (index < lines.length && !FENCE_END_RE.test(lines[index])) {
        buffer.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      out.push("<pre><code>" + escapeHtml(buffer.join("\n")) + "</code></pre>");
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push("<h" + level + ">" + renderInline(heading[2], options) + "</h" + level + ">");
      index += 1;
      continue;
    }
    if (HR_RE.test(line)) {
      out.push("<hr>");
      index += 1;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const buffer = [];
      while (index < lines.length && QUOTE_RE.test(lines[index])) {
        buffer.push(QUOTE_RE.exec(lines[index])[1]);
        index += 1;
      }
      out.push("<blockquote>" + renderBlocks(buffer, options) + "</blockquote>");
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && TABLE_SEP_RE.test(lines[index + 1]) && lines[index + 1].includes("-")) {
      const header = splitTableRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      const head = "<tr>" + header.map((cell) => "<th>" + renderInline(cell, options) + "</th>").join("") + "</tr>";
      const body = rows
        .map((cells) => "<tr>" + header.map((_cell, col) => "<td>" + renderInline(cells[col] ?? "", options) + "</td>").join("") + "</tr>")
        .join("");
      out.push("<table><thead>" + head + "</thead><tbody>" + body + "</tbody></table>");
      continue;
    }
    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const startMatch = ordered ? OL_RE.exec(line) : null;
      const items = [];
      while (index < lines.length && (ordered ? OL_RE.test(lines[index]) : UL_RE.test(lines[index]))) {
        const match = ordered ? OL_RE.exec(lines[index]) : UL_RE.exec(lines[index]);
        let text = ordered ? match[3] : match[2];
        index += 1;
        while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index]) && /^\s{2,}\S/.test(lines[index])) {
          text += " " + lines[index].trim();
          index += 1;
        }
        items.push("<li>" + renderInline(text, options) + "</li>");
      }
      if (ordered) {
        const start = Number(startMatch[2]);
        const attr = Number.isFinite(start) && start !== 1 ? " start=\"" + start + "\"" : "";
        out.push("<ol" + attr + ">" + items.join("") + "</ol>");
      } else {
        out.push("<ul>" + items.join("") + "</ul>");
      }
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    out.push("<p>" + renderInline(paragraph.join(" "), options) + "</p>");
  }
  return out.join("\n");
}

/**
 * 零依赖 Markdown 子集渲染器，渲染结果经过白名单净化。
 * @param {string} markdown Markdown 文本
 * @param {{idPrefix?: string, allowParent?: boolean, rewriteHref?: (href: string) => (string|null)}} options
 * @returns {string} 安全 HTML 片段
 */
export function mdToHtmlLite(markdown, options = {}) {
  const settings = {
    idPrefix: typeof options.idPrefix === "string" ? options.idPrefix : "",
    allowParent: options.allowParent !== false,
    rewriteHref: typeof options.rewriteHref === "function" ? options.rewriteHref : null,
  };
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = renderBlocks(lines, settings);
  return sanitizeFragment(html, { idPrefix: settings.idPrefix, allowParent: settings.allowParent });
}
