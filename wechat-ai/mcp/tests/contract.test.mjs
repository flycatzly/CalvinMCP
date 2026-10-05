// 契约测试（v1.1.3）：MCP 声明面与信封面的全工具一次遍历。
// 1) tools/list：73 工具、outputSchema 恒 {type:"object"}、inputSchema 形态、无重名。
// 2) 空参数遍历：73 工具逐个 tools/call（成功或定制报错皆可）——任何路径下
//    content[0] 必为 text 且不含 "[object Object]"、structuredContent 必为 record（非数组/非 null/非标量）。
//    这是 BUG-2/4（裸数组/裸数字 structuredContent）的类级免疫网，不依赖逐工具参数知识。
// 3) 内容层渲染扫描：mock 演示数据全量渲染（A–I 分析、日报/简报/复联/渲染器/Bundle），
//    递归扫描数据根所有文本产物（.md/.json/.html/.txt/.csv/.ics）无 "[object Object]"——
//    pick 双名路径（BUG-3 同类病灶）在内容层一网打尽。
//
// pick 双名静态审计（2026-10-05，md.mjs 全量多键 pick 枚举）：
//   - 唯一首键为对象的多键 pick 是「摘要候选」（BUG-3，v1.1.1 已修为 objPick 下钻并在 regression 套件钉住）；
//   - 「时间段/结束时间」双名（867/878/951）生产方 buildGroupEditorialPacket 两键同写一个字符串，安全；
//   - 跨群链接 contexts/证据行走逐字段下钻（安全模式）；其余多键 pick 首键均为标量或字符串数组；
//   - 顺带修正 objPick(session, ["actionable"]) 传数组当键的隐式 toString 依赖（行为等价，纯卫生）。
// 全部用例跑在隔离 WECHAT_AI_HOME 上，不碰真实 store。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "wai-contract-"));
let passed = 0, failed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (e) { failed += 1; fails.push(name + " :: " + (e?.message ?? e)); console.log("  ✗ " + name + " :: " + (e?.message ?? e)); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m ?? "不相等") + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m ?? "断言失败"); };

async function withHome(sub, fn) {
  const home = path.join(BASE, sub);
  fs.mkdirSync(home, { recursive: true });
  process.env.WECHAT_AI_HOME = home;
  const srv = await import(new URL("../server.mjs", import.meta.url).href + "?h=" + encodeURIComponent(sub));
  const rpc = (msg) => srv.handleRpc(msg);
  const call = async (name, args) => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } });
    return r.result ?? {};
  };
  return fn({ home, call, rpc, srv });
}

/** 信封契约断言：对任何 tools/call 结果（成功或错误）都成立 */
function assertEnvelope(name, res) {
  ok(Array.isArray(res.content) && res.content.length >= 1, name + "：缺 content");
  ok(res.content[0]?.type === "text" && typeof res.content[0].text === "string", name + "：content[0] 应为 text");
  ok(!res.content[0].text.includes("[object Object]"), name + "：content 文本出现 [object Object]：" + res.content[0].text.slice(0, 120));
  const sc = res.structuredContent;
  ok(sc !== null && sc !== undefined && typeof sc === "object" && !Array.isArray(sc), name + "：structuredContent 必为 record，实际 " + JSON.stringify(sc)?.slice(0, 80));
  if (res.isError) ok(typeof sc?.error === "string" && sc.error.length > 0, name + "：错误信封 error 应为非空字符串");
}

console.log("1) 声明面（tools/list）");

await t("73 个工具，无重名，inputSchema 形态为 object", async () => {
  await withHome("schema", async ({ rpc, srv }) => {
    eq(srv.TOOLS.length, 73, "工具数应为 73");
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const tools = r.result?.tools;
    ok(Array.isArray(tools), "tools/list 应返回 tools 数组");
    eq(tools.length, 73, "tools/list 数量应为 73");
    eq(new Set(tools.map((x) => x.name)).size, 73, "工具名不应重复");
    for (const x of tools) {
      eq(x.inputSchema?.type, "object", x.name + " inputSchema.type 应为 object");
    }
  });
});

