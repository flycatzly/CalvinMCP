// mock Reader：内置虚构演示数据（不含任何真实聊天），用于零数据验证全链路
import { minMax } from "../util.mjs";
import { envelope, paginate, sortByTime, toReaderMessage } from "./common.mjs";

const H = 3600_000;
const D = 86400_000;

/** 构造相对当前时间的演示数据，保证 24/48 小时窗口内总有信号 */
export function buildDemoMessages(now = new Date()) {
  const t = (daysAgo, hour, minute) => {
    const d = new Date(now.getTime() - daysAgo * D);
    d.setHours(hour, minute, 0, 0);
    return d.getTime();
  };
  const raw = [
    // —— NovaAI：商单私聊，含待回复 + 承诺 ——
    ["NovaAI", "NovaAI", t(2, 10, 12), "你好，想咨询一下你 X thread 的合作报价，7 月初有一个 campaign"],
    ["NovaAI", "我", t(2, 10, 16), "可以，麻烦发一下 brief、产品介绍和预期发布时间"],
    ["NovaAI", "NovaAI", t(2, 11, 25), "预算 650 USD，想这周五发布，可以先给一个 quote repost 和 thread 两个档位吗？"],
    ["NovaAI", "我", t(2, 11, 40), "收到，我今天晚些把两个档位的报价整理给你"],
    ["NovaAI", "NovaAI", t(1, 9, 5), "另外能不能加一个 quote 转推的加热包？我们希望能有个组合价"],
    ["NovaAI", "我", t(1, 9, 30), "组合价我明天上午给你，今天先确认前两个档位"],
    ["NovaAI", "NovaAI", t(0, 8, 40), "早上好，组合价那边有结论了吗？我们内部今天要过预算"],

    // —— QuantClub：AI 量化活动推广，初稿截止 ——
    ["QuantClub", "QuantClub", t(2, 13, 40), "老板在吗，我们这边 AI 量化活动想找你推广，今晚能确认排期吗"],
    ["QuantClub", "QuantClub", t(2, 14, 5), "brief 已发你邮箱，主要要求是不要太硬广，周四前需要初稿"],
    ["QuantClub", "我", t(2, 14, 20), "排期可以，初稿我周四中午前发你"],
    ["QuantClub", "QuantClub", t(0, 10, 2), "初稿有进展吗？我们市场部周五要审"],

    // —— OldBrand：结算 ——
    ["OldBrand", "OldBrand", t(3, 17, 20), "上次发布数据不错，麻烦发一下 invoice，我们这周安排结算"],
    ["OldBrand", "我", t(3, 17, 45), "好的，我整理一下数据一起发你"],
    ["OldBrand", "OldBrand", t(0, 11, 15), "invoice 收到了吗？财务这边今天要走流程"],

    // —— Web3 Alpha 群：跨群投放线索 + 加热 ——
    ["Web3 Alpha 群", "群友A", t(1, 19, 45), "有项目方找 KOL 做投放，预算 3000-5000 RMB，AI/Web3 方向优先 https://example.com/campaign-brief"],
    ["Web3 Alpha 群", "群友B", t(1, 19, 52), "同一条 brief 我在另一个群也看到了 https://example.com/campaign-brief"],
    ["Web3 Alpha 群", "群友C", t(1, 20, 10), "转发领红包，三连加热一下就行"],
    ["Web3 Alpha 群", "我", t(1, 21, 0), "我这边可以接 AI 方向的，方便的话帮我引荐一下对接人"],

    // —— AI KOL 资源群：品牌方招募 + 图片附件 ——
    ["AI KOL 资源群", "资源君", t(1, 20, 10), "有个品牌方在找 AI 自媒体博主合作，发红包给大家转推加热，有人想接的话我可以推荐 [图片]"],
    ["AI KOL 资源群", "群友D", t(1, 20, 25), "预算多少？"],
    ["AI KOL 资源群", "资源君", t(1, 20, 40), "预算 8000，需要提供主页和数据，下周三前出片 https://example.com/brand-req"],
    ["AI KOL 资源群", "群友E", t(1, 21, 5), "这个我上次合作过，结款挺慢的"],

    // —— 客户群-澄明科技：客户需求 ——
    ["客户群-澄明科技", "王工", t(1, 9, 10), "我们想在 9 月做一场内部 AI 培训，想先了解你们的课程大纲和报价"],
    ["客户群-澄明科技", "我", t(1, 9, 40), "好的，我整理一版大纲和报价，本周内发你"],
    ["客户群-澄明科技", "王工", t(0, 9, 20), "大纲这块大概什么时候能给？我们要先报预算"],
    ["客户群-澄明科技", "李经理", t(0, 9, 35), "另外能不能先安排一次线上试讲，听众大概 30 人"],

    // —— 项目交付群：初稿/终稿 ——
    ["项目交付群-Aurora", "项目经理", t(2, 15, 0), "初稿今天能出吗？客户周三要看"],
    ["项目交付群-Aurora", "我", t(2, 15, 30), "今晚 8 点前给你初稿"],
    ["项目交付群-Aurora", "项目经理", t(1, 10, 0), "初稿收到了，客户提了 3 个修改点，终稿周五前"],
    ["项目交付群-Aurora", "设计师", t(1, 10, 30), "配图我这边明天给 [文件]"],
    ["项目交付群-Aurora", "项目经理", t(0, 8, 50), "终稿别忘了，周五上午要交付"],

    // —— 培训合作群：讲师招募 ——
    ["培训合作群", "渠道老张", t(1, 14, 0), "有一家企业内训需要 AI 方向讲师，2 天课程，8 月中，预算可谈，需要大纲和试讲"],
    ["培训合作群", "我", t(1, 14, 30), "我这边可以，麻烦把企业背景和听众构成发我"],
    ["培训合作群", "渠道老张", t(0, 12, 0), "企业背景发你了，另外他们想先看一版课程大纲"],

    // —— 生活闲聊群：低价值但活跃 ——
    ["周末爬山群", "邻居A", t(0, 7, 30), "今天天气不错，有人去爬山吗"],
    ["周末爬山群", "邻居B", t(0, 7, 45), "我下午有空，几点集合"],
    ["周末爬山群", "邻居C", t(0, 8, 0), "带娃一起去，中午吃农家乐"],

    // —— 复联候选：长期未联系 ——
    ["老客户-云帆", "云帆-刘总", t(52, 16, 0), "上次合作很愉快，后面有合适项目再联系"],
    ["老客户-云帆", "我", t(52, 16, 20), "好的刘总，随时联系"],
  ];
  return raw.map(([chat, sender, ts, content]) => toReaderMessage({ chat, sender, ts, content, is_owner: sender === "我" }, { chat }));
}

