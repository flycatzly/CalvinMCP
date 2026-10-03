/**
 * crypt-cli.mjs — dbmcp.config.json 加解密命令行（薄层，不含密钥材料）
 * 加解密实现在 crypt.mjs（旧格式，已混淆）与 crypt2.mjs（enc2: 主密钥绑定格式）。用法:
 *   node crypt-cli.mjs encrypt            # 明文 url → enc 字段（写回配置文件）
 *   node crypt-cli.mjs decrypt            # enc 字段 → 明文 url（写回配置文件，维护用，用完记得 encrypt 回去）
 *   node crypt-cli.mjs decrypt --stdout   # 解密结果仅打印到 stdout，不落盘（推荐；避免明文持久化）
 *   node crypt-cli.mjs rekey [--config <path>]  # 逐源把旧格式 enc 升级为 enc2（需 DBMCP_MASTER_KEY ≥8 字符）
 * 配置路径: --config <path>（rekey 用）/ 环境变量 DBMCP_CONFIG / ./dbmcp.config.json
 * v1.5.0: encrypt 在设置 DBMCP_MASTER_KEY 时写 enc2（AES-256-GCM），否则写旧格式；decrypt 两种格式都认。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptForConfig, decryptAny, encryptTextV2, isEnc2, masterKeyBound } from "./crypt2.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const mode = argv[0];
const toStdout = argv.includes("--stdout");
const cfgIdx = argv.indexOf("--config");
// v1.5.1 fail-closed：--config 出现但缺值时直接报错退出，绝不静默回退默认配置
//（旧行为会拿默认路径继续跑，rekey 可能改写用户没打算动的配置文件）
if (cfgIdx >= 0 && (!argv[cfgIdx + 1] || argv[cfgIdx + 1].startsWith("--"))) {
  console.error("[crypt-cli] --config 缺少路径参数（用法: --config <path>）。为防误操作默认配置，已中止。");
  process.exit(1);
}
const file = (cfgIdx >= 0 && argv[cfgIdx + 1]) || process.env.DBMCP_CONFIG || path.join(__dirname, "dbmcp.config.json");

if ((mode !== "encrypt" && mode !== "decrypt" && mode !== "rekey") || (toStdout && mode !== "decrypt")) {
  console.error("用法: node crypt-cli.mjs encrypt|decrypt [--stdout]|rekey [--config <path>]");
  console.error("  encrypt       明文 url → enc（设置 DBMCP_MASTER_KEY 时写 enc2，否则旧格式）");
  console.error("  decrypt       enc → 明文 url 写回（--stdout 只打印不写盘，推荐）");
  console.error("  rekey         旧格式 enc 逐源升级为 enc2（需 DBMCP_MASTER_KEY ≥8 字符；失败源保持原样并标失败退出码）");
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error("[crypt-cli] 配置不存在: " + file);
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
const sources = cfg.sources || {};

/* -------- v1.5.0 rekey：旧格式 enc → enc2（主密钥绑定），逐源容错，失败源不动、整体标失败 -------- */
if (mode === "rekey") {
  if (!masterKeyBound()) {
    console.error("[crypt-cli] rekey 需要主密钥：请设置环境变量 DBMCP_MASTER_KEY（≥8 字符）后重试。");
    process.exit(1);
  }
  let upgraded = 0, skipped = 0, failed = 0;
  for (const [id, s] of Object.entries(sources)) {
    if (!s.enc || isEnc2(s.enc)) { skipped++; continue; }   // 明文 url 源 / 已是 enc2：不动
    try {
      const url = decryptAny(s.enc);
      s.enc = encryptTextV2(url);
      upgraded++;
    } catch (e) {
      failed++;
      console.error(`  ${id}: 升级失败——${e.message}（该源保持原样）`);
    }
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  console.log(`[crypt-cli] rekey: ${file} 升级 ${upgraded} 个源，跳过 ${skipped} 个，失败 ${failed} 个`);
  process.exit(failed ? 1 : 0);
}

let n = 0;
for (const [id, s] of Object.entries(sources)) {
  if (mode === "encrypt") {
    if (!s.url) continue;
    s.enc = encryptForConfig(s.url);
    delete s.url;
  } else if (toStdout) {
    // v1.0.3: 只读解密——不改内存对象、不写回文件，明文仅出现在 stdout（管道消费后即逝）
    if (!s.enc) continue;
    console.log(id + "\t" + decryptAny(s.enc));
    n++;
    continue;
  } else {
    if (!s.enc) continue;
    s.url = decryptAny(s.enc);
    delete s.enc;
  }
  n++;
}
if (!toStdout) fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log(`[crypt-cli] ${mode}${toStdout ? " --stdout" : ""}: ${file} 处理 ${n} 个 source${toStdout ? "（未写盘）" : ""}`);
