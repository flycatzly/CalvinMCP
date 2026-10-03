// 微信流核心自测：场景匹配 → 载荷渲染 → 投递（folder/agent/obsidian/clipboard）→ 批次状态机 → 历史记录。
// 全程使用临时数据根（WECHAT_AI_HOME）与临时目录，不碰真实用户数据。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = path.join(os.tmpdir(), "wechat-ai-selftest-" + Date.now());
const WORK = path.join(os.tmpdir(), "wechat-ai-selftest-work-" + Date.now());
process.env.WECHAT_AI_HOME = HOME; // 必须在动态 import 之前设置（paths.home() 每次读取环境变量）

const { paths, ensureHome } = await import("./lib/paths.mjs");
const scenes = await import("./lib/wechat/scenes.mjs");
const targets = await import("./lib/wechat/targets.mjs");
const obsidian = await import("./lib/wechat/obsidian.mjs");
const skills = await import("./lib/wechat/skills-catalog.mjs");
const batch = await import("./lib/wechat/batch.mjs");
const history = await import("./lib/wechat/history.mjs");

let passed = 0;
let failed = 0;
const short = (v, n = 240) => {
  if (typeof v === "string") return v.length > n ? v.slice(0, n) + "…(" + v.length + " 字)" : v;
  if (Array.isArray(v)) return v.map((x) => short(x, n));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, short(x, n)]));
  return v;
};
const dump = (v) => console.log(JSON.stringify(short(v), null, 2).split("\n").map((l) => "    " + l).join("\n"));
function expect(cond, message) {
  if (!cond) throw new Error("断言失败：" + message);
}
async function step(name, fn) {
  try {
    const r = await fn();
    passed += 1;
    console.log("\n[通过] " + name);
    if (r !== undefined) dump(r);
    return r;
  } catch (e) {
    failed += 1;
    console.log("\n[失败] " + name);
    console.log("    " + String(e?.stack ?? e).split("\n").join("\n    "));
    return null;
  }
}

fs.mkdirSync(WORK, { recursive: true });
const outDir = path.join(WORK, "out");
const folderDir = path.join(WORK, "folder");
const vaultDir = path.join(WORK, "vault");
for (const d of [outDir, folderDir, vaultDir]) fs.mkdirSync(d, { recursive: true });

console.log("数据根：" + HOME);
console.log("临时工作目录：" + WORK);

// ---------- 1. 数据根 ----------
await step("1. 数据根与目录（paths/ensureHome）", () => {
  ensureHome();
  const p = paths();
  expect(p.home === HOME, "WECHAT_AI_HOME 未生效：" + p.home);
  expect(fs.existsSync(p.output), "输出目录未创建");
  return { home: p.home, output: p.output, store: p.store };
});

// ---------- 2. 造载荷 ----------
const LINK = "https://mp.weixin.qq.com/s/AbCdEf12345";
const now = Date.now();
const payload = {
  source: "selftest",
  title: "客户群 · 3 月需求确认",
  chat: "AI 客户对接群",
  kind: "chat",
  messages: [
    { sender: "王经理", ts: now - 3600_000, content: "下周要把初稿发我，预算 3 万以内。" },
    { sender: "我", ts: now - 1800_000, content: "收到，先看这篇参考文章 " + LINK, is_owner: true },
  ],
  files: [],
};
await step("2. 构造载荷（中文群名 + 2 条消息 + 1 个链接）", () => {
  const p = scenes.normalizeDeliveryPayload(payload);
  expect(p.chat === "AI 客户对接群", "群名丢失");
  expect(p.count === 2, "消息条数应为 2，实际 " + p.count);
  expect(p.links.length === 1 && p.links[0].includes("mp.weixin.qq.com"), "链接未识别");
  return { chat: p.chat, title: p.title, count: p.count, links: p.links, sinceMs: p.sinceMs, untilMs: p.untilMs };
});

// ---------- 3. 场景匹配 ----------
await step("3. scenes.matchSceneFor（客户群 → 客户群场景）", () => {
  const hit = scenes.matchSceneFor("AI 客户对接群");
  expect(hit && hit.id === "customer", "应匹配到 customer 场景，实际 " + JSON.stringify(hit?.id ?? null));
  return { id: hit.id, name: hit.name, priority: hit.priority, task: hit.task };
});

