# realtest-r52 探索性实测 — 2026-10-08T14:32:04.831Z

- [PASS] next 模式 3 页全链：rowCount 15 / pagesScanned 3 / 末页无下一页诚实停 no-paging-control：{"isError":false,"rowCount":15,"pagesScanned":3,"stop":"no-paging-control"}
- [PASS] CSV 公式注入真链路：页面 =HYPERLINK 单元格 → CSV 带 ' 前缀（r52 修复面端到端）：中和在位
- [PASS] keyIndex 跨页去重真跑：粘行去重 → rowCount 8 / page2 added=2（3 行含 1 粘行不重复计入）：{"rowCount":8,"pages":[3,2,3]}
- [PASS] r53 纯重复中间页修复：续采到尾页（rowCount 3/pagesScanned 3/no-paging-control，page3 新行不丢）：{"rowCount":3,"pagesScanned":3,"stop":"no-paging-control","pages":[[1,2,2],[2,2,0],[3,1,1]]}