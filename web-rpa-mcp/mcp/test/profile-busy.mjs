// 测试套件「profile 争用诚实化」纯分类器（可注入文本+pid，唯一语义落点）：
// 回放类用例撞 PROFILE_BUSY（浏览器 profile 正被另一个执行占用）时按锁持有者 pid 分流——
// 持有者≠本进程 = 其它会话的浏览器流（v1.5.18 轮三次实锤：外部流按 6-8 分钟间隔拿锁，
// 58 个回放用例连坐假红，失败集合两次逐字节相同）→ 诚实 SKIP（环境让行，不计失败）；
// 持有者=本进程 = 自己套件内的锁泄漏，照旧 FAIL（防产品锁泄漏被 SKIP 洗白成假绿）。
// 文本匹配面=抛出的错误消息 + 用例期间 console 输出（'fail' !== 'pass' 型断言的错误详情
// 只打在回放日志里、不进异常消息）。签名取自 browser.mjs 的 PROFILE_BUSY 错误原文。
export const PROFILE_BUSY_RE = /浏览器 profile 正被另一个执行占用（pid (\d+)，/;

export function classifyProfileBusy(text, selfPid = process.pid) {
  const m = PROFILE_BUSY_RE.exec(String(text || ''));
  if (!m) return { busy: false, holder: null, external: false };
  const holder = Number(m[1]);
  return { busy: true, holder, external: holder !== selfPid };
}