await step("3b. scenes.upsertScene / listScenes / deleteScene（store+config 双写）", () => {
  const created = scenes.upsertScene({
    id: "selftest-scene",
    name: "自测场景",
    match: ["自测群", "selftest"],
    priority: 95,
    task: "只输出待办清单。",
    targets: ["folder"],
    enabled: true,
  });
  expect(created.id === "selftest-scene", "写入失败");
  const list = scenes.listScenes();
  expect(list.some((s) => s.id === "selftest-scene"), "listScenes 未包含新场景");
  const hit = scenes.matchSceneFor("自测群 A");
  expect(hit?.id === "selftest-scene", "匹配优先级未生效，实际 " + hit?.id);
  const removed = scenes.deleteScene("selftest-scene");
  expect(removed === true, "deleteScene 应返回 true");
  expect(!scenes.listScenes().some((s) => s.id === "selftest-scene"), "删除后仍存在");
  return { count: list.length, matchPriority: hit.priority, removed };
});

await step("4. scenes.sceneTaskPreview（含来源群名/时间范围/条数/场景要求）", () => {
  const preview = scenes.sceneTaskPreview(null, payload);
  for (const key of ["【来源群名】AI 客户对接群", "【时间范围】", "共 2 条消息", "【场景要求】"]) {
    expect(preview.prompt.includes(key), "提示词缺少 " + key);
  }
  return { scene: preview.scene?.name, task: preview.task, prompt: preview.prompt };
});

// ---------- 5. 目标与渲染 ----------
await step("5. targets.listTargets / agentTargets / upsertTarget", () => {
  const folderTarget = targets.upsertTarget({ id: "folder", kind: "folder", name: "文件夹", path: folderDir, enabled: true });
  const agentTarget = targets.upsertTarget({ id: "codex", kind: "agent", name: "Codex", out: outDir, enabled: true });
  const obsTarget = targets.upsertTarget({ id: "obsidian", kind: "obsidian", name: "Obsidian", vault: vaultDir, folder: "微信流", tags: ["微信流", "自测"], enabled: true });
  targets.upsertTarget({ id: "clipboard", kind: "clipboard", name: "剪贴板", enabled: true });
  const all = targets.listTargets();
  const agents = targets.agentTargets();
  expect(folderTarget.path === folderDir, "folder 目标路径未写入");
  expect(agentTarget.out === outDir, "agent 输出目录未写入");
  expect(obsTarget.vault === vaultDir, "obsidian vault 未写入");
  expect(agents.length >= 7, "Agent 目标应至少 7 个（Codex/Claude Code/DSH/WorkBuddy/豆包/千问/WeSight），实际 " + agents.length);
  return { total: all.length, agents: agents.map((a) => a.name), kinds: [...new Set(all.map((t) => t.kind))] };
});

let rendered = null;
await step("6. targets.renderPayload（模板变量 {{out}}/{{slug}}/{{title}}/{{date}}/{{chat}}）", () => {
  const t = targets.resolveTarget("folder");
  rendered = targets.renderPayload(payload, t, { scene: "customer" });
  expect(rendered.markdown.includes("AI 客户对接群"), "Markdown 缺少群名");
  expect(rendered.markdown.includes("[" + LINK + "](" + LINK + ")"), "链接未保留为 [文本](URL)");
  expect(rendered.prompt.includes("【场景要求】"), "提示词缺少场景要求");
  expect(rendered.files.length === 0, "附件清单应为空");
  const vars = targets.applyTemplate("{{out}}/{{slug}}/{{date}}/{{chat}}/{{title}}", { out: "OUT", slug: "SLUG", date: "DATE", chat: "CHAT", title: "TITLE" });
  expect(vars === "OUT/SLUG/DATE/CHAT/TITLE", "模板变量替换异常：" + vars);
  return { title: rendered.title, slug: rendered.vars.slug, vars, markdown: rendered.markdown, prompt: rendered.prompt };
});

// ---------- 7. 投递 ----------
await step("7. deliver → folder（写 <path>/<slug>.md）", () => {
  const r = targets.deliver(payload, { target: "folder", scene: "customer" });
  expect(r.status === "ok", "投递失败：" + r.detail);
  expect(fs.existsSync(r.path), "文件不存在：" + r.path);
  expect(fs.readFileSync(r.path, "utf8").includes("AI 客户对接群"), "文件内容异常");
  return r;
});