export function createMockReader({ now = new Date() } = {}) {
  let data = null;
  const get = () => {
    if (!data) data = buildDemoMessages(now);
    return data;
  };
  const byChat = () => {
    const m = new Map();
    for (const x of get()) {
      if (!m.has(x.chat)) m.set(x.chat, []);
      m.get(x.chat).push(x);
    }
    return m;
  };
  const A = "demo-reader";
  return {
    id: "mock",
    kind: "mock",
    isDemo: true,
    describe: () => ({ reader: "mock", messages: get().length, sessions: byChat().size, note: "虚构演示数据，可用于零数据验证" }),
    version: async () => envelope({ tool: A, command: "version", data: { version: "1.0.0", reader: "mock", protocol: "wechat-reader/1" } }),
    status: async () => envelope({ tool: A, command: "status", data: { state: "ready", reader: "mock", decrypted_dir: "(demo)", message_count: get().length, session_count: byChat().size, detail: "演示数据：完全虚构，不含真实聊天" } }),
    sessions: async ({ limit = 80, typeFilter } = {}) => {
      const kinds = typeFilter ? String(typeFilter).split(",").map((x) => x.trim()) : null;
      const rows = [...byChat().entries()].map(([name, msgs]) => {
        const { min, max } = minMax(msgs.map((m) => m.ts));
        return {
          name, kind: /群/.test(name) ? "group" : "private", message_count: msgs.length,
          first_ts: min, last_ts: max,
        };
      }).filter((s) => !kinds || kinds.includes(s.kind)).sort((a, b) => b.last_ts - a.last_ts);
      return envelope({ tool: A, command: "sessions", data: { sessions: rows.slice(0, limit) } });
    },
    resolveChat: async (name, { typeFilter } = {}) => {
      const q = String(name ?? "");
      let hits = [...byChat().keys()].filter((k) => k === q || k.includes(q));
      if (typeFilter) hits = hits.filter((k) => (/群/.test(k) ? "group" : "private") === typeFilter);
      if (!hits.length) return envelope({ tool: A, command: "resolve-chat", ok: false, data: { state: "not_found", candidates: [] } });
      return envelope({ tool: A, command: "resolve-chat", data: { chat: hits[0], talker: hits[0], kind: /群/.test(hits[0]) ? "group" : "private", ambiguous: hits.length > 1, candidates: hits.slice(0, 10) } });
    },
    timeline: async (talker, { limit = 200, offset = 0, displayOrder = "asc", since, before } = {}) => {
      const m = byChat();
      const key = [...m.keys()].find((k) => k === talker) ?? [...m.keys()].find((k) => k.includes(String(talker)));
      if (!key) return envelope({ tool: A, command: "timeline", ok: false, data: { messages: [] } });
      let rows = sortByTime(m.get(key), displayOrder === "desc" ? "desc" : "asc");
      if (since) { const x = Date.parse(since); if (!Number.isNaN(x)) rows = rows.filter((r) => (r.ts ?? 0) >= x); }
      if (before) { const x = Date.parse(before); if (!Number.isNaN(x)) rows = rows.filter((r) => (r.ts ?? 0) <= x); }
      const p = paginate(rows, { limit, offset });
      return envelope({ tool: A, command: "timeline", data: { talker: key, chat: key, messages: p.rows, query: p.query } });
    },
    members: async (chatroomId, { limit = 500 } = {}) => {
      const m = byChat();
      const key = [...m.keys()].find((k) => k.includes(String(chatroomId)));
      if (!key) return envelope({ tool: A, command: "members", ok: false, data: { members: [] } });
      const seen = new Map();
      for (const x of m.get(key)) {
        if (!seen.has(x.sender)) seen.set(x.sender, { name: x.sender, id: null, message_count: 0 });
        seen.get(x.sender).message_count += 1;
      }
      return envelope({ tool: A, command: "members", data: { chat: key, members: [...seen.values()].slice(0, limit) } });
    },
    search: async (keyword, { limit = 100, offset = 0, maxTextChars = 240, inChat, after, before } = {}) => {
      const kws = String(keyword).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
      let rows = get().filter((m) => kws.every((k) => m.content.toLowerCase().includes(k)));
      if (inChat) rows = rows.filter((m) => m.chat.includes(inChat));
      if (after) { const x = Date.parse(after); if (!Number.isNaN(x)) rows = rows.filter((m) => m.ts >= x); }
      if (before) { const x = Date.parse(before); if (!Number.isNaN(x)) rows = rows.filter((m) => m.ts <= x); }
      rows = sortByTime(rows, "desc");
      const p = paginate(rows, { limit, offset });
      return envelope({ tool: A, command: "search", data: { keyword, messages: p.rows.map((m) => ({ ...m, content: m.content.slice(0, maxTextChars) })), query: p.query } });
    },
    stats: async () => {
      const m = byChat();
      const perChat = [...m.entries()].map(([name, msgs]) => ({ chat: name, talker: name, messages: msgs.length }));
      return envelope({
        tool: A, command: "stats",
        data: {
          reader: "mock", sessions: m.size, contacts: new Set(get().map((x) => x.sender)).size,
          total_messages: get().length, message_database_count: 1, message_table_count: m.size,
          top_chats: perChat.sort((a, b) => b.messages - a.messages).slice(0, 20),
          note: "演示数据：完全虚构，不含任何真实聊天",
        },
      });
    },
    sql: async () => envelope({ tool: A, command: "sql", ok: false, data: { rows: [], error: "mock reader 不支持 sql" } }),
  };
}
