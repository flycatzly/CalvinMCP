# wechat-ai — 内部接口契约（实现者必读）

零依赖 Node ESM（Node ≥ 22，实测 24）。只用 `node:` 内置模块。所有文件 UTF-8、中文注释。

## 目录

```
wechat-ai/mcp/
  server.mjs                 # MCP stdio JSON-RPC 服务器（工具注册与路由）
  selftest.mjs               # 断言自检，输出 "=== N passed, M failed ==="
  lib/
    paths.mjs util.mjs timewin.mjs duedate.mjs store.mjs config.mjs profile.mjs
    parse.mjs inbox.mjs ingest.mjs signals.mjs opportunities.mjs views.mjs
    analytics/ core.mjs report.mjs content.mjs social.mjs sentiment.mjs tasks.mjs
               finance.mjs memory.mjs team.mjs risk.mjs render.mjs
    report/md.mjs report/html.mjs report/security.mjs report/bundle.mjs
    wechat/ scenes.mjs targets.mjs obsidian.mjs skills-catalog.mjs delivery.mjs history.mjs batch.mjs
    security.mjs access.mjs replystyle.mjs
    reader/ common.mjs index.mjs local.mjs vault.mjs cli.mjs sqlite.mjs wcdb.mjs mock.mjs
```

## 已完成模块（可直接 import，勿修改签名）

### paths.mjs
`home()`, `paths()` → `{home,config,profile,store,inbox,inboxNew,inboxProcessing,inboxProcessed,inboxFailed,vault,output,logs,cache,contacts}`,
`ensureHome()`, `runDir(kind, stamp)`, `timestampSlug(d)`, `PKG_ROOT`, `MCP_DIR`, `ASSETS_DIR`, `SAMPLES_DIR`。

### util.mjs
`fmtLocal(d)`→"YYYY-MM-DD HH:mm", `fmtDay(d)`, `fmtIso(d)`, `sha1(s)`, `shortId(s,len)`, `slugify(s)`, `safeFileName(s)`,
`extractUrls(text)`, `normalizeUrl(u)`, `isHeatLink(u)`, `inferKindSafe(name)`, `uniq(a)`, `clamp(n,lo,hi)`, `truncate(s,n)`,
`stripControl(s)`, `ensureDir(p)`, `readJson(f,d)`, `writeJson(f,o)`, `atomicWrite(f,t)`, `readText(f)`, `appendLine(f,l)`,
`toCsv(rows,cols)`, `redact(s)`, `looksLikeSecret(s)`, `deepGet(o,path,d)`, `daysAgo(n)`, `startOfDay(d)`, `endOfDay(d)`, `diffDays(a,b)`, `pad2(n)`。

### timewin.mjs
`parseWhen(input, now?, opts?)`, `parseMessageTime(input, ref?)`, `parseHmRange(s)`, `minutesOfDay(d)`,
`resolveWindow({hours,days,since,until,week,month,now})` → `{since,until,sinceMs,untilMs,hours,label,explicitSince,explicitUntil}`,
`windowTag(w)`。

### store.mjs（node:sqlite，表结构见文件末尾 SCHEMA）
`store()`, `openStore(file?)`, `closeStore()`, `tx(db,fn)`, `kvGet/kvSet`,
`sessionId(name,kind)`, `upsertSession(db,s)`, `recalcSessionCounts(db)`, `listSessions({kind,sinceMs,untilMs,limit,minMessages,order})`,
`normalizeMessage(m,opts)`, `insertMessages(db,msgs,opts)`, `messageId(m)`, `messagesInWindow({sinceMs,untilMs,sessionIds,limit,order})`,
`searchMessages({keyword,keywords,chat,sender,sinceMs,untilMs,limit,ownerOnly,excludeOwner})`, `lastMessagesOf(name,limit)`, `sessionDigest({sinceMs,untilMs})`,
`upsertContact(db,c)`, `setContactLabels(db,ref,labels)`, `labelsOf(ref)`, `listLabels()`, `contactsByLabels(labels)`, `rebuildContactStats(db)`,
`addLink(db,l)`, `crossGroupLinks({sinceMs,untilMs,minChats,limit})`, `linkAppearances(norm,limit)`,
`startRun({kind,params,outDir,id})`, `finishRun(id,{summary,status})`, `listRuns(limit)`, `getRun(id)`,
`logHistory(h)`, `listHistory({limit,action,target})`,
`addInboxEntry(db,e)`, `listInbox({status,limit})`, `updateInbox(db,id,patch)`,
`addExclusion(db,pattern,kind,note)`, `listExclusions()`, `isExcluded(name)`, `storeStats()`。

