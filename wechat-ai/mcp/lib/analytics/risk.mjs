// I. 安全/风控分析：诈骗话术、敏感信息泄露、合规风险、异常行为。
// 红线：只输出风险线索（level=低|中|高），一律 needs_review=true，不直接定性违法；必须授权后才可分析。
import { truncate, maskPii, countBy, fmtLocal } from "./core.mjs";

const RULES = [
  // ---- 诈骗 ----
  { type: "诈骗", level: "高", id: "scam.invest", re: /稳赚|保本|高回报|高额返利|带你投资|带你赚|内幕消息|平台漏洞|博彩|刷单返利|返利[0-9]|杀猪盘|虚拟币.{0,8}(?:带单|跟单)|稳赚不赔/, desc: "高回报/带单/刷单类话术（常见诈骗模式）", action: "不转账、不点链接；核实对方身份并向平台/警方举报" },
  { type: "诈骗", level: "高", id: "scam.authority", re: /公检法|安全账户|涉嫌洗钱|涉嫌犯罪|通缉令|冻结账户|转到.{0,8}(?:安全|指定).{0,4}账户|配合调查.{0,8}(?:资金|转账)/, desc: "冒充公检法/要求转入安全账户", action: "立即挂断/停止沟通；拨打官方电话核实，必要时报警" },
  { type: "诈骗", level: "高", id: "scam.advance_fee", re: /解冻金|保证金|刷流水|先交.{0,6}(?:费|钱|保证金)|手续费.{0,6}(?:先|提前)|垫付.{0,8}(?:资金|货款|费用)|先.{0,4}垫付/, desc: "先交钱/垫付/解冻金类要求", action: "任何「先付钱才能拿钱」都按诈骗预案处理，不付款" },
  { type: "诈骗", level: "中", id: "scam.impersonate", re: /冒充|假装.{0,6}(?:领导|老板|客服|熟人)|(?:领导|老板).{0,8}(?:让|让).{0,6}(?:转账|打款|汇款)|我是.{0,8}客服/, desc: "冒充身份要求转账/操作", action: "用既有渠道（不是对方给的号码）二次核验身份" },
  { type: "诈骗", level: "中", id: "scam.phishing", re: /点击.{0,8}链接|输入.{0,6}(?:密码|验证码|卡号)|领取.{0,6}(?:补贴|退款|红包).{0,12}链接|注销.{0,6}(?:账户|校园贷)|影响征信/, desc: "诱导点击链接/输入敏感信息/注销账户", action: "不点陌生链接；官方 App/官网自行核实" },
  // ---- 敏感信息泄露 ----
  { type: "敏感信息泄露", level: "高", id: "pii.id_card", re: /(?<!\d)\d{17}[\dXx](?!\d)/, desc: "身份证号", action: "立即脱敏并提醒对方撤回/删除；检查是否被用于冒名" },
  { type: "敏感信息泄露", level: "高", id: "pii.bank_card", re: /(?<!\d)\d{16,19}(?!\d)/, desc: "疑似银行卡号（16-19 位）", action: "提醒不要在聊天中传递卡号；改用安全渠道" },
  { type: "敏感信息泄露", level: "中", id: "pii.phone", re: /(?<!\d)1[3-9]\d{9}(?!\d)/, desc: "手机号明文", action: "报告中脱敏；提醒对方注意隐私" },
  { type: "敏感信息泄露", level: "高", id: "pii.verify_code", re: /(?:验证码|校验码|动态码|短信码)[^\d]{0,6}\d{4,8}|\d{4,8}[^\d]{0,6}(?:验证码|校验码)/, desc: "验证码明文", action: "验证码绝不外发；若已发出，立即改密并检查账户" },
  { type: "敏感信息泄露", level: "高", id: "pii.password", re: /(?:密码|口令|pwd|password)\s*[:=：]?\s*\S{4,}/i, desc: "密码/口令明文", action: "立即改密；聊天中不再传递凭据" },
  { type: "敏感信息泄露", level: "中", id: "pii.address", re: /(?:住址|地址|我家住|收货地址)[：:]?\s*[\u4e00-\u9fa5]{2,20}(?:路|街|道|巷|小区|花园|大厦|苑|号楼|栋)/, desc: "详细住址", action: "报告中脱敏为地点层级；避免长期留存" },
  // ---- 合规 ----
  { type: "合规", level: "中", id: "comp.guarantee", re: /保证收益|保收益|承诺收益|稳赚不赔|零风险|兜底回购|刚兑/, desc: "收益/兜底类承诺（合规高风险）", action: "不作为事实引用；法务复核措辞" },
  { type: "合规", level: "中", id: "comp.kickback", re: /回扣|返点|好处费|疏通费|打点费|走账|虚开发票|两套账|避税方案|走私|偷税/, desc: "利益输送/税务风险词", action: "留证据链，交合规/法务人工复核，不自行定性" },
  { type: "合规", level: "低", id: "comp.insider", re: /内幕|内部消息|还没公开|保密.{0,6}(?:信息|材料)|别外传/, desc: "内幕/保密信息外传风险", action: "确认是否属于受控信息；必要时停止传播" },
  // ---- 异常行为 ----
  { type: "异常", level: "中", id: "abn.private_transfer", re: /走线下|私下转|别走平台|私人账户|绕开平台|现金交易/, desc: "绕开平台/私下资金往来", action: "警惕资金安全与合规风险；保留凭证并复核" },
  { type: "异常", level: "低", id: "abn.short_link", re: /https?:\/\/(?:t\.cn|dwz\.cn|bit\.ly|url\.cn|tinyurl\.com|suo\.im)\/\S+/i, desc: "短链（目标不可见）", action: "不直接点开；先展开/查杀后再访问" },
  { type: "异常", level: "低", id: "abn.delete_history", re: /撤回了|删除聊天记录|把.{0,8}记录删了|清空聊天记录|别留记录/, desc: "撤回/要求删除记录", action: "重要交易另行留痕；关注是否有规避证据意图" },
];

