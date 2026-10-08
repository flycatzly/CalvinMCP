/**
 * suites.mjs — 全量回归的套件清单与波次调度（纯数据 + 纯函数，无 IO）
 *
 * 为什么单独抽出来：verify-all.mjs 的调度结构（谁和谁并发、谁必须独占末位）
 * 是「会假失败 vs 不会」的分界线，而这种结构一旦被顺手「优化」掉，
 * 症状只是偶发假失败 —— 最难查的那类回归。抽成数据后，
 * 加固 H21 可以对**真实清单**做行为断言（deployed-check 独占末波），
 * 而不是对着 verify-all 源码做字符串匹配。
 */

/** 套件清单。serial: true 的套件必须独占一波、排在最后（整树比对不容并发写入）。
 *
 * 断言数字段（数字单一源 —— README 套件表、§15.3 判据行、verify-all 判据全从这里对账，加固 H22）：
 *   assertions       稳定断言数（不含存在性钉）——任何形态跑出的 PASS 数都以它为基准
 *   assertionsNoDep  零依赖态部分执行时的断言数（缺省 == assertions；整套 SKIP 的用 needs 标记，不填）
 *   dotPins          存在性钉数（钉各自绑定 PIN_FILES 里的 . 前缀基础设施文件，在位才跑、缺失诚实 SKIP；缺省 0）
 */
/** 存在性钉绑定的 . 前缀基础设施文件：纯净发布包按口径不含它们，对应检查在包里诚实 SKIP 不计数。
 *  数量必须与 hardened-check 的存在性守卫一一对应（H22 机械钉住）。 */