**messages 行**（`rowToMessage`）：`{id, session_id, session_name, session_kind, sender, sender_id, is_owner:boolean, ts:number(ms), day, content, links:string[], attachments:any[], source, run_id}`
**sessions 行**（`rowToSession`）：`{id, name, kind:'private'|'group', is_group:boolean, member_count, owner, labels:string[], first_ts, last_ts, msg_count, source, meta}`

### config.mjs
`loadConfig({reload})`, `saveConfig(cfg)`, `updateConfig(patch)`, `configPath()`, `configExists()`, `sceneById(id)`, `targetById(id)`, `matchScene(title,cfg)`,
`DEFAULT_SCENES`, `DEFAULT_TARGETS`。config 形状：`{version, owner:{aliases,handles}, vaults:[{id,path,enabled}], readers:[{id,name,command,args,cwd,env,enabled}], sqliteSources:[{id,path,enabled}], scenes:[{id,name,match[],priority,task,targets[],enabled}], targets:[{id,name,kind:'agent'|'obsidian'|'clipboard'|'folder'|'custom',...}], settings:{defaultHours:24,maxImmediateActions:10,candidateStaleDays:14,reactivationInactiveDays:21,replyHistoryDays:30,minimumChatMessages:5,outputDir,autoPurgeInboxDays:30,reader:'auto'}, privacy:{redactOutputs:true,blockInsideRepo:true}}`

### profile.mjs（上游 profile v2 兼容）
`loadProfile({reload})`, `saveProfile(p)`, `profilePath()`, `initProfile({ownerAlias,ownerAliases,personalDoc,planDoc,priorityLabel,priorityLabels,force})`,
`profileStatus()` → `{state:'ready'|'partial'|'needs_context', owner_aliases, priority_labels, documents, documents_present, documents_missing, focus_areas, personalization_note, path}`,
`onboardingChecklist()`, `ownerAliases()`, `isOwnerName(sender)`, `defaultProfile()`, `PUBLIC_FOCUS_AREAS`。

### parse.mjs
`parseAny(text,{defaultChat,refDate,ownerNames})` → `{format,title,chat,messages:[{chat,session_name,sender,ts,content,is_owner,links,attachments}]}`,
`parseChatText(text,opts)`, `parseJsonChat(obj,opts)`, `extractAttachments(text)`, `guessTitle(text,fallback)`。

### inbox.mjs（微信流 Inbox，状态机 new→processing→processed|failed）
`normalizePayload(input)` → entry `{schema:'wechat-ai/inbox@1',id,created_ts,source,kind,title,chat,scene,target,body,messages,files,links,ts_min,ts_max,hash,meta,status}`,
`inboxAdd(input)` → `{id,duplicate,status,entry}`, `inboxGet(id)`, `inboxClaim(id)`, `inboxComplete(id,result)`, `inboxFail(id,err)`,
`inboxFiles(status)` → `[{id,file,bytes,mtime,title,kind,source,created_ts}]`, `inboxStats()`, `inboxMaintain({days,apply})`, `INBOX_SCHEMA`。

### ingest.mjs
`collectFiles(target)`, `ingestMessages(db,msgs,{source,runId})` → `{inserted,skipped,sessions,links}`,
`scanPath(target,{source,runId,out})` → `{target,files,inserted,perFile}`, `ingestInbox({limit,runId})`,
`indexFromReader({source,scope:'sessions'|'labels'|'search',sinceMs,untilMs,sessionType,sessionLimit,perChatLimit,keywords,label,out,runId,allowDemo})`,
`freshness()` → `{messages,last_message_ts,last_message_at,data_age_hours,last_index_ts,index_age_hours,fresh,source}`。