await t("每个工具都声明 outputSchema（{type:\"object\"}），与 record 信封契约互为靶子", async () => {
  await withHome("schema2", async ({ rpc }) => {
    const r = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    for (const x of r.result.tools) {
      eq(x.outputSchema?.type, "object", x.name + " 应声明 outputSchema.type=object");
      ok(Object.keys(x.outputSchema).every((k) => k === "type" || k === "description"), x.name + " outputSchema 只应声明 type（不锁字段）");
    }
  });
});

console.log("\n2) 全工具空参数信封遍历（成功/报错皆可，信封必须恒为 record）");

await withHome("sweep", async ({ call, srv }) => {
  for (const name of srv.TOOLS.map((x) => x.name)) {
    await t("空参数信封：" + name, async () => {
      const res = await call(name, {});
      assertEnvelope(name, res);
    });
  }
});

console.log("\n3) 内容层渲染扫描（mock 全量渲染 + 数据根文本产物 [object Object] 扫描）");

await withHome("render", async ({ home, call }) => {
  await t("准备：mock 演示数据建索引", async () => {
    const r = await call("wai_db_index", { source: "mock", scope: "sessions", sessionLimit: 40, allowDemo: true });
    ok(!r.isError, "mock 索引失败：" + JSON.stringify(r.structuredContent).slice(0, 160));
  });

  const out = (...seg) => path.join(home, "out", ...seg);
  const TABLE = [
    ["wai_home", { out: out("home") }],
    ["wai_brief", { days: 30, out: out("brief") }],
    ["wai_today", { out: out("today") }],
    ["wai_group_daily", { days: 30, groupLimit: 20, out: out("group") }],
    ["wai_contact_daily", { days: 30, out: out("contact") }],
    ["wai_reactivation", { days: 30, out: out("react") }],
    ["wai_period_report", { days: 30, out: out("period") }],
    ["wai_social_graph", { days: 30, out: out("social") }],
    ["wai_sentiment_trend", { days: 30, out: out("sent") }],
    ["wai_task_extract", { days: 30, out: out("task") }],
    ["wai_finance", { days: 30, out: out("fin") }],
    ["wai_memory", { days: 30, out: out("mem") }],
    ["wai_content_analysis", { days: 30, out: out("content") }],
    ["wai_team_review", { days: 30, out: out("team") }],
    ["wai_risk_scan", { days: 30, out: out("risk") }],
    ["wai_signals", { days: 30 }],
    ["wai_opportunities", {}],
    ["wai_new_leads", {}],
    ["wai_person", { name: "客户群-澄明科技", days: 30, out: out("person") }],
    ["wai_topic", { topic: "AI 培训", keyword: ["培训", "大纲"], days: 30, out: out("topic") }],
    ["wai_render_html", { markdown: "# 契约渲染\n\n正文 **加粗** 与列表：\n\n- 甲\n- 乙\n", out: out("render.html"), title: "契约渲染" }],
  ];
  for (const [name, args] of TABLE) {
    await t("渲染信封：" + name, async () => {
      const res = await call(name, args);
      ok(!res.isError, name + " 渲染失败：" + JSON.stringify(res.structuredContent?.error ?? res.structuredContent).slice(0, 200));
      assertEnvelope(name, res);
    });
  }

  await t("Bundle 渲染（以群日报目录为输入）", async () => {
    const res = await call("wai_render_bundle", { reportDir: out("group"), out: out("bundle", "index.html"), title: "契约 Bundle" });
    ok(!res.isError, "render_bundle 失败：" + JSON.stringify(res.structuredContent?.error ?? res.structuredContent).slice(0, 200));
    assertEnvelope("wai_render_bundle", res);
  });

  await t("数据根文本产物全扫描：无 [object Object]", async () => {
    const exts = new Set([".md", ".json", ".html", ".txt", ".csv", ".ics"]);
    const bad = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (exts.has(path.extname(ent.name).toLowerCase())) {
          const text = fs.readFileSync(p, "utf8");
          if (text.includes("[object Object]")) bad.push(path.relative(home, p));
        }
      }
    };
    walk(home);
    ok(bad.length === 0, "以下产物出现 [object Object]：" + bad.join("、"));
  });
});

console.log("\n" + "=".repeat(50));
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  console.log("");
}
console.log("=== " + passed + " passed, " + failed + " failed ===");
try { fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