export const PIN_FILES = ['.gitattributes', '.gitignore', '.github/workflows/ci.yml'];
export const SUITES = [
  { name: '扫描器（三份样例集）', file: 'mcp/test/lint-check.mjs', assertions: 58, note: 'clean 不冤枉 / messy 全中 / tricky 不误报 / 结构边界 11 / 对抗语料 18（误报漏报边界，r47 +5 钉修饰断言形态 expect.soft/expect.poll 正反面）/ 属性化语料 20 规则 × bad+good（真 lint 跑，bad 命中自己 good 不冤枉）+ 覆盖门' },
  { name: '归因（缺陷 4 回归）', file: 'mcp/test/signature-check.mjs', assertions: 42, note: 'ANSI 清洗幂等、断言不被误归成超时、6 条压成 4 个签名、输入校验不静默全零、多报告趋势（通过率曲线/签名漂移三分法/计数矩阵含簇内多条/md 落盘形态）、趋势 md 行截断（每列表 ≤50 行/诚实「还有 N 条」计数/结构化数据保全量/小趋势形态零变化）、趋势上下文有界（slim 截 50 与 md 同一常量/total 诚实/回灌面 ≤ 全量一半/行内保真/纯函数不突变/未超上限透传）' },
  { name: '生成器', file: 'mcp/test/generate-check.mjs', assertions: 27, note: '门禁、PO 分层、方法名、占位符、脆弱选择器' },
  { name: 'MCP 协议与工具面', file: 'mcp/test/protocol-check.mjs', assertions: 116, note: '握手、版本协商、16 个工具、annotations 副作用声明、观测日志脱敏与聚合、错误码语义、stdin EOF 排空、报告输入校验、真实 stdio、日志容量上限与轮转（PVMCP_LOG_MAX_MB）、计划缓存观测（cache= 字段：可选解析/三态按工具聚/命中率 hit/(hit+miss) 白名单外进 malformed/CLI 同一份判定）、按工具块渲染（权重序/maxMs 透出/逐字节形状）' },
  { name: '浏览器插件本地桥（通道/守门/脱敏）', file: 'mcp/test/bridge-check.mjs', assertions: 56, note: '/rpc 打穿 handleMessage（错误码/通知 204/批量 id 对应/405/404）、守门（Host 挡 DNS rebinding、网页来源 403、扩展来源放行、口令 401 三态、/health 探活豁免、预检 Allow-Headers、4MB 上限 413）、串行队列并发不失位、CLI 真启动 + 脱敏哨兵（参数值不进观测日志）、manifest MV3 只圈本机、manifest.version 与 package.json 同步、面板 schema 驱动 tools/list+tools/call、面板双模行为面（r49：键统一 pv_base/pv_token+旧键迁移、clientInfo 走 manifest、独立模式零 fetch+runTool 守卫、模式往返）、历史区富渲染（r50：pvFactsLine 双面同口径防复制漂移、【verdict】+facts 预览行为面、恶意载荷保真+renderHistory 零 innerHTML、空态四段不塌）、连接失败可执行指引与安装插件引导（r51）' },
  { name: '猫耳悬浮球（录制/回放/中转）', file: 'mcp/test/floating-check.mjs', assertions: 106, note: 'vm 加载真 recorder.js（定位器六级优先级与 canonicalLocator 同口径、敏感字段双防线含 nameAttr、归一合并/去重/截断、locatorToQuery 非法抛错、生成输入键集恰在 schema 白名单且 overwrite 恒 false、exportFileName 文件名清洗+全符号回落）；stub DOM 真跑 floating.js（Shadow DOM 猫耳球、幂等注入、拖拽落盘、录制 capture 链、敏感跳过角标不动、结束保存归一、回放 URL 守门/真执行/未找到即停、巡检/采集/生成/导出 JSON/NL/控制台走中转、敏感值不进任何载荷；导出链 Blob/URL/timer 观测存根；r49 插拔式双模：pv_mode 持久化/桥依赖按钮停用/本地能力保留/守卫零发出/模式往返/持久化恢复/面板高度帽防底部按钮出视口）；真 background.js 中转（POST /rpc 口令只经请求头、/health 免口令、未配不带头、桥不可达诚实报错、params 透传）；manifest 契约（注入顺序、只圈 http/https、网络面不扩权）、keydown Enter 录 press（key 在事件上）、同值 fill 跨 press 无损归一' },
  { name: '悬浮球端到端（真浏览器/本地靶场）', file: 'mcp/test/floating-e2e.mjs', assertions: 37, browser: true, needs: ['cli'], note: '真 msedge 加载扩展 + 自起桥（tools/list=16 新鲜度）+ 本地靶场页（light DOM/开放影子树/关闭影子树三形态，零外网依赖）；SW storage 注入桥地址、录制 4 原始步含口令跳过、归一保存 3 步、刷新恢复、回放 3 ✓（含深搜）、工具快捷三件套走真桥、导出录制 JSON（下载触发+日志回执 write:false 口径）、r49 双模真浏览器（切独立：橙点/生成停用/导出保留+断桥不断本地+切回探活往返）、r51 控制台整页全流程（桥未起指引/重连 16 工具/lint_spec 真调用+历史预览+回填/面板双模往返/模式钮视口内可达性）、URL 守门、关闭影子树录宿主不假装穿透、目标消失诚实停止、R2 稳定性复跑、扩展侧零 error' },
  { name: '规则表一致性', file: 'mcp/test/rules-check.mjs', assertions: 37, note: '规则 id 唯一、文档与实际规则表不漂移、属性化语料覆盖门（每条规则必须带 bad/good 样例，展开数=规则数×2）' },
  // 加固套件来自一次对抗性审计：专钉「不报错但结论错」的静默失效
  {
    name: '加固（静默失效/反转/覆盖/篡改）', file: 'mcp/test/hardened-check.mjs', assertions: 149, dotPins: 3,
    note: 'H1–H30：规则静默失效、数据篡改、模板串吞代码、静默覆盖、落盘绕过、配置误判、环境失败不漏成 unknown、智能体线守门、分发纯净、发版门禁、CLI 失败根因不被噪声淹没、并行调度与收尾（波并发帽形状：每波 ≤ MAX_WAVE/波数最小化不退化一队一波/声明顺序保持/非法 maxWave 回退默认）、断言数单一源与 CI 定义、安装器镜像式复制（沙箱真装：陈旧残留默认自愈/--force 整目录重置/用户杂散文件不动）、浏览器缺失三签名分类与通道自愈契约（stale-exec-pin 决策规则：机器生成物残留 executablePath 钉即重生成，手工配置不自动动）、零依赖口径只认副本本地（机器级全局不得污染判定与诚实报缺）、成功判定要证据不只退出码（假 CLI 不得出「已落盘」假绿：产物在场/非空/魔数/快照 ref 标记/自报 isError 信封）、崩溃具名（已知原生崩溃码给可读名且正负双形态归一/未知码不编造/普通异常退出不误标进程崩溃）、排除口径单一源与 fixture 哨兵（mcp/lib/exclude.js 五面派生且差集理由显式、diffManifests 运行时产物双向豁免、install 沙箱哨兵与 nettree 忠实镜像哨兵：源文件不误杀/产物不漏排）、判据基数 serial 解耦（serialAssertions 求和与 planWaves 同源：多 serial 各占一波全计入，find 单取即回归；serial 计入按声明匹配不硬编码文件名）、崩溃/异常退出现场落盘（crashbundle 决策/写盘/自修剪 + verify-all 崩溃 close 与挂死双分支接线 + bundle 不进收尾清理清单，证据不被下次全绿抹掉）',
  },
  { name: 'CLI 真实交互与落盘', file: 'mcp/test/cli-e2e.mjs', assertions: 25, note: 'Ref 交互、fill/click 生效、产物落盘、PNG 魔数、白名单、通道自愈闭环（活体：陈旧 executablePath 钉+空缓存→自动重写 channel 配置重试通过，autoHeal 如实标注）', browser: true, needs: ['cli'] },
  { name: 'Excel 编排端到端', file: 'mcp/test/orchestrate-e2e.mjs', assertions: 20, assertionsNoDep: 17, note: '读表 → 映射 → 生成门禁 → 落盘 → 真跑通过', browser: true },
  { name: '参数规范化与产物命名', file: 'mcp/test/args-check.mjs', assertions: 46, assertionsNoDep: 38, note: '布尔不静默反转、非法值报错、整数参数不静默取整、并发产物不互相覆盖、浏览器通道优先级', browser: true },
  // 智能体线（自然语言声明式测试）：无浏览器套验 LLM 协议回环与守门，浏览器套验真执行
  { name: '智能体线（LLM 回环/守门/计划契约/自愈采集纯函数）', file: 'mcp/test/nl-agent-check.mjs', assertions: 149, note: 'stub LLM 真 HTTP 回环、危险目标拒绝、白名单不静默丢弃、死链坏图判定、自愈语义提取与选择题边界、翻页归并与两期对比、自愈 LLM 预算闸门（总闸/短路/穿线/用量）、断点续采计划（指纹闸/断点页/种子归并/工具守门）、整数参数工具面（keyIndex/maxPages/probeTimeoutMs/maxLinks/retries/timeoutMs×2/maxSteps 拒小数）、探活预算闸门（慢死主机单探测超时/整段总预算/耗尽诚实 partial）、多报告趋势工具面（files 互斥/坏成员不静默跳过/md 落盘只回摘要）、计划缓存纯函数（指纹四元组任一变即失效/TTL 到期即淘汰/容量 FIFO/报告增量字段缺省兼容）、趋势 md 截断工具面（签名爆炸 md 有界/诚实计数行）、趋势上下文有界工具面（structuredContent 截 50+total/落盘 JSON 回读 65 条全量含 sample/format=json text 同口径）、表单指纹与两期对比纯函数（formHash 重排不敏感/敏感四变体/整页指纹/diffForms 三分检出/无变更全零/明细有界 total 诚实）、步骤→CLI 位置参数映射（click 不透传鼠标键/fill 双参/press 键值优先/未知空数组）、执行语义收敛（结果带 act/target/value 不误判 Blocked、断言按快照内容判定且失败钉「不放宽」）、浏览器通道环境适配（PVMCP_CLI_BROWSER 仅 open 注入/不设零变化）、采集 CSV 公式注入中和（r52：=/+/-/@ TAB CR 开头加 \' 前缀，与 db export_data 同口径）、推进检测纯函数 sameRows（r53：页内容逐行同判真未推进/首页无基准不误判）' },
  { name: '智能体线端到端（真浏览器）', file: 'mcp/test/nl-agent-e2e.mjs', assertions: 21, note: 'LLM 规划→goto/fill/click/断言/截图真执行、降级骨架、Fail 语义、巡检、表单指纹两期对比真跑（formsHash 变化/三分检出/diffAgainst 不可读诚实报错）', browser: true, needs: ['cli'] },
  // 全流程验证：两篇文章差异化能力（两层自愈、翻页采集）合入后，整条工具链串起来真跑
  {
    name: '全流程验证（工具链串联+自然语言真跑）', file: 'mcp/test/flow-check.mjs', assertions: 45,
    note: 'lint 门禁→自然语言真执行（两层自愈真回环）→翻页采集两期对比与断点续采（pagesScanned 本轮/pagesTotal 累计两口径）→巡检归因；断言绝不自愈、行数据只落盘、日志脱敏哨兵；计划缓存活体（同指纹命中 LLM 桩零新增请求且 tier-1 自愈照常/goal·url 变更现场重规划/llm=off skip/落盘报告 planCache 可审计）；计划缓存观测真 stdio 双调用（miss→hit→skip 三态落行、其余工具不落 cache= 字段）；r53 纯重复中间页两击制（一次同内容放行续采、F7 真未推进守门原语义保留）',
    browser: true, needs: ['cli'],
  },
  // 部署副本验证必须**独占末波**：它比对整棵树，任何并发写入（含刚写完还在落盘的）都会让它报假漂移。
  // 实测：排在中间时，紧跟 install 之后的第一次全量会假失败一次、第二次就正常 —— 典型的顺序竞态。
  // 一个会假失败的门禁比一个慢的门禁危险得多，所以这里用调度把它钉死（serial: true → planWaves 独占末波）。
  { name: '部署副本验证（须最后跑）', file: 'mcp/test/deployed-check.mjs', assertions: 30, note: '装完的副本能发现工具、真能调用、与源码逐文件一致、含浏览器插件桥/控制台/猫耳悬浮球与录制核（未安装时自动 SKIP）', serial: true },
];