### reader/index.mjs + reader/common.mjs
`listSources({probe})`, `getSource(id)`, `pickReader({source,allowDemo,preferIndexed})` → `{reader,sourceId,reason}`,
`pickReadyReader({allowDemo})` → `{reader,sourceId,status,tried}`, `cliReaders(cfg)`, `vaultDirs(cfg)`, `clearReaderCache()`。
Reader 实例接口（全部 async，返回信封 `{ok,tool,command,data,warnings,protocol}`）：
`version(), status(), sessions({limit,typeFilter,keyword}), contacts({limit,keyword,friendsOnly,groupsOnly}), labels(), resolveChat(name,{typeFilter}), timeline(talker,{limit,offset,displayOrder,since,before,keyword,sender,typeFilter}), context({talker,localId,beforeCount,afterCount}), members(chat,{limit}), announcements(chat,{limit}), favorites({limit,after,before}), snsFeed({keyword,limit}), snsSearch(kw,{limit}), search(kw,{limit,offset,maxTextChars,inChat,after,before}), media({chat,kind,limit}), redPackets({limit}), transfers({limit}), forwardHistory({limit}), unread({limit}), stats(), sql({query,limit}), exportMessages({chat,format,limit,since,before}), describe()`
数据源 id：`local`（本地索引）、`vault[:path]`、`sqlite[:path]`（指向 db_storage，实现为 `reader/sqlite.mjs`，识别 3.x MSG 与 4.x message/Name2Id 两套 schema）、`wcdb[:path]`（`reader/wcdb.mjs` 的 `createWcdbReader({roots,selfUsername,resourceRoots})`，微信 4.x db_storage 六类库全量实现：session/contact/message/favorite/sns/hardlink）、`cli:<id>`（外部只读 CLI）、`mock`（虚构演示）。两者的 `sql` 错误形状不同（sqlite 为字符串、wcdb 为 `{code,message}`），wai_reader 工具层统一归一为 `error` 字符串 + `error_code`。

### signals.mjs（情报引擎）
`analyze({messages, sinceMs, untilMs, now, extraExclusions})` → 
`{window, coverage:{sessions,messages,groups,private,low_value_sessions}, sessions:[SessionRow], pendingReplies:[], promises:[], waiting:[], deadlines:[], settlements:[], published:[], brandDeals:[], trainings:[], projects:[], resources:[], heat:[], links:[], lowValue:[], sessionsByName:{}}`

- `SessionRow` = `{name,kind:'group'|'private',topic,messages,senders,first_ts,last_ts,owner_messages,other_messages,last_sender,last_from_owner,topics:string[],deal_hits,training_hits,project_hits,resource_hits,amounts:string[],low_value:boolean,priority:number,signals:string[]}`
- `pendingReplies[]` = `{chat,kind,sender,ts,content,reason,age_hours}`
- `promises[]` = `{chat,kind,ts,content,due:number|null,due_text,delivered,acknowledged,state:'已兑现'|'待兑现',overdue:boolean,note}`
- `waiting[]` = `{chat,kind,ts,content,reason,age_hours}`
- `deadlines[]` = `{chat,kind,ts,sender,content,due:number,due_text,overdue,days_left}`
- `settlements[]` = `{chat,kind,ts,terms:string[],amounts,last_sender,content,pending}`
- `brandDeals[]/trainings[]` = `{chat,kind,ts,qualification:0-100,confidence:'高概率'|'中概率'|'待核实',hits,amounts,evidence:[{sender,ts,content,is_owner?}],...}`
- `links[]` = `{norm,url,chats:string[],senders:string[],first_ts,last_ts,hits,heat:boolean,probability:'高概率商单'|'疑似商单'|'普通内容',rank:0-3,contexts:[{chat,sender,ts,content,is_owner}],note?}`
- 词表常量：`BRAND_DEAL_TERMS, TRAINING_TERMS, PROJECT_TERMS, RESOURCE_TERMS, DEADLINE_TERMS, SETTLEMENT_TERMS, PUBLISH_TERMS, HEAT_TERMS, NON_DEAL_TERMS, LOW_VALUE_TERMS, HIGH_FOLLOWER_TERMS`
- 工具：`hits(text,terms)`, `hitCount`, `isQuestion`, `isPromise`, `isAck`, `isClosing`, `extractAmounts(text)`, `extractDueDates(text,ref)`, `classifyChat(name)`, `chatTopics(name,text)`, `isLowValueChat({name,text})`, `clampScore(n)`, `reactivation({messages,now,inactiveDays,maxPerBand})` → `{bands:{今天优先看,待交接跟进,等待区,纯佣低优先级,我方主动放弃}, all, inactive_days, immediate}`

