#!/usr/bin/env node
/**
 * 一键全量验收：calvin-db-mcp selftest → 全链路 E2E（合并裁决，机器可读汇总行）
 *
 * 用法：node tests/run_all.mjs [mcpDir]
 *   mcpDir 默认 <本仓库>/../calvin-db-mcp/mcp（可用 DBMCP_MCP_DIR 覆盖）
 * live 段随环境变量门控（与 fullchain_test.mjs 同口径）：
 *   FULLCHAIN_MYSQL=1 / FULLCHAIN_PG=1 时 E2E 含对应真实源只读段。
 *
 * 退出码（统一诚实 SKIP 口径，与 mysql-validate 退出码 3 同义）：
 *   0 = 全部通过且无诚实 SKIP；1 = 存在失败或套件无法运行；3 = 无失败但有诚实 SKIP
 *   （缺 fixture / 开了 live 门却没源 / 缺依赖起不来）—— 未跑的部分明示出来，不冒充全绿。
 * 汇总行：RUN_ALL selftest=<p>/<f>[/<s>] e2e=<p>/<f>[/<s>] gates=<...> => OK|SKIP|FAIL
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
// 同一判定两种计数来源：selftest 与 E2E 各自的机器可读汇总行（第三组 = 诚实 SKIP，旧格式缺省 0）
const pick = (text, re) => {
  const m = text.match(re);
  return m ? [m[1], m[2], m[3] ?? "0"] : ["-", "-", "-"];
};

let sP = "-", sF = "-", sS = "-", eP = "-", eF = "-", eS = "-";
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

if (!fs.existsSync(E2E)) {
  console.error("✗ 未找到全链路 E2E：" + E2E);
  failedAny = true;
} else {
  const r = run("全链路 E2E" + (gates.length ? "（含 " + gates.join("+") + " live 段）" : "（核心段）"), [E2E, MCP_DIR], { cwd: here });
  [eP, eF, eS] = pick((r.stdout || "") + (r.stderr || ""), /=== 全链路 E2E：(\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/);
  noteStatus("全链路 E2E", r.status);
}

const verdict = failedAny ? "FAIL" : skippedAny ? "SKIP" : "OK";
console.log(`\nRUN_ALL selftest=${sP}/${sF}/${sS} e2e=${eP}/${eF}/${eS} gates=${gates.join("+") || "core"} => ${verdict}`);
process.exit(failedAny ? 1 : skippedAny ? 3 : 0);
