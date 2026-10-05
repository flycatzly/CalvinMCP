// E. 财务与消费记录：转账/红包/AA/收付款/购物/账单抽取与月度统计。
// 红线：不提供任何投资、借贷、理财建议；金额默认只给区间（showAmounts 才给精确值）；只做记录与趋势。
import { evidence, round, fmtDay, truncate, maskPii } from "./core.mjs";

const AMOUNT_RE = /(\d[\d,.]*)\s*(万|w|W|k|K|元|块|RMB|rmb|人民币|美元|USD|usd|美金|刀|\$)/g;
const CN_AMOUNT_RE = /([一二三四五六七八九十百千万两]+)\s*(万|元|块|k|K)/g;
const FINANCE_RE = /转账|红包|收款|付款|已付|已收|打款|汇款|还款|还你|转给你|转我|给你转|给我转|AA|平摊|份子钱|随礼|账单|报销|定金|尾款|订金|押金|优惠|买了|下单|零钱|提现|扫(?:码)?(?:付|收款)|二维码收款|没还|欠着|欠款|借款|借钱|还钱/;
const REDPACKET_RE = /红包|恭喜发财|领取了?红包|开红包/;
const AA_RE = /AA|平摊|均摊|各付各|一人一半|对半/;
const SHOP_RE = /买了|下单|购物|淘宝|京东|拼多多|链接.{0,10}(?:买|拍)|付款链接|拍下/;
const BILL_RE = /账单|缴费|房租|水电|物业|话费|续费|年费|月供|学费|保险/;
const OUT_RE = /转你|发你|付你|已付|给你转|替你付|垫付|先付/;
const IN_RE = /转我|发我|还我|收到|回款|入账|报销(?:下来|到账)|退回/;
const UNRETURNED_RE = /还没(?:还|给|转)|未还|欠(?:着|你|我)|待还|回头还|明天还|下周还|过两天还|先欠/;
const RETURNED_RE = /已还|还了|还你了|结清|已结清|两清/;
const SUSPICIOUS_RE = /走线下|私下转|别告诉|保密|避税|绕开|走私人账户|稳赚|保本|高回报|内部渠道/;

const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000, 万: 10000 };

function cnToNumber(s) {
  let total = 0, section = 0, num = 0;
  for (const ch of String(s)) {
    const v = CN_NUM[ch];
    if (v === undefined) continue;
    if (v >= 10) {
      if (num === 0) num = 1;
      if (v === 10000) { section = (section + num) * v; total += section; section = 0; }
      else section += num * v;
      num = 0;
    } else num = v;
  }
  return total + section + num;
}

/** 解析金额：返回 [{value, currency, text}]；万/k 换算成基本单位，中文数字识别 */
export function parseAmounts(text) {
  const out = [];
  const t = String(text ?? "");
  for (const m of t.matchAll(AMOUNT_RE)) {
    const raw = String(m[1]).replace(/,/g, "");
    let value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const unit = m[2];
    if (/万/.test(unit)) value *= 10000;
    else if (/[kK]/.test(unit)) value *= 1000;
    const currency = /美元|USD|usd|美金|刀|\$/.test(unit) ? "USD" : "CNY";
    out.push({ value: round(value, 2), currency, text: `${m[1]}${unit}`.replace(/\s+/g, "") });
  }
  for (const m of t.matchAll(CN_AMOUNT_RE)) {
    let value = cnToNumber(m[1]);
    if (/万/.test(m[2])) value *= 10000;
    else if (/[kK]/.test(m[2])) value *= 1000;
    if (value > 0) out.push({ value: round(value, 2), currency: "CNY", text: `${m[1]}${m[2]}` });
  }
  return out;
}

export function amountBand(value) {
  if (value < 50) return "0-50";
  if (value < 200) return "50-200";
  if (value < 1000) return "200-1000";
  if (value < 5000) return "1000-5000";
  if (value < 20000) return "5000-20000";
  return "20000+";
}

function classifyCategory(text) {
  if (/饭|外卖|火锅|奶茶|咖啡|餐|烧烤|宵夜/.test(text)) return "餐饮";
  if (/打车|地铁|高铁|机票|火车|油费|停车|公交|高速/.test(text)) return "交通";
  if (SHOP_RE.test(text)) return "购物";
  if (/房租|水电|物业|网费|月供/.test(text)) return "住房";
  if (/红包|份子|随礼|礼物|生日|人情/.test(text)) return "人情";
  if (/电影|游戏|门票|旅行|演唱会|剧本杀|健身/.test(text)) return "娱乐";
  if (/借|还|欠|贷/.test(text)) return "借贷";
  if (/话费|套餐|宽带|续费|会员/.test(text)) return "订阅";
  if (/学费|课程|培训|书/.test(text)) return "学习";
  return "其他";
}

function classifyType(text) {
  if (REDPACKET_RE.test(text)) return "红包";
  if (AA_RE.test(text)) return "AA";
  if (BILL_RE.test(text)) return "账单";
  if (SHOP_RE.test(text)) return "购物";
  if (/收(?:款|到|回款|入账)|回款|入账/.test(text)) return "收款";
  if (/付款|付(?:了)?款|已付|打款|汇款|转你|发你|给你转/.test(text)) return "付款";
  return "转账";
}

/**
 * 财务流水与月度统计。
 * @param {{showAmounts?:boolean}} opts showAmounts=false 时金额给区间（默认，保护敏感金额）
 */
