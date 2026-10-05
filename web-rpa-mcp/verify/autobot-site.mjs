// web-rpa-mcp 全流程实测 — 自动演示机器人站点
// 作用：提供一组与 demo 站点同构的本地页面（登录 → 查订单 → 导出）。
// 带 ?auto=1（或 sessionStorage.rpaAuto=1）时页面会用 JS 自动触发真实的 DOM
// input/change/click 事件（无 isTrusted 过滤，录制器照常捕获），从而让 MCP 层的
// record_start → record_stop 在无人工参与的情况下录出一条真实步骤链。
import http from 'node:http';

function todayIso() {
  const x = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

const SETVAL = `
function setVal(el, v){
  el.focus(); el.value = v;
  el.dispatchEvent(new Event('input', {bubbles:true}));
  el.dispatchEvent(new Event('change', {bubbles:true}));
  el.blur();
}`;

function page(title, body, script) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + title + '</title>' +
    '<style>body{font-family:Microsoft YaHei,sans-serif;margin:32px;color:#222}' +
    'table{border-collapse:collapse;margin:16px 0}th,td{border:1px solid #ccc;padding:6px 12px;font-size:14px}' +
    'th{background:#f5f5f5}label{display:inline-block;min-width:90px;margin-right:8px}' +
    'input,button{padding:6px 10px;margin:4px 8px 4px 0}</style></head><body>' + body +
    '<script>' + (script || '') + '</scr' + 'ipt></body></html>';
}

const loginPage = (auto) => page('A系统登录',
  '<h1>A系统登录</h1>' +
  '<div class="row"><label for="empNo">工号</label>' +
  '<input id="empNo" name="empNo" data-testid="empNo" placeholder="请输入工号"></div>' +
  '<div class="row"><label for="pwd">密码</label>' +
  '<input id="pwd" name="pwd" type="password" data-testid="pwd" placeholder="请输入密码"></div>' +
  '<button type="button" id="loginBtn" data-testid="loginBtn">登录</button>',
  SETVAL +
  'document.getElementById("loginBtn").addEventListener("click", function(){ location.href = "/report"; });' +
  (auto
    ? 'sessionStorage.setItem("rpaAuto","1");' +
      'setTimeout(function(){' +
      '  setVal(document.getElementById("empNo"), "1001");' +
      '  setVal(document.getElementById("pwd"), "DemoPass123");' +
      '  document.getElementById("loginBtn").click();' +
      '}, 500);'
    : ''));

function reportPage(date) {
  const hasDate = !!(date && String(date).length === 10 && /^\d{4}-\d{2}-\d{2}$/.test(date));
  const rows = hasDate ? [
    ['SO100035', '张伟', '687.50', '已完成'],
    ['SO100042', '李娜', '446.25', '待发货'],
    ['SO100049', '王强', '1229.00', '已完成'],
  ] : [];
  const body =
    '<h1>订单日报表</h1>' +
    '<form method="GET" action="/report">' +
    '<label for="reportDate">报表日期</label>' +
    '<input id="reportDate" name="date" data-testid="reportDate" value="' + (hasDate ? date : todayIso()) + '">' +
    '<button type="submit" id="queryBtn" data-testid="queryBtn">查询</button></form>' +
    (hasDate
      ? '<div id="queryDone" data-testid="queryDone">查询完成</div>' +
        '<table id="orders"><thead><tr><th>单号</th><th>客户</th><th>金额</th><th>状态</th></tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>' +
        '<a id="exportBtn" data-testid="exportBtn" href="/export?date=' + date + '">导出</a>'
      : '<div id="queryTip">请选择日期后查询</div>');
  // 自动演示链只在 sessionStorage.rpaAuto=1（由登录页 auto 模式设置）时才接管页面；
  // 回放的全新浏览器上下文里该标记不存在，页面保持被动、由回放驱动，保证回放确定性。
  const script = SETVAL +
    'if (sessionStorage.getItem("rpaAuto") === "1") {' +
    (hasDate
      ? 'setTimeout(function(){ document.getElementById("exportBtn").click(); }, 600);'
      : 'setTimeout(function(){' +
        '  setVal(document.getElementById("reportDate"), "' + todayIso() + '");' +
        '  document.getElementById("queryBtn").click();' +
        '}, 400);') +
    '}';
  return page('订单日报表', body, script);
}

export function startAutobotServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;
      const auto = url.search.indexOf('auto=1') >= 0;
      if (p === '/' || p === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(loginPage(auto));
      } else if (p === '/report') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(reportPage(url.searchParams.get('date'))); // 自动链由 sessionStorage.rpaAuto 门控
      } else if (p === '/export') {
        const d = url.searchParams.get('date') || todayIso();
        const csv = '单号,客户,金额,状态\nSO100035,张伟,687.50,已完成\nSO100042,李娜,446.25,待发货\nSO100049,王强,1229.00,已完成\n';
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="orders-' + d + '.csv"',
        });
        res.end(csv);
      } else if (p === '/profile-home') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('工作台', '<h1>工作台</h1><p>欢迎回来，已登录</p>'));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('404', '<h1>404 页面不存在</h1><div id="missingTip">这里什么都没有</div>'));
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, url: 'http://127.0.0.1:' + addr.port });
    });
  });
}
