/**
 * dbeaver-parse.mjs — DBeaver 导入器的纯函数解析核心（v1.1.1 从 import-dbeaver.mjs 拆出）
 * 拆出目的：JDBC URL 解析 / 环境词元映射 / source id 清洗都是纯逻辑，值得不依赖真实 .dbp
 * 的 fixture 单测（import-dbeaver.mjs 是线性脚本，import 即执行，无法直接单测）。
 */
import path from "node:path";

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

/**
 * v1.6.25: .dbp 参数解析（纯函数，目录遍历/文件判定经注入，便于 fixture 单测）。
 * 支持三种写法（install.mjs 与 import-dbeaver.mjs 同语义共用）：
 *   ① 完整/相对路径：demo.dbp、sub\a.dbp、C:\x\a.dbp —— 相对路径先按 cwd 解析，再按脚本目录回退；
 *   ② 同级目录裸文件名：只写文件名（如 保险-20260929.dbp），cwd 找不到时回退脚本目录；
 *   ③ 通配符：*.dbp / 保险-*.dbp（* 与 ?，大小写不敏感；目录段可带路径 sub\*.dbp）——
 *      cmd 引号内通配符不展开，由本解析器处理，故 `node install.mjs "*.dbp"` 可用。
 * 零匹配 → code:"no-match"；多匹配（通配符命中多个 / 大小写变体多个）→ code:"ambiguous" 列出候选——
 * 一律拒绝猜测、不静默挑一个（与 --force 防误覆盖同一条安全口径）。
 * io: { cwd, scriptDir, listDir(dir) -> string[]（失败返回 []）, isFile(absPath) -> boolean }
 * 返回 { ok: true, file } | { ok: false, code: "no-match"|"ambiguous", message, candidates? }
 */
export function resolveDbpArg(arg, io) {
  const raw = String(arg ?? "").trim();
  const baseDirs = [...new Set([path.resolve(io.cwd || "."), path.resolve(io.scriptDir || io.cwd || ".")])];
  const listDir = (d) => { try { return io.listDir(d) || []; } catch { return []; } };
  const isFile = (p) => { try { return !!io.isFile(p); } catch { return false; } };
  const uniq = (xs) => [...new Set(xs)];

  if (!/[*?]/.test(raw)) {
    // ①/② 字面路径：绝对路径只试一次；相对路径依次按 cwd、脚本目录解析
    const tried = uniq(path.isAbsolute(raw) ? [path.resolve(raw)] : baseDirs.map((d) => path.resolve(d, raw)));
    const hit = tried.find(isFile);
    if (hit) return { ok: true, file: hit };
    // 同名大小写不敏感回退（Windows 文件系统语义；唯一命中才采纳，多个变体拒绝）
    const ci = [];
    for (const p of tried) {
      const dir = path.dirname(p), name = path.basename(p);
      for (const n of listDir(dir)) {
        if (n.toLowerCase() !== name.toLowerCase()) continue;
        const q = path.join(dir, n);
        if (isFile(q)) ci.push(q);
      }
    }
    const ciHits = uniq(ci);
    if (ciHits.length === 1) return { ok: true, file: ciHits[0] };
    if (ciHits.length > 1) return { ok: false, code: "ambiguous", message: "文件名大小写不敏感匹配到 " + ciHits.length + " 个文件，请用完整路径指定其中一个：" + ciHits.join("、"), candidates: ciHits };
    return { ok: false, code: "no-match", message: "文件不存在：" + raw + "（尝试过：" + tried.join("、") + "）" };
  }

  // ③ 通配符：最后一段作为文件名模式，前面作为目录段
  const sep = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  const dirPart = sep >= 0 ? raw.slice(0, sep) : "";
  const pat = sep >= 0 ? raw.slice(sep + 1) : raw;
  const rx = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  const searchDirs = dirPart
    ? uniq(path.isAbsolute(dirPart) ? [path.resolve(dirPart)] : baseDirs.map((d) => path.resolve(d, dirPart)))
    : baseDirs;
  const found = [];
  for (const d of searchDirs) {
    for (const n of listDir(d)) {
      if (!rx.test(n)) continue;
      const p = path.join(d, n);
      if (isFile(p)) found.push(p);
    }
  }
  const hits = uniq(found).sort();
  if (hits.length === 1) return { ok: true, file: hits[0] };
  if (!hits.length) return { ok: false, code: "no-match", message: "通配符未匹配到任何文件：" + raw + "（搜索目录：" + (searchDirs.join("、") || "无") + "）" };
  return { ok: false, code: "ambiguous", message: "通配符匹配到 " + hits.length + " 个文件，请改用完整路径指定其中一个：" + hits.join("、"), candidates: hits };
}
