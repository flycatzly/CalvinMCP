/**
 * exclude.js — 排除口径单一源（r40）
 *
 * 为什么存在：五个面各写各的排除清单时，手工 ad-hoc 差集会静默假红。
 * r38 实锤：净树生成多排了 demo 与 package-lock.json → 4 套假红蒸发 290 断言
 * （lint/hardened 崩 demo 样例 ENOENT、protocol NOT_FOUND、deployed 报假「多余」）。
 * r40 诊断又抓出三处差集：deployed-check 漏排 generated-booltest（假漂移面）、
 * install 漏排 generated 系（陈旧产物进安装副本）、deployed-check 缺失面零豁免
 * （「失败保留产物」+「重装前产物已清」组合下运行时产物报假「丢文件」）。
 *
 * 五个面从这里取，禁止再写字面量：
 *   1) distribute（发布包）   EXCLUDE_DIRS + EXCLUDE_FILE_RES + 任何 . 前缀
 *   2) deployed-check（比对） EXCLUDE_DIRS + IGNORE_TOP + EXPECTED_DEPLOY_EXTRA + . 前缀跳过
 *   3) install（复制面）      EXCLUDE_DIRS（只拷 mcp/skill/demo/extension 四子树 + 根文件白名单）
 *   4) nettree（净树）        EXCLUDE_DIRS（忠实镜像减排除：源文件一个都不能少）
 *   5) verify-all 收尾清理    不派生 —— 它是**路径**清单（含 demo/ 前缀与
 *      mcp/py/__pycache__ 特例），与这里的目录名口径形态不同，单独维护
 *      （mcp/test/verify-all.mjs ARTIFACT_DIRS）。
 *
 * 语义专属面的差集理由（为什么某面多/少东西）：
 *   · EXCLUDE_FILE_RES 只有 distribute 用：发布包连 .log/.tmp/probe 试验脚本都不带；
 *     比对/复制面不排它们（用户放什么源文件都该原样进副本）。
 *   · IGNORE_TOP 只有 deployed-check 用：dsh-bundle 是安装时生成的，源码目录没有，
 *     不是「多余陈旧」。
 *   · EXPECTED_DEPLOY_EXTRA 只有 deployed-check 用：demo/generated* 与 test-results/
 *     是运行时产物（跑过测试就会有），**双向豁免**——任一侧出现都不算漂移；
 *     真实漂移面在 mcp/skill/demo/extension 的源文件上。
 *   · . 前缀策略：distribute 全排（纯净包规范）、deployed-check 全跳过（开发树与
 *     分发版两侧不对称，纳入比对=假漂移）、install 只拷 MANAGED_ROOT_FILES 显式
 *     白名单（.gitignore 等）与 .github/。
 */

/** 依赖与版本控制：可重装/无分发价值 */
export const DEPENDENCY_DIRS = ['node_modules', '.git'];

/** 运行产物：跑测试就再生，任何面都不该当「源内容」 */
export const ARTIFACT_DIRS = [
  '.playwright-artifacts',        // CLI 快照/截图/日志（本工具自己的约定目录）
  '.playwright-cli',              // playwright-cli 自己写的产物（首次跑才会出现）
  'crash-bundles',                // 崩溃/异常退出现场 bundle（r44 crashbundle.js；自修剪，verify-all 收尾清理刻意不含它——证据不许被下次全绿抹掉）
  'test-results',
  'dist',
  'generated',                    // 生成器/编排产物（demo/generated-* 任意层级同名匹配）
  'generated-e2e',
  'generated-orchestrated',
  'generated-booltest',
  'generated-argscheck',          // args-check 临时生成目录在并行波内正建删，比对必须视而不见
  '__pycache__',                  // Python 字节码：内嵌编译时源码路径，运行时再生成
];

/** 会话私有试验场/临时探查：试验品绝不进发布包与安装副本 */
export const SANDBOX_DIRS = ['Temp', 'scratch'];

/** 目录名口径（任意层级）：五面共用的排除真身 */
export const EXCLUDE_DIRS = [...DEPENDENCY_DIRS, ...ARTIFACT_DIRS, ...SANDBOX_DIRS];

/** distribute 专属：文件名模式（发布包连散落的试验脚本/日志都不带） */
export const EXCLUDE_FILE_RES = [
  /\.log$/i,
  /\.tmp$/i,
  /^\.probe/i,
  /^probe\d*\.mjs$/i,
  /^dbg/i,
  /\.bak-/i,
  /\.pyc$/i,
];

/** deployed-check 专属：只在部署副本里出现的安装生成物（顶层） */
export const IGNORE_TOP = ['dsh-bundle'];

/** deployed-check 专属：运行时产物豁免面（双向，见头注） */
export const EXPECTED_DEPLOY_EXTRA = [
  /^demo\/generated/,
  /^test-results\//,
];

/** 运行时产物判定（双向豁免的单一源）：源/副本任一侧出现都不算漂移 */
export function isRuntimeArtifact(rel) {
  return EXPECTED_DEPLOY_EXTRA.some((re) => re.test(rel));
}

/**
 * 漂移判定（deployed-check 的比对语义单一源）：
 *   missing          源有副本无 —— 运行时产物豁免（不算丢文件）
 *   extra            副本有源无 —— 全量
 *   unexpectedExtra  extra 中非运行时产物 —— 真「多余陈旧」
 */
export function diffManifests(srcKeys, dstKeys) {
  const src = srcKeys instanceof Set ? srcKeys : new Set(srcKeys);
  const dst = dstKeys instanceof Set ? dstKeys : new Set(dstKeys);
  const missing = [...src].filter((k) => !dst.has(k) && !isRuntimeArtifact(k));
  const extra = [...dst].filter((k) => !src.has(k));
  const unexpectedExtra = extra.filter((k) => !isRuntimeArtifact(k));
  return { missing, extra, unexpectedExtra };
}