await step("8. deliver → agent（写 {{out}}/{{slug}}.prompt.md，不注入其它应用）", () => {
  const r = targets.deliver(payload, { target: "codex", scene: "customer" });
  expect(r.status === "ok", "投递失败：" + r.detail);
  expect(r.path.endsWith(".prompt.md"), "文件名应为 .prompt.md：" + r.path);
  expect(fs.existsSync(r.path), "提示词文件不存在");
  expect(r.detail.includes("粘贴给"), "缺少粘贴指引：" + r.detail);
  return r;
});

await step("9. deliver → obsidian（走 obsidian.writeObsidianNote）", () => {
  const r = targets.deliver(payload, { target: "obsidian", scene: "customer" });
  expect(r.status === "ok", "投递失败：" + r.detail);
  expect(fs.existsSync(r.path), "笔记不存在：" + r.path);
  return r;
});

await step("10. obsidian.writeObsidianNote（含图片与普通附件、frontmatter）", () => {
  const img = path.join(WORK, "封面.png");
  fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  const pdf = path.join(WORK, "需求说明.pdf");
  fs.writeFileSync(pdf, "%PDF-1.4 selftest");
  const note = obsidian.writeObsidianNote({
    vault: vaultDir,
    folder: "微信流/自测",
    title: "AI 客户对接群 的聊天",
    markdown: "## 消息\n\n原文：[参考文章](" + LINK + ")",
    attachments: [img, { path: pdf, name: "需求说明.pdf" }],
    tags: ["微信流", "客户"],
    sourceChat: "AI 客户对接群",
    sourceUrl: LINK,
    sinceMs: now - 3600_000,
    untilMs: now,
  });
  expect(fs.existsSync(note.path), "笔记未写入");
  expect(note.attachmentPaths.length === 2, "附件应复制 2 个，实际 " + note.attachmentPaths.length);
  for (const key of ["title:", "created:", "source: wechat-ai", "chat:", "url:", "tags:"]) {
    expect(note.note.includes(key), "frontmatter 缺少 " + key);
  }
  expect(note.note.includes("![[封面.png]]"), "图片未用 ![[]] 嵌入");
  expect(note.note.includes("[[需求说明.pdf]]"), "普通附件未用 [[]] 链接");
  expect(note.note.includes("[参考文章](" + LINK + ")"), "链接标记被破坏");
  const again = obsidian.writeObsidianNote({ vault: vaultDir, folder: "微信流/自测", title: "AI 客户对接群 的聊天", markdown: "第二次", sourceChat: "AI 客户对接群" });
  expect(again.path !== note.path && again.path.includes("-2"), "重名未追加 -2：" + again.path);
  const notes = obsidian.listNotes({ vault: vaultDir, folder: "微信流/自测" });
  expect(notes.length === 2, "listNotes 应返回 2 条，实际 " + notes.length);
  return { path: note.path, attachments: note.attachmentPaths.map((p) => path.basename(p)), second: path.basename(again.path), notes: notes.map((n) => n.name), note: note.note };
});

await step("11. deliver → clipboard（失败时回退写文件并说明）", () => {
  const r = targets.deliver(payload, { target: "clipboard", scene: "customer" });
  expect(r.status === "ok", "剪贴板投递状态异常：" + r.detail);
  return { status: r.status, degraded: !!r.degraded, detail: r.detail, path: r.path };
});

await step("12. deliver → custom（载荷走文件、不经 shell 插值）", () => {
  const sink = path.join(WORK, "custom-sink.json");
  const script = path.join(WORK, "sink.mjs");
  fs.writeFileSync(script, "import fs from 'node:fs';\nfs.copyFileSync(process.argv[2], " + JSON.stringify(sink) + ");\nconsole.error('sink-ok');\n", "utf8");
  targets.upsertTarget({ id: "custom", kind: "custom", name: "自定义应用", command: '"' + process.execPath + '" "' + script + '"', out: outDir, enabled: true });
  // 回归守卫：Windows 路径的反斜杠必须原样保留，不能被当成转义吃掉
  const argv = targets.parseCommand('"' + process.execPath + '" "C:\\a b\\sink.mjs" --flag');
  expect(argv.length === 3, "分词结果应为 3 段，实际 " + JSON.stringify(argv));
  expect(argv[0] === process.execPath, "可执行文件路径被破坏：" + argv[0]);
  expect(argv[1] === "C:\\a b\\sink.mjs", "带空格的反斜杠路径被破坏：" + argv[1]);
  const r = targets.deliver(payload, { target: "custom", scene: "customer" });
  expect(r.status === "ok", "自定义目标失败：" + r.detail);
  expect(r.exitCode === 0, "退出码应为 0");
  expect(fs.existsSync(sink), "载荷文件未传给命令");
  const got = JSON.parse(fs.readFileSync(sink, "utf8"));
  expect(got.title === "客户群 · 3 月需求确认", "载荷内容异常");
  return { status: r.status, exitCode: r.exitCode, stderr: r.stderr, payloadPath: r.path, title: got.title };
});

