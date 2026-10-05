#!/usr/bin/env node
/**
 * 护栏配置门禁（config-lint）——把 references/ 两份护栏配置的自述校验规则从人工核对变成机器判定。
 *
 * 背景：白名单与脱敏配置.yaml / sql_input_contract.yaml 是技能的安全底座（只在白名单库表取证、
 * 敏感列脱敏、生产库默认禁止），此前无任何机器校验：键被删、列表写空、重复条目、
 * 超集 YAML 语法被当字符串静默吞掉，都要到运行期才暴露。
 *
 * 检查项（18）：
 *   解析 2：两份配置 YAML 子集解析成功（超集语法 fail-closed，不静默误解析）
 *   whitelist 7：必备键 / allowed_databases / allowed_tables / sensitive_columns /
 *                max_result_rows / environment_allowlist 取值合法 / 不含 PROD（生产库默认禁止）
 *   contract 8：必备键（13）/ mode ∈ {check, analysis} / sql 非空 / tables 非空唯一 /
 *               has_explain 布尔 / return_contract 六工具口径键 /
 *               environment ∈ {TEST/PRE/UAT/DEV/PROD}（大小写不敏感）/ environment 命中 environment_allowlist
 *   跨文件 1：契约 tables 全部命中 allowed_tables（跨库「库名.表名」时库 ∈ allowed_databases）——
 *             白名单文件头「校验规则」原文的机器化
 *
 * YAML 子集解析器（零依赖，本仓无 npm 依赖）：
 *   支持：`key: 标量`（裸串/引号串/整数/布尔）、`key: |` 块文本、`key:` + 缩进嵌套（对象/列表）、
 *         `- 标量` 列表项、`#` 注释（含行内）、空行；行内注释只在裸串上剥离（引号串内 ` #` 是内容）。
 *   不支持（显式 FAIL 并给出行号，不静默误解析）：锚点/别名/流式 [a,b] 与 {a:1}、折行 >、标签、多文档 ---。
 *   两份配置由本仓维护，子集即契约；用户写超集语法 = FAIL 并提示支持形态。
 *   模板占位符（<项目根目录> 等）属模板态放行——运行期必填由工作流约束，不在本门禁。
 *
 * 用法：node tests/config_lint_test.mjs
 * 退出码：0 = 全部通过；1 = 存在失败（或配置缺失/解析失败，fail-closed）
 * 汇总行：=== config-lint: P passed, F failed ===
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT = path.join(ROOT, "references", "sql_input_contract.yaml");
const WHITELIST = path.join(ROOT, "references", "白名单与脱敏配置.yaml");

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const summary = () => {
  console.log(`\n=== config-lint: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
};

/* ----------------------------- YAML 子集解析 ------------------------------ */

const stripInlineComment = (s) => {
  const t = s.replace(/\s+#.*$/, "").trim();
  return t.startsWith("#") ? "" : t; // 值位即注释（key:  # x）→ 空值，走嵌套分支
};

// 行内值切分：引号串先找闭合引号（引号内 ` #` 是内容），裸串剥行内注释
function splitValue(v, label, lineNo) {
  const t = v.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0];
    for (let k = 1; k < t.length; k++) {
      if (t[k] !== q) continue;
      if (q === "'" && t[k + 1] === "'") { k++; continue; }
      if (q === '"' && t[k - 1] === "\\") continue;
      return t.slice(0, k + 1);
    }
    throw new Error(`${label} 第 ${lineNo} 行：引号未闭合`);
  }
  return stripInlineComment(t);
}

function parseScalar(v, label, lineNo) {
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0], inner = v.slice(1, -1);
    return q === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner.replace(/''/g, "'");
  }
  if (v === "true" || v === "false") return v === "true";
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/[[\]{}>|*&!%@`]/.test(v) && !/^<[^<>]*>$/.test(v)) {
    // 裸串里出现 YAML 结构字符 = 多半是超集语法（流式/锚点/折行）被当字符串 —— fail-closed
    throw new Error(`${label} 第 ${lineNo} 行：疑似超出 YAML 子集（支持 key: 标量 / key: | 块文本 / - 标量 / # 注释）：${v.slice(0, 40)}`);
  }
  return v;
}