/**
 * 三模式的「核心断言数」——不含 . 前缀钉（dotPins）、不含部署段（serial 套件）。
 * verify-all 的判据行与《部署说明》§15.3 都从这里对账（加固 H16/H22）：
 *   mode 1 = 非浏览器套件之和；mode 2 = mode 1 + 浏览器面套件的零依赖态部分执行数
 *   （带 needs 的整套诚实 SKIP 不计）；mode 3 = 全部非部署套件之和。
 *
 * @param {Array<object>} suites 套件清单（默认 SUITES）
 * @returns {{1: number, 2: number, 3: number}}
 */
export function coreCounts(suites = SUITES) {
  const core = suites.filter((s) => !s.serial);
  const c1 = core.filter((s) => !s.browser).reduce((n, s) => n + s.assertions, 0);
  const c2 = c1 + core.filter((s) => s.browser && !s.needs)
    .reduce((n, s) => n + (s.assertionsNoDep ?? s.assertions), 0);
  const c3 = core.reduce((n, s) => n + s.assertions, 0);
  return { 1: c1, 2: c2, 3: c3 };
}

/**
 * serial 段断言基数（r41）——所有 serial 套件声明断言之和，与 planWaves 的
 * `suites.filter((s) => s.serial)` 同一口径：每个 serial 各独占一波全都会跑，
 * 判据行的期望总数必须把它们**全算上**。
 *
 * 为什么存在（r41 解耦）：verify-all 判据行原先 `SUITES.find((s) => s.serial).assertions`
 * 硬取**第一个** serial —— 现拓扑只有 deployed-check（30）时数值碰巧对，一旦再加
 * serial 套件（planWaves 早已支持多 serial 各占一波），实跑 total 会把多跑的 serial
 * 全计入，期望值却只算第一个 → 判据行自己假红。判据基数从这里取，禁止 find 单取。
 *
 * @param {Array<object>} suites 套件清单（默认 SUITES）
 * @returns {number} serial 套件声明断言之和（无 serial 时 0）
 */
