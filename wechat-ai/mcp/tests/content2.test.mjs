// 内容级口径（第二批，上游 GROUP_DIGEST 与机会候选）
// 重点钉死「否定式/上下文式」判定：娱乐群/闲聊群不能被误判为重点，
// 群内日报/纯加热/系统消息不能进入证据。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "content2-"));
process.env.WECHAT_AI_HOME = ROOT;

let passed = 0, failed = 0;
const fails = [];
const t = async (name, fn) => {
  try { await fn(); passed += 1; console.log("  ✓ " + name); }
  catch (e) { failed += 1; fails.push(name + " :: " + (e?.message ?? e)); console.log("  ✗ " + name + " :: " + (e?.message ?? e)); }
};
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m ?? "不相等") + "：期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); };
const ok = (v, m) => { if (!v) throw new Error(m ?? "断言失败"); };

const S = await import(new URL("../lib/signals.mjs", import.meta.url).href);
const md = await import(new URL("../lib/report/md.mjs", import.meta.url).href);
const opp = await import(new URL("../lib/opportunities.mjs", import.meta.url).href);

const now = Date.now(); const H = 3600_000;
const M = (chat, sender, h, content, links = [], isOwner = false) => ({ session_name: chat, sender, ts: now - h * H, content, is_owner: isOwner, links });
const W = { sinceMs: now - 48 * H, untilMs: now + H };

// =====================================================================================
console.log("1) 可行动类别：否定式/上下文式判定");

const catCases = [
  ["大单来了！LLM Campaign 现已开放申请，报名从速", ["商单"]],
  ["最近还有投放广告，有一大笔预算，私信我", ["商单"]],
  ["[招募] VibeHacks #05 报名开启，欢迎报名参加活动", ["活动"]],
  ["今晚足球赛谁看，比分预测一下", []],
  ["场地大，保底就 108 个人参与了", []],
  ["如果允许读取之前的所有商单，我就能分析了", []],
  ["帮我找 IT 开发安装一个东西", []],
  ["短平快项目，收益破千", ["赚钱/奖励"]],
  ["最近有个企业AI培训项目，需要找一位讲师", ["培训"]],
  ["这是企业培训的公司给我配的编导", []],
  ["这个账号后台报价40w一条广告", []],
];
await t("可行动类别：12 条否定/肯定用例全部符合上游", async () => {
  for (const [text, expect] of catCases) {
    const got = S.discussionCategories(text);
    for (const e of expect) ok(got.includes(e), JSON.stringify(text.slice(0, 22)) + " 应含 " + e + "，实际 " + JSON.stringify(got));
    for (const g of got) ok(expect.includes(g), JSON.stringify(text.slice(0, 22)) + " 不应含 " + g + "，期望 " + JSON.stringify(expect));
  }
});

await t("招聘/外包：活动/招募但无明确用工词时不误判", async () => {
  // 「招募 AI 博主」既含招募又含需要，可同时是商单+招聘信号，这里只验不出现纯招聘误判
  ok(!S.discussionCategories("[招募] VibeHacks #05 报名开启").includes("招聘/外包"), "活动报名不应判成招聘");
  ok(S.discussionCategories("急招 AI 方向运营，简历私我").includes("招聘/外包"), "急招…简历应是招聘");
});

// =====================================================================================
console.log("\n2) 群聊价值矩阵：分级不能把娱乐/闲聊群判成重点");

async function matrixFor(groups) {
  const a = S.analyze({ messages: groups.flat(), ...W });
  const outDir = path.join(ROOT, "mx-" + Math.random().toString(36).slice(2, 8));
  const files = await md.renderGroupDaily(a, { since: "s", until: "u", outDir, links: a.links, coverage: a.coverage });
  const mx = JSON.parse(fs.readFileSync(files.matrixJson, "utf8"));
  return new Map(mx.groups.map((g) => [g["群聊"], g]));
}

await t("商业群（真实商单）→ 商业与合作 / 重点", async () => {
  const mx = await matrixFor([[M("商业群", "品牌方", 3, "大单来了！LLM Campaign 现已开放申请"), M("商业群", "组织者", 2, "品牌方招募 AI 博主，预算 3000 元，需要主页数据")]]);
  const g = mx.get("商业群");
  eq(g["群聊类型"], "商业与合作");
  eq(g["建议关注级别"], "重点");
});

await t("运动群（比分+保底108人）→ 低价值娱乐/闲聊 / 低优先级", async () => {
  const mx = await matrixFor([[M("运动群", "球友", 3, "今晚足球赛谁看，比分预测一下"), M("运动群", "球友2", 2, "场地大，保底就 108 个人参与了")]]);
  const g = mx.get("运动群");
  eq(g["群聊类型"], "低价值娱乐/闲聊", "类型=" + g["群聊类型"]);
  eq(g["建议关注级别"], "低优先级", "级别=" + g["建议关注级别"]);
});

