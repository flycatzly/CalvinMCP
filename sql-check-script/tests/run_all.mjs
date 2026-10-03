#!/usr/bin/env node
/**
 * 一键全量验收：calvin-db-mcp selftest → 全链路 E2E（合并裁决，机器可读汇总行）
 *
 * 用法：node tests/run_all.mjs [mcpDir]
 *   mcpDir 默认 <本仓库>/../calvin-db-mcp/mcp（可用 DBMCP_MCP_DIR 覆盖）
 * live 段随环境变量门控（与 fullchain_test.mjs 同口径）：
 *   FULLCHAIN_MYSQL=1 / FULLCHAIN_PG=1 时 E2E 含对应真实源只读段。
 *
 * 退出码：0 = 全部通过；1 = 存在失败或套件无法运行。
 * 汇总行：RUN_ALL selftest=<p>/<f> e2e=<p>/<f> gates=<...> => OK|FAIL
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = process.argv[2] || process.env.DBMCP_MCP_DIR || path.resolve(here, "..", "..", "calvin-db-mcp", "mcp");
const SELFTEST = path.join(MCP_DIR, "selftest.mjs");
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
// 同一判定两种计数来源：selftest 与 E2E 各自的机器可读汇总行
const pick = (text, re) => (text.match(re) ? [text.match(re)[1], text.match(re)[2]] : ["-", "-"]);

let sP = "-", sF = "-", eP = "-", eF = "-";
let ok = true;

if (!fs.existsSync(SELFTEST)) {
  console.error("✗ 未找到 selftest：" + SELFTEST);
  ok = false;
} else {
  const r = run("calvin-db-mcp selftest", [SELFTEST], { cwd: MCP_DIR });
  [sP, sF] = pick((r.stdout || "") + (r.stderr || ""), /=== (\d+) passed, (\d+) failed ===/);
  if (r.status !== 0) ok = false;
}

if (!fs.existsSync(E2E)) {
  console.error("✗ 未找到全链路 E2E：" + E2E);
  ok = false;
} else {
  const r = run("全链路 E2E" + (gates.length ? "（含 " + gates.join("+") + " live 段）" : "（核心段）"), [E2E, MCP_DIR], { cwd: here });
  [eP, eF] = pick((r.stdout || "") + (r.stderr || ""), /=== 全链路 E2E：(\d+) passed, (\d+) failed ===/);
  if (r.status !== 0) ok = false;
}

console.log(`\nRUN_ALL selftest=${sP}/${sF} e2e=${eP}/${eF} gates=${gates.join("+") || "core"} => ${ok ? "OK" : "FAIL"}`);
process.exit(ok ? 0 : 1);