export function financeLedger(messages, { now = new Date(), showAmounts = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const entries = [];
  const suspicious = [];
  let seq = 0;
  for (const m of list) {
    const text = String(m?.content ?? "");
    if (!FINANCE_RE.test(text)) continue;
    const amounts = parseAmounts(text);
    if (!amounts.length) continue;
    seq += 1;
    const author = m.is_owner ? "我" : (m.sender ?? "未知");
    // 交易对手（相对我的口径）：私聊取对端名字，群聊里我发言时取「群内」、他人发言时取发言者
    const counterparty = m.is_owner
      ? (m.session_kind === "group" ? "群内" : (m.session_name ?? "未知"))
      : (m.sender ?? m.session_name ?? "未知");
    let direction = "未知";
    if (m.is_owner) direction = OUT_RE.test(text) ? "我付" : IN_RE.test(text) ? "我收" : "未知";
    else direction = OUT_RE.test(text) ? "我收" : IN_RE.test(text) ? "我付" : "未知";
    const amount = amounts[0];
    const status = UNRETURNED_RE.test(text) ? "未还" : RETURNED_RE.test(text) ? "已还" : "未知";
    entries.push({
      entry_id: `f${seq}`,
      date: m.ts ? fmtDay(new Date(m.ts)) : null,
      ts: m.ts ?? null,
      type: classifyType(text),
      amount: amount.value,
      currency: amount.currency,
      amount_text: amount.text,
      amount_band: amountBand(amount.value),
      direction,
      counterparty,
      author,
      category: classifyCategory(text),
      status,
      source_msg_id: m.id ?? null,
      raw: truncate(maskPii(text.replace(/\s+/g, " ")), 100),
    });
    if (SUSPICIOUS_RE.test(text)) {
      suspicious.push({ reason: "话术命中风险词（线下/保密/高回报等），仅线索需人工复核", entry_id: `f${seq}`, evidence: evidence(m, { limit: 100 }) });
    }
  }

  // 月度收支（只统计「我付/我收」方向明确的；未知方向单独计数）
  const monthly = new Map();
  for (const e of entries) {
    const month = (e.date ?? "").slice(0, 7) || "未知";
    if (!monthly.has(month)) monthly.set(month, { month, income: 0, expense: 0, unknown: 0, count: 0 });
    const row = monthly.get(month);
    row.count += 1;
    if (e.direction === "我收") row.income += e.amount;
    else if (e.direction === "我付") row.expense += e.amount;
    else row.unknown += e.amount;
  }
  const monthlyRows = [...monthly.values()]
    .sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((r) => ({ ...r, income: round(r.income, 2), expense: round(r.expense, 2), unknown: round(r.unknown, 2), net: round(r.income - r.expense, 2) }));

  // 高频交易对象
  const party = new Map();
  for (const e of entries) {
    const key = e.counterparty ?? "未知";
    if (!party.has(key)) party.set(key, { name: key, count: 0, income: 0, expense: 0 });
    const row = party.get(key);
    row.count += 1;
    if (e.direction === "我收") row.income += e.amount;
    if (e.direction === "我付") row.expense += e.amount;
  }
  const topParties = [...party.values()].sort((a, b) => b.count - a.count || b.expense - a.expense).slice(0, 10)
    .map((r) => ({ ...r, income: round(r.income, 2), expense: round(r.expense, 2) }));

  // 类别汇总
  const cat = new Map();
  for (const e of entries) {
    if (!cat.has(e.category)) cat.set(e.category, { category: e.category, count: 0, amount: 0 });
    cat.get(e.category).count += 1;
    cat.get(e.category).amount += e.amount;
  }
  const categories = [...cat.values()].sort((a, b) => b.amount - a.amount).map((r) => ({ ...r, amount: round(r.amount, 2) }));

  // 异常线索：大额（>3 倍中位且 >=1000）、高频（同对象 >=5 笔）、未还悬置
  const amounts = entries.map((e) => e.amount).sort((a, b) => a - b);
  const median = amounts.length ? amounts[Math.floor(amounts.length / 2)] : 0;
  for (const e of entries) {
    if (median && e.amount >= 1000 && e.amount > median * 3) {
      suspicious.push({ reason: `大额支出（${e.amount_band}，中位 ${amountBand(median)} 的 3 倍以上），建议核对`, entry_id: e.entry_id, evidence: null });
    }
  }
  for (const p of topParties) {
    if (p.count >= 5) suspicious.push({ reason: `与「${p.name}」在窗口内有 ${p.count} 笔往来，频率偏高，建议核对用途`, entry_id: null, evidence: null });
  }
  for (const e of entries.filter((x) => x.status === "未还")) {
    suspicious.push({ reason: `未还悬置：${e.counterparty} ${e.amount_band}（${e.date ?? "-"}）`, entry_id: e.entry_id, evidence: null });
  }

  return {
    entries: showAmounts ? entries : entries.map((e) => {
      const { amount, amount_text, ...rest } = e;
      return rest; // 默认脱敏：精确金额不外发，只留区间
    }),
    monthly: monthlyRows,
    top_counterparties: topParties,
    categories,
    suspicious,
    totals: {
      entries: entries.length,
      income: round(monthlyRows.reduce((a, b) => a + b.income, 0), 2),
      expense: round(monthlyRows.reduce((a, b) => a + b.expense, 0), 2),
      unknown_direction: round(monthlyRows.reduce((a, b) => a + b.unknown, 0), 2),
      show_amounts: !!showAmounts,
    },
    caliber: "金额解析：数字/中文数字 + 元/万/k/货币单位；方向按发言者与收付词推断，「未知」不计入收支；默认脱敏为区间（showAmounts=true 才给精确值）。不提供任何投资/借贷/理财建议。",
  };
}