await t("闲聊群（假设语气+找IT）不被判成重点", async () => {
  const mx = await matrixFor([[M("闲聊群", "某人", 3, "如果允许读取之前的所有商单，我就能分析了"), M("闲聊群", "某人2", 2, "帮我找 IT 开发安装一个东西")]]);
  const g = mx.get("闲聊群");
  ok(g["建议关注级别"] !== "重点", "闲聊群不应是重点，实际 " + g["建议关注级别"]);
  ok(g["群聊类型"] !== "商业与合作", "闲聊群不应是商业与合作，实际 " + g["群聊类型"]);
});

await t("群内日报被排除 → 有效讨论数下降、不产生商单信号", async () => {
  const a = S.analyze({
    messages: [M("日报群", "发布者", 3, "9月18日 微信群聊日报"), M("日报群", "群友", 2, "这个日报做得不错")],
    ...W,
  });
  const s0 = a.sessions.find((x) => x.name === "日报群");
  ok(s0.recap_count >= 1, "应识别出群内日报");
  eq(s0.actionable["商单"], 0, "日报不应产生商单信号");
  ok(s0.effective <= 1, "有效讨论数应排除日报：" + s0.effective);
});

await t("纯加热（三连/已三连）不计入证据", async () => {
  const a = S.analyze({
    messages: [M("加热群", "甲", 3, "Topview商单求加热，三连2元"), M("加热群", "乙", 2, "三连"), M("加热群", "丙", 1, "已三连")],
    ...W,
  });
  const s0 = a.sessions.find((x) => x.name === "加热群");
  ok(s0.boost_count >= 2, "三连/已三连 应计为纯互动：" + s0.boost_count);
  eq(s0.actionable["商单"], 0, "求加热的协调消息不应产生商单讨论信号");
});

// =====================================================================================
console.log("\n3) 机会候选：系统消息与叙述句不产生候选");

const cand = (msgs) => opp.buildCandidates(msgs);
await t("红包/转账系统消息不产生候选", async () => {
  const msgs = [
    M("系统群", "微信", 3, "你收到一个红包，请在手机上查看", [], true),
    { session_name: "系统群", sender: "微信", ts: now - 2 * H, content: "[转账] 你发起了一笔转账", is_owner: true, links: [] },
  ];
  eq(cand(msgs).length, 0, "系统消息不应产生候选：" + JSON.stringify(cand(msgs).map((c) => c.content)));
});
await t("「后台报价40w一条广告」是叙述，不产生候选", async () => {
  const msgs = [M("叙述群", "甲", 3, "这个账号后台报价40w一条广告，真夸张")];
  eq(cand(msgs).length, 0, JSON.stringify(cand(msgs)));
});
await t("「公司给我配的编导」是叙述，不产生候选", async () => {
  const msgs = [M("叙述群", "甲", 3, "这是企业培训的公司给我配的编导")];
  eq(cand(msgs).length, 0, JSON.stringify(cand(msgs)));
});
await t("企业AI培训找讲师 → 1 个候选，类型培训", async () => {
  const msgs = [M("培训群", "甲", 3, "最近有个企业AI培训项目，需要找一位讲师")];
  const c = cand(msgs);
  eq(c.length, 1, JSON.stringify(c));
  ok(/培训/.test(c[0].opportunity_type), "type=" + c[0].opportunity_type);
});
await t("品牌方招募AI博主预算3000元 → amount 含 3000 元", async () => {
  const msgs = [M("招募群", "品牌方", 3, "品牌方招募 AI 博主，预算 3000 元，需要主页数据")];
  const c = cand(msgs);
  ok(c.length >= 1 && /3000/.test(c[0].amount ?? ""), "amount=" + JSON.stringify(c.map((x) => x.amount)));
});
await t("Topview商单求加热三连2元 → amount 为空（加热奖励不算报价）", async () => {
  const msgs = [M("加热报价群", "甲", 3, "Topview商单求加热，三连2元", ["https://example.com/topview"])];
  const c = cand(msgs);
  ok(c.length >= 1, "应有候选");
  ok(!(c[0].amount ?? "").trim(), "amount 应为空：" + JSON.stringify(c[0].amount));
});

console.log("\n" + "=".repeat(50));
if (fails.length) {
  console.log("失败项：");
  for (const f of fails) console.log("  ✗ " + f);
  console.log("");
}
console.log("=== " + passed + " passed, " + failed + " failed ===");
try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 }); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
