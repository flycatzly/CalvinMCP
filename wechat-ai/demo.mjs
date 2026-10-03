#!/usr/bin/env node
/**
 * 演示：用完全虚构的数据生成一份完整的「微信个人情报库」综合日报。
 *
 *   node demo.mjs                 # 写入默认数据根（~/.wechat-ai）下的 output/run-demo-<时间戳>/
 *   node demo.mjs --home <dir>    # 用隔离的数据根（推荐先这样试）
 *   node demo.mjs --keep          # 保留数据根（默认也不删除，方便你看产物）
 *
 * 生成的产物：
 *   wechat_daily_report.html   旗舰交互式报告（全局搜索 / 分区路由 / 明暗主题 / 打印 / 当前分区 Markdown 下载 / 群聊筛选）
 *   wechat_daily_full.md       门户 Markdown（阅读入口）
 *   wechat-report/             分区 Markdown 站点（综合行动 / 群聊日报 / 重点联系人 / 商单信号雷达）
 *   group-daily/               机器初筛、证据附录、话题日报、重点群聊、跨群链接、群聊价值矩阵、编辑包
 *   contact-daily/             重点联系人私聊日报
 *
 * 数据全部虚构，不含任何真实聊天、联系人或凭据。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const homeIdx = argv.indexOf("--home");
if (homeIdx >= 0 && argv[homeIdx + 1]) process.env.WECHAT_AI_HOME = path.resolve(argv[homeIdx + 1]);

const srv = await import(new URL("./mcp/server.mjs", import.meta.url).href);
const call = async (name, args) => {
  const r = await srv.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } });
  const res = r.result ?? {};
  if (res.isError) throw new Error(`${name} 失败：${res.structuredContent?.error ?? res.content?.[0]?.text ?? "未知"}`);
  return res.structuredContent ?? {};
};

const { paths, timestampSlug } = await import(new URL("./mcp/lib/paths.mjs", import.meta.url).href);
const P = paths();
console.log("数据根：" + P.home);

console.log("\n1/6 写入个人 Profile（本人昵称 + 重点标签）");
await call("wai_profile_init", { ownerAlias: "我", priorityLabel: "客户" });

console.log("2/6 导入样例导出文件（samples/export-demo）");
const scanned = await call("wai_scan", { target: path.join(here, "samples", "export-demo") });
console.log("    " + scanned.files + " 个文件 / " + scanned.inserted + " 条消息");

console.log("3/6 导入虚构演示数据源（覆盖全部信号类型）");
const indexed = await call("wai_db_index", { source: "mock", scope: "sessions", sessionLimit: 30, perChatLimit: 300, allowDemo: true });
console.log("    " + indexed.totals.sessions + " 个会话 / " + indexed.totals.inserted + " 条消息");

console.log("4/6 生成群聊日报 + 重点联系人日报 + 行动总览");
const run = path.join(P.output, "run-demo-" + timestampSlug());
fs.mkdirSync(path.join(run, "group-daily"), { recursive: true });
fs.mkdirSync(path.join(run, "contact-daily"), { recursive: true });

const g = await call("wai_group_daily", { hours: 100000, out: path.join(run, "group-daily") });
const c = await call("wai_contact_daily", { hours: 100000, out: path.join(run, "contact-daily") });
const b = await call("wai_brief", { hours: 100000, out: run });
console.log("    " + g.groupCount + " 个群 / " + c.count + " 个联系人");

// contact_daily_digest.md 属于 internal 类别，复制一份为 contacts 分区的入口
const cdDigest = c.files?.digest ?? path.join(run, "contact-daily", "contact_daily_digest.md");
if (fs.existsSync(cdDigest)) fs.copyFileSync(cdDigest, path.join(run, "contact-daily", "contact_daily_brief.md"));
// brief.md 作为综合行动分区的入口
const briefMd = b.files?.brief ?? path.join(run, "brief.md");
if (fs.existsSync(briefMd)) fs.copyFileSync(briefMd, path.join(run, "final_report.md"));

console.log("5/6 渲染旗舰交互式 HTML + 分区 Markdown 站点");
const bundle = await call("wai_render_bundle", { reportDir: run, title: "微信个人情报库｜综合日报" });
console.log("    路由：" + JSON.stringify(bundle.routes));

console.log("6/6 顺带跑一次商机管线与回复草稿");
const sync = await call("wai_opportunity_sync", { hours: 100000, dryRun: false });
const opps = await call("wai_opportunities", { includeCandidates: true, minPriority: 0, limit: 50 });
const reply = await call("wai_reply_draft", { name: "NovaAI", limit: 60 });
console.log("    商机：" + opps.count + " 条（本次新建 " + sync.created + " / 更新 " + sync.updated + "）");
console.log("    回复草稿：" + (reply.needed ? "需要回复 → " + (reply.draft ?? "").slice(0, 40) : "无需回复"));

console.log("\n产物目录：" + run);
console.log("  旗舰报告  " + bundle.html);
console.log("  门户 MD   " + bundle.markdown);
console.log("  分区站点  " + path.join(run, "wechat-report"));
console.log("\n用浏览器打开上面那个 .html 即可（全局搜索 ⌘/Ctrl+K、右上角 ◐ 切主题、▣ 打印、↓ 下载当前分区 Markdown）。");
console.log("全部数据均为虚构，不含任何真实聊天。");