export function serialAssertions(suites = SUITES) {
  return suites.filter((s) => s.serial).reduce((n, s) => n + s.assertions, 0);
}

/**
 * 某套在给定环境下的期望 PASS 断言数。
 *
 * @param {object} suite 套件条目
 * @param {{ fullDeps?: boolean, noDeps?: boolean, pins?: number }} env
 *   fullDeps = @playwright/test 与 @playwright/cli 均可解析；noDeps = 均不可解析（纯净包口径）。
 *   pins = PIN_FILES 中实际在位的文件数（存在性钉按在位数生效，部分在位不假红）。
 *   混合态（只装一半）没实测过，返回 null —— 宁可不校验也不误报。
 * @returns {number|null} 期望 PASS 数；null 表示该态不校验
 */
export function expectedAssertions(suite, env = {}) {
  const full = !!env.fullDeps;
  const none = !!env.noDeps;
  if (full === none) return null;
  let n = full ? suite.assertions : (suite.assertionsNoDep ?? suite.assertions);
  if (suite.dotPins) n += Math.min(Number(env.pins) || 0, suite.dotPins);
  return n;
}

/**
 * 原生崩溃退出码 → 可读名（H27）。表里没有的码返回 null —— 调用方保持原「异常退出」措辞。
 *
 * Windows 的原生崩溃以 32 位退出码出现（0xC0000409 fail-fast 实测在并发波里打崩过套件），
 * 十进制 3221226505 与有符号 -1073740791 是同一个码 —— 无符号口径归一后同名，不看书写形式。
 * 只收录见过/文档化的码：没见过的名字编不出来也不该编（诚实优于好看）。
 */