### duedate.mjs
`nextWeekday(dow,which,ref)`, `parseDueDate(text,ref)`, `dayOfWeekCn(d)`, `DOW_CN`, `DOW_NAME`, `fmtDateCn(d)`。

### analytics/*（聊天记录分析引擎，对应提示词全集 A-I）
全部为纯函数（输入 messages 行数组 + 选项，输出 JSON 可序列化对象），不做 I/O；落盘只走 `render.mjs`。
统一线程：不臆测（证据不足标 `confidence`/`需确认`）、输出脱敏（`maskPii`）、金额默认打码（`showAmounts:false` 只给区间）、风控只出线索（`needs_review:true`）。

- `core.mjs` 共享原语：`classifyMessage(m)`→`text|image|voice|file|transfer|redpacket|link|location`、`typeBreakdown`、`termFreq`（2-4 字滑窗 n-gram 分词）、`catchphrases`、`emojiTop`、`hourBuckets/weekdayBuckets/dayBuckets/monthBuckets`、`activityStreaks`、`replyIntervals`、`groupByChat`、`countBy`、`topEntries`、`median`、`round`、`maskPii(text)`、`evidence(m)`→`{msg_id,time,sender,chat,text}`。
- `report.mjs`（A 年度/月度报告）：`periodReport(messages,{sinceMs,untilMs,top,now,minSample})` → period/total/type_breakdown/active_hours/keywords/catchphrases/emojis/reply_interval/relationship_trend/insights[5-10]/caliber。
- `social.mjs`（B 社交关系）：`socialGraph(messages,{top,gapMs,...})` → who_contacts_me_most/who_i_contact_most/reply_time/bidirectional/relationship_change/group_network(core/edge)/bridge_members/clusters(标签传播)/caliber。
- `sentiment.mjs`（C 情绪趋势）：`sentimentTrend(...)` → daily_sentiment/stress_topics/conflict_words/night_negative_messages/high_risk_periods + `limitations`（必须含"不是心理或医疗诊断"）。
- `tasks.mjs`（D 时间任务）：`taskExtract(messages,{now,includeIcs})` → tasks[{kind,title,owner,direction,status,due_ts,source_msg_id,confidence}] + `toIcs(tasks)`。
- `finance.mjs`（E 财务记录）：`financeLedger(messages,{now,showAmounts})` → entries/monthly/top_counterparties/categories/suspicious；默认 `amount_band` 打码，无投资建议。
- `memory.mjs`（F 记忆库）：`memoryCards(messages,{maxCards})` → cards/timeline/stats + `memoryAnswer(messages,query)`（仅检索，不编造）。
- `content.mjs`（G 内容分析）：`contentAnalysis` → topicClusters/intentDistribution/entityTable/extractiveSummary/lexicalStats + `answerQuestion(messages,query)`（引用 msg_id）。
- `team.mjs`（H 团队分析）：`teamReview(messages,{projectName,now})` → decisions/assignments/risks/service_qc/sales/faq。
- `risk.mjs`（I 风控）：`riskScan(messages,{goal,now})` → risks[{risk_id,type,level,evidence_msg_ids,evidence_text(masked),suggested_action,needs_review}] + 免责声明。
- `render.mjs`：`renderAnalytics(kind,result,{outDir,title})` → 写 `<kind>_report.md` + `<kind>.json`，RENDERERS 覆盖 9 类。

## 约定

- **只读红线**：绝不发送/回复/转发微信消息；回复只能作为本地草稿。
- **隐私红线**：报告不得包含真实凭据；`security.mjs` 的扫描必须在 test/CI 中可用。
- 所有对外输出用中文；代码注释中文。
- 每个 `lib/*.mjs` 必须能被 `node --check` 通过，且不得 import npm 包。
- 时间统一用毫秒 number；展示用 `fmtLocal`。
- 报告落盘目录：`paths().output/<kind>-<timestampSlug>/`。
