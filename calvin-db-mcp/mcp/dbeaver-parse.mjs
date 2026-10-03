/**
 * dbeaver-parse.mjs — DBeaver 导入器的纯函数解析核心（v1.1.1 从 import-dbeaver.mjs 拆出）
 * 拆出目的：JDBC URL 解析 / 环境词元映射 / source id 清洗都是纯逻辑，值得不依赖真实 .dbp
 * 的 fixture 单测（import-dbeaver.mjs 是线性脚本，import 即执行，无法直接单测）。
 */

/**
 * 解析 DBeaver JDBC URL（configurationType=URL 时 url 内嵌 host/port/db/userinfo）。
 * v1.0.2 起支持 user:pass@ 前缀（命名分组杜绝组号错位），百分号编码自动解码。
 * 非 jdbc:mysql/postgresql 形态返回 null。
 */
export function parseJdbcUrl(rawUrl) {
  const jdbc = /^jdbc:(mysql|postgresql):\/\/(?:(?<userinfo>[^@\/?]*)@)?(?<host>[^\/:?]+)(?::(?<port>\d+))?\/(?<db>[^?]*)/.exec(rawUrl || "");
  const jg = jdbc ? jdbc.groups : null;
  if (!jg) return null;
  let user = "", password = "";
  if (jg.userinfo) {
    const ci = jg.userinfo.indexOf(":");
    user = ci >= 0 ? jg.userinfo.slice(0, ci) : jg.userinfo;
    password = ci >= 0 ? jg.userinfo.slice(ci + 1) : "";
    try { user = decodeURIComponent(user); } catch { /* 保留原样 */ }
    try { password = decodeURIComponent(password); } catch { /* 保留原样 */ }
  }
  let db = null;
  if (jg.db) {
    try { db = decodeURIComponent(jg.db); } catch { db = jg.db; }
  }
  return { host: jg.host, port: jg.port || null, db, user, password };
}

/**
 * DBeaver 文件夹名 → 环境标签。
 * v1.0.3 起按词元匹配（旧版 /test/ 子串会把 "latest" 误判成 TEST）；"线上" 保留子串匹配。
 */
export function envFromFolder(folder) {
  const folderLc = String(folder || "").toLowerCase();
  const tokens = new Set(folderLc.split(/[^a-z0-9]+/));
  return tokens.has("test") ? "TEST" : tokens.has("uat") ? "UAT" : tokens.has("pre") ? "PRE"
    : /prod|prd|线上/.test(folderLc) ? "PROD" : tokens.has("dev") ? "DEV" : "OTHER";
}

/** source id 用的标识符清洗（小写、非法字符转下划线、去首尾下划线、截断 40 字符、空则 "db"） */
export function sanitizeId(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "db";
}

/**
 * PowerShell 单引号字面量：包 ' ' 并把内部 ' 双写为 ''（PS 转义规则）。
 * v1.5.1：解包回退的 Expand-Archive 命令串曾直接插值路径——临时目录/用户名含 ' 时
 * 单引号被截断，后续字符按 PS 语法解析（命令注入面）。统一经此函数拼接后封死。
 */
export function psSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * v1.5.2: 源 URL 组装（纯函数）。user/password/database 全部 encodeURIComponent——
 * 旧版 db 名裸拼：库名含空格/斜杠/问号会破坏 URL 结构（pathname 截断、? 后混入 search）。
 * 消费端均已解码：mysql2 parseUrl / pg-connection-string / server 展示层 decodeURIComponent。
 * 安全字符（字母数字 -_.!~*'()）编码后保持原样，常规库名的可读性不受影响。
 */
export function buildSourceUrl(c) {
  const scheme = c.type === "mysql" ? "mysql" : "postgres";
  return `${scheme}://${encodeURIComponent(c.user || "")}:${encodeURIComponent(c.password || "")}@${c.host}:${c.port}/${encodeURIComponent(c.database || "")}`;
}
