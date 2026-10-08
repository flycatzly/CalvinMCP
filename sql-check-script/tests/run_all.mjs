#!/usr/bin/env node
/**
 * 一键全量验收：calvin-db-mcp selftest → sqlite-validate → mysql-validate → docsync → config-lint → 全链路 E2E（合并裁决，机器可读汇总行）
 *
 * 用法：node tests/run_all.mjs [mcpDir]
 *   mcpDir 默认 <本仓库>/../calvin-db-mcp/mcp（可用 DBMCP_MCP_DIR 覆盖）
 * 套件构成与门控（v1.4.4 起）：
 *   selftest        263+ 用例（只读守卫/写守卫/LIMIT/协议/握手）—— 总是跑
 *   sqlite-validate 全工具面活库验证（自建临时库 + 最高权限，含 execute/create_table 真写链路）—— 总是跑
 *   mysql-validate  真实 MySQL 全工具面（自建临时库 dbmcp_probe_hist 自删，需 CREATE DATABASE 权限）——
 *                   FULLCHAIN_MYSQL=1 才跑（重套件，最小权限账号跑不了，故不自动）；无 mysql 源时退出码 3 诚实 SKIP
 *   docsync         文档一致性门禁（版本标记 / 用例数口径 / RUN_ALL 汇总行引文 / 目录树双向完整性 / 引用完整性 / 示例结构 / 格式模板骨架 / 工作流口径 / 巡检示例对齐）—— 总是跑，纯 fs 秒级
 *   config-lint     护栏配置门禁（references/ 两份配置：YAML 子集解析 fail-closed / 结构键类型 /
 *                   白名单红线 / 契约↔白名单跨文件一致性）—— 总是跑，纯 fs 秒级
 *   inspect-one     巡检一键 CLI 门禁（预审四门/落盘守门/manifest 门/consistency 门/参数面）——
 *                   总是跑，免 DB 秒级（v1.4.33 起）
 *   全链路 E2E      fixture 隔离副本 + live 段自动门控（FULLCHAIN_MYSQL/PG：未设自动发现、=1 强开、=0 关）
 * live 段随环境变量门控（与 fullchain_test.mjs 同口径）：
 *   FULLCHAIN_MYSQL=1 / FULLCHAIN_PG=1 时 E2E 含对应真实源只读段。
 *
 * 退出码（统一诚实 SKIP 口径，与 mysql-validate 退出码 3 同义）：
 *   0 = 全部通过且无诚实 SKIP；1 = 存在失败或套件无法运行；3 = 无失败但有诚实 SKIP
 *   （缺 fixture / 开了 live 门却没源 / 缺依赖起不来）—— 未跑的部分明示出来，不冒充全绿。
 * 汇总行：RUN_ALL selftest=<p>/<f>[/<s>] sqlite-val=<p>/<f> mysql-val=<p>/<f>[/<s>|off] docsync=<p>/<f> config-lint=<p>/<f> inspect=<p>/<f> e2e=<p>/<f>[/<s>] gates=<...> => OK|SKIP|FAIL
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = process.argv[2] || process.env.DBMCP_MCP_DIR || path.resolve(here, "..", "..", "calvin-db-mcp", "mcp");
const SELFTEST = path.join(MCP_DIR, "selftest.mjs");
const SQLITE_VAL = path.join(MCP_DIR, "sqlite-validate.mjs");
const MYSQL_VAL = path.join(MCP_DIR, "mysql-validate.mjs");
const DOCSYNC = path.join(here, "docsync_test.mjs");
const CFG_LINT = path.join(here, "config_lint_test.mjs");
const INSPECT = path.join(here, "inspect_one_test.mjs");
const E2E = path.join(here, "fullchain_test.mjs");

const gates = [];
if (process.env.FULLCHAIN_MYSQL === "1") gates.push("FULLCHAIN_MYSQL");
if (process.env.FULLCHAIN_PG === "1") gates.push("FULLCHAIN_PG");

function run(title, args, opts = {}) {
  console.log(`\n---- ${title} ----`);
  const r = spawnSync(process.execPath, args, { encoding: "utf8", ...opts });
  process.stdout.write(r.stdout || "");
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}
// 同一判定两种计数来源：selftest 与 E2E 各自的机器可读汇总行（第三组 = 诚实 SKIP，旧格式缺省 0）
const pick = (text, re) => {
  const m = text.match(re);
  return m ? [m[1], m[2], m[3] ?? "0"] : ["-", "-", "-"];
};

let sP = "-", sF = "-", sS = "-", svP = "-", svF = "-", mvP = "-", mvF = "-", mvS = "-", dP = "-", dF = "-", cP = "-", cF = "-", iP = "-", iF = "-", eP = "-", eF = "-", eS = "-";
let failedAny = false, skippedAny = false;

// 子套件退出码口径：1（或其它非 0/3）= 失败；3 = 无失败但有诚实 SKIP；0 = 全绿
const noteStatus = (label, status) => {
  if (status === 3) { skippedAny = true; console.log(`（${label}：退出码 3 —— 无失败但有诚实 SKIP，不冒充全绿）`); }
  else if (status !== 0) { failedAny = true; }
};

if (!fs.existsSync(SELFTEST)) {
  console.error("✗ 未找到 selftest：" + SELFTEST);
  failedAny = true;
} else {
  const r = run("calvin-db-mcp selftest", [SELFTEST], { cwd: MCP_DIR });
  [sP, sF, sS] = pick((r.stdout || "") + (r.stderr || ""), /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/);
  noteStatus("selftest", r.status);
}

// sqlite-validate：全工具面活库验证（自建临时 sqlite 库 + 最高权限，含 execute/create_table 真写链路）
// —— selftest 不碰的写链路验收面由它补上；零外部依赖、总是跑。
if (!fs.existsSync(SQLITE_VAL)) {
  console.error("✗ 未找到 sqlite-validate：" + SQLITE_VAL);
  failedAny = true;
} else {
  const r = run("calvin-db-mcp sqlite-validate（全工具面活库）", [SQLITE_VAL], { cwd: MCP_DIR });
  [svP, svF] = pick((r.stdout || "") + (r.stderr || ""), /=== sqlite-validate: (\d+) passed, (\d+) failed ===/);
  noteStatus("sqlite-validate", r.status);
}

// mysql-validate：真实 MySQL 全工具面（自建临时库自删，需 CREATE DATABASE 权限）——
// 最小权限账号跑不了，故仅 FULLCHAIN_MYSQL=1 显式开启；无 mysql 源时退出码 3 诚实 SKIP。
if (process.env.FULLCHAIN_MYSQL === "1") {
  if (!fs.existsSync(MYSQL_VAL)) {
    console.error("✗ 未找到 mysql-validate：" + MYSQL_VAL);
    failedAny = true;
  } else {
    const r = run("calvin-db-mcp mysql-validate（真实 MySQL 全工具面）", [MYSQL_VAL], { cwd: MCP_DIR });
    [mvP, mvF, mvS] = pick((r.stdout || "") + (r.stderr || ""), /=== mysql-validate: (\d+) passed, (\d+) failed(?:, (\d+) skipped)? ===/);
    noteStatus("mysql-validate", r.status);
  }
} else {
  // 未开门 = 设计默认（重套件不自动跑），不计诚实 SKIP、不翻裁决 —— 与 E2E live 段未命中的口径一致
  console.log("\n---- calvin-db-mcp mysql-validate（真实 MySQL 全工具面） ----");
  console.log("SKIP mysql-validate（重套件：自建临时库需 CREATE DATABASE 权限，不自动跑；设 FULLCHAIN_MYSQL=1 启用）");
  mvP = "off";
}

// docsync：文档一致性门禁（版本标记 / 用例数口径 / RUN_ALL 汇总行引文 / 目录树双向完整性 / 引用完整性 / 示例结构）——纯 fs 秒级，先跑早报
if (!fs.existsSync(DOCSYNC)) {
  console.error("✗ 未找到 docsync：" + DOCSYNC);
  failedAny = true;
} else {
  const r = run("文档一致性门禁 docsync", [DOCSYNC], { cwd: here });
  [dP, dF] = pick((r.stdout || "") + (r.stderr || ""), /=== docsync: (\d+) passed, (\d+) failed ===/);
  noteStatus("docsync", r.status);
}

// config-lint：护栏配置门禁（references/ 两份配置的结构/红线/跨文件一致性）——纯 fs 秒级
if (!fs.existsSync(CFG_LINT)) {
  console.error("✗ 未找到 config-lint：" + CFG_LINT);
  failedAny = true;
} else {
  const r = run("护栏配置门禁 config-lint", [CFG_LINT], { cwd: here });
  [cP, cF] = pick((r.stdout || "") + (r.stderr || ""), /=== config-lint: (\d+) passed, (\d+) failed ===/);
  noteStatus("config-lint", r.status);
}

// inspect-one：巡检一键 CLI 门禁（预审四门/落盘守门/manifest/consistency/参数面）——免 DB 秒级，先跑早报
if (!fs.existsSync(INSPECT)) {
  console.error("✗ 未找到 inspect-one：" + INSPECT);
  failedAny = true;
} else {
  const r = run("巡检一键 CLI 门禁 inspect-one", [INSPECT], { cwd: here });
  [iP, iF] = pick((r.stdout || "") + (r.stderr || ""), /=== inspect-one: (\d+) passed, (\d+) failed ===/);
  noteStatus("inspect-one", r.status);
}

if (!fs.existsSync(E2E)) {
  console.error("✗ 未找到全链路 E2E：" + E2E);
  failedAny = true;
} else {
  const r = run("全链路 E2E" + (gates.length ? "（含 " + gates.join("+") + " live 段）" : "（核心段）"), [E2E, MCP_DIR], { cwd: here });
  [eP, eF, eS] = pick((r.stdout || "") + (r.stderr || ""), /=== 全链路 E2E：(\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/);
  noteStatus("全链路 E2E", r.status);
}

const verdict = failedAny ? "FAIL" : skippedAny ? "SKIP" : "OK";
console.log(`\nRUN_ALL selftest=${sP}/${sF}/${sS} sqlite-val=${svP}/${svF} mysql-val=${mvP}/${mvF}/${mvS} docsync=${dP}/${dF} config-lint=${cP}/${cF} inspect=${iP}/${iF} e2e=${eP}/${eF}/${eS} gates=${gates.join("+") || "core"} => ${verdict}`);
process.exit(failedAny ? 1 : skippedAny ? 3 : 0);