const CRASH_NAMES = new Map([
  [0xC0000409, 'fail-fast/STATUS_STACK_BUFFER_OVERRUN'],
  [0xC0000005, 'ACCESS_VIOLATION'],
  [0xC00000FD, 'STACK_OVERFLOW'],
  [0x80000003, 'BREAKPOINT'],
  [134, 'SIGABRT'],
  [139, 'SIGSEGV'],
]);

export function crashLabel(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return null;
  const u = n >>> 0;
  const name = CRASH_NAMES.get(u);
  if (!name) return null;
  return `${u > 0xFFFF ? `0x${u.toString(16).toUpperCase()}` : u} ${name}`;
}

/**
 * 套件退出结果归类 —— 失败证据（尤其崩溃现场）不许丢。
 *
 * 实际踩过的坑：套件进程崩溃（Windows 0xC0000409 快速失败）时一行 FAIL 都没有，
 * 旧口径 detail 只剩「? 项失败（退出码 …）」、failedLines 取 FAIL 行取到空 ——
 * stderr 里的崩溃根因（FATAL ERROR / 堆栈）整段丢弃。门禁报了失败却没留证据，
 * 偶发崩溃永远查不出根因。所以：无 FAIL 行的异常退出必须把输出尾部
 * （stdout+stderr 合流后的最后 12 个非空行）作为取证带出来；有 FAIL 行时
 * FAIL 行优先 —— 断言取证不被尾部噪声顶掉。
 *
 * @param {number|null} code 进程退出码（0 = 通过）
 * @param {string} out stdout 累积
 * @param {string} err stderr 累积
 * @returns {{ ok: boolean, passCount: number, skipCount: number, detail: string, failedLines: string[] }}
 */
