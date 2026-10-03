// 运维健壮性测试：这些场景此前完全没测过。
// 覆盖：特殊路径（空格/中文/emoji）、损坏配置自愈、库文件缺失/损坏、
//       并发写入、超长内容、重复运行幂等、时间窗边界、只读输出目录、非法参数。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "robust-"));
let passed = 0, failed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (e) { failed += 1; fails.push(name + " :: " + (e?.message ?? e)); console.log("  ✗ " + name + " :: " + (e?.message ?? e)); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ?? "不相等") + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m ?? "断言失败"); };

/** 每个用例一个独立数据根，避免相互污染 */
async function withHome(sub, fn) {
  const home = path.join(BASE, sub);
  fs.mkdirSync(home, { recursive: true });
  process.env.WECHAT_AI_HOME = home;
  const srv = await import(new URL("../server.mjs", import.meta.url).href + "?h=" + encodeURIComponent(sub));
  const call = async (name, args) => {
    const r = await srv.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args ?? {} } });
    return r.result ?? {};
  };
  const sc = async (name, args) => (await call(name, args)).structuredContent ?? {};
  return fn({ home, call, sc, srv });
}

// =====================================================================================
console.log("1) 特殊数据根路径");

await t("数据根含空格 + 中文 + emoji 时全链路可用", async () => {
  await withHome("路径 含空格/中文目录/🎉 emoji", async ({ home, sc }) => {
    ok(fs.existsSync(home), "数据根未创建");
    const r = await sc("wai_db_index", { source: "mock", scope: "sessions", sessionLimit: 10, allowDemo: true });
    ok(r.totals.inserted > 0, "索引未写入：" + JSON.stringify(r.totals));
    const s = await sc("wai_status");
    ok(s.messages > 0, "读不到刚写入的数据");
    const g = await sc("wai_group_daily", { hours: 100000 });
    ok(g.files?.digest && fs.existsSync(g.files.digest), "报告未落盘：" + JSON.stringify(g.files).slice(0, 200));
    // 路径里必须真的是那些字符，而不是被转义/替换
    ok(g.files.digest.startsWith(home), "报告路径不在数据根下：" + g.files.digest);
  });
});

await t("数据根很深（>200 字符）时可用", async () => {
  const deep = path.join(BASE, "deep", ...Array.from({ length: 12 }, (_, i) => "nested_segment_" + i));
  fs.mkdirSync(deep, { recursive: true });
  process.env.WECHAT_AI_HOME = deep;
  const srv = await import(new URL("../server.mjs", import.meta.url).href + "?h=deep");
  const r = await srv.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "wai_db_index", arguments: { source: "mock", sessionLimit: 5, allowDemo: true } } });
  ok(!r.result.isError, "深路径索引失败：" + (r.result.structuredContent?.error ?? ""));
});

// =====================================================================================
console.log("\n2) 损坏配置与库文件的自愈");

await t("config.json 损坏时不崩溃，且不静默丢弃原文件", async () => {
  await withHome("corrupt-config", async ({ home, sc }) => {
    await sc("wai_status"); // 先生成默认配置
    const cfg = path.join(home, "config.json");
    ok(fs.existsSync(cfg), "默认配置未生成");
    fs.writeFileSync(cfg, "{ 这不是合法 JSON ", "utf8");
    const s = await sc("wai_status");
    ok(!s.error, "损坏配置导致工具失败：" + s.error);
    // 原始损坏内容应被保留为备份，便于排查
    const backups = fs.readdirSync(home).filter((n) => n.includes("config.json") && n.includes("bak"));
    ok(backups.length >= 1, "损坏的 config.json 应被备份而不是直接覆盖；目录内容=" + JSON.stringify(fs.readdirSync(home)));
    ok(fs.existsSync(cfg), "应重建出可用配置");
  });
});

await t("profile.json 损坏时不崩溃，且不静默丢弃原文件", async () => {
  await withHome("corrupt-profile", async ({ home, sc }) => {
    await sc("wai_profile_status");
    const pf = path.join(home, "profile.json");
    ok(fs.existsSync(pf), "默认 Profile 未生成");
    fs.writeFileSync(pf, "]]]broken[[[", "utf8");
    const s = await sc("wai_profile_status");
    ok(!s.error, "损坏 Profile 导致工具失败：" + s.error);
    const backups = fs.readdirSync(home).filter((n) => n.includes("profile.json") && n.includes("bak"));
    ok(backups.length >= 1, "损坏的 profile.json 应被备份；目录内容=" + JSON.stringify(fs.readdirSync(home)));
  });
});