function parseYamlSubset(text, label) {
  const rawLines = text.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, ref: root, kind: "map" }];
  let i = 0;
  while (i < rawLines.length) {
    const raw = rawLines[i], lineNo = i + 1;
    if (!raw.trim() || /^\s*#/.test(raw)) { i++; continue; }
    const indent = raw.match(/^ */)[0].length;
    if (raw[indent] === "\t") throw new Error(`${label} 第 ${lineNo} 行：不支持 Tab 缩进`);
    const body = raw.slice(indent);
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];

    if (body.startsWith("- ") || body === "-") {
      if (top.kind !== "seq") throw new Error(`${label} 第 ${lineNo} 行：列表项不在列表上下文`);
      top.ref.push(parseScalar(splitValue(body.slice(1), label, lineNo), label, lineNo));
      i++; continue;
    }
    const m = body.match(/^([^:]+):(.*)$/); // 不吞冒号后空格——行内注释前的空白要留给 splitValue 判定
    if (!m) throw new Error(`${label} 第 ${lineNo} 行：无法识别（期望 key: value / - 标量 / # 注释）`);
    if (top.kind !== "map") throw new Error(`${label} 第 ${lineNo} 行：键值对不在对象上下文`);
    const key = m[1].trim();
    const val = splitValue(m[2], label, lineNo);

    if (val === "|" || val === "|-" || val === "|+") {
      i++;
      const buf = [];
      let base = null;
      while (i < rawLines.length) {
        const l = rawLines[i];
        if (!l.trim()) { buf.push(""); i++; continue; }
        const ind = l.match(/^ */)[0].length;
        if (ind <= indent) break;
        if (base === null) base = ind;
        buf.push(l.slice(Math.min(base, ind)));
        i++;
      }
      top.ref[key] = buf.join("\n").replace(/\n+$/, "");
      continue;
    }
    if (val === "") {
      let j = i + 1;
      while (j < rawLines.length && (!rawLines[j].trim() || /^\s*#/.test(rawLines[j]))) j++;
      const next = j < rawLines.length ? rawLines[j] : null;
      const nIndent = next ? next.match(/^ */)[0].length : -1;
      const nBody = next ? next.slice(nIndent) : "";
      if (next && nIndent > indent && /^-\s/.test(nBody)) {
        const arr = [];
        top.ref[key] = arr;
        stack.push({ indent, ref: arr, kind: "seq" });
      } else if (next && nIndent > indent) {
        const obj = {};
        top.ref[key] = obj;
        stack.push({ indent, ref: obj, kind: "map" });
      } else {
        top.ref[key] = null;
      }
      i++; continue;
    }
    top.ref[key] = parseScalar(val, label, lineNo);
    i++;
  }
  return root;
}

const isStrList = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x.trim());
const isUnique = (v) => Array.isArray(v) && new Set(v).size === v.length;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/* --------------------------------- 检查 --------------------------------- */

let wl = null, ct = null;
for (const [file, label, into] of [[WHITELIST, "whitelist", "wl"], [CONTRACT, "contract", "ct"]]) {
  let parsed = null, err = "";
  try {
    if (!fs.existsSync(file)) throw new Error("配置文件缺失：" + path.relative(ROOT, file).replace(/\\/g, "/"));
    parsed = parseYamlSubset(fs.readFileSync(file, "utf8"), label);
  } catch (e) { err = e.message; }
  ok(`${label}: YAML 子集解析成功（超集语法 fail-closed）`, !!parsed, err);
  if (into === "wl") wl = parsed; else ct = parsed;
}
if (!wl || !ct) summary(); // 解析失败 = fail-closed，后续结构检查无意义

// whitelist（7）
const WL_KEYS = ["allowed_databases", "allowed_tables", "sensitive_columns", "max_result_rows", "environment_allowlist"];
ok("whitelist: 必备键齐全（allowed_databases/allowed_tables/sensitive_columns/max_result_rows/environment_allowlist）",
  WL_KEYS.every((k) => k in wl), "缺失：" + WL_KEYS.filter((k) => !(k in wl)).join(","));
ok("whitelist: allowed_databases 非空唯一字符串列表",
  isStrList(wl.allowed_databases) && isUnique(wl.allowed_databases),
  JSON.stringify(wl.allowed_databases));
ok("whitelist: allowed_tables 非空唯一字符串列表",
  isStrList(wl.allowed_tables) && isUnique(wl.allowed_tables),
  JSON.stringify(wl.allowed_tables));
