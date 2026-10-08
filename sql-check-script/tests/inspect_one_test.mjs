#!/usr/bin/env node
/**
 * 巡检一键 CLI 门禁测试（inspect_one）——把 巡检一键.mjs 的预审/清单/落盘守门从「轮内实测」固化为常跑回归。
 *
 * 覆盖（全部免 DB——被拒路径都发生在连接服务端之前，--help/--source 缺失等也不连库）：
 *   预审四门    ：写词 / 多语句 / 纯注释 / 空 SQL → exit 2，整批不执行
 *   落盘守门    ：--out 指进仓内 → exit 2（运行产物不进树不进包）
 *   manifest 门 ：非法 JSON / items 缺 sql / 与位置参数互斥 → exit 2；sql 文件不存在 → exit 3
 *   consistency 门：标识符非法 / value 夹带写词（生成 SQL 审计拦截）/ 缺字段 → exit 2
 *   参数面      ：--help → 0；未知参数 → 2；无参 → 3；输入不存在 → 3
 *
 * 判定口径：exit code + stderr/stdout 关键子串双确认（防「碰巧同码」假绿）。
 * 用法：node tests/inspect_one_test.mjs（无外部依赖、秒级）
 * 退出码：0 = 全部通过；1 = 存在失败
 * 汇总行：=== inspect-one: N passed, F failed ===
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SCRIPT = path.join(REPO, "巡检一键.mjs");

let passed = 0, failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inspect-one-"));
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 竞态容忍 */ } };
process.on("exit", cleanup);

const write = (name, content) => { const p = path.join(tmp, name); fs.writeFileSync(p, content); return p; };
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8", timeout: 30000 });
/** 断言 exit code + 输出关键子串（out+err 合并匹配） */
const gate = (name, args, wantCode, wantText) => {
  const r = run(args);
  const out = (r.stdout || "") + (r.stderr || "");
  const codeOk = r.status === wantCode;
  const textOk = !wantText || out.includes(wantText);
  ok(name, codeOk && textOk,
    `exit=${r.status}（期望 ${wantCode}）${wantText && !textOk ? ` 输出缺「${wantText}」` : ""}${!codeOk ? " 输出尾：" + out.trim().slice(-160) : ""}`);
};

// ---------- 预审四门（含整批语义：一个坏文件 → 全批不执行） ----------
const goodSql = write("good.sql", "SELECT 1 FROM dual;\n");
gate("预审：写词整批拒绝", ["--source", "x", goodSql, write("bad_write.sql", "UPDATE t SET a = 1;\n")],
  2, "命中写词「UPDATE」");
gate("预审：多语句拒绝", ["--source", "x", write("bad_multi.sql", "SELECT 1; SELECT 2;\n")],
  2, "多语句（2 条）");
gate("预审：纯注释拒绝", ["--source", "x", write("bad_comment.sql", "-- 只有注释\n")],
  2, "纯注释");
gate("预审：空 SQL 拒绝", ["--source", "x", write("bad_empty.sql", "   \n")],
  2, "空 SQL");
// 好文件+坏文件混批：坏的拒绝后好的也不跑（整批语义在报错行数上体现：auditFails 列出坏件）
gate("预审：整批语义（坏件连坐）", ["--source", "x", goodSql, write("bad_write2.sql", "DROP TABLE t;\n")],
  2, "整批不执行");

// ---------- 落盘守门（报告写进仓内 → 拒绝；用 --out 指向仓内真实路径） ----------
gate("落盘守门：报告指仓内拒绝", ["--source", "x", "--out", path.join(REPO, "README.md"), goodSql],
  2, "落盘守门");

// ---------- manifest 门 ----------
gate("manifest：非法 JSON", ["--source", "x", "--manifest", write("mf_bad.json", "not json")],
  2, "不是合法 JSON");
gate("manifest：items 缺 sql 字段", ["--manifest", write("mf_nosql.json", '{"items":[{"chain":"c"}]}')],
  2, "缺 sql 字段");