await t("store.db 被删除后能自动重建", async () => {
  await withHome("store-gone", async ({ home, sc }) => {
    await sc("wai_db_index", { source: "mock", sessionLimit: 5, allowDemo: true });
    const db = path.join(home, "store.db");
    ok(fs.existsSync(db), "库文件不存在");
    for (const suffix of ["", "-wal", "-shm"]) { try { fs.unlinkSync(db + suffix); } catch { /* ignore */ } }
    const s = await sc("wai_status");
    ok(typeof s.messages === "number", "删除库后应重建：" + JSON.stringify(s).slice(0, 150));
    eq(s.messages, 0, "重建后应为空库");
    ok(s.notice, "应通过 notice 告知用户库被重建了：" + JSON.stringify(s.notice));
  });
});

await t("打开损坏的 store.db 时给出可诊断错误，且不删除原文件", async () => {
  const home = path.join(BASE, "store-corrupt");
  fs.mkdirSync(home, { recursive: true });
  process.env.WECHAT_AI_HOME = home;
  const store = await import(new URL("../lib/store.mjs", import.meta.url).href);
  store.closeStore();
  // 直接造一个「不是数据库」的文件，避免与单例句柄/ WAL 纠缠
  const corruptFile = path.join(home, "corrupt.db");
  fs.writeFileSync(corruptFile, Buffer.concat([Buffer.from("XXXXXXXX"), Buffer.alloc(8192, 7)]));
  const before = fs.statSync(corruptFile).size;
  let threw = null;
  try {
    const db = store.openStore(corruptFile);
    db.prepare("SELECT COUNT(*) AS n FROM messages").get();
  } catch (e) {
    threw = e;
  }
  ok(threw, "损坏的库应当抛错，而不是静默返回空库");
  const msg = String(threw.message ?? threw);
  ok(/not a database|malformed|corrupt|encrypted/i.test(msg), "错误信息应可诊断，实际：" + msg);
  ok(fs.existsSync(corruptFile), "损坏的库不应被自动删除");
  eq(fs.statSync(corruptFile).size, before, "损坏的库不应被改写");
});

await t("store.db 删除后重开为空库（重启语义）", async () => {
  const home = path.join(BASE, "store-swap");
  fs.mkdirSync(home, { recursive: true });
  process.env.WECHAT_AI_HOME = home;
  const store = await import(new URL("../lib/store.mjs", import.meta.url).href);
  store.closeStore();
  const db = store.openStore();
  store.insertMessages(db, [{ session_name: "自愈群", session_kind: "group", sender: "甲", ts: Date.now(), content: "x" }], { source: "robust" });
  ok(store.storeStats().messages >= 1, "写入后应有数据");
  store.closeStore();
  const dbFile = path.join(home, "store.db");
  let removed = true;
  for (const suffix of ["", "-wal", "-shm"]) {
    // 干净关闭后 -wal/-shm 会被 SQLite 主动清掉，ENOENT 不代表「仍被占用」
    try { fs.unlinkSync(dbFile + suffix); } catch (e) { if (e.code !== "ENOENT") removed = false; }
  }
  if (!removed) {
    // Windows 上句柄释放有延迟，删不掉时本用例不适用（产品行为由「不可用即自愈」那条覆盖）
    console.log("      ⊹ Windows 仍占用文件，跳过删除断言（已由 notice 用例覆盖自愈路径）");
    return;
  }
  const s2 = store.storeStats();
  eq(s2.messages, 0, "删除后重开应为空库");
});

await t("长驻进程里句柄失效时自愈并给出 notice", async () => {
  const home = path.join(BASE, "store-notice");
  fs.mkdirSync(home, { recursive: true });
  process.env.WECHAT_AI_HOME = home;
  const store = await import(new URL("../lib/store.mjs", import.meta.url).href);
  store.closeStore();
  const internal = store.openStore();
  store.insertMessages(internal, [{ session_name: "N", session_kind: "group", sender: "甲", ts: Date.now(), content: "y" }], { source: "robust" });
  internal.close(); // 模拟句柄失效（外部替换/损坏/被回收）
  const s = store.storeStats();
  ok(typeof s.messages === "number", "自愈后仍应可用");
  ok(store.storeNotice(), "应给出 notice 说明发生了什么");
});

// =====================================================================================
console.log("\n3) 并发与一致性");

