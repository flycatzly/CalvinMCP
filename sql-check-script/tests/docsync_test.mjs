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

// ① 版本标记唯一且 ≥ 20 处（22 处基线；outputs/ 模板不在扫描面）
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

// ⑤ RUN_ALL 汇总行引文含全套件字段（格式漂移在引文层钉住；v1.4.6 起含 config-lint=）
const runAllRe = /RUN_ALL selftest=[^`)\n]*/g;
const quoteOk = (q) => /sqlite-val=/.test(q) && /mysql-val=/.test(q) && /docsync=/.test(q) && /config-lint=/.test(q) && /e2e=/.test(q);
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

console.log(`\n=== docsync: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