gate("manifest：与位置参数互斥", ["--source", "x", "--manifest", write("mf_ok.json", '{"items":[{"sql":"a.sql"}]}'), goodSql],
  2, "互斥");
gate("manifest：sql 文件不存在", ["--source", "x", "--manifest", write("mf_missing.json", '{"items":[{"sql":"nope.sql"}]}')],
  3, "SQL 文件不存在");
gate("manifest：形态不符（items 非数组）", ["--manifest", write("mf_shape.json", '{"items":42}')],
  2, "形态不符");

// ---------- consistency 门（骨架生成在装载期，免 DB 可测） ----------
const mfCons = (obj) => ["--source", "x", "--manifest", write(`mf_c_${Math.random().toString(36).slice(2)}.json`, JSON.stringify({ items: [{ sql: path.relative(tmp, goodSql) }], consistency: [obj] }))];
gate("consistency：表名标识符非法（注入形态）",
  mfCons({ name: "x", leftTable: "t; drop table x", leftKey: "id", leftValue: "a", rightTable: "r", rightKey: "rk", rightValue: "b" }),
  2, "不是合法标识符");
gate("consistency：value 夹带写词（生成 SQL 审计拦截）",
  mfCons({ name: "x", leftTable: "t1", leftKey: "id", leftValue: "amount); DROP TABLE x; -- ", rightTable: "r1", rightKey: "rk", rightValue: "b" }),
  2, "命中写词「DROP」");
gate("consistency：缺字段",
  mfCons({ name: "x", leftTable: "t1", leftKey: "id", leftValue: "amount", rightTable: "r1", rightKey: "rk" }),
  2, "缺 rightValue");

// ---------- 增量门（--diff；连接前解析，免 DB 可测） ----------
gate("增量门：--diff 文件不存在", ["--source", "x", "--diff", path.join(tmp, "ghost.md"), goodSql],
  3, "上份报告不存在");
gate("增量门：--diff 非生成报告", ["--source", "x", "--diff", write("junk.md", "# 随手写的笔记\n"), goodSql],
  2, "不是巡检一键生成的报告");

// ---------- compare 门（--compare <A> <B>；与 --diff 同口径：不存在 exit 3 / 非生成报告 exit 2） ----------
gate("compare 门：--compare 报告不存在", ["--compare", path.join(tmp, "ghost_a.md"), path.join(tmp, "ghost_b.md")],
  3, "报告文件不存在");
gate("compare 门：--compare 非生成报告", ["--compare", write("junk_a.md", "# 随手写的笔记\n"), write("junk_b.md", "# 也是笔记\n")],
  2, "不是巡检一键生成的报告");
gate("compare 门：--compare 缺参数", ["--compare", write("junk_c.md", "# 笔记\n")],
  2, "需要两个报告路径");

// ---------- 基线门（--baseline-dir；连接前校验，免 DB 可测） ----------
gate("基线门：目录指仓内拒绝", ["--source", "x", "--baseline-dir", REPO, goodSql],
  2, "基线目录在本仓/发布包内");
{
  const bd = path.join(tmp, "baselines");
  fs.mkdirSync(bd, { recursive: true });
  fs.writeFileSync(path.join(bd, "baseline_默认.md"), "# 随手写的，不是生成报告\n");
  gate("基线门：基线损坏 fail-closed", ["--source", "x", "--baseline-dir", bd, goodSql],
    2, "不是巡检一键生成的报告");
}

