/* crypt2.mjs — v1.5.0 配置加密 v2（明文源码，可审计）：
 * AES-256-GCM + scrypt KDF，密钥材料绑定 DBMCP_MASTER_KEY 环境变量（不再依赖仓库内静态密钥）。
 *
 * 密文格式：`enc2:` + base64( salt(16) || iv(12) || authTag(16) || ciphertext )
 * 与旧格式（crypt.mjs：静态密钥 AES-128-CBC，base64(iv||ct)，无认证）以 `enc2:` 前缀区分——
 * decryptAny 按前缀派发，旧配置永远可解（向后兼容）；encryptForConfig 在设置了主密钥时产出 enc2，
 * 否则回退旧格式（未升级部署零感知）。GCM 自带认证：换钥/篡改必报错，不会静默解出乱码。
 *
 * 安全边界（如实）：enc2 防的是"拿到配置文件"的攻击者（无主密钥不可解、篡改可检测）；
 * 但主密钥来自环境变量——能读 MCP 服务进程环境的人仍可解密。这是配置加密能做到的合理上限。
 */
import crypto from "node:crypto";
import { encryptText as legacyEncrypt, decryptText as legacyDecrypt } from "./crypt.mjs";

export const ENC2_PREFIX = "enc2:";
const MIN_MASTER_KEY_LEN = 8;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

/** 主密钥是否已绑定（≥8 字符的 DBMCP_MASTER_KEY）。决定 encryptForConfig 走 v2 还是旧格式。 */
export function masterKeyBound() {
  return typeof process.env.DBMCP_MASTER_KEY === "string" && process.env.DBMCP_MASTER_KEY.length >= MIN_MASTER_KEY_LEN;
}

/** 是否 enc2 格式密文（按前缀判定，与密钥是否设置无关）。 */
export function isEnc2(enc) {
  return typeof enc === "string" && enc.startsWith(ENC2_PREFIX);
}

function masterKey() {
  const km = process.env.DBMCP_MASTER_KEY;
  if (typeof km !== "string" || km.length < MIN_MASTER_KEY_LEN) {
    throw new Error(
      `DBMCP_MASTER_KEY 未设置（或少于 ${MIN_MASTER_KEY_LEN} 字符）：enc2 密文需要主密钥才能解密。` +
      `请在 MCP 服务的环境（客户端注册 JSON 的 "env" 块）中设置 DBMCP_MASTER_KEY 后重启，见《部署说明.详细版.md》。`
    );
  }
  return km;
}

function deriveKey(salt) {
  return crypto.scryptSync(masterKey(), salt, 32, SCRYPT_OPTS);
}

/** 明文 → enc2 密文（每次随机 salt + IV；同明文两次密文不同）。 */
export function encryptTextV2(text) {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return ENC2_PREFIX + Buffer.concat([salt, iv, cipher.getAuthTag(), ct]).toString("base64");
}

/** enc2 密文 → 明文。错钥/篡改/格式非法都明确报错（GCM 认证，不静默出乱码）。 */
export function decryptTextV2(enc) {
  if (!isEnc2(enc)) throw new Error("非法密文：enc2 密文必须以 'enc2:' 前缀开头。");
  const raw = Buffer.from(enc.slice(ENC2_PREFIX.length), "base64");
  if (raw.length < 16 + 12 + 16 + 1) throw new Error("密文长度不足或非法（enc2）。");
  const salt = raw.subarray(0, 16);
  const iv = raw.subarray(16, 28);
  const tag = raw.subarray(28, 44);
  const ct = raw.subarray(44);
  const d = crypto.createDecipheriv("aes-256-gcm", deriveKey(salt), iv);
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    throw new Error("解密失败：DBMCP_MASTER_KEY 不匹配或密文被篡改。");
  }
}

/**
 * 按前缀派发解密：enc2 → v2，其余 → 旧格式（向后兼容所有历史配置）。
 * v1.5.2: 旧格式密文损坏时驱动抛裸 OpenSSL 错误（实测 "error:1C800064:Provider routines::bad
 * decrypt"），使用者无从下手——映射为可诊断的中文说明（保留原文片段供定位）；
 * 长度检查类既有中文错误保持原样，不二次包装。
 */
export function decryptAny(enc) {
  if (isEnc2(enc)) return decryptTextV2(enc);
  try {
    return legacyDecrypt(enc);
  } catch (e) {
    const raw = String(e?.message || "");
    if (/长度不足|非法/.test(raw)) throw e;
    throw new Error(`旧格式密文解密失败：密文损坏或被篡改（OpenSSL 原文: ${raw.slice(0, 60)}）。可用 node crypt-cli.mjs decrypt 定位坏源后重新导入或重加密。`);
  }
}

/** 写配置用：绑定主密钥时产出 enc2，否则回退旧格式（并由调用方提示升级路径）。 */
export function encryptForConfig(text) {
  return masterKeyBound() ? encryptTextV2(text) : legacyEncrypt(text);
}
