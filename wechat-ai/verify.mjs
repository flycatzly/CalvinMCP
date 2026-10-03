#!/usr/bin/env node
/**
 * 一键验证：把全部测试套件跑一遍并汇总。
 *
 *   node verify.mjs            # 跑全部套件
 *   node verify.mjs --quick    # 只跑自检（跳过端到端）
 *
 * 退出码（统一诚实 SKIP 口径，与 mysql-validate 退出码 3 同义）：
 *   0 = 全部通过且无诚实 SKIP；1 = 存在失败；3 = 无失败但有诚实 SKIP（模块未就绪 / 能力未提供）——
 *   未跑的部分明示出来，不冒充全绿，也不算失败。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const QUICK = process.argv.includes("--quick");

const SUITES = [
  { name: "核心自检（断言式）", file: path.join(here, "mcp", "selftest.mjs"), parse: /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/ },
  { name: "MCP stdio 传输", file: path.join(here, "mcp", "tests", "stdio.test.mjs"), parse: /=== (.+?) ===/ },
  { name: "微信流核心", file: path.join(here, "mcp", "selftest-wechat-core.mjs"), parse: /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/ },
  { name: "报告安全", file: path.join(here, "mcp", "tests", "security.test.mjs"), parse: null },
  { name: "WCDB 只读解析（合成库）", file: path.join(here, "mcp", "tests", "wcdb.test.mjs"), parse: /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/ },
  { name: "其余只读数据源", file: path.join(here, "mcp", "tests", "readers.test.mjs"), parse: /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/ },
  { name: "结构漂移（真实库变体）", file: path.join(here, "mcp", "tests", "schema-drift.test.mjs"), parse: /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/ },
  { name: "内容级口径（上游对齐）", file: path.join(here, "mcp", "tests", "content.test.mjs"), parse: /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/ },
  { name: "内容级口径（群聊矩阵/机会候选）", file: path.join(here, "mcp", "tests", "content2.test.mjs"), parse: /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/ },
  { name: "运维健壮性", file: path.join(here, "mcp", "tests", "robustness.test.mjs"), parse: /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/ },
  { name: "规模与增量语义", file: path.join(here, "mcp", "tests", "scale.test.mjs"), parse: /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/ },
];
if (!QUICK) SUITES.push({ name: "端到端验收（63 工具）", file: path.join(here, "mcp", "e2e.mjs"), parse: /=== (\d+) passed, (\d+) failed(?:, (\d+) 诚实SKIP)? ===/ });

console.log("wechat-ai 验证\n" + "=".repeat(60));
let bad = 0;
let skipAny = false;
const rows = [];

for (const s of SUITES) {
  if (!fs.existsSync(s.file)) {
    rows.push({ ...s, status: "SKIP", detail: "文件不存在" });
    skipAny = true;
    console.log("\n— " + s.name + "：跳过（" + path.basename(s.file) + " 不存在）");
    continue;
  }
  console.log("\n— " + s.name + "：" + path.relative(here, s.file));
  const t0 = Date.now();
  const r = spawnSync(node, [s.file], { encoding: "utf8", env: { ...process.env } });
  const ms = Date.now() - t0;
  const out = (r.stdout || "") + (r.stderr || "");
  const tail = out.split("\n").filter((l) => l.trim()).slice(-6);
  console.log(tail.map((l) => "    " + l).join("\n"));
  const m = s.parse ? out.match(s.parse) : null;
  // 套件退出码口径：0=全绿；3=无失败但有诚实 SKIP（不算失败，也绝不冒充全绿）；其余=失败
  const pass = r.status === 0;
  const hSkip = r.status === 3;
  if (hSkip) skipAny = true;
  if (!pass && !hSkip) bad += 1;
  rows.push({
    name: s.name, status: pass ? "PASS" : hSkip ? "SKIP" : "FAIL", ms,
    detail: m ? (m[2] !== undefined ? m[1] + " passed / " + m[2] + " failed" + (m[3] !== undefined ? " / " + m[3] + " 诚实SKIP" : "") : m[1]) : "exit " + r.status,
  });
}

console.log("\n" + "=".repeat(60));
console.log("汇总");
for (const r of rows) {
  console.log("  " + (r.status === "PASS" ? "✓" : r.status === "SKIP" ? "⊹" : "✗") + " " + r.name.padEnd(24, " ") + (r.ms ? String(r.ms).padStart(7) + "ms  " : "        ") + r.detail);
}
const passSuites = rows.filter((r) => r.status === "PASS").length;
const skipSuites = rows.filter((r) => r.status === "SKIP").length;
console.log("\n套件: " + passSuites + " 通过 / " + bad + " 失败 / " + skipSuites + " 诚实SKIP");
console.log(bad === 0 ? (skipAny ? "无失败，但有诚实 SKIP ⊹——未跑部分见上，不冒充全绿" : "全部通过 ✓") : bad + " 个套件失败 ✗");
process.exit(bad ? 1 : skipAny ? 3 : 0);