// ---------- 基线对比门（--baseline-compare <dirA> <dirB>；跨项目横向对比，免 DB 可测） ----------
// 共享 fixture：生成巡检一键可解析的 mock 报告（含生成标记 + 二节卡片 + EXPLAIN + 表行数）
const mkReport = (cardName, explain, tableRows = 100) =>
  `# SQL 巡检报告（自动骨架）\n\n> 由 巡检一键.mjs 生成 · 2026-10-08 10:00:00\n\n## 二、逐条 SQL 证据\n\n### 卡片 1：${cardName}\n- EXPLAIN：${explain}\n- 表 t1：count_rows=${tableRows}\n`;
{
  const dirA = path.join(tmp, "bl_a"), dirB = path.join(tmp, "bl_b");
  fs.mkdirSync(dirA, { recursive: true }); fs.mkdirSync(dirB, { recursive: true });
  // 同名卡片、不同 EXPLAIN → compare 输出「计划有变化」
  fs.writeFileSync(path.join(dirA, "baseline_projA.md"), mkReport("q.sql", "type=ALL key=NULL rows=100"));
  fs.writeFileSync(path.join(dirB, "baseline_projB.md"), mkReport("q.sql", "type=ref key=idx rows=10"));
  // 正例：两目录各有基线 → 复用 compare 输出「计划有变化」
  gate("基线对比门：跨项目对比正常", ["--baseline-compare", dirA, dirB], 0, "计划有变化");
  // 错误例：目录不存在 → exit 3
  gate("基线对比门：目录不存在", ["--baseline-compare", path.join(tmp, "ghost_dir"), dirB], 3, "目录不存在");
  // 错误例：目录存在但无基线 → exit 3
  const emptyDir = path.join(tmp, "bl_empty"); fs.mkdirSync(emptyDir, { recursive: true });
  gate("基线对比门：目录无基线文件", ["--baseline-compare", emptyDir, dirB], 3, "无基线文件");
  // 错误例：缺参数 → exit 2
  gate("基线对比门：缺参数", ["--baseline-compare", dirA], 2, "需要两个基线目录");
  // --report-index：写基线后自动生成 _index.json（mock 目录预置基线文件 → CLI 触发索引更新）
  {
    const idxDir = path.join(tmp, "bl_idx");
    fs.mkdirSync(path.join(idxDir, "sub"), { recursive: true });
    // 预置一个带时间戳的归档基线（模拟历史轮次）+ 当前基线
    fs.writeFileSync(path.join(idxDir, "baseline_projX_20261008-100000.md"), mkReport("x.sql", "type=ALL rows=50"));
    fs.writeFileSync(path.join(idxDir, "baseline_projY.md"), mkReport("y.sql", "type=ref rows=5"));
    const r = run(["--source", "x", "--baseline-dir", idxDir, "--project", "projY", "--out", path.join(tmp, "idx_out.md"), goodSql]);
    // 无法真正连库取证（--source x 不存在），但 --report-index 在基线写回阶段——
    // 连库失败前参数/基线扫描不触发；改用直接验证 _index.json 生成逻辑：
    // 用一个能走到基线写回的路径不可行（需真实源），故断言 CLI 对该目录的错误行为不误生成
    const idxPath = path.join(idxDir, "_index.json");
    // 诚实断言：无真实源时 CLI 在连库前退出，_index.json 不应被误生成
    ok("报告索引：无真实源时不误生成 _index.json", r.status !== 0 && !fs.existsSync(idxPath),
      `exit=${r.status} index=${fs.existsSync(idxPath)}`);
  }
}

// ---------- 参数面 ----------
gate("参数面：--jobs 非法（0）", ["--source", "x", "--jobs", "0", goodSql], 2, "--jobs 需 1-16 的整数");
gate("参数面：--jobs 上限外（99）", ["--source", "x", "--jobs", "99", goodSql], 2, "--jobs 需 1-16 的整数");
gate("参数面：--jobs 非整数", ["--source", "x", "--jobs", "abc", goodSql], 2, "--jobs 需 1-16 的整数");
gate("参数面：--help", ["--help"], 0, "用法");
gate("参数面：未知参数", ["--nope"], 2, "未知参数");
gate("参数面：无参", [], 3, "用法");
gate("参数面：输入文件不存在", ["--source", "x", path.join(tmp, "ghost.sql")], 3, "输入不存在");

console.log(`\n=== inspect-one: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