await step("13. deliver dryRun（不落盘）", () => {
  const before = fs.readdirSync(folderDir).length;
  const r = targets.deliver(payload, { target: "folder", dryRun: true });
  const after = fs.readdirSync(folderDir).length;
  expect(r.status === "skipped", "演练应为 skipped，实际 " + r.status);
  expect(before === after, "演练模式写了文件");
  return { status: r.status, path: r.path, detail: r.detail };
});

// ---------- 14. 技能 ----------
await step("14. skills-catalog：listSkills / buildSkillPrompt / runSkill", () => {
  const list = skills.listSkills();
  expect(list.length === 2, "内置技能应为 2 个");
  const built = skills.buildSkillPrompt("wechat-article-extract", "群里分享了 " + LINK + " 这篇", { chat: "AI 客户对接群", title: "文章提取" });
  expect(built.prompt.includes(LINK), "提示词未包含内容");
  expect(built.expected.includes("标题"), "输出外壳缺少标题字段");
  const run = skills.runSkill("video-information-reading", "视频号：某某讲了 3 个方法", { chat: "视频群", title: "视频信息读取", outDir: path.join(WORK, "skill") });
  expect(fs.existsSync(run.promptPath), "提示词文件未写入");
  expect(run.inferredLocally === false, "应明确未在本地做推理");
  const outline = run.summary;
  expect(["主题", "结论", "论据", "可行动项", "待核实项"].every((k) => outline.includes(k)), "视频技能缺少要求的结构");
  return { skills: list.map((s) => s.id), promptPath: run.promptPath, outlinePath: run.outlinePath, expected: built.expected };
});

// ---------- 15. 批次状态机 ----------
let batchId = null;
await step("15. batch.createBatch（去重 + 上限）", () => {
  const created = batch.createBatch({
    source: "selftest",
    scene: "customer",
    target: "folder",
    items: [
      { title: "客户群 A 批次", chat: "AI 客户对接群", text: "第一条内容", ts_min: now - 7200_000, ts_max: now - 3600_000 },
      { title: "客户群 A 批次", chat: "AI 客户对接群", text: "第一条内容", ts_min: now - 7200_000, ts_max: now - 3600_000 },
      { title: "客户群 B 批次", chat: "另一个客户群", text: "第二条内容 " + LINK },
    ],
  });
  batchId = created.id;
  expect(created.count === 2, "去重后应剩 2 条，实际 " + created.count);
  expect(created.duplicates === 1, "重复计数应为 1");
  expect(fs.existsSync(created.manifestPath), "manifest 未写入");
  return created;
});

await step("16. batch.stageItem / markReady / batchStatus", () => {
  const a = batch.stageItem(batchId, 0, { text: "第一条内容" });
  expect(a.ok && a.item.status === "staging", "stageItem 状态异常");
  expect(fs.existsSync(a.artifact), "原始载荷未落盘：" + a.artifact);
  batch.markReady(batchId, 0);
  const b = batch.stageItem(batchId, 1, { text: "第二条内容 " + LINK });
  batch.markReady(batchId, 1);
  const st = batch.batchStatus(batchId);
  expect(st.status === "ready", "汇总状态应为 ready，实际 " + st.status);
  expect(st.counts.ready === 2, "ready 计数异常");
  return { item: st.items[0], counts: st.counts, status: st.status, manifestPath: st.manifestPath };
});

await step("17. batch.deliverBatch → folder（逐条投递并落状态）", () => {
  const r = batch.deliverBatch(batchId, { target: "folder" });
  expect(r.delivered === 2 && r.failed === 0, "应交付 2 条：delivered=" + r.delivered + " failed=" + r.failed);
  expect(r.status === "done", "批次状态应为 done，实际 " + r.status);
  const st = batch.batchStatus(batchId);
  expect(st.counts.done === 2, "done 计数异常");
  return { id: r.id, status: r.status, delivered: r.delivered, failed: r.failed, counts: r.counts, results: r.results.map((x) => ({ index: x.index, status: x.status, path: x.path })) };
});