export function summarizeSuiteExit(code, out, err) {
  const lines = `${out}${err}`.split('\n');
  const failed = lines.filter((l) => l.trim().startsWith('FAIL'));
  const ok = code === 0;
  const passCount = lines.filter((l) => l.trim().startsWith('PASS')).length;
  // 套件内部诚实跳过的断言（缺可选依赖/前置数据）也要报出来 —— 不报就成了假绿
  const skipCount = lines.filter((l) => l.trim().startsWith('SKIP')).length;
  if (ok) {
    return {
      ok, passCount, skipCount,
      detail: `全部通过（${passCount} 项断言${skipCount ? `，${skipCount} 项 SKIP` : ''}）`,
      failedLines: [],
    };
  }
  if (failed.length) {
    return {
      ok, passCount, skipCount,
      detail: `${failed.length} 项失败（退出码 ${code}）`,
      failedLines: failed.map((l) => l.trim()),
    };
  }
  // 异常退出且无 FAIL 行：崩溃取证 —— 输出尾部（含 stderr）必须带出来。
  // 已知原生崩溃码再给可读名（H27）：「异常退出（退出码 3221226505）」没人看得出是
  // fail-fast 打崩的，光这一行分不清崩溃/断言失败/环境问题；具名一步到位。
  // 表里没有的码不编造名字，保持原措辞（诚实优于好看）。
  const label = crashLabel(code);
  return {
    ok, passCount, skipCount,
    detail: label
      ? `进程崩溃（${label}，无 FAIL 行）`
      : `异常退出（退出码 ${code}，无 FAIL 行）`,
    failedLines: lines.map((l) => l.trim()).filter(Boolean).slice(-12),
  };
}

/** 波内并发上限（H27 配套）：为什么是 4，见 planWaves 注释里的实测记录。 */
export const MAX_WAVE = 4;

/**
 * 波次调度：非 serial 套件按**并发帽**分波（同波内 --parallel 并发），serial 套件各自
 * 独占一波、按声明顺序殿后。波间严格串行 —— 末波的整树比对不能与任何写盘并发。
 * 分波保持声明顺序：串行模式逐波逐序 == 纯串行，行为不变。
 *
 * 为什么有帽（2026-10 实测复现台，8 跑 2 损伤）：--parallel 9~14 个 Node 进程同起的
 * 启动风暴 —— bridge-check 被 0xC0000409 fail-fast 打崩（0.3s 处、风暴期），protocol-check
 * 的 cli_health 最小闭环被并发挤兑假红（非代码回归）。帽=4：风暴压到 2.5× 以下，
 * 同时不退化成一队一波（并发收益保住）。
 *
 * @param {Array<object>} suites 套件清单（默认 SUITES）
 * @param {{maxWave?: number}} [opts] 每波并发上限（缺省 MAX_WAVE；非法值回退默认，不静默改语义）
 * @returns {Array<Array<object>>} 波次（每波一个数组）
 */
export function planWaves(suites = SUITES, { maxWave = MAX_WAVE } = {}) {
  const n = Number(maxWave);
  const cap = Number.isInteger(n) && n >= 1 ? n : MAX_WAVE;
  const rest = suites.filter((s) => !s.serial);
  const serials = suites.filter((s) => s.serial);
  const waves = [];
  for (let i = 0; i < rest.length; i += cap) waves.push(rest.slice(i, i + cap));
  for (const s of serials) waves.push([s]);
  return waves;
}

export default { SUITES, planWaves, coreCounts, serialAssertions, expectedAssertions, summarizeSuiteExit, crashLabel, PIN_FILES, MAX_WAVE };