ok("whitelist: sensitive_columns 非空字典且键值均非空",
  isObj(wl.sensitive_columns) && Object.keys(wl.sensitive_columns).length > 0 &&
  Object.entries(wl.sensitive_columns).every(([k, v]) => k.trim() && typeof v === "string" && v.trim()),
  JSON.stringify(wl.sensitive_columns));
ok("whitelist: max_result_rows 正整数",
  Number.isInteger(wl.max_result_rows) && wl.max_result_rows > 0, String(wl.max_result_rows));
const ENV_TOKENS = new Set(["TEST", "PRE", "UAT", "DEV", "PROD"]);
const envNorm = (x) => String(x).trim().toUpperCase();
ok("whitelist: environment_allowlist 非空且取值合法（TEST/PRE/UAT/DEV/PROD，大小写不敏感）",
  isStrList(wl.environment_allowlist) && wl.environment_allowlist.every((x) => ENV_TOKENS.has(envNorm(x))),
  JSON.stringify(wl.environment_allowlist));
ok("whitelist: environment_allowlist 不含 PROD（生产库默认禁止）",
  Array.isArray(wl.environment_allowlist) && wl.environment_allowlist.every((x) => envNorm(x) !== "PROD"),
  JSON.stringify(wl.environment_allowlist));

// contract（6）
const CT_KEYS = ["mode", "project_path", "datasource", "environment", "source", "sql", "tables",
  "business_scene", "data_volume", "api_name", "symptom", "has_explain", "return_contract"];
ok("contract: 必备键齐全（mode/project_path/datasource/environment/source/sql/tables 等 13 键）",
  CT_KEYS.every((k) => k in ct), "缺失：" + CT_KEYS.filter((k) => !(k in ct)).join(","));
ok("contract: mode ∈ {check, analysis}", ct.mode === "check" || ct.mode === "analysis", String(ct.mode));
ok("contract: sql 非空", typeof ct.sql === "string" && ct.sql.trim().length > 0);
ok("contract: tables 非空唯一字符串列表", isStrList(ct.tables) && isUnique(ct.tables), JSON.stringify(ct.tables));
ok("contract: has_explain 为布尔值", typeof ct.has_explain === "boolean", String(ct.has_explain));
// environment 口径（v1.4.10 收口三轮挂账）：枚举取值 + 跨文件一致性双层——
// 模板曾以 production 作示例，与自身注释枚举 TEST/PRE/UAT/DEV/PROD 及白名单禁 PROD 双重矛盾；
// 归一为枚举值后，生产禁令经「environment_allowlist 不含 PROD」+「environment ∈ allowlist」两层机器化。
ok("contract: environment ∈ {TEST/PRE/UAT/DEV/PROD}（大小写不敏感）",
  ENV_TOKENS.has(envNorm(ct.environment ?? "")), String(ct.environment));
ok("contract↔whitelist: environment 命中 environment_allowlist（PROD 默认禁止机器化）",
  isStrList(wl.environment_allowlist) && wl.environment_allowlist.some((x) => envNorm(x) === envNorm(ct.environment ?? "")),
  `environment=${JSON.stringify(ct.environment)} allowlist=${JSON.stringify(wl.environment_allowlist)}`);
const RC_KEYS = ["query", "count_rows", "distinct_values", "find_database", "list_tables", "describe_table"];
ok("contract: return_contract 六工具口径键齐全（query/count_rows/distinct_values/find_database/list_tables/describe_table）",
  isObj(ct.return_contract) && RC_KEYS.every((k) => isObj(ct.return_contract[k]) && Object.keys(ct.return_contract[k]).length > 0),
  "缺失/空：" + RC_KEYS.filter((k) => !(isObj(ct.return_contract?.[k]) && Object.keys(ct.return_contract?.[k] || {}).length > 0)).join(","));

// 跨文件（1）—— 白名单文件头「校验规则」原文：每个表名必须命中 allowed_tables；
// 跨库「库名.表名」时库也必须在 allowed_databases 内。
const bad = (ct.tables || []).filter((t) => {
  const s = String(t);
  const dot = s.indexOf(".");
  if (dot === -1) return !(wl.allowed_tables || []).includes(s);
  const db = s.slice(0, dot), tbl = s.slice(dot + 1);
  return !(wl.allowed_databases || []).includes(db) || !(wl.allowed_tables || []).includes(tbl);
});
ok("contract↔whitelist: tables 全部命中 allowed_tables（跨库「库名.表名」时库 ∈ allowed_databases）",
  bad.length === 0, "越界：" + bad.join(","));

summary();
