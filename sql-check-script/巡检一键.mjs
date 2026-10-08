#!/usr/bin/env node
/**
 * 巡检一键.mjs — SQL 清单 → 只读取证 → 巡检报告骨架（自动化）
 *
 * 解决什么：巡检模式下「每条 SQL 手工跑 EXPLAIN / count_rows / sample_data、
 * 手工拼报告头与五节骨架」是重复劳动且易漏证据。本脚本把机械部分自动化：
 *   审计（写词/多语句/空语句预审，一票否决全批）→ 只读取证（EXPLAIN + 表行数 +
 * 脱敏样例）→ 按 outputs/巡检报告模板.md 生成报告骨架（六节标题运行时从模板解析，
 * 口径单源：模板改骨架即随动）。风险判定、调用链、优化建议仍留人工 —— 先审后执行。
 *
 * 只读保证（三层）：
 *   1. 本脚本只调用 list_sources / query_plan / count_rows / sample_data 四个只读工具；
 *   2. 客户端预审：SQL 含写词 / 多语句 / 纯注释 / 空 → 整批拒绝，一条都不执行；
 *   3. 服务端兜底：calvin-db-mcp 只读门（guardReadOnly）仍然生效 —— 本脚本不是绕过它，
 *      而是在它前面加一道更早、报错更友好的闸。
 *
 * 脱敏：展示用 SQL 与样例数据先脱敏（邮箱 / ≥11 位数字串整体打码；
 * 命中敏感列名（手机/邮箱/证件等）的样例值整格打码）。判定口径仍以
 * references/白名单与脱敏配置.yaml 为准，本脚本内置的是兜底口径。
 *
 * 用法：
 *   node 巡检一键.mjs --source real_mysql [--config <dbmcp配置>] [--project 名称]
 *                     [--out <报告路径>] [--sample N] [--allow-in-tree]
 *                     <a.sql> [b.sql | 目录]...
 *   或清单态：node 巡检一键.mjs --source real_mysql --manifest <清单.json>（与位置参数互斥）
 *   --manifest    JSON 清单：{"project?","source?","sample?","items":[{"sql","chain?","note?","tables?"}],
 *                 "consistency?":[{"name","leftTable","leftKey","leftValue","rightTable","rightKey","rightValue"}]}
 *                 —— sql 相对 manifest 所在目录；chain/note/tables 直接进报告卡片（调用链也自动化）；
 *                    tables 显式声明优先于自动抽取；CLI 同名字段优先于 manifest；
 *                    consistency 项自动生成第四节对账骨架（差异汇总/差异样例/孤儿检查三段只读 SQL）
 *                    并实测：左表逐行值 vs 右表按 key 聚合值（diff_rows 带百分比提示：口径不一致 vs 数据级差异），装载期过写词/多语句/标识符审计后才连库；
 *                    "dialect": "pg" 按双引号标识符生成（缺省 mysql 不加引号）；
 *                    报告头自带「建议落盘名」（对齐模板口径 outputs/巡检报告_<项目>_<日期>.md）；
 *                    --diff 与上份生成报告比对出增量摘要（巡检周期化）
 *   --source      必填（CLI 或 manifest.source），数据源 id（list_sources 里可见的）
 *   --config      DBMCP_CONFIG 注入（缺省透传环境变量，再缺省用服务端默认配置）
 *   --sample      每表样例行数，默认 3
 *   --jobs        受控并发度 1-16（证据任务条目级并行；默认 4，1=串行；越界 fail-closed 拒绝）
 *   --diff        增量模式：与上份巡检一键生成的报告比对（新增/移除 SQL 与一致性项、EXPLAIN/行数/
 *                 diff_rows 变化），摘要落报告头「增量对比」；只接受生成报告（缺生成标记即拒）
 *   --baseline-dir 基线目录：按项目自动存/取基线（<dir>/baseline_<项目>.md）——首轮无基线直接生成，
 *                 之后每轮自动与上轮基线比对并刷新；同时生成 baseline_<项目>_history.csv（趋势分析用）
 *                 + baseline_<项目>_<时间戳>_diff.md（归档时对比上上份，列出新增/移除/计划变化卡片）；
 *                 与 --diff 同用显式优先；目录在仓内拒绝（产物纪律）
 *   --html        同时产出静态 HTML 版（<out>.md → .html；报告摘要头含风险分布表 + vs 上份增量行 +
 *                 --baseline-dir 轮跨轮趋势 SVG（≥2 数据点才出图）+ 增量对比高亮与卡片级上色，
 *                 产物纪律随 --out 同守门）
 *   --out         报告落盘路径；缺省 CWD/巡检报告_<项目>_<时间戳>.md
 *                 缺省拒绝写进本仓库/发布包目录内（运行产物不进树、不进包；
 *                 确要如此用 --allow-in-tree 显式放行，后果自担）
 *   --allow-in-tree  允许报告落盘在本脚本所属仓内（破坏「产物不进树」纪律时自担）
 *
 * 退出码：0=成功；1=运行错误；2=预审拒绝（写词/多语句/空语句/仓内落盘）；3=环境缺失（无 SQL 清单/起不来）
 *
 * 证据工具返回形态（实测钉）：
 *   query_plan → { sql_explained, plan_format, columns[], plan[], duration_ms }
 *   count_rows → { table, total, duration_ms }（total 为字符串）
 *   sample_data → { row_count, truncated_cells, columns[], rows[], duration_ms }
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_DIR = process.env.DBMCP_MCP_DIR
  ? path.resolve(process.env.DBMCP_MCP_DIR)
  : path.resolve(REPO, "..", "calvin-db-mcp", "mcp");
const TEMPLATE = path.join(REPO, "outputs", "巡检报告模板.md");

// ---------- parseGeneratedReport（--compare / --baseline-dir / --diff 共用解析器，早初始化） ----------
const REPORT_MARKER_RE = /由 巡检一键\.mjs 生成/;
const normDur = (s) => String(s).replace(/（\d+ms）/g, "").trim();
/** 解析巡检一键生成的报告 → {file, cards, checks}；非生成报告/解析不到 → 抛错（fail-closed） */
const parseGeneratedReport = (dp) => {
  const txt = fs.readFileSync(dp, "utf8");
  if (!REPORT_MARKER_RE.test(txt)) throw new Error(`目标不是巡检一键生成的报告（缺生成标记）：${dp}`);
  const secs = {};
  let cur = null;
  for (const line of txt.split("\n")) {
    const hm = line.match(/^## (.+)/);
    if (hm) cur = hm[1].trim();
    else if (cur) (secs[cur] ??= []).push(line);
  }
  const secText = (prefix) => (Object.entries(secs).find(([k]) => k.startsWith(prefix))?.[1] ?? []).join("\n");
  const cards = new Map();
  for (const m of secText("二、").matchAll(/### 卡片 \d+：(.+)\n([\s\S]*?)(?=\n### |$)/g)) {
    const body = m[2];
    const ex = body.match(/- EXPLAIN：(.*)/);
    const tables = new Map();
    for (const t of body.matchAll(/- 表 (.+?)：count_rows=([^（\s]+)/g)) tables.set(t[1], t[2]);
    for (const t of body.matchAll(/- 表 (.+?)：✗/g)) if (!tables.has(t[1])) tables.set(t[1], "✗");
    cards.set(m[1].trim(), { explain: ex ? normDur(ex[1]) : "?", tables });
  }
  const checks = new Map();
  for (const m of secText("四、").matchAll(/### ([^\n]+)\n([\s\S]*?)(?=\n### |$)/g)) {
    const body = m[2];
    const s = body.match(/- 实测：diff_rows=(\S+) · total_abs_diff=(\S+)/);
    const o = body.match(/- 实测：孤儿样例 (\d+) 行/);
    if (s || o) checks.set(m[1].trim(), { diffRows: s ? s[1] : "?", totalAbs: s ? s[2] : "?", orphan: o ? Number(o[1]) : "?" });
  }
  if (cards.size === 0 && checks.size === 0) throw new Error(`解析不到任何巡检卡片/一致性项：${dp}`);
  return { file: path.basename(dp), cards, checks };
};
// safeName 在参数解析之后才能求值（依赖 opt.project），但在 --compare / --baseline-dir 之前已能确定
const safeName = () => String(opt.project || "默认").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "默认";

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = { sqlInputs: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--source") opt.source = argv[++i];
  else if (a === "--config") opt.config = argv[++i];
  else if (a === "--project") opt.project = argv[++i];
  else if (a === "--out") opt.out = argv[++i];
  else if (a === "--sample") { opt.sample = Number(argv[++i]); opt.sampleGiven = true; }
  else if (a === "--jobs") { opt.jobs = argv[++i]; opt.jobsGiven = true; }
  else if (a === "--diff") opt.diff = argv[++i];
  else if (a === "--baseline-dir") opt.baselineDir = argv[++i];
  else if (a === "--baseline-keep") opt.baselineKeep = Math.max(1, parseInt(argv[++i], 10) || 3);
  else if (a === "--compare") { opt.compare = [argv[++i], argv[++i]]; }
  else if (a === "--baseline-compare") { opt.baselineCompare = [argv[++i], argv[++i]]; }
  else if (a === "--html") opt.html = true;
  else if (a === "--json") opt.json = true;
  else if (a === "--trend-cols") opt.trendCols = argv[++i];
  else if (a === "--manifest") opt.manifest = argv[++i];
  else if (a === "--allow-in-tree") opt.allowInTree = true;
  else if (a === "--help" || a === "-h") opt.help = true;
  else if (a.startsWith("--")) { console.error(`未知参数：${a}（--help 看用法）`); process.exit(2); }
  else opt.sqlInputs.push(a);
}
if (opt.help) {
  console.log(`用法：node 巡检一键.mjs --source <sourceId> [--manifest <清单.json> | <a.sql | 目录>...]
              [--config <配置>] [--project 名称] [--out <路径>] [--sample N] [--allow-in-tree]
              [--baseline-dir <目录> [--baseline-keep N]] [--diff <上份报告>] [--compare <A> <B>] [--baseline-compare <dirA> <dirB>] [--html] [--json] [--trend-cols a,b]
  --manifest   JSON 清单：{"project?","source?","sample?","items":[{"sql","chain?","note?","tables?"}]}
               （sql 相对 manifest 所在目录；chain/note/tables 直接进报告卡片——调用链也自动化；
                 与位置参数互斥；CLI --source/--project/--sample 优先于 manifest 同名字段）
  --baseline-dir <目录>   按项目自动存取基线（baseline_<项目>.md）；首轮无基线直接生成
               之后每次运行自动与上份基线比对；同时生成 baseline_<项目>_history.csv
               （time/sql_count/total_rows 三列，跨轮次趋势）+ 每归档生成 _diff.md
               （对比上上份：新增/移除/计划变化卡片）；目录指仓/包内 → exit 2
  --baseline-keep N       滚动保留最近 N 份归档基线（默认 3）；归档 + CSV 行数共用此配额，过期的归档和 CSV 旧行自动淘汰
  --diff <报告路径>       显式指定上份报告比对（--baseline-dir 的轮次同样写回刷新）
  --compare <A> <B>       对比两份巡检报告的 EXPLAIN plan 文本差异（逐行 diff：+B 新增/-A 移除/共通行，不跑 SQL）
  --html                  同时生成静态 HTML 版（风险分布表/增量对比高亮框）`);
  process.exit(0);
}
// ---------- --baseline-compare <dirA> <dirB>：跨项目基线目录横向对比（解析最新基线 → 复用 --compare） ----------
if (opt.baselineCompare && !opt.compare) {
  const [dirA, dirB] = opt.baselineCompare;
  if (!dirA || !dirB) { console.error("--baseline-compare 需要两个基线目录"); process.exit(2); }
  const latestBaseline = (dir) => {
    const d = path.resolve(dir);
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) { console.error(`[基线对比] 目录不存在：${dir}`); process.exit(3); }
    const files = fs.readdirSync(d)
      .filter((f) => f.startsWith("baseline_") && f.endsWith(".md") && !f.endsWith("_diff.md"))
      .sort((a, b) => b.localeCompare(a)); // 时间戳字典序降序 = 最新在前
    if (!files.length) { console.error(`[基线对比] 目录无基线文件：${dir}`); process.exit(3); }
    return path.join(d, files[0]);
  };
  opt.compare = [latestBaseline(dirA), latestBaseline(dirB)];
  console.log(`基线对比：${path.basename(opt.compare[0])} ↔ ${path.basename(opt.compare[1])}`);
}
// ---------- --compare <报告A> <报告B>：两份报告同 SQL 的 EXPLAIN plan 文本对比 ----------
if (opt.compare) {
  const [fpA, fpB] = opt.compare;
  if (!fpA || !fpB) { console.error("--compare 需要两个报告路径"); process.exit(2); }
  // 与 --diff 同口径：文件不存在 exit 3；存在但非生成报告 exit 2
  for (const fp of [fpA, fpB]) if (!fs.existsSync(path.resolve(fp))) { console.error(`[compare] 报告文件不存在：${fp}`); process.exit(3); }
  const ra = (() => { try { return parseGeneratedReport(path.resolve(fpA)); } catch (e) { console.error(`[compare] ${e.message}`); process.exit(2); } })();
  const rb = (() => { try { return parseGeneratedReport(path.resolve(fpB)); } catch (e) { console.error(`[compare] ${e.message}`); process.exit(2); } })();
  const onlyA = [...ra.cards.keys()].filter((k) => !rb.cards.has(k));
  const onlyB = [...rb.cards.keys()].filter((k) => !ra.cards.has(k));
  const common = [...ra.cards.keys()].filter((k) => rb.cards.has(k));
  const changed = common.filter((k) => ra.cards.get(k).explain !== rb.cards.get(k).explain);
  // LCS 逐行 diff（--compare --html 与终端输出共用）
  const lcsDiff = (a, b) => {
    const la = String(a || "").split("\n"), lb = String(b || "").split("\n");
    const m = la.length, n = lb.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
      dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (la[i] === lb[j]) { out.push({ tag: "same", text: la[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ tag: "del", text: la[i] }); i++; }
      else { out.push({ tag: "add", text: lb[j] }); j++; }
    }
    while (i < m) out.push({ tag: "del", text: la[i++] });
    while (j < n) out.push({ tag: "add", text: lb[j++] });
    return out;
  };
  console.log(`\n=== 两份报告 EXPLAIN plan 对比 ===`);
  console.log(`报告 A：${ra.file}（${ra.cards.size} SQL）`);
  console.log(`报告 B：${rb.file}（${rb.cards.size} SQL）`);
  if (onlyA.length) { console.log(`\n仅 A（${onlyA.length}）：`); for (const k of onlyA) console.log(`  · ${k}`); }
  if (onlyB.length) { console.log(`\n仅 B（${onlyB.length}）：`); for (const k of onlyB) console.log(`  · ${k}`); }
  const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  if (changed.length) {
    console.log(`\n计划有变化（${changed.length}）：`);
    for (const k of changed) {
      const a = ra.cards.get(k).explain, b = rb.cards.get(k).explain;
      console.log(`\n  SQL：${k}`);
      const diffLines = lcsDiff(a, b);
      const onlyLines = diffLines.filter((l) => l.tag !== "same");
      for (const dl of diffLines) {
        const prefix = dl.tag === "add" ? " +B" : dl.tag === "del" ? " -A" : "   ";
        console.log(`  ${prefix} ${dl.text}`);
      }
      console.log(`  （共 ${diffLines.length} 行，其中变更 ${onlyLines.length} 行）`);
    }
  } else if (!onlyA.length && !onlyB.length) {
    console.log(`\n两份报告 SQL 完全一致，计划无变化。`);
  }
  // --compare --html：生成红绿着色 diff 视图
  if (opt.html) {
    const htmlPath = path.resolve((opt.out ? String(opt.out) : "compare_diff").replace(/\.[^.]+$/, "") + ".html");
    const diffSections = changed.map((k) => {
      const a = ra.cards.get(k).explain, b = rb.cards.get(k).explain;
      const lines = lcsDiff(a, b);
      const rows = lines.map((l) => {
        const cls = l.tag === "add" ? ' class="dl-add"' : l.tag === "del" ? ' class="dl-del"' : "";
        const mark = l.tag === "add" ? "+" : l.tag === "del" ? "-" : " ";
        return `<tr${cls}><td class="dl-mark">${mark}</td><td><pre>${escHtml(l.text)}</pre></td></tr>`;
      }).join("\n");
      return `<h3>${escHtml(k)}</h3>\n<table class="diff-table"><thead><tr><th></th><th>行</th></tr></thead>\n<tbody>\n${rows}\n</tbody></table>`;
    }).join("\n");
    const cardRows = [
      ...onlyA.map((k) => `<tr class="dl-del"><td>${escHtml(k)}</td><td>仅 A</td></tr>`),
      ...onlyB.map((k) => `<tr class="dl-add"><td>${escHtml(k)}</td><td>仅 B</td></tr>`),
      ...changed.map((k) => `<tr class="dl-chg"><td>${escHtml(k)}</td><td>计划变化</td></tr>`),
    ].join("\n");
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>EXPLAIN Plan Diff</title><style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1c2733}
h1{font-size:1.4em;border-bottom:2px solid #2b6cb0;padding-bottom:6px}
h3{margin-top:1.4em;font-size:1em}
.meta{color:#718096;font-size:.9em;margin-bottom:16px}
.diff-table{border-collapse:collapse;width:100%;font-size:.88em;margin:6px 0}
.diff-table th{background:#edf2f7;border:1px solid #cbd5e0;padding:3px 8px;text-align:left}
.diff-table td{border:1px solid #e2e8f0;padding:2px 8px;vertical-align:top}
.diff-table pre{margin:0;font-family:Consolas,Menlo,monospace;font-size:.92em;white-space:pre-wrap;word-break:break-all}
.dl-add{background:#f0fff4}
.dl-del{background:#fff5f5}
.dl-chg{background:#fffaf0}
.dl-mark{width:24px;text-align:center;font-weight:700;color:#718096;user-select:none}
.dl-add .dl-mark{color:#276e3a}
.dl-del .dl-mark{color:#c53030}
@media print{
  body{max-width:none;margin:0}
  .dl-add,.dl-del,.dl-chg{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h3{page-break-after:avoid}
  tr{page-break-inside:avoid}
}
</style></head><body>
<h1>EXPLAIN Plan Diff</h1>
<div class="meta">A：${escHtml(ra.file)}（${ra.cards.size} SQL） · B：${escHtml(rb.file)}（${rb.cards.size} SQL）</div>
${cardRows ? `<h2>卡片差异</h2>\n<table class="diff-table"><thead><tr><th>SQL</th><th>状态</th></tr></thead>\n<tbody>\n${cardRows}\n</tbody></table>` : ""}
${diffSections ? `<h2>计划逐行 diff</h2>\n${diffSections}` : ""}
${!cardRows && !diffSections ? "<p>两份报告完全一致。</p>" : ""}
</body></html>`;
    fs.writeFileSync(htmlPath, html, "utf8");
    console.log(`\nHTML diff 已生成：${htmlPath}`);
  }
  process.exit(0);
}
if (opt.manifest && opt.sqlInputs.length) {
  console.error("[审计] --manifest 与位置参数互斥 —— 一次只用一种清单方式"); process.exit(2);
}

// ---------- SQL 清单：--manifest JSON（带调用链等元数据）或位置参数（文件 / 目录取 .sql） ----------
const planItems = [];   // {file, name, chain, note, tablesDeclared}
let consistencyRaw;     // manifest.consistency 原文（审计区解析生成——auditOne 定义在后）
if (opt.manifest) {
  const mPath = path.resolve(opt.manifest);
  if (!fs.existsSync(mPath)) { console.error(`[审计] manifest 不存在：${opt.manifest}`); process.exit(3); }
  let mf;
  try { mf = JSON.parse(fs.readFileSync(mPath, "utf8")); }
  catch (e) { console.error(`[审计] manifest 不是合法 JSON：${e.message}`); process.exit(2); }
  if (!mf || typeof mf !== "object" || !Array.isArray(mf.items) || mf.items.length === 0) {
    console.error('[审计] manifest 形态不符：需要 {"project?","source?","sample?","items":[{"sql","chain?","note?","tables?"}]} 且 items 非空');
    process.exit(2);
  }
  if (mf.project && !opt.project) opt.project = String(mf.project);
  if (mf.source && !opt.source) opt.source = String(mf.source);
  if (Number.isFinite(mf.sample) && !opt.sampleGiven) opt.sample = mf.sample;
  consistencyRaw = mf.consistency;
  const mdir = path.dirname(mPath);
  mf.items.forEach((it, i) => {
    const ref = it && it.sql;
    if (typeof ref !== "string" || !ref.trim()) {
      console.error(`[审计] items[${i}] 缺 sql 字段（相对 manifest 所在目录）`); process.exit(2);
    }
    const p = path.resolve(mdir, ref);
    if (!fs.existsSync(p)) { console.error(`[审计] items[${i}] SQL 文件不存在：${ref}`); process.exit(3); }
    planItems.push({
      file: p, name: path.basename(p),
      chain: typeof it.chain === "string" ? it.chain.trim() : "",
      note: typeof it.note === "string" ? it.note.trim() : "",
      tablesDeclared: Array.isArray(it.tables)
        ? it.tables.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()) : [],
    });
  });
} else {
  if (!opt.source || opt.sqlInputs.length === 0) {
    console.error("缺 --source 或 SQL 清单（位置参数 / --manifest，--help 看用法）"); process.exit(3);
  }
  for (const input of opt.sqlInputs) {
    const p = path.resolve(input);
    if (!fs.existsSync(p)) { console.error(`[审计] 输入不存在：${input}`); process.exit(3); }
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      const found = fs.readdirSync(p).filter((f) => f.toLowerCase().endsWith(".sql")).sort()
        .map((f) => path.join(p, f));
      if (found.length === 0) { console.error(`[审计] 目录里没有 .sql：${input}`); process.exit(3); }
      for (const f of found) planItems.push({ file: f, name: path.basename(f), chain: "", note: "", tablesDeclared: [] });
    } else planItems.push({ file: p, name: path.basename(p), chain: "", note: "", tablesDeclared: [] });
  }
}
if (!Number.isFinite(opt.sample) || opt.sample < 1 || opt.sample > 50) opt.sample = 3;
// 受控并发：证据任务条目级并行（rpc pending 表天然支持乱序响应）；1=串行；越界 fail-closed
opt.jobs = opt.jobsGiven ? Number(opt.jobs) : 4;
if (!Number.isInteger(opt.jobs) || opt.jobs < 1 || opt.jobs > 16) {
  console.error("[参数] --jobs 需 1-16 的整数（1=串行；默认 4）"); process.exit(2);
}
if (!opt.source) { console.error("缺 --source（CLI 或 manifest.source 二选一）"); process.exit(3); }

// ---------- 客户端预审（第一层闸；服务端只读门仍是最终兜底） ----------
// 注释先行剥离再判多语句 —— 尾注释不算第二条语句（对侧 OBS-4 教训：先判后剥会误报）。
const stripComments = (sql) => sql
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/--[^\n]*/g, " ")
  .replace(/#[^\n]*/g, " ");
// 写词即拒：宁拒勿放（值/列名里撞词的误拒属于 fail-closed 可用性边缘，服务端口径从宽时以服务端为准）
const WRITE_WORDS_RE = /\b(update|delete|insert|drop|truncate|alter|create|replace|grant|revoke|merge|call|set|lock|rename)\b/i;
const auditOne = (name, raw) => {
  const trimmed = raw.trim();
  if (!trimmed) return `[${name}] 空 SQL`;
  const stripped = stripComments(trimmed).trim();
  if (!stripped) return `[${name}] 纯注释（无可执行语句）`;
  if (WRITE_WORDS_RE.test(stripped)) {
    const w = stripped.match(WRITE_WORDS_RE)[1];
    return `[${name}] 命中写词「${w}」—— 本脚本只读，写操作请走 DBA 渠道`;
  }
  const stmts = stripped.replace(/;[;\s]*$/, ";").split(";").map((s) => s.trim()).filter(Boolean);
  if (stmts.length > 1) return `[${name}] 多语句（${stmts.length} 条）—— 一次一条，逐条取证`;
  return null;
};

// ---------- 一致性检查骨架生成（manifest.consistency，装载期即生成+审计 —— 先审后执行） ----------
// 形态：{"name","leftTable","leftKey","leftValue","rightTable","rightKey","rightValue"}
//   语义：按 join key 对账 —— 左表逐行值 vs 右表按 key 聚合值（如 orders.amount vs SUM(order_items.qty*price)）；
//   生成三段只读骨架：①差异汇总 ②差异样例（左多/右缺 → COALESCE 0 即左有右无也入 diff）③孤儿检查（只在右表）
//   value 表达式是人工输入 —— 生成后的 SQL 过与直连 SQL 同款审计（写词/多语句），标识符另做形态白名单。
const IDENT_RE = /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*$/;
const cleanIdent = (s) => String(s ?? "").trim().replace(/[`"\[]/g, "").replace(/\]/g, "");
const buildConsistencySqls = (c, dialect) => {
  // 方言化：pg 用双引号包裹标识符各段；mysql 缺省不加引号（与历史口径兼容）
  const qi = (s) => {
    const parts = cleanIdent(s).split(".");
    return dialect === "pg" ? parts.map((p) => `"${p}"`).join(".") : parts.join(".");
  };
  const lt = qi(c.leftTable), lk = qi(c.leftKey), lv = String(c.leftValue).trim();
  const rt = qi(c.rightTable), rk = qi(c.rightKey), rv = String(c.rightValue).trim();
  const inner =
    `SELECT q.${lk} AS join_key, q.${lv} AS left_value, COALESCE(t.rv, 0) AS right_value,\n` +
    `       q.${lv} - COALESCE(t.rv, 0) AS diff\n` +
    `FROM ${lt} q\n` +
    `LEFT JOIN (SELECT ${rk} AS rk, SUM(${rv}) AS rv FROM ${rt} GROUP BY ${rk}) t ON t.rk = q.${lk}`;
  return {
    summary: `SELECT COUNT(*) AS diff_rows, COALESCE(SUM(ABS(diff)), 0) AS total_abs_diff FROM (\n${inner}\n) d WHERE diff <> 0`,
    sample: `SELECT * FROM (\n${inner}\n) d WHERE diff <> 0 ORDER BY ABS(diff) DESC LIMIT 20`,
    orphan: `SELECT t.rk AS orphan_key, t.rv AS orphan_value FROM (SELECT ${rk} AS rk, SUM(${rv}) AS rv FROM ${rt} GROUP BY ${rk}) t\n` +
      `LEFT JOIN ${lt} q ON q.${lk} = t.rk\nWHERE q.${lk} IS NULL ORDER BY t.rv DESC LIMIT 20`,
  };
};
const consistencyChecks = [];
if (Array.isArray(consistencyRaw)) {
  consistencyRaw.forEach((c, i) => {
    const label = `consistency[${i}]`;
    if (!c || typeof c !== "object") { console.error(`[审计] ${label} 形态不符（需要对象）`); process.exit(2); }
    for (const k of ["name", "leftTable", "leftKey", "leftValue", "rightTable", "rightKey", "rightValue"]) {
      if (typeof c[k] !== "string" || !c[k].trim()) { console.error(`[审计] ${label} 缺 ${k}`); process.exit(2); }
    }
    for (const [k, v] of Object.entries({ leftTable: c.leftTable, leftKey: c.leftKey, rightTable: c.rightTable, rightKey: c.rightKey })) {
      if (!IDENT_RE.test(cleanIdent(v))) { console.error(`[审计] ${label}.${k} 不是合法标识符：${v}`); process.exit(2); }
    }
    const dialect = String(c.dialect || "mysql").toLowerCase();
    if (dialect !== "mysql" && dialect !== "pg") { console.error(`[审计] ${label}.dialect 只支持 mysql/pg：${c.dialect}`); process.exit(2); }
    const confidence = (typeof c.confidence === "string" && ["high","medium","low"].includes(c.confidence)) ? c.confidence : "high";
    const sqls = buildConsistencySqls(c, dialect);
    for (const [k, sql] of Object.entries(sqls)) {
      const why = auditOne(`${label}.${k}`, sql);
      if (why) { console.error(`[审计] ${why}`); process.exit(2); }
    }
    consistencyChecks.push({ name: c.name, leftTable: cleanIdent(c.leftTable), confidence, ...sqls });
  });
} else if (consistencyRaw !== undefined && consistencyRaw !== null) {
  console.error("[审计] manifest.consistency 形态不符：需要数组"); process.exit(2);
}
const sqlItems = [];
const auditFails = [];
for (const it of planItems) {
  const raw = fs.readFileSync(it.file, "utf8");
  const why = auditOne(path.relative(process.cwd(), it.file) || it.file, raw);
  if (why) auditFails.push(why);
  else sqlItems.push({
    ...it,
    sql: stripComments(raw).trim().replace(/;+\s*$/, ""),
  });
}
if (auditFails.length) {
  console.error(`预审拒绝（${auditFails.length} 项），整批不执行：`);
  for (const w of auditFails) console.error(`  ✗ ${w}`);
  process.exit(2);
}
if (sqlItems.length === 0) { console.error("没有可执行的 SQL"); process.exit(3); }

// ---------- 增量基线：--diff 显式指定 / --baseline-dir 按项目自动存取（输入侧校验，先于落盘守门） ----------
let prevReport = null;
let pendingBaseline = null;
if (opt.diff) {
  const dp = path.resolve(opt.diff);
  if (!fs.existsSync(dp)) { console.error(`[增量] 上份报告不存在：${opt.diff}`); process.exit(3); }
  try { prevReport = parseGeneratedReport(dp); }
  catch (e) { console.error(`[增量] ${e.message}`); process.exit(2); }
}
if (opt.baselineDir) {
  const bd = path.resolve(opt.baselineDir);
  if (!opt.allowInTree && (bd === REPO || bd.startsWith(REPO + path.sep))) {
    console.error(`[基线] 基线目录在本仓/发布包内：${bd} —— 运行产物不进树不进包（用仓外目录，或 --allow-in-tree 显式自担）`);
    process.exit(2);
  }
  fs.mkdirSync(bd, { recursive: true });
  pendingBaseline = path.join(bd, `baseline_${safeName()}.md`);
  if (!opt.diff && fs.existsSync(pendingBaseline)) {
    try { prevReport = parseGeneratedReport(pendingBaseline); }
    catch (e) { console.error(`[基线] ${e.message}`); process.exit(2); }
  }
}

// ---------- 落盘路径：运行产物默认不进仓/不进包 ----------
const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
const defaultOut = path.resolve(process.cwd(), `巡检报告_${opt.project || "默认"}_${stamp}.md`);
const outPath = opt.out ? path.resolve(opt.out) : defaultOut;
if (!opt.allowInTree && (outPath === REPO || outPath.startsWith(REPO + path.sep))) {
  console.error(`[落盘守门] 报告路径在本仓/发布包内：${outPath}`);
  console.error("  运行产物进树会撞 docsync「盘→树」门（未收录文件）、进包会污染纯净分发版。");
  console.error("  用 --out 指到仓外路径；确有特殊需要加 --allow-in-tree 显式自担。");
  process.exit(2);
}

// ---------- 脱敏（兜底口径；判定以 references/白名单与脱敏配置.yaml 为准） ----------
const SENSITIVE_COL_RE = /(phone|mobile|tel|e?mail|id_?card|identity|ssn|passport|身份|手机|邮箱|证件)/i;
const maskText = (s) => String(s ?? "")
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***")
  .replace(/\d{11,}/g, "***");
const maskCell = (col, v) => (SENSITIVE_COL_RE.test(String(col)) ? "***（敏感列）" : maskText(v));

// ---------- 表名抽取（FROM/JOIN 后的标识符；剥引号；schema.table 拆分） ----------
const extractTables = (sql) => {
  const out = [];
  const re = /\b(?:from|join)\s+([`"\[]?)([A-Za-z_][\w$]*|[\u4e00-\u9fa5][\w\u4e00-\u9fa5$]*)\1(?:\s*\.\s*([`"\[]?)([\w$\u4e00-\u9fa5]+)\3)?/gi;
  for (const m of sql.matchAll(re)) {
    const raw = m[2] + (m[4] ? "." + m[4] : "");
    if (/^(select|\()$/i.test(m[2])) continue;          // 子查询开头，非表名
    if (!/^[\w$.\u4e00-\u9fa5"`\[\]]+$/.test(raw)) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
};
const splitQualified = (t) => {
  const bare = t.replace(/[`"\[\]]/g, "");
  const i = bare.lastIndexOf(".");
  return i > 0 ? { schema: bare.slice(0, i), table: bare.slice(i + 1) } : { table: bare };
};

// ---------- stdio JSON-RPC 客户端（与 tests/fullchain_test.mjs 同一套协议形态） ----------
if (!fs.existsSync(path.join(SERVER_DIR, "server.mjs"))) {
  console.error(`找不到 calvin-db-mcp 服务端：${SERVER_DIR}（可用 DBMCP_MCP_DIR 覆盖）`);
  process.exit(3);
}
const spawnEnv = { ...process.env };
if (opt.config) spawnEnv.DBMCP_CONFIG = path.resolve(opt.config);
const child = spawn(process.execPath, ["server.mjs"], { cwd: SERVER_DIR, stdio: ["pipe", "pipe", "pipe"], env: spawnEnv });
let nextId = 1;
const pending = new Map();
let buf = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    } catch { /* 忽略非 JSON 行 */ }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
const rpc = (method, params, timeoutMs = 30000) => new Promise((resolve, reject) => {
  const id = nextId++;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const call = (name, args) => rpc("tools/call", { name, arguments: args ?? {} });
const unwrap = (resp) => {
  if (resp.error) throw new Error("rpc-error: " + JSON.stringify(resp.error));
  const text = resp.result?.content?.[0]?.text;
  if (text === undefined) return resp.result;
  try { return JSON.parse(text); } catch { return text; }
};
// 工具级失败有三种实形，都必须抛错而不是当成「空证据」：
//   ① rpc error；② result.isError=true + 纯文本 content（MCP 标准形，如 E_NOT_FOUND）；
//   ③ 结果 JSON 内带 error 字段（服务端 in-band 错误）
const take = (resp, tool) => {
  const r = unwrap(resp);
  if (resp.result?.isError || typeof r !== "object" || r === null || r.error) {
    const msg = typeof r === "string" ? r : (r?.error ?? JSON.stringify(resp.result ?? r));
    throw new Error(`${tool}: ${String(msg).split("\n")[0]}`);
  }
  return r;
};
const errCode = (e) => (String(e?.message ?? e).match(/\[([A-Z_]+)[:\]]/)?.[1] ?? "");

// ---------- 取证 ----------
const die = (msg) => { try { child.kill(); } catch {} console.error(msg); process.exit(1); };
let sourcesDesc = "";
try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "sql-check-script 巡检一键", version: "1.0.0" },
  });
  if (!init.result?.serverInfo?.name) die("[连接] initialize 握手失败");
  await rpc("notifications/initialized", {});
  const ls = take(await call("list_sources"), "list_sources");
  const list = Array.isArray(ls?.sources) ? ls.sources : [];
  const src = list.find((s) => s.id === opt.source);
  if (!src) die(`[连接] source「${opt.source}」不在 list_sources 里（可见：${list.map((s) => s.id).join(", ") || "无"}）`);
  sourcesDesc = src.description || `${src.type}${src.host ? ` ${src.host}:${src.port ?? ""}` : ""}`;
} catch (e) { die(`[连接] ${e.message}`); }

// 受控并发取证：条目级任务 + 工作池（rpc pending 表天然支持乱序响应；每任务只写自己的证据槽，零共享可变）
const runPool = async (tasks, limit) => {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(tasks.length, 1)) }, async () => {
    while (idx < tasks.length) {
      const t = tasks[idx++];
      await t();
    }
  });
  await Promise.all(workers);
};
const evidenceTasks = [];
for (const item of sqlItems) {
  evidenceTasks.push(async () => {
    // manifest.tables 显式声明优先（人工口径）；未声明才从 SQL 自动抽取
    item.tables = item.tablesDeclared.length ? item.tablesDeclared : extractTables(item.sql);
    try {
      const plan = take(await call("query_plan", { source: opt.source, sql: item.sql }), "query_plan");
      item.plan = plan;
    } catch (e) {
      item.planError = `${errCode(e) ? `[${errCode(e)}] ` : ""}${String(e.message ?? e).split("\n")[0]}`;
    }
    item.tableEvidence = [];
    for (const t of item.tables) {
      const q = splitQualified(t);
      const ev = { ref: t, schema: q.schema, table: q.table };
      try {
        const cr = take(await call("count_rows", { source: opt.source, table: q.table, ...(q.schema ? { schema: q.schema } : {}) }), "count_rows");
        ev.total = cr.total ?? cr.count ?? "?";
        ev.countMs = cr.duration_ms;
      } catch (e) {
        const code = errCode(e);
        ev.error = `${code ? `[${code}] ` : ""}${String(e.message ?? e).split("\n")[0]}`;
        if (code === "E_NOT_FOUND") ev.hint = "默认库无此表 —— 引用必带 schema 限定（如 sqlchk_test.orders）";
      }
      if (!ev.error) {
        try {
          const sd = take(await call("sample_data", { source: opt.source, table: q.table, ...(q.schema ? { schema: q.schema } : {}), limit: opt.sample }), "sample_data");
          ev.sample = {
            rowCount: sd.row_count, truncated: sd.truncated_cells,
            columns: sd.columns ?? [],
            rows: (sd.rows ?? []).map((r) => Object.fromEntries(Object.entries(r).map(([c, v]) => [c, maskCell(c, v)]))),
            ms: sd.duration_ms,
          };
        } catch (e) { ev.sampleError = String(e.message ?? e).split("\n")[0]; }
      }
      item.tableEvidence.push(ev);
    }
  });
}
// 一致性检查任务（骨架装载期已审计；只读执行取实测证据，结果零明文脱敏；附带左表行数作口径提示基准）
for (const cc of consistencyChecks) {
  evidenceTasks.push(async () => {
    for (const k of ["summary", "sample", "orphan"]) {
      try {
        const r = take(await call("query", { source: opt.source, sql: cc[k] }), "query");
        if (k === "summary") cc.summaryRes = r.rows?.[0] ?? null;
        else cc[k + "Res"] = {
          rowCount: r.row_count ?? (r.rows ?? []).length,
          columns: r.columns ?? [],
          rows: (r.rows ?? []).map((row) => Object.fromEntries(Object.entries(row).map(([c2, v]) => [c2, maskCell(c2, v)]))),
        };
      } catch (e) { cc[k + "Err"] = String(e.message ?? e).split("\n")[0]; }
    }
    try {
      const q = splitQualified(cc.leftTable);
      const cr = take(await call("count_rows", { source: opt.source, table: q.table, ...(q.schema ? { schema: q.schema } : {}) }), "count_rows");
      cc.leftRows = Number(cr.total);
    } catch { cc.leftRows = null; }
  });
}
await runPool(evidenceTasks, opt.jobs);
try { child.kill(); } catch {}

// ---------- EXPLAIN 证据摘要（MySQL 列形态优先；其余方言逐行原样） ----------
const planSummary = (p) => {  if (!p) return "（EXPLAIN 失败，见错误行）";
  const rows = Array.isArray(p.plan) ? p.plan : [];
  if (rows.length && ["type", "key", "rows", "Extra"].every((k) => rows.every((r) => k in r))) {
    const nv = (x) => (x === null || x === undefined || x === "" ? "-" : x);
    return rows.map((r) =>
      `type=${nv(r.type)} · key=${nv(r.key)} · rows=${nv(r.rows)} · Extra=${nv(r.Extra)}`).join("；");
  }
  // PG 等文本计划：单列（如 QUERY PLAN）逐行原样 —— Seq Scan 即全扫信号
  if (rows.length && rows.every((r) => typeof r === "object" && r !== null && Object.keys(r).length === 1)) {
    return rows.map((r) => String(Object.values(r)[0]).trim()).join("；");
  }
  return rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join(" | ").slice(0, 600) || "(空计划)";
};

// ---------- 静态 HTML 渲染（--html；仅覆盖本报告自产 md 子集：标题/表格/代码块/列表/引用/加粗） ----------
const escHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const renderHtml = (mdText) => {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = mdText.split("\n");
  const out = [];
  let i = 0, inDelta = false;
  const closeDelta = () => { if (inDelta) { out.push("</div>"); inDelta = false; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^\*\*增量对比/.test(l)) { closeDelta(); out.push('<div class="delta">'); inDelta = true; }
    if (/^```/.test(l)) {
      i++; const buf = [];
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
      i++;
      out.push(`<pre class="sql">${buf.join("\n")}</pre>`);
      continue;
    }
    if (/^\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.split("|").slice(1, -1).map((c) => inline(c.trim()));
      const isSep = rows.length >= 2 && /^[\s|:\-]+$/.test(rows[1]);
      const head = isSep ? rows[0] : null;
      const bodyRows = isSep ? rows.slice(2) : rows;
      out.push("<table>" + (head ? "<thead><tr>" + cells(head).map((c) => `<th>${c}</th>`).join("") + "</tr></thead>" : "") + "<tbody>");
      for (const r of bodyRows) out.push("<tr>" + cells(r).map((c) => `<td>${c}</td>`).join("") + "</tr>");
      out.push("</tbody></table>");
      continue;
    }
    const h = l.match(/^(#{1,3}) (.*)/);
    if (h) {
      closeDelta();
      // 卡片标题按 diff 集合上色：新增=绿、证据变化=橙（高亮信息来自 --diff/--baseline-dir 增量比对）
      const cardM = h[2].match(/^卡片 \d+：(.+)$/);
      if (cardM && deltaHighlight) {
        const name = cardM[1].trim();
        if (deltaHighlight.added.has(name)) { out.push(`<h${h[1].length} class="card-added">${inline(h[2])} <span class="delta-badge">新增</span></h${h[1].length}>`); i++; continue; }
        if (deltaHighlight.changed.has(name)) { out.push(`<h${h[1].length} class="card-changed">${inline(h[2])} <span class="delta-badge">证据变化</span></h${h[1].length}>`); i++; continue; }
      }
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue;
    }
    if (/^> /.test(l)) { out.push(`<blockquote>${inline(l.slice(2))}</blockquote>`); i++; continue; }
    if (/^- /.test(l) || /^\s+- /.test(l)) {
      const sub = /^\s+- /.test(l);
      const items = [];
      while (i < lines.length && (sub ? /^\s+- /.test(lines[i]) : /^- /.test(lines[i]))) {
        items.push(`<li>${inline(lines[i].replace(sub ? /^\s+- / : /^- /, ""))}</li>`); i++;
      }
      out.push(`<ul${sub ? ' class="sub"' : ""}>${items.join("")}</ul>`);
      continue;
    }
    if (!l.trim()) { closeDelta(); out.push(""); i++; continue; }
    out.push(`<p>${inline(l)}</p>`); i++;
  }
  closeDelta();
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>SQL 巡检报告</title><style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#1c2733;line-height:1.6}
h1{font-size:1.5em;border-bottom:2px solid #2b6cb0;padding-bottom:6px}h2{font-size:1.25em;color:#2b6cb0;margin-top:1.6em}h3{font-size:1.05em;margin-top:1.2em}
table{border-collapse:collapse;margin:8px 0;font-size:.92em}th,td{border:1px solid #cbd5e0;padding:4px 10px;text-align:left}th{background:#edf2f7}
pre.sql{background:#f6f8fa;border:1px solid #e2e8f0;border-radius:6px;padding:10px;overflow-x:auto;font-size:.88em}
blockquote{margin:.4em 0;padding:2px 12px;border-left:4px solid #2b6cb0;background:#f0f7ff;color:#4a5568}
.delta{background:#fffbe6;border:1px solid #f6d860;border-radius:6px;padding:8px 14px;margin:10px 0}
h2.card-added,h3.card-added{border-left:4px solid #38a169;padding-left:8px;background:#f0fff4}
h2.card-changed,h3.card-changed{border-left:4px solid #dd6b20;padding-left:8px;background:#fffaf0}
.delta-badge{display:inline-block;font-size:.65em;font-weight:600;padding:1px 8px;border-radius:10px;vertical-align:middle;margin-left:6px;color:#fff}
h2.card-added .delta-badge,h3.card-added .delta-badge{background:#38a169}
h2.card-changed .delta-badge,h3.card-changed .delta-badge{background:#dd6b20}
code{background:#f6f8fa;padding:1px 4px;border-radius:3px}
ul.sub{list-style:circle;margin:2px 0 8px}
.rsummary{margin:0 0 18px;padding:14px 18px;background:#f7faff;border:1px solid #c3d9f5;border-radius:8px}
.rsummary-title{font-size:1em;font-weight:700;color:#2b6cb0;margin:0 0 10px}
.rsummary-table{font-size:.9em;margin:0}
.rsummary td.ok{color:#276e3a;font-weight:600}
.rsummary td.err{color:#c53030;font-weight:600}
.trend{margin:0 0 18px;padding:14px 18px;background:#fff;border:1px solid #e2e8f0;border-radius:8px}
.trend-title{font-size:1em;font-weight:700;color:#2b6cb0;margin:0 0 8px}
@media print{
  body{max-width:none;margin:0;padding:0;color:#000}
  .rsummary{border:1px solid #999;background:#f7faff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .rsummary td.ok{color:#276e3a!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .rsummary td.err{color:#c53030!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .delta{border:1px solid #c9a800;background:#fffbe6!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h2.card-added,h3.card-added{border-left:4px solid #38a169;background:#f0fff4!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h2.card-changed,h3.card-changed{border-left:4px solid #dd6b20;background:#fffaf0!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .delta-badge{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h2.card-added .delta-badge,h3.card-added .delta-badge{background:#38a169!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h2.card-changed .delta-badge,h3.card-changed .delta-badge{background:#dd6b20!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .trend{border:1px solid #ccc;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  pre.sql{border:1px solid #ccc;background:#f6f8fa!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  blockquote{border-left:4px solid #2b6cb0;background:#f0f7ff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  th{background:#edf2f7!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h1,h2,h3{page-break-after:avoid}
  table{page-break-inside:auto}
  tr{page-break-inside:avoid}
}
</style></head><body>
${out.join("\n")}
</body></html>`;
};

// ---------- --html 趋势图（零依赖内联 SVG；读 baseline_<项目>_history.csv 的 sql_count/total_rows 两列） ----------
// 仅 1 个数据点不出图（无趋势可画）；坐标轴刻度取 min/max 端点标注
// ≥3 数据点时评估环比阈值：任一指标环比 >200%（涨幅或跌幅）在对应点打 ⚠ 警示圈
const renderTrendSvg = (csvText, title) => {
  const rows = csvText.trim().split("\n").slice(1)
    .map((l) => { const [t, s, r] = l.split(","); return { t: (t || "").slice(5, 16), sql: parseInt(s, 10) || 0, rows: parseInt(r, 10) || 0 }; })
    .filter((x) => x.t);
  if (rows.length < 2) return "";
  // 阈值告警：≥3 点才评估环比（第 1 点无前值）
  const alerts = []; // {i, key, pct}
  if (rows.length >= 3) {
    for (let i = 1; i < rows.length; i++) {
      for (const key of ["sql", "rows"]) {
        const prev = rows[i - 1][key], curr = rows[i][key];
        if (prev > 0 && curr > 0) {
          const ratio = curr / prev;
          if (ratio > 2 || ratio < 0.5) alerts.push({ i, key, pct: Math.round((ratio - 1) * 100) });
        } else if (prev > 0 && curr === 0) {
          alerts.push({ i, key, pct: -100 });
        } else if (prev === 0 && curr > 0) {
          alerts.push({ i, key, pct: 100 });
        }
      }
    }
  }
  const alertedIdx = new Map(); // i → true（有告警的 x 坐标索引）
  for (const a of alerts) alertedIdx.set(a.i, true);
  const W = 720, H = 200, PAD = { l: 48, r: 12, t: 20, b: 32 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const series = (key, color, axis) => {
    const vals = rows.map((x) => x[key]);
    const max = Math.max(...vals, 1), min = 0;
    const px = (i) => PAD.l + (rows.length === 1 ? iw / 2 : (i * iw) / (rows.length - 1));
    const py = (v) => PAD.t + ih - ((v - min) / (max - min)) * ih;
    const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(" ");
    const dots = vals.map((v, i) => {
      const isAlert = alertedIdx.has(i);
      const r = isAlert ? 4.5 : 2.5;
      const stroke = isAlert ? ` stroke="#c53030" stroke-width="2"` : "";
      // 悬停提示：时点值 + 环比 ±%（vs 前一点）+ 偏移 ±%（vs 首点）
      let tip = `${rows[i].t} ${key === "sql" ? "SQL数" : "总行数"}=${v}`;
      if (i > 0 && vals[i - 1] > 0) {
        const mom = Math.round(((v - vals[i - 1]) / vals[i - 1]) * 100);
        tip += ` · 环比${mom > 0 ? "+" : ""}${mom}%`;
      }
      if (i > 0 && vals[0] > 0) {
        const off = Math.round(((v - vals[0]) / vals[0]) * 100);
        tip += ` · 偏移${off > 0 ? "+" : ""}${off}%`;
      }
      return `<circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="${r}" fill="${color}"${stroke}><title>${tip}</title></circle>`;
    }).join("");
    // 基线偏移标注：末点相对首点的 ±%（首点为 0 时不标）
    let offsetLabel = "";
    if (rows.length >= 2 && vals[0] > 0) {
      const pct = Math.round(((vals[vals.length - 1] - vals[0]) / vals[0]) * 100);
      const sign = pct > 0 ? "+" : "";
      const offColor = pct > 0 ? "#c53030" : pct < 0 ? "#276e3a" : "#718096";
      const lastX = px(rows.length - 1), lastY = py(vals[vals.length - 1]);
      offsetLabel = `<text x="${Math.min(lastX + 6, W - 4).toFixed(1)}" y="${(lastY - 6).toFixed(1)}" font-size="9" fill="${offColor}" font-weight="700">${sign}${pct}%</text>`;
    }
    // 轴标签：左轴（总行数）或右轴（SQL数），避免两条系列互相覆盖刻度
    const ax = axis === "right"
      ? `<text x="${(PAD.l + iw + 4).toFixed(1)}" y="${(py(max)+4).toFixed(1)}" font-size="10" fill="${color}">${max}</text><text x="${(PAD.l + iw + 4).toFixed(1)}" y="${(py(min)+4).toFixed(1)}" font-size="10" fill="${color}">0</text>`
      : `<text x="${(PAD.l-6).toFixed(1)}" y="${(py(max)+4).toFixed(1)}" text-anchor="end" font-size="10" fill="${color}">${max}</text><text x="${(PAD.l-6).toFixed(1)}" y="${(py(min)+4).toFixed(1)}" text-anchor="end" font-size="10" fill="${color}">0</text>`;
    return `<polyline class="trend-line" points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>${dots}${offsetLabel}${ax}`;
  };
  const xLabels = rows.map((x, i) => {
    const mark = alertedIdx.has(i) ? `⚠ ` : "";
    const fill = alertedIdx.has(i) ? "#c53030" : "#718096";
    const weight = alertedIdx.has(i) ? " font-weight=\"700\"" : "";
    return `<text x="${(PAD.l + (i * iw) / (rows.length - 1)).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="9" fill="${fill}"${weight}>${mark}${x.t}</text>`;
  }).join("");
  const alertNote = alerts.length
    ? `<div style="font-size:.78em;color:#c53030;margin-top:4px">⚠ 环比超阈值：${alerts.map((a) => `${rows[a.i].t} ${a.key === "sql" ? "SQL数" : "总行数"} ${a.pct > 0 ? "+" : ""}${a.pct}%`).join("；")}</div>`
    : "";
  // 面积渐变 + 入场动画：SVG <defs> 定义两条渐变，polyline 用 CSS stroke-dasharray 动画
  const defs = `<defs><linearGradient id="trendGradRows" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2b6cb0" stop-opacity=".25"/><stop offset="100%" stop-color="#2b6cb0" stop-opacity=".02"/></linearGradient><linearGradient id="trendGradSql" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#38a169" stop-opacity=".25"/><stop offset="100%" stop-color="#38a169" stop-opacity=".02"/></linearGradient></defs>`;
  const animStyle = `<style>.trend-line{stroke-dasharray:1600;stroke-dashoffset:1600;animation:tlDraw 1.2s ease forwards}@keyframes tlDraw{to{stroke-dashoffset:0}}</style>`;
  // 面积填充 polygon（polyline 点 + 底边闭合）
  const areaPoly = (key, gradId) => {
    const vals = rows.map((x) => x[key]);
    const max = Math.max(...vals, 1);
    const px = (i) => PAD.l + (rows.length === 1 ? iw / 2 : (i * iw) / (rows.length - 1));
    const py = (v) => PAD.t + ih - (v / max) * ih;
    const pts = vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`);
    const bottom = `${px(rows.length - 1).toFixed(1)},${(PAD.t + ih).toFixed(1)} ${px(0).toFixed(1)},${(PAD.t + ih).toFixed(1)}`;
    return `<polygon points="${pts.join(" ")} ${bottom}" fill="url(#${gradId})" stroke="none"/>`;
  };
  return `<div class="trend"><div class="trend-title">📈 ${escHtml(title)}</div><svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui,sans-serif">${animStyle}${defs}<rect x="${PAD.l}" y="${PAD.t}" width="${iw}" height="${ih}" fill="#fafbfc" stroke="#e2e8f0"/>${areaPoly("rows", "trendGradRows")}${areaPoly("sql", "trendGradSql")}${series("rows", "#2b6cb0", "left")}${series("sql", "#38a169", "right")}${xLabels}<text x="${W - 12}" y="14" text-anchor="end" font-size="10" fill="#2b6cb0">— 总行数</text><text x="${W - 90}" y="14" text-anchor="end" font-size="10" fill="#38a169">— SQL 数</text></svg>${alertNote}</div>`;
};

// ---------- 报告骨架：六节标题运行时从模板解析（口径单源） ----------
if (!fs.existsSync(TEMPLATE)) die(`找不到巡检报告模板：${TEMPLATE}`);
const tplHeaders = [...fs.readFileSync(TEMPLATE, "utf8").matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
if (tplHeaders.length < 6) die(`巡检报告模板解析异常：仅 ${tplHeaders.length} 节（期望 报告头+五节）`);
const H = {
  head: tplHeaders[0],
  s1: tplHeaders.find((h) => h.startsWith("一、")),
  s2: tplHeaders.find((h) => h.startsWith("二、")),
  s3: tplHeaders.find((h) => h.startsWith("三、")),
  s4: tplHeaders.find((h) => h.startsWith("四、")),
  s5: tplHeaders.find((h) => h.startsWith("五、")),
};
if (Object.values(H).some((x) => !x)) die(`模板五节解析失败：[${tplHeaders.join(" | ")}]`);

const now = new Date();
const L = [];
L.push(`# SQL 巡检报告（自动骨架）`);
L.push("");
L.push(`> 由 巡检一键.mjs 生成 · ${now.toISOString().replace("T", " ").slice(0, 19)} · 骨架与 outputs/巡检报告模板.md 六节逐字对齐（口径单源）`);
L.push(`> **先审后执行**：本骨架只含机械取证，风险判定 / 调用链 / 优化建议须人工完成后再交付。`);
L.push(`> 建议落盘名：巡检报告_${safeName()}_${now.toISOString().slice(0, 10).replace(/-/g, "")}.md（模板口径 outputs/巡检报告_<项目>_<日期>.md）`);
L.push("");
L.push(`## ${H.head}`);
L.push("");
L.push(`| 项 | 值 |`);
L.push(`|----|----|`);
L.push(`| 项目 | ${opt.project || "待补充"} |`);
L.push(`| 数据库 / 环境 | ${sourcesDesc || "待补充"} |`);
L.push(`| source id | ${opt.source} |`);
L.push(`| 检查时间 | ${now.toISOString().slice(0, 19).replace("T", " ")} |`);
L.push(`| SQL 总数 | ${sqlItems.length} |`);
L.push(`| 风险分布 | 待人工判定（P0：? · P1：? · P2：?，按 references/风险等级定义.md） |`);
L.push("");
// --html 卡片级高亮：diff 环节把「新增/证据变化」的卡片名记进集合，渲染 HTML 时给对应卡片标题上色
// deltaSummary 同时给 HTML 摘要表「vs 上份」一行供数（无 diff 轮为 null，摘要表不出该行）
const deltaHighlight = { added: new Set(), changed: new Set() };
let deltaSummary = null;
if (prevReport) {
  const normz = (s) => String(s).replace(/（\d+ms）/g, "").trim();
  const addedItems = [], removedItems = [], changes = [];
  for (const it of sqlItems) {
    const prev = prevReport.cards.get(it.name);
    if (!prev) { addedItems.push(it.name); deltaHighlight.added.add(it.name); continue; }
    const curEx = normz(it.planError ? `✗ ${it.planError}` : planSummary(it.plan));
    if (curEx !== prev.explain) { changes.push(`${it.name}：EXPLAIN「${prev.explain}」→「${curEx}」`); deltaHighlight.changed.add(it.name); }
    for (const ev of it.tableEvidence ?? []) {
      const pt = prev.tables.get(ev.ref);
      if (pt === undefined) { changes.push(`${it.name}：新增涉及表 ${ev.ref}=${ev.total}`); deltaHighlight.changed.add(it.name); }
      else if (String(pt) !== String(ev.total)) { changes.push(`${it.name}：表 ${ev.ref} 行数 ${pt} → ${ev.total}`); deltaHighlight.changed.add(it.name); }
    }
    for (const [ref] of prev.tables) {
      if (!(it.tableEvidence ?? []).some((e) => e.ref === ref)) changes.push(`${it.name}：不再涉及表 ${ref}`);
    }
  }
  for (const [name] of prevReport.cards) if (!sqlItems.some((i) => i.name === name)) removedItems.push(name);
  const addedChecks = [], removedChecks = [];
  const consistencyChanges = []; // 结构化一致性变化明细（进 delta JSON）
  for (const cc of consistencyChecks) {
    const prev = prevReport.checks.get(cc.name);
    if (!prev) { addedChecks.push(cc.name); continue; }
    const dr = cc.summaryRes ? String(cc.summaryRes.diff_rows) : "?";
    const ta = cc.summaryRes ? String(cc.summaryRes.total_abs_diff) : "?";
    const or = cc.orphanRes ? String(cc.orphanRes.rowCount) : "?";
    if (dr !== prev.diffRows || ta !== prev.totalAbs) {
      changes.push(`${cc.name}：diff_rows ${prev.diffRows} → ${dr}（total_abs_diff ${prev.totalAbs} → ${ta}）`);
      consistencyChanges.push({ name: cc.name, field: "diff_rows/total_abs_diff", from: `${prev.diffRows}/${prev.totalAbs}`, to: `${dr}/${ta}` });
    }
    if (or !== String(prev.orphan)) {
      changes.push(`${cc.name}：孤儿 ${prev.orphan} → ${or}`);
      consistencyChanges.push({ name: cc.name, field: "orphan", from: String(prev.orphan), to: or });
    }
  }
  for (const [name] of prevReport.checks) if (!consistencyChecks.some((c) => c.name === name)) removedChecks.push(name);
  deltaSummary = { addedSql: addedItems.length, removedSql: removedItems.length, addedChecks: addedChecks.length, removedChecks: removedChecks.length, changes: changes.length, vs: prevReport.file, changeDetails: changes, consistencyChanges };
  L.push(`**增量对比（vs ${prevReport.file}）**：`);
  if (addedItems.length) L.push(`- 新增巡检 SQL：${addedItems.join("、")}`);
  if (removedItems.length) L.push(`- 不再巡检：${removedItems.join("、")}`);
  if (addedChecks.length) L.push(`- 新增一致性检查：${addedChecks.join("、")}`);
  if (removedChecks.length) L.push(`- 移除一致性检查：${removedChecks.join("、")}`);
  if (changes.length) { L.push(`- 证据变化：`); for (const c of changes) L.push(`  - ${c}`); }
  if (!addedItems.length && !removedItems.length && !addedChecks.length && !removedChecks.length && !changes.length) {
    L.push(`- 与上份相比无证据变化`);
  }
  L.push("");
}
L.push(`## ${H.s1}`);
L.push("");
L.push(`待人工判定 —— 依据下方各 SQL 卡片的 EXPLAIN 证据（type=ALL/rows 巨大/Using filesort 等信号）对照 references/风险等级定义.md 与 references/sql_risk_signals.md 摘出 Top 问题。`);
L.push("");
L.push(`## ${H.s2}`);
L.push("");
sqlItems.forEach((it, i) => {
  L.push(`### 卡片 ${i + 1}：${it.name}`);
  L.push("");
  L.push(`- **调用链**：${it.chain || `待补充（源文件：${path.relative(process.cwd(), it.file) || it.file}）`}`);
  if (it.note) L.push(`- **业务背景**：${it.note}`);
  L.push(`- **原始 SQL**（已脱敏）：`);
  L.push("");
  L.push("```sql");
  for (const line of maskText(it.sql).split("\n")) L.push(line);
  L.push("```");
  L.push("");
  L.push(`- **八步结论摘要（自动取证）**：`);
  L.push(`  - EXPLAIN：${it.planError ? `✗ ${it.planError}` : planSummary(it.plan)}${it.plan?.duration_ms != null ? `（${it.plan.duration_ms}ms）` : ""}`);
  for (const ev of it.tableEvidence) {
    if (ev.error) L.push(`  - 表 ${ev.ref}：✗ ${ev.error}${ev.hint ? ` —— ${ev.hint}` : ""}`);
    else L.push(`  - 表 ${ev.ref}：count_rows=${ev.total}${ev.countMs != null ? `（${ev.countMs}ms）` : ""}${ev.sample ? ` · 脱敏样例 ${ev.sample.rowCount} 行${ev.sample.truncated ? `（截断单元格 ${ev.sample.truncated}）` : ""}` : ""}${ev.sampleError ? ` · 样例取证失败：${ev.sampleError}` : ""}`);
  }
  L.push(`- **风险等级**：待人工判定（P0/P1/P2）`);
  L.push(`- **优化建议**：待人工（附 EXPLAIN 前后对比验证方式）`);
  L.push("");
});
L.push(`## ${H.s3}`);
L.push("");
const allTables = [...new Map(sqlItems.flatMap((it) => it.tableEvidence).map((ev) => [ev.ref, ev])).values()];
if (allTables.length === 0) L.push("（未从 SQL 清单识别出表 —— 人工补充）");
else {
  L.push(`| 表 | 行数 | 取证 |`);
  L.push(`|----|------|------|`);
  for (const ev of allTables) {
    L.push(`| ${ev.ref} | ${ev.error ? "✗" : ev.total} | ${ev.error ? ev.error + (ev.hint ? "；" + ev.hint : "") : `行数 ${ev.countMs ?? "-"}ms` + (ev.sample ? `；样例 ${ev.sample.rowCount} 行（已脱敏）` : "")}${ev.sampleError ? `；样例失败：${ev.sampleError}` : ""} |`);
  }
  L.push("");
  L.push(`索引命中结论见各 SQL 卡片 EXPLAIN（type=ALL / key=NULL 即全扫，建议补索引需人工结合业务确认）。`);
  L.push(`脏数据 / 异常值 / 缺失值样例（sample_data 实证，已脱敏，每表 ≤ ${opt.sample} 行）：`);
  for (const ev of allTables) {
    if (!ev.sample || !ev.sample.rows.length) continue;
    L.push("");
    L.push(`**${ev.ref}（${ev.sample.rowCount} 行中取 ${ev.sample.rows.length}）**`);
    L.push("");
    L.push(`| ${ev.sample.columns.join(" | ")} |`);
    L.push(`|${ev.sample.columns.map(() => "----").join("|")}|`);
    for (const r of ev.sample.rows) L.push(`| ${ev.sample.columns.map((c) => String(r[c] ?? "")).join(" | ")} |`);
  }
  if (allTables.some((ev) => ev.sample?.truncated)) {
    L.push("");
    L.push(`（有单元格超长被截断——完整值按需以 query 取证，仍只读并脱敏）`);
  }
}
L.push("");
L.push(`## ${H.s4}`);
L.push("");
if (consistencyChecks.length === 0) {
  L.push(`待人工补充 —— 多表状态一致性（订单 vs 流水 vs 库存等）比对 SQL 需按业务口径设计后补进本节（只读）；`);
  L.push(`也可在 manifest 里声明 consistency 项（leftTable/leftKey/leftValue vs rightTable/rightKey/rightValue），本脚本自动生成对账骨架并实测。`);
} else {
  const emitSql = (title, sql) => {
    L.push(`**${title}**（骨架装载期已过审计）：`);
    L.push("");
    L.push("```sql");
    for (const line of sql.split("\n")) L.push(line);
    L.push("```");
    L.push("");
  };
  const emitRows = (res) => {
    if (!res || !res.rows.length) return;
    L.push(`| ${res.columns.join(" | ")} |`);
    L.push(`|${res.columns.map(() => "----").join("|")}|`);
    for (const r of res.rows) L.push(`| ${res.columns.map((c2) => String(r[c2] ?? "")).join(" | ")} |`);
    L.push("");
  };
  for (const cc of consistencyChecks) {
    L.push(`### ${cc.name}`);
    L.push(`- 置信度：${cc.confidence === "high" ? "**高**（字段级直接比对）" : cc.confidence === "medium" ? "中（跨表JOIN，需人工确认 JOIN 条件）" : "低（估算/第三方来源）"}`);
    L.push("");
    emitSql("差异汇总", cc.summary);
    {
      const dr = cc.summaryRes ? Number(cc.summaryRes.diff_rows) : NaN;
      const ta = cc.summaryRes ? String(cc.summaryRes.total_abs_diff) : "?";
      const pct = (cc.leftRows != null && Number.isFinite(dr) && cc.leftRows > 0) ? `（${(dr / cc.leftRows * 100).toFixed(1)}%）` : "";
      L.push(`- 实测：${cc.summaryErr ? `✗ ${cc.summaryErr}` : `diff_rows=${cc.summaryRes?.diff_rows ?? "?"}${pct} · total_abs_diff=${ta}`}`);
      if (!cc.summaryErr && cc.summaryRes) {
        if (cc.leftRows != null && Number.isFinite(dr) && cc.leftRows > 0 && dr >= cc.leftRows) {
          L.push(`- 口径提示：diff_rows（${dr}）≥ 左表行数（${cc.leftRows}）—— **疑口径不一致**（左值与右聚合语义不同级，如订单级金额 vs 明细合计），非逐行数据错误；人工定性后再判级`);
        } else if (Number.isFinite(dr) && dr > 0) {
          L.push(`- 口径提示：部分不一致（${dr}/${cc.leftRows ?? "?"} 行，${(dr / cc.leftRows * 100).toFixed(1)}%）—— 数据级差异候选，人工定性`);
        }
      }
    }
    L.push("");
    emitSql("差异样例（前 20，按 |diff| 降序；右缺按 0 计 → 左有右无也入 diff）", cc.sample);
    L.push(`- 实测：${cc.sampleErr ? `✗ ${cc.sampleErr}` : `命中 ${cc.sampleRes.rowCount} 行（已脱敏）`}`);
    L.push("");
    emitRows(cc.sampleRes);
    emitSql("孤儿检查（只在右表、左表缺行）", cc.orphan);
    L.push(`- 实测：${cc.orphanErr ? `✗ ${cc.orphanErr}` : `孤儿样例 ${cc.orphanRes.rowCount} 行${cc.orphanRes.rowCount ? "（已脱敏）" : " —— 无孤儿"}`}`);
    L.push("");
    emitRows(cc.orphanRes.rowCount ? cc.orphanRes : null);
    L.push(`- **风险等级**：待人工判定（P0/P1/P2，按 references/风险等级定义.md）`);
    L.push("");
  }
  L.push(`口径说明：差异 = 左表逐行值 vs 右表按 key 聚合值（COALESCE 0 计右缺）；孤儿 = 只在右表的 key。骨架由 manifest.consistency 生成（装载期已过写词/多语句/标识符白名单审计），实测结果脱敏后落报告。`);
}
L.push("");
L.push(`## ${H.s5}`);
L.push("");
L.push(`| 优先级 | 动作 | 涉及 SQL / 表 | 预期收益 | 验证方式 |`);
L.push(`|--------|------|---------------|----------|----------|`);
for (const p of ["P0", "P1", "P2"]) L.push(`| ${p} | | | | |`);
L.push("");

fs.writeFileSync(outPath, L.join("\n"), "utf8");
// 基线写回：本轮报告成为下轮 --baseline-dir 自动对比的基线（--diff 显式指定的轮次同样刷新基线）
// 滚动淘汰：每次写回前把旧基线归档为时间戳版本，保留最近 N 份，过期淘汰
if (pendingBaseline) {
  try {
    const keep = opt.baselineKeep || 3;
    const latest = path.join(opt.baselineDir, `baseline_${safeName()}.md`);
    if (fs.existsSync(latest)) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
      const arch = path.join(opt.baselineDir, `baseline_${safeName()}_${stamp}.md`);
      // 生成归档 diff.md：对比上上份归档（本次归档 vs 上上份）
      // 用文件名时间戳降序（字典序）确定新旧，避免 mtime 相同导致排序不稳定
      const allArchs = fs.readdirSync(opt.baselineDir)
        .filter((f) => f.startsWith(`baseline_${safeName()}_`) && f.endsWith(".md") && !f.endsWith("_diff.md") && !f.endsWith("_history.csv"))
        .sort((a, b) => b.localeCompare(a)); // 字典序降序 = 时间戳更新
      const prevArch = allArchs[1]; // second newest = 上上份
      if (prevArch) {
        try {
          const prev = parseGeneratedReport(path.join(opt.baselineDir, prevArch.f));
          const curr = parseGeneratedReport(latest);
          const added = [...curr.cards.keys()].filter((k) => !prev.cards.has(k));
          const removed = [...prev.cards.keys()].filter((k) => !curr.cards.has(k));
          const changed = [...curr.cards.keys()].filter((k) => prev.cards.has(k) && prev.cards.get(k).explain !== curr.cards.get(k).explain);
          const diffLines = ["# 基线对比（上上份）", `对比：${prevArch.f} → ${path.basename(latest)}`, "", `新增卡片（${added.length}）：${added.length ? added.join("、") : "无"}`, `移除卡片（${removed.length}）：${removed.length ? removed.join("、") : "无"}`, `计划变化（${changed.length}）：${changed.length ? changed.join("、") : "无"}`];
          fs.writeFileSync(arch.replace(".md", "_diff.md"), diffLines.join("\n"), "utf8");
        } catch (e) { /* 比对失败不阻塞归档 */ }
      }
      fs.copyFileSync(latest, arch);
      // 滚动淘汰：保留最近 N 份归档（按修改时间升序，过期淘汰）
      const archives = fs.readdirSync(opt.baselineDir)
        .filter((f) => f.startsWith(`baseline_${safeName()}_`) && f.endsWith(".md") && !f.endsWith("_diff.md") && !f.endsWith("_history.csv"))
        .map((f) => ({ f, mtime: fs.statSync(path.join(opt.baselineDir, f)).mtime }))
        .sort((a, b) => a.mtime - b.mtime);
      while (archives.length > keep) {
        const old = archives.shift();
        // 同时淘汰同名 diff.md
        const diffFile = path.join(opt.baselineDir, old.f.replace(".md", "_diff.md"));
        if (fs.existsSync(diffFile)) fs.unlinkSync(diffFile);
        fs.unlinkSync(path.join(opt.baselineDir, old.f));
        console.log(`基线过期淘汰：${old.f}`);
      }
    }
    fs.copyFileSync(outPath, latest);
    console.log(`基线已更新：${latest}`);
    // 历史趋势 CSV：每次更新后追加一行（time, sql_count, total_rows + --trend-cols 自定义列）
    try {
      const histPath = path.join(opt.baselineDir, `baseline_${safeName()}_history.csv`);
      // 解析最新报告
      const cur = parseGeneratedReport(outPath);
      const sqlCount = cur.cards.size;
      const totalRows = [...cur.cards.values()].reduce((s, c) => s + [...c.tables.values()].reduce((t, v) => t + (parseInt(v, 10) || 0), 0), 0);
      // --trend-cols 自定义聚合列：从 sqlItems/consistencyChecks 计算指标值
      const trendColDefs = opt.trendCols
        ? opt.trendCols.split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      const trendMetrics = {
        plan_err: sqlItems.filter((it) => it.planError).length,
        plan_ok: sqlItems.filter((it) => !it.planError).length,
        table_total: sqlItems.reduce((n, it) => n + it.tableEvidence.length, 0),
        table_err: sqlItems.reduce((n, it) => n + it.tableEvidence.filter((ev) => ev.error).length, 0),
        consistency_count: consistencyChecks.length,
        consistency_diff_total: consistencyChecks.reduce((s, cc) => s + (cc.summaryRes ? (parseInt(cc.summaryRes.diff_rows, 10) || 0) : 0), 0),
      };
      for (const col of trendColDefs) {
        if (!(col in trendMetrics)) {
          console.error(`[趋势列] 未知指标：${col}（可用：${Object.keys(trendMetrics).join(", ")}）`);
          process.exit(2);
        }
      }
      const baseHeader = ["time", "sql_count", "total_rows"];
      const header = [...baseHeader, ...trendColDefs].join(",") + "\n";
      const baseRow = [new Date().toISOString().slice(0, 19).replace("T", " "), sqlCount, totalRows];
      const newRow = [...baseRow, ...trendColDefs.map((c) => trendMetrics[c])].join(",") + "\n";
      if (!fs.existsSync(histPath)) {
        fs.writeFileSync(histPath, header + newRow, "utf8");
      } else {
        const prev = fs.readFileSync(histPath, "utf8");
        const lines = prev.trim().split("\n");
        const prevHeader = lines[0];
        if (prevHeader !== header.trim()) {
          // 列数/列名变化：旧数据行按新表头补齐（缺失列填空），整体重写
          const oldCols = prevHeader.split(",");
          const newCols = header.trim().split(",");
          const remapped = lines.slice(1).map((row) => {
            const vals = row.split(",");
            const map = {};
            oldCols.forEach((c, i) => { map[c] = vals[i] ?? ""; });
            return newCols.map((c) => map[c] ?? "").join(",");
          });
          fs.writeFileSync(histPath, header + remapped.join("\n") + "\n", "utf8");
          console.log(`基线历史 CSV 列变更：${prevHeader.trim()} → ${header.trim()}（旧数据已补齐）`);
        } else if (lines[lines.length - 1] !== newRow.trim()) {
          fs.writeFileSync(histPath, prev + newRow, "utf8");
        }
      }
      // 滚动淘汰：CSV 保留最近 N 行数据（不含表头）
      const csvContent = fs.readFileSync(histPath, "utf8");
      const csvLines = csvContent.trim().split("\n");
      const dataRows = csvLines.slice(1);
      if (dataRows.length > keep) {
        const trimmed = [csvLines[0], ...dataRows.slice(-keep)].join("\n") + "\n";
        fs.writeFileSync(histPath, trimmed, "utf8");
        console.log(`基线历史已淘汰${dataRows.length - keep}行（保留最近${keep}行）`);
      }
      console.log(`基线历史已更新：${histPath}`);
    } catch (e) { console.error(`[基线] 历史 CSV 生成失败（不影响基线）：${e.message}`); }
    // --report-index：跨项目仪表盘索引 _index.json（扫目录内全部 baseline_*.md 最新条目）
    try {
      const indexPath = path.join(opt.baselineDir, "_index.json");
      const files = fs.readdirSync(opt.baselineDir)
        .filter((f) => f.startsWith("baseline_") && f.endsWith(".md") && !f.endsWith("_diff.md"));
      // 按项目分组，每组取时间戳最新的（文件名字典序降序 = 最新在前）
      const byProject = {};
      for (const f of files.sort((a, b) => b.localeCompare(a))) {
        const m = f.match(/^baseline_(.+?)_\d{8}-\d{6}\.md$|^baseline_(.+)\.md$/);
        const proj = m?.[1] || m?.[2] || f;
        if (!byProject[proj]) {
          const csvPath = path.join(opt.baselineDir, `baseline_${proj}_history.csv`);
          let histRows = 0;
          if (fs.existsSync(csvPath)) histRows = fs.readFileSync(csvPath, "utf8").trim().split("\n").length - 1;
          byProject[proj] = { project: proj, latestBaseline: f, historyRows: histRows };
        }
      }
      const index = { generatedAt: new Date().toISOString(), projects: Object.values(byProject).sort((a, b) => a.project.localeCompare(b.project)) };
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
      console.log(`基线索引已更新：${indexPath}（${index.projects.length} 个项目）`);
    } catch (e) { console.error(`[基线] 索引生成失败（不影响基线）：${e.message}`); }
  }
  catch (e) { console.error(`[基线] 写回失败（不影响本份报告）：${e.message}`); }
}
// --html：同一报告的静态 HTML 版（风险分布表/增量对比高亮框；产物纪律随 outPath 同守门）
if (opt.html) {
  const htmlPath = outPath.replace(/\.[^.]+$/, "") + ".html"; // 剥离任意扩展名替换为 .html（防 --out xxx.html → xxx.html.html）
  // 从 sqlItems 聚合风险分布（planError=关键信号）+ 表行数证据
  const planErr = sqlItems.filter((it) => it.planError).length;
  const planOk = sqlItems.length - planErr;
  const tableErr = sqlItems.reduce((n, it) => n + it.tableEvidence.filter((ev) => ev.error).length, 0);
  const tableTotal = sqlItems.reduce((n, it) => n + it.tableEvidence.length, 0);
  const riskP0 = planErr + tableErr; // plan 无法生成或表证据失败 → P0
  const riskP1 = 0; // 骨架阶段无人工判定，P0 以下均为 P2 待定
  const riskP2 = (planOk + tableTotal - tableErr) - riskP1;
  // deltaSummary 非空时在摘要表追加「vs 上份」一行（增量轮才出，首轮无基线不出）
  const deltaRow = deltaSummary
    ? `<tr><td>vs 上份（${escHtml(deltaSummary.vs)}）</td><td>新增SQL ${deltaSummary.addedSql} · 移除SQL ${deltaSummary.removedSql} · 新增检查 ${deltaSummary.addedChecks} · 移除检查 ${deltaSummary.removedChecks} · 证据变化 ${deltaSummary.changes}</td></tr>`
    : "";
  const htmlSummary = `\n<!-- report-summary -->\n<div class="rsummary">\n<div class="rsummary-title">📋 报告摘要</div>\n<table class="rsummary-table"><tr><th>项</th><th>值</th></tr>\n<tr><td>项目</td><td>${escHtml(opt.project || "待补充")}</td></tr>\n<tr><td>source id</td><td>${escHtml(opt.source || "待补充")}</td></tr>\n<tr><td>SQL 总数</td><td>${sqlItems.length}</td></tr>\n<tr><td>EXPLAIN 通过</td><td class="ok">✓ ${planOk}</td></tr>\n<tr><td>EXPLAIN 失败</td><td class="err">✗ ${planErr}</td></tr>\n<tr><td>表证据总数</td><td>${tableTotal}</td></tr>\n<tr><td>表证据异常</td><td class="${tableErr ? "err" : "ok"}">${tableErr > 0 ? "✗ " + tableErr : "✓ 0"}</td></tr>\n<tr><td>风险分布</td><td>P0: ${riskP0} · P1: ${riskP1} · P2: ${riskP2}（骨架自动，待人工最终判定）</td></tr>${deltaRow}\n<tr><td>生成时间</td><td>${now.toISOString().replace("T", " ").slice(0, 19)}</td></tr>\n</table>\n</div>\n`;
  // 摘要 HTML 直接注入渲染后的 HTML（不走 markdown 注入，避免 HTML 标签被转义）
  // 趋势图：--baseline-dir 轮读 history.csv（本轮 CSV 已在基线写回阶段更新）内联 SVG，≥2 点才出图
  let trendHtml = "";
  if (opt.baselineDir) {
    try {
      const histPath = path.join(opt.baselineDir, `baseline_${safeName()}_history.csv`);
      if (fs.existsSync(histPath)) trendHtml = renderTrendSvg(fs.readFileSync(histPath, "utf8"), "跨轮趋势（baseline history）");
    } catch (e) { /* 趋势图失败不影响 HTML 主体 */ }
  }
  const rendered = renderHtml(L.join("\n"));
  const inj = rendered.indexOf("<h1>");
  const finalHtml = inj > 0 ? rendered.slice(0, inj) + htmlSummary.trim() + "\n" + trendHtml.trim() + "\n" + rendered.slice(inj) : rendered + htmlSummary.trim() + trendHtml.trim();
  fs.writeFileSync(htmlPath, finalHtml, "utf8");
  console.log(`HTML 版已生成：${htmlPath}`);
}
// --json：结构化输出（机器可读；产物纪律随 outPath 同守门——路径在仓内已由落盘守门拒绝）
if (opt.json) {
  const jsonPath = outPath.replace(/\.[^.]+$/, "") + ".json";
  const planErr = sqlItems.filter((it) => it.planError).length;
  const jsonOut = {
    generator: "巡检一键.mjs",
    version: "v1.4.46",
    generatedAt: now.toISOString(),
    project: opt.project || null,
    source: opt.source || null,
    sqlCount: sqlItems.length,
    summary: {
      planOk: sqlItems.length - planErr,
      planErr,
      tableTotal: sqlItems.reduce((n, it) => n + it.tableEvidence.length, 0),
      tableErr: sqlItems.reduce((n, it) => n + it.tableEvidence.filter((ev) => ev.error).length, 0),
    },
    delta: deltaSummary,
    items: sqlItems.map((it) => ({
      name: it.name,
      chain: it.chain || null,
      note: it.note || null,
      sqlMasked: maskText(it.sql),
      planOk: !it.planError,
      planError: it.planError || null,
      planSummary: it.planError ? null : planSummary(it.plan),
      planDurationMs: it.plan?.duration_ms ?? null,
      tables: it.tableEvidence.map((ev) => ({
        ref: ev.ref,
        total: ev.error ? null : ev.total,
        error: ev.error || null,
      })),
    })),
    consistency: consistencyChecks.map((cc) => ({
      name: cc.name,
      leftTable: cc.leftTable,
      confidence: cc.confidence || null,
      diffRows: cc.summaryRes ? String(cc.summaryRes.diff_rows) : null,
      totalAbsDiff: cc.summaryRes ? String(cc.summaryRes.total_abs_diff) : null,
      orphanRows: cc.orphanRes ? cc.orphanRes.rowCount : null,
    })),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 2) + "\n", "utf8");
  console.log(`JSON 版已生成：${jsonPath}`);
}
console.log(`预审通过：${sqlItems.length} 条 SQL（写词/多语句/空语句 0 命中）`);
for (const it of sqlItems) {
  const ok1 = it.planError ? "EXPLAIN✗" : "EXPLAIN✓";
  const tinfo = it.tableEvidence.map((ev) => `${ev.ref}=${ev.error ? "✗" : ev.total}`).join(" ");
  console.log(`  · ${it.name}: ${ok1} ${tinfo}`);
}
console.log(`报告骨架已生成：${outPath}`);
console.log(`（风险分布/调用链/优化建议留人工 —— 先审后执行；产物在仓外，未进树未进包）`);