await step("18. 失败 → 重试（failed → pending → ready → done，原始载荷不丢）", () => {
  const created = batch.createBatch({ source: "selftest-fail", items: [{ title: "失败重试条目", chat: "自测群", text: "重试内容" }] });
  const staged = batch.stageItem(created.id, 0, { text: "重试内容" });
  batch.failItem(created.id, 0, "模拟失败：目标不可写");
  let st = batch.batchStatus(created.id);
  expect(st.status === "failed", "应为 failed，实际 " + st.status);
  expect(st.items[0].error.includes("模拟失败"), "错误信息未保留");
  const retried = batch.retryFailed(created.id);
  expect(retried.retried === 1 && retried.status === "pending", "重试后应为 pending");
  expect(fs.existsSync(staged.artifact), "重试后原始载荷丢失");
  batch.markReady(created.id, 0);
  const done = batch.deliverBatch(created.id, { target: "folder" });
  expect(done.delivered === 1, "重试交付失败");
  st = batch.batchStatus(created.id);
  expect(st.status === "done", "重试后应为 done，实际 " + st.status);
  return { batchId: created.id, retried: retried.retried, counts: st.counts, status: st.status, artifactKept: fs.existsSync(staged.artifact) };
});

await step("19. batch.listBatches", () => {
  const list = batch.listBatches();
  expect(list.length >= 2, "应至少 2 个批次，实际 " + list.length);
  return list.map((b) => ({ id: b.id, status: b.status, count: b.count, createdAt: b.createdAt }));
});

// ---------- 20. 历史 ----------
await step("20. history.listOperations / historySummary", () => {
  const ops = history.listOperations({ limit: 20 });
  expect(ops.length >= 6, "操作记录过少：" + ops.length);
  const deliveries = history.listDeliveries({ limit: 10 });
  expect(deliveries.length >= 6, "投递记录过少：" + deliveries.length);
  const summary = history.historySummary();
  expect(summary.total === ops.length || summary.total >= ops.length, "汇总条数异常");
  return {
    operations: ops.map((o) => ({ id: o.id, action: o.action, target: o.target, ok: o.ok, at: o.at })),
    deliveries: deliveries.map((d) => ({ target: d.target, status: d.status, at: d.at })),
    summary: { total: summary.total, ok: summary.ok, failed: summary.failed, byTarget: summary.byTarget, byAction: summary.byAction },
  };
});

await step("21. history.rerun（把一条记录再投递到另一个目标）", () => {
  const first = history.listOperations({ action: "forward", target: "folder", limit: 50 })
    .find((o) => o.title === "客户群 · 3 月需求确认");
  expect(first, "没有可重发的 folder 记录");
  const r = history.rerun(first.id, { target: "codex" });
  expect(r.status === "ok", "重发失败：" + r.detail);
  expect(r.rerunOf === first.id && !!r.rerunId, "重发记录未关联");
  expect(fs.existsSync(r.path), "重发产物不存在");
  return { rerunOf: r.rerunOf, rerunId: r.rerunId, target: r.target, status: r.status, path: r.path };
});

await step("22. history.exportHistory（json/csv/md）", () => {
  const out = path.join(WORK, "history");
  const j = history.exportHistory({ outDir: out, format: "json" });
  const c = history.exportHistory({ outDir: out, format: "csv" });
  const m = history.exportHistory({ outDir: out, format: "md" });
  for (const f of [j, c, m]) expect(fs.existsSync(f.path) && f.count > 0, "导出失败：" + f.path);
  expect(JSON.parse(fs.readFileSync(j.path, "utf8")).operations.length === j.count, "json 内容异常");
  return [j, c, m].map((f) => ({ format: f.format, count: f.count, bytes: f.bytes, path: f.path }));
});

// ---------- 21. 汇总 ----------
console.log("\n产物位置：");
for (const [label, dir] of [["输出目录", outDir], ["文件夹目标", folderDir], ["Obsidian 知识库", vaultDir], ["数据根", HOME]]) {
  console.log("  " + label + "：" + dir);
}
console.log("\n=== " + passed + " passed, " + failed + " failed ===");
process.exit(failed ? 1 : 0);