/**
 * 风控线索扫描。返回风险线索表（全部 needs_review=true）。
 * @param {{goal?:string,now?:Date}} opts goal 可限定重点（如「诈骗」「合规」）
 */
export function riskScan(messages, { goal = null, now = new Date(), limit = 50 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const risks = [];
  let seq = 0;
  for (const m of list) {
    const text = String(m?.content ?? "");
    if (!text.trim()) continue;
    for (const rule of RULES) {
      if (goal && !String(rule.type + rule.id + rule.desc).includes(goal) && !rule.re.source.includes(goal)) continue;
      if (!rule.re.test(text)) continue;
      seq += 1;
      risks.push({
        risk_id: `r${seq}`,
        type: rule.type,
        level: rule.level,
        rule_id: rule.id,
        description: rule.desc,
        chat: m.session_name ?? "未知",
        sender: m.is_owner ? "我" : (m.sender ?? "未知"),
        time: m.ts ? fmtLocal(new Date(m.ts)) : null,
        evidence_msg_ids: [m.id].filter(Boolean),
        evidence_text: maskPii(truncate(text.replace(/\s+/g, " "), 120)),
        suggested_action: rule.action,
        needs_review: true,
      });
    }
  }

  // 异常行为聚合：频繁转账 / 深夜资金 / 单日爆发
  const moneyMsgs = list.filter((m) => /转账|红包|还款|收款|付款|打款/.test(String(m.content ?? "")));
  const byParty = countBy(moneyMsgs, (m) => (m.is_owner ? (m.session_name ?? "未知") : (m.sender ?? "未知")));
  for (const [party, count] of byParty) {
    if (count >= 5) {
      seq += 1;
      risks.push({
        risk_id: `r${seq}`, type: "异常", level: "低", rule_id: "abn.frequent_transfer",
        description: `窗口内与「${party}」有 ${count} 条资金往来消息，频率偏高（仅统计线索）`,
        chat: String(party), sender: "-", time: null, evidence_msg_ids: [],
        evidence_text: "", suggested_action: "核对用途与凭证；如涉及借贷请走正规渠道", needs_review: true,
      });
    }
  }
  const nightMoney = moneyMsgs.filter((m) => {
    const h = m.ts ? new Date(m.ts).getHours() : -1;
    return h >= 23 || h < 5;
  });
  if (nightMoney.length >= 3) {
    seq += 1;
    risks.push({
      risk_id: `r${seq}`, type: "异常", level: "低", rule_id: "abn.night_money",
      description: `深夜（23:00-05:00）资金消息 ${nightMoney.length} 条，作息异常，建议关注`,
      chat: "-", sender: "-", time: null,
      evidence_msg_ids: nightMoney.slice(0, 5).map((m) => m.id).filter(Boolean),
      evidence_text: "", suggested_action: "确认是否本人操作；警惕深夜诱导转账", needs_review: true,
    });
  }

  risks.sort((a, b) => levelRank(b.level) - levelRank(a.level) || (a.risk_id < b.risk_id ? -1 : 1));
  return {
    goal,
    scanned: list.length,
    risks: risks.slice(0, limit),
    stats: {
      total: risks.length,
      by_level: Object.fromEntries([...countBy(risks, (r) => r.level)]),
      by_type: Object.fromEntries([...countBy(risks, (r) => r.type)]),
    },
    disclaimer: "本结果只是风险线索，不是违法/诈骗认定。所有条目 needs_review=true，必须人工复核；误报常见（如身份证号出现在体检报告转发里）。未获数据主体授权不得运行本分析。",
    caliber: "规则词 + 正则匹配 + 资金消息聚合；证据片段已脱敏（手机号/身份证/卡号/验证码打码）。",
  };
}

function levelRank(level) {
  return { 高: 3, 中: 2, 低: 1 }[level] ?? 0;
}
