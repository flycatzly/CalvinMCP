#!/usr/bin/env node
/**
 * 文档一致性门禁（docsync）——把 README「版本与文档同步规范」从手工纪律变成机器判定。
 *
 * 发版时漏改一处文档（版本标记行、用例数口径、RUN_ALL 汇总行引文）肉眼难察，
 * 历史上已两次靠人工 grep 才逮到残留（验收清单旧 passed 数、汇总行格式漂移）。
 * 本套件纯 fs 检查、秒级完成，纳入 run_all 常跑。
 *
 * 检查项：
 *   1. 全量版本标记（「> 版本 vX.Y.Z ·」/「# 版本 vX.Y.Z ·」）唯一，且 ≥ 20 处
 *   2. 标记行版本 == README「更新记录」首条版本（版本说明唯一落点对齐）
 *   3. E2E 数字口径唯一：所有「N passed, 0 failed`（[全链路 E2E：]M 核心」提法的 (N,M) 相同
 *   4. 「（N 用例」提法 N == 全量口径 N；「M 项核心 / 核心 M 项」== 核心口径 M（更新记录历史段除外）
 *   5. 所有 RUN_ALL 汇总行引文含全套件字段（selftest= / sqlite-val= / mysql-val= / docsync= / e2e=）
 *   6. RUN_ALL 引文对方侧字段（selftest= / sqlite-val= / mysql-val=）用占位形态，不写死具体数字——
 *      对方侧套件随版本增长（selftest 硬数字曾一天三跳 284→290→292），写死即漂移源（v1.4.12 降敏）
 *   7. 目录树声明条目全部在盘（树→盘，README/SKILL.md 双树）——丢文件直查
 *      （2026-10-05 示例×2 + SQL 样例×3 丢失曾仅靠标记数 19/21 间接暴露，此门直查本体）
 *   8. 仓内文件全部被目录树收录（盘→树，双树同口径）——新增文件防漏记
 *   9. 文档反引号文件引用全部可解析（占位/裸扩展名/命令行形态豁免；README 历史段除外；
 *      对侧仓入口 install.mjs/selftest.mjs 按显式名单放行——部署态无同级目录时检查不失效）
 *  10. 示例结构合规（口径单源）：示例 A/B 标题按序对齐格式文档/模板解析出的标题——口径从格式文档取，不在测试里硬编码
 *  11. 格式/模板骨架保全：检测格式 8 项清单 / 分析模板 6 节 / 巡检模板 报告头+五节 全在且有序
 *  12. 工作流↔输出口径一致：模式 A Step 1-8 对齐格式 8 项（前缀归一）；模式 B Step 数 == 模板节数
 *  13. 巡检示例结构对齐模板（口径单源）：巡检示例六头按序逐字对齐巡检模板解析结果
 *      （报告头+五节）+ 敏感列脱敏口径 + 风险分布行 + 标记行首
 *  14. 自动骨架产物防混入：巡检一键.mjs 生成的报告骨架不得被搬进仓（运行产物不进树不进包；
 *      仓内 md/yaml 命中生成标记行即 FAIL——真示例须按模板手工编写，介绍性提法不含标记行不误伤）
 *
 * 用法：node tests/docsync_test.mjs
 * 退出码：0 = 全部一致；1 = 存在漂移（FAIL 行给出具体位置）
 * 汇总行：=== docsync: P passed, F failed ===
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const SKIP_DIRS = new Set(["node_modules"]);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    if (e.isDirectory()) walk(path.join(d, e.name));
    else if (/\.(md|yaml)$/.test(e.name)) files.push(path.join(d, e.name));
  }
})(ROOT);

/** 去掉 README「更新记录」历史段——历史条目允许出现旧版本号与旧数字，不参与一致性判定 */
const stripHistory = (txt) => txt.split(/^## 更新记录/m)[0];

// ① 版本标记唯一且 ≥ 20 处（门槛固定；处数随文档增减浮动，以实测 detail 为准）
const markerRe = /^[>#] 版本 v(\d+\.\d+\.\d+) ·/gm;
const markers = [];
for (const f of files) {
  const txt = fs.readFileSync(f, "utf8");
  for (const m of txt.matchAll(markerRe)) markers.push({ file: path.relative(ROOT, f).replace(/\\/g, "/"), v: m[1] });
}
const uniqVersions = [...new Set(markers.map((m) => m.v))];
ok("版本标记全量唯一且 ≥ 20 处",
  markers.length >= 20 && uniqVersions.length === 1,
  `实测 ${markers.length} 处、版本集 [${uniqVersions.join(",")}]`);

// ② 标记行版本 == 更新记录首条版本
const readmeRaw = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const latest = readmeRaw.match(/^- \*\*v(\d+\.\d+\.\d+)\*\*：/m)?.[1];
ok("更新记录首条版本与标记行一致",
  !!latest && uniqVersions.length === 1 && uniqVersions[0] === latest,
  `标记=${uniqVersions.join(",")} / 更新记录首条=${latest}`);

// ③ E2E 数字口径唯一：(N passed, 0 failed`（[全链路 E2E：]M 核心) 全文一致
const tupleRe = /(\d+) passed, 0 failed`（(?:全链路 E2E：)?(\d+) 核心/g;
const tuples = [];
for (const f of files) {
  const txt = stripHistory(fs.readFileSync(f, "utf8"));
  for (const m of txt.matchAll(tupleRe)) tuples.push({ file: path.relative(ROOT, f).replace(/\\/g, "/"), n: m[1], core: m[2] });
}
const uniqTuples = [...new Set(tuples.map((t) => `${t.n}/${t.core}`))];
ok("E2E 口径「N passed`（M 核心」提法唯一",
  tuples.length >= 2 && uniqTuples.length === 1,
  `实测 ${tuples.length} 处、口径集 [${uniqTuples.join(",")}]（${tuples.map((t) => t.file).join("、")}）`);
const total = tuples[0]?.n, core = tuples[0]?.core;

// ④ 「（N 用例」= 全量 N；「M 项核心 / 核心 M 项」= 核心 M
const caseRe = /（(\d+) 用例/g;
const coreRe = /(\d+) 项核心|核心 (\d+) 项/g;
const cases = [], cores = [];
for (const f of files) {
  const txt = stripHistory(fs.readFileSync(f, "utf8"));
  for (const m of txt.matchAll(caseRe)) cases.push({ file: path.relative(ROOT, f).replace(/\\/g, "/"), n: m[1] });
  for (const m of txt.matchAll(coreRe)) cores.push({ file: path.relative(ROOT, f).replace(/\\/g, "/"), n: m[1] ?? m[2] });
}
ok("「（N 用例」提法与全量口径一致",
  cases.length >= 2 && !!total && cases.every((c) => c.n === total),
  `提法 [${cases.map((c) => `${c.file}:${c.n}`).join(", ")}] vs 全量 ${total}`);
ok("「N 项核心 / 核心 N 项」提法与核心口径一致",
  cores.length >= 1 && !!core && cores.every((c) => c.n === core),
  `提法 [${cores.map((c) => `${c.file}:${c.n}`).join(", ")}] vs 核心 ${core}`);

// ⑤ RUN_ALL 汇总行引文含全套件字段（格式漂移在引文层钉住；v1.4.6 起含 config-lint=，v1.4.33 起含 inspect=）
const runAllRe = /RUN_ALL selftest=[^`)\n]*/g;
const quoteOk = (q) => /sqlite-val=/.test(q) && /mysql-val=/.test(q) && /docsync=/.test(q) && /config-lint=/.test(q) && /inspect=/.test(q) && /e2e=/.test(q);
const quotes = [];
for (const f of files) {
  const txt = stripHistory(fs.readFileSync(f, "utf8"));
  for (const m of txt.matchAll(runAllRe)) quotes.push({ file: path.relative(ROOT, f).replace(/\\/g, "/"), q: m[0] });
}
ok("RUN_ALL 汇总行引文含全套件字段（sqlite-val=/mysql-val=/docsync=/config-lint=/e2e=）",
  quotes.length >= 2 && quotes.every((x) => quoteOk(x.q)),
  `实测 ${quotes.length} 处、问题引文 [${quotes.filter((x) => !quoteOk(x.q)).map((x) => x.file).join(", ")}]`);

// ⑥ 引文对方侧数值字段用占位，不写死具体数字（防随对方滚版漂移；off/=0 等非数字值合法）
const digitRe = /(selftest|sqlite-val|mysql-val)=\d/;
const digitQuotes = quotes.filter((x) => digitRe.test(x.q));
ok("RUN_ALL 引文对方侧字段不写死数字（selftest=/sqlite-val=/mysql-val= 用占位，防漂移）",
  digitQuotes.length === 0,
  `问题引文 [${digitQuotes.map((x) => x.file).join(", ")}]`);

// ===== 包完整性与示例结构门禁（v1.4.29 新增 ⑦～⑩） =====

/** 树块解析：├──/└── 后整行取名（剥 2+ 空格尾注），目录行设路径前缀 */
const parseTree = (block) => {
  const items = [];
  let prefix = "";
  for (const line of block.split("\n")) {
    const m = line.match(/[├└]── (.+)$/);
    if (!m) continue;
    const name = m[1].replace(/\s{2,}#.*$/, "").trim();
    if (name.endsWith("/")) { prefix = name; items.push({ p: name, isDir: true }); }
    else items.push({ p: prefix + name, isDir: false });
  }
  return items;
};
const treeDocs = ["SKILL.md", "README.md"].map((f) => ({
  f,
  items: parseTree(fs.readFileSync(path.join(ROOT, f), "utf8").match(/## 目录结构\n\n```\n([\s\S]*?)```/)?.[1] ?? ""),
}));

// ⑦ 树→盘：目录树声明的条目全部在盘（丢文件直查；树块缺失/过短同样 FAIL 防空过）
const missingTree = treeDocs.flatMap(({ f, items }) =>
  items.filter((it) => !fs.existsSync(path.join(ROOT, it.p))).map((it) => `${f}:${it.p}`));
ok("目录树声明条目全部在盘（树→盘，双树直查丢文件）",
  treeDocs.every((t) => t.items.length >= 20) && missingTree.length === 0,
  `缺失 [${missingTree.join(", ")}]（树规模 ${treeDocs.map((t) => `${t.f}:${t.items.length}`).join("、")}）`);

// ⑧ 盘→树：仓内文件全部被目录树收录（新增文件防漏记）
const diskAll = [];
(function walkAll(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".") || e.name === "dist") continue;
    if (e.isDirectory()) walkAll(path.join(d, e.name));
    else diskAll.push(path.relative(ROOT, path.join(d, e.name)).replace(/\\/g, "/"));
  }
})(ROOT);
const unlisted = treeDocs.flatMap(({ f, items }) => {
  const set = new Set(items.filter((it) => !it.isDir).map((it) => it.p));
  return diskAll.filter((d) => !set.has(d)).map((d) => `${f}:${d}`);
});
ok("仓内文件全部被目录树收录（盘→树，新增防漏记）",
  unlisted.length === 0,
  `盘 ${diskAll.length} 文件、树外 [${unlisted.join(", ")}]`);

// ⑨ 交叉引用完整性：反引号文件引用全部可解析（防引用悬空；对方仓入口 install.mjs/selftest.mjs 经同级目录解析）
//    部署态决策（v1.4.31）：包单独部署时无同级 calvin-db-mcp 目录，对侧入口按显式名单放行；
//    名单只收对侧仓入口本体（install.mjs/selftest.mjs），其余引用仍须可解析——不整段降级、不按环境放松
const sibling = path.join(ROOT, "..", "calvin-db-mcp");
const EXTERNAL_ENTRIES = new Set(["install.mjs", "selftest.mjs"]);
const findByName = (dir, base, depth = 0) => {
  if (depth > 3 || !fs.existsSync(dir)) return false;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    if (e.isFile() && e.name === base) return true;
    if (e.isDirectory() && findByName(path.join(dir, e.name), base, depth + 1)) return true;
  }
  return false;
};
const refResolves = (ref) => {
  const clean = ref.replace(/^\.\//, "");
  const cands = ["", "outputs", "references", "workflows", "tests", "assets/sample_sql", "assets"]
    .map((d) => path.join(ROOT, d, clean));
  return cands.some((c) => fs.existsSync(c))
    || findByName(ROOT, path.basename(clean))
    || findByName(sibling, path.basename(clean))
    || EXTERNAL_ENTRIES.has(path.basename(clean));
};
const refRe = /`([^`\n]*?\.(?:md|yaml|sql|mjs))`/g;
const badRefs = [];
let refCount = 0;
for (const f of files) {
  const txt = stripHistory(fs.readFileSync(f, "utf8"));
  for (const m of txt.matchAll(refRe)) {
    let ref = m[1];
    if (/[<*?#]/.test(ref)) continue;                    // 通配/占位路径（如 <项目>_<日期>）
    if (/^\.(md|yaml|sql|mjs)$/.test(ref)) continue;     // 裸扩展名提法
    ref = ref.replace(/^(?:node|npx|npm|git)\s+/i, "");  // 命令行形态剥命令词
    refCount++;
    if (!refResolves(ref)) badRefs.push(`${path.relative(ROOT, f).replace(/\\/g, "/")} → ${m[1]}`);
  }
}
ok("文档反引号文件引用全部可解析", badRefs.length === 0,
  `共 ${refCount} 处、悬空 [${badRefs.join("; ")}]`);

// ===== ⑩～⑫ 口径单源门禁（v1.4.30）：口径从格式/模板文档解析，测试不硬编码；示例/格式/模板/工作流四方对齐 =====
const secNums = (txt) => [...txt.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
const seqOk = (ord, n) => ord.length === n && ord.every((v, i) => v === i + 1);
const looseEq = (a, b) => {
  const strip = (s) => s.replace(/（[^）]*）/g, "").trim();
  const [x, y] = [strip(a), strip(b)];
  return x === y || x.startsWith(y) || y.startsWith(x);
};

// 口径源：检测格式 8 项清单（「## 必须按顺序输出 N 个小节」下编号清单）/ 分析模板 6 节 / 巡检模板骨架
const fmtA = fs.readFileSync(path.join(ROOT, "outputs/SQL 检测输出格式.md"), "utf8");
const listRegion = fmtA.match(/## 必须按顺序输出 \d+ 个小节\n\n([\s\S]*?)\n\n## /)?.[1] ?? "";
const fmtItems = [...listRegion.matchAll(/^(\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), t: m[2].trim() }));
const tplB = fs.readFileSync(path.join(ROOT, "outputs/分析报告模板.md"), "utf8");
const tplBSecs = [...tplB.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), t: m[2].trim() }));
const tplIns = fs.readFileSync(path.join(ROOT, "outputs/巡检报告模板.md"), "utf8");
const insHeaders = [...tplIns.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());

const exAPath = path.join(ROOT, "outputs/示例_订单列表慢查询.md");
const exBPath = path.join(ROOT, "outputs/示例_状态分布分析.md");
const exA = fs.existsSync(exAPath) ? fs.readFileSync(exAPath, "utf8") : "";
const exB = fs.existsSync(exBPath) ? fs.readFileSync(exBPath, "utf8") : "";
const exASecs = [...exA.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), t: m[2].trim() }));
const exBSecs = [...exB.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => ({ n: Number(m[1]), t: m[2].trim() }));

// ⑩ 示例结构合规（口径单源：标题按序对齐格式/模板解析结果 + 证据①～⑧ + 敏感列口径 + 标记行首形态）
const aAligned = exASecs.length === fmtItems.length && exASecs.every((s, i) => looseEq(s.t, fmtItems[i].t))
  && seqOk(exASecs.map((s) => s.n), 8);
const bAligned = exBSecs.length === tplBSecs.length && exBSecs.every((s, i) => s.t === tplBSecs[i].t)
  && seqOk(exBSecs.map((s) => s.n), 6);
const markerOk = (t) => /^> 版本 v\d+\.\d+\.\d+ ·/m.test(t);
const phraseOk = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"].every((c) => exA.includes(`证据${c}`))
  && exB.includes("本查询未涉及敏感列") && exB.includes("无敏感字段");
ok("示例结构合规（口径单源：A/B 标题按序对齐格式/模板 + 证据①～⑧ + 敏感列口径 + 标记行首）",
  aAligned && bAligned && phraseOk && markerOk(exA) && markerOk(exB),
  `A对齐=${aAligned} B对齐=${bAligned} 短语=${phraseOk} 标记 A${markerOk(exA)} B${markerOk(exB)}（A 实测 [${exASecs.map((s) => s.t).join(" | ")}]）`);

// ⑪ 格式/模板骨架保全（口径源本体不能被静默改小/删节）
const fmtSeqOk = fmtItems.length === 8 && fmtItems.every((it, i) => it.n === i + 1);
const tplSeqOk = tplBSecs.length === 6 && tplBSecs.every((it, i) => it.n === i + 1);
const insOk = insHeaders.includes("报告头") && ["一", "二", "三", "四", "五"].every((c) =>
  insHeaders.some((h) => h.startsWith(`${c}、`)));
ok("格式/模板骨架保全（检测格式 8 项清单 / 分析模板 6 节 / 巡检模板 报告头+五节）",
  fmtSeqOk && tplSeqOk && insOk,
  `格式清单 [${fmtItems.map((it) => it.n + "." + it.t).join(" | ")}] / 分析模板节 ${tplBSecs.length} / 巡检头 [${insHeaders.join(" | ")}]`);

// ⑫ 工作流↔输出口径一致（模式 A 步骤标题对齐格式 8 项；模式 B 步数 == 模板节数）
const wfA = fs.readFileSync(path.join(ROOT, "workflows/sql_check_workflow.md"), "utf8");
const wfASteps = [...wfA.matchAll(/^## Step (\d+) (.+)$/gm)].filter((m) => Number(m[1]) >= 1);
const wfAAligned = wfASteps.length === 8 && wfASteps.every((m, i) => looseEq(m[2], fmtItems[i]?.t ?? ""));
const wfB = fs.readFileSync(path.join(ROOT, "workflows/02_数据分析工作流.md"), "utf8");
const wfBCount = [...wfB.matchAll(/^## Step (\d+) /gm)].length;
ok("工作流↔输出口径一致（模式 A Step 1-8 对齐格式 8 项；模式 B Step 数 == 模板 6 节）",
  wfAAligned && wfBCount === 6 && tplBSecs.length === 6,
  `模式 A 对齐=${wfAAligned}（实测 [${wfASteps.map((m) => m[2]).join(" | ")}]）/ 模式 B Step 数=${wfBCount} vs 模板 ${tplBSecs.length}`);

// ⑬ 巡检示例结构对齐模板（口径单源：六头按序逐字对齐模板解析结果 + 敏感列脱敏 + 风险分布行 + 标记行首）
const exInsPath = path.join(ROOT, "outputs/示例_巡检报告.md");
const exIns = fs.existsSync(exInsPath) ? fs.readFileSync(exInsPath, "utf8") : "";
const exInsHeaders = [...exIns.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
const insAligned = exInsHeaders.length === insHeaders.length
  && exInsHeaders.every((h, i) => h === insHeaders[i]);
const insPhraseOk = exIns.includes("脱敏") && exIns.includes("敏感") && exIns.includes("风险分布");
ok("巡检示例结构对齐模板（口径单源：六头按序逐字 + 敏感列脱敏 + 风险分布行 + 标记行首）",
  insAligned && insPhraseOk && markerOk(exIns),
  `模板头 [${insHeaders.join(" | ")}] / 示例头 [${exInsHeaders.join(" | ")}] 短语=${insPhraseOk} 标记=${markerOk(exIns)}`);

// ⑭ 自动骨架产物防混入（运行产物不进树不进包；真示例须按模板手工编写——
//    ⑬ 只管示例结构对齐，不构成生成物豁免）。介绍性提法（如「可用 巡检一键.mjs 自动化」）
//    不含标记行形态，不会误伤；若未来工具名改名，此处标记正则随 巡检一键.mjs 同步。
const GEN_MARK = /由 巡检一键\.mjs 生成/;
const genHits = [];
for (const f of files) {
  if (GEN_MARK.test(fs.readFileSync(f, "utf8"))) genHits.push(path.relative(ROOT, f).replace(/\\/g, "/"));
}
ok("自动骨架产物未混入仓（生成标记行零命中）", genHits.length === 0,
  `命中 [${genHits.join(", ")}] —— 巡检一键产物应留在仓外（--out 指仓外路径）；确需示例请按模板手工重写`);

console.log(`\n=== docsync: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