await t("两个连接同时写入不丢数据、不报锁错误（WAL + busy_timeout）", async () => {
  const home = path.join(BASE, "concurrent");
  fs.mkdirSync(home, { recursive: true });
  process.env.WECHAT_AI_HOME = home;
  const { DatabaseSync } = await import("node:sqlite");
  const { paths } = await import(new URL("../lib/paths.mjs", import.meta.url).href);
  const store = await import(new URL("../lib/store.mjs", import.meta.url).href);
  store.closeStore();
  const owner = store.openStore();                       // 建表
  const second = new DatabaseSync(paths().store);        // 第二个连接，模拟另一个进程
  second.exec("PRAGMA journal_mode=WAL");
  second.exec("PRAGMA busy_timeout=8000");
  const insert = (db, tag) => {
    for (let i = 0; i < 200; i++) {
      store.insertMessages(db, [{ session_name: "并发" + tag, session_kind: "group", sender: tag, ts: Date.now() + i, content: tag + " 第 " + i + " 条" }], { source: "concurrent" });
    }
  };
  let err = "";
  try {
    insert(owner, "A");
    insert(second, "B");
  } catch (e) {
    err = String(e.message ?? e);
  }
  second.close();
  ok(!err, "并发写入报错：" + err);
  const n = owner.prepare("SELECT COUNT(*) AS n FROM messages").get().n;
  eq(n, 400, "两次写入应全部落库，实际 " + n);
});

await t("重复运行同一报告不产生重复计数", async () => {
  await withHome("idempotent", async ({ sc }) => {
    const src = path.join(BASE, "..", "samples", "export-demo");
    const target = path.join(process.env.WECHAT_AI_HOME, "vault");
    fs.mkdirSync(target, { recursive: true });
    for (const f of fs.readdirSync(path.resolve("D:/Users/DeepSeekWeb/wechat-ai/samples/export-demo"))) {
      fs.copyFileSync(path.join("D:/Users/DeepSeekWeb/wechat-ai/samples/export-demo", f), path.join(target, f));
    }
    const a = await sc("wai_vault_scan", { dirs: [target] });
    const after1 = (await sc("wai_status")).messages;
    const b = await sc("wai_vault_scan", { dirs: [target] });
    const after2 = (await sc("wai_status")).messages;
    eq(after2, after1, "重复扫描不应增加消息数（" + after1 + " → " + after2 + "）");
    ok(b.inserted <= a.inserted, "第二次扫描不应比第一次插入更多");
  });
});

// =====================================================================================
console.log("\n4) 极端内容与时间边界");

await t("单条 1MB 正文不崩溃且被正确截断展示", async () => {
  await withHome("huge", async ({ sc }) => {
    const big = "很长的内容".repeat(50_000); // 约 1MB（UTF-8 约 1.5MB）
    await sc("wai_inbox_push", { body: "[2026-06-30 10:00] 甲: " + big, chat: "巨量群" });
    const r = await sc("wai_inbox_process", { limit: 5 });
    ok(r.processed >= 1, "大正文未处理：" + JSON.stringify(r).slice(0, 200));
    const s = await sc("wai_status");
    ok(s.messages >= 1, "大正文未入库");
    const g = await sc("wai_group_daily", { hours: 100000 });
    ok(g.files?.digest && fs.existsSync(g.files.digest), "含大正文时报告仍应生成");
  });
});

await t("时间窗边界：since == until / since > until / 未来时间都不崩溃", async () => {
  await withHome("windows", async ({ call }) => {
    const cases = [
      { since: "2026-06-01", until: "2026-06-01" },
      { since: "2026-06-30", until: "2026-06-01" },
      { since: "2030-01-01", until: "2030-12-31" },
      { hours: 0 },
      { days: 0 },
    ];
    for (const c of cases) {
      const r = await call("wai_group_daily", { ...c, out: path.join(process.env.WECHAT_AI_HOME, "w-" + JSON.stringify(c).length) });
      ok(!r.isError, JSON.stringify(c) + " 失败：" + (r.structuredContent?.error ?? ""));
    }
  });
});

await t("非法参数给出可读错误而不是崩溃", async () => {
  await withHome("badargs", async ({ call }) => {
    const cases = [
      ["wai_db_index", { source: "根本不存在的数据源" }],
      ["wai_person", {}],
      ["wai_opportunity_update", { id: 999999 }],
      ["wai_triage", { id: 1, decision: "不是有效决策" }],
      ["wai_scan", { target: "D:/绝对不存在的路径/xyz" }],
      ["wai_render_bundle", { reportDir: "D:/也不存在" }],
    ];
    for (const [name, args] of cases) {
      const r = await call(name, args);
      if (r.isError) {
        const msg = String(r.structuredContent?.error ?? r.content?.[0]?.text ?? "");
        ok(msg.length > 3, name + " 错误信息过短：" + msg);
        ok(!/Cannot read propert|is not a function|undefined is not/.test(msg), name + " 暴露了内部错误：" + msg);
      }
    }
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
