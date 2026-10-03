import assert from "node:assert/strict";
import { sanitizeFragment, safeHref, protectDocument, escapeHtml, mdToHtmlLite } from "file:///D:/Users/DeepSeekWeb/wechat-ai/mcp/lib/report/security.mjs";

let passed = 0;
const t = (name, fn) => { try { fn(); passed += 1; } catch (error) { console.log("FAIL " + name + " :: " + error.message); process.exitCode = 1; } };

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/g;
const ATTR_RE = /([^\s=]+)(?:="([^"]*)")?/g;
function tags(html) {
  const out = [];
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html)) !== null) {
    const attrs = {};
    let a;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(m[2])) !== null) attrs[a[1]] = a[2] === undefined ? "" : a[2];
    out.push([m[1].toLowerCase(), attrs]);
  }
  return out;
}
function assertInert(fragment) {
  for (const [tag, attrs] of tags(fragment)) {
    assert.ok(!["script","img","iframe","svg","math","object","form","input","style"].includes(tag), "危险标签 " + tag);
    for (const key of Object.keys(attrs)) {
      assert.ok(!key.startsWith("on") && !["style","src","srcdoc"].includes(key), "危险属性 " + key);
    }
    if ("href" in attrs && attrs.href !== "") assert.notEqual(safeHref(attrs.href), null, "href 不安全 " + attrs.href);
  }
}

t("safeHref 拒绝清单", () => {
  for (const url of ["javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,test", "file:///etc/passwd", "//invalid.example", "\\invalid.example", "%2f%2finvalid.example", "https://user:pass@example.com"]) {
    assert.equal(safeHref(url), null, url + " 应被拒绝");
  }
});
t("safeHref 允许清单", () => {
  for (const url of ["https://example.com/?x=1&y=2", "#/groups", "#section", "group-daily/report.md"]) {
    assert.equal(safeHref(url), url, url + " 应被允许");
  }
});
t("safeHref allowParent", () => {
  assert.equal(safeHref("../final_report.md"), null);
  assert.equal(safeHref("../final_report.md", { allowParent: true }), "../final_report.md");
});
t("净化主动标记与追踪", () => {
  const payload = '<p onclick="alert(1)">hello</p><img src="https://invalid.example/pixel" onerror="alert(1)">'
    + '<svg><a xlink:href="javascript:alert(1)">x</a></svg><iframe srcdoc="x"></iframe>'
    + '<style>body{display:none}</style><script>window.bad=1</script>'
    + '<a href="jAvAsCrIpT:alert(1)">bad</a><a href="https://example.com">ok</a>';
  const cleaned = sanitizeFragment(payload);
  assertInert(cleaned);
  assert.ok(cleaned.includes("hello"));
  assert.ok(cleaned.includes("https://example.com"));
  assert.ok(!cleaned.includes("window.bad"));
  assert.ok(!cleaned.includes("<!--"));
});
t("表格 标题 代码保留", () => {
  const cleaned = sanitizeFragment('<h2 id="source-topic">Topic</h2><table><tr><td>Evidence</td></tr></table><pre><code>&lt;script&gt;example&lt;/script&gt;</code></pre>', { idPrefix: "source-" });
  assert.ok(cleaned.includes('id="source-topic"'), cleaned);
  assert.ok(cleaned.includes("<table>"));
  assert.ok(cleaned.includes("&lt;script&gt;"));
  assert.ok(!sanitizeFragment('<p id="search-input">bad id</p>', { idPrefix: "source-" }).includes("id="));
});
t("a 标签带 rel", () => {
  const cleaned = sanitizeFragment('<a href="https://example.com" title="t">x</a>');
  assert.ok(cleaned.includes('rel="noopener noreferrer"'), cleaned);
  assert.ok(cleaned.includes('title="t"'));
});
t("protectDocument 结构校验", () => {
  assert.throws(() => protectDocument('<meta charset="utf-8"><script>app()</script><script>bad()</script>'));
  assert.throws(() => protectDocument('<script>app()</script>'));
  assert.throws(() => protectDocument('<meta charset="utf-8"><script>a()</script><meta charset="utf-8">'));
  const out = protectDocument('<meta charset="utf-8">\n<title>x</title>\n<script>app()</script>');
  assert.ok(out.includes("Content-Security-Policy"));
  assert.ok(out.includes("connect-src &#x27;none&#x27;"));
  assert.ok(out.includes('<meta name="referrer" content="no-referrer">'));
  assert.ok(/script-src 'sha256-[A-Za-z0-9+/=]+'/.test(out.replace(/&#x27;/g, "'")), out);
  const stat = protectDocument('<meta charset="utf-8"><p>x</p>', { static: true });
  assert.ok(stat.includes("script-src &#x27;none&#x27;"));
  assert.equal((out.match(/<meta charset="utf-8">/g) || []).length, 1);
});
t("escapeHtml", () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), "&lt;a href=&quot;x&quot;&gt;&amp;&#x27;&lt;/a&gt;");
});
t("mdToHtmlLite 覆盖", () => {
  const md = [
    "# 标题一", "", "段落 **粗体** *斜体* \x60code\x60 与 https://example.com/a?b=1&c=2 以及 [链接](https://example.com/x)。", "",
    "## 列表", "", "- 甲", "- 乙", "", "3. 丙", "4. 丁", "", "> 引用 **重要**", "",
    "| 列一 | 列二 |", "| --- | ---: |", "| a | b |", "", "---", "",
    "~~~js", "const a = 1 < 2;", "~~~", "",
    "[坏](javascript:alert(1))", "",
    "<script>alert(1)</script>",
  ].join("\n");
  const html = mdToHtmlLite(md);
  assert.ok(html.includes("<h1>标题一</h1>"), html);
  assert.ok(html.includes("<h2>列表</h2>"));
  assert.ok(html.includes("<strong>粗体</strong>"));
  assert.ok(html.includes("<em>斜体</em>"));
  assert.ok(html.includes("<code>code</code>"));
  assert.ok(html.includes('href="https://example.com/a?b=1&amp;c=2"'), html);
  assert.ok(html.includes('href="https://example.com/x"') && html.includes(">链接</a>"), html);
  assert.ok(html.includes("<ul><li>甲</li><li>乙</li></ul>"));
  assert.ok(html.includes('<ol start="3"><li>丙</li><li>丁</li></ol>'));
  assert.ok(html.includes("<blockquote><p>引用 <strong>重要</strong></p></blockquote>"));
  assert.ok(html.includes("<table><thead><tr><th>列一</th><th>列二</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>"), html);
  assert.ok(html.includes("<hr>"));
  assert.ok(html.includes("const a = 1 &lt; 2;"));
  assert.ok(html.includes("<p>坏</p>"), html);
  assertInert(html);
  assert.ok(!html.includes("<script"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), html);
});
console.log("=== " + passed + " passed ===");
