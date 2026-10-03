// web-rpa-mcp — 演示站点（本地假「A系统/B系统」+ 各类控件），用于端到端与集成测试
// 独立运行: node demo/app.mjs [port]
import http from 'node:http';
import { URL } from 'node:url';
import { extraPage } from './extra-pages.mjs';

// 空数据哨兵日期：用于确定性验证"空结果守卫"（对应文章里"生成了一张空表"的坑）
const EMPTY_SENTINEL = '1999-01-01';

function todayIso(d) {
  const x = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
}

function rowsFor(dateStr, forceEmpty) {
  if (forceEmpty) return [];
  if (dateStr === EMPTY_SENTINEL) return [];
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return [];
  const base = d.getDate();
  return [
    { no: 'SO' + String(100000 + base * 7), cust: '张伟', amount: (base * 137.5).toFixed(2), status: '已完成' },
    { no: 'SO' + String(100001 + base * 7), cust: '李娜', amount: (base * 89.25).toFixed(2), status: '待发货' },
    { no: 'SO' + String(100002 + base * 7), cust: '王强', amount: (base * 245.8).toFixed(2), status: '已完成' },
  ];
}

function layout(title, body) {
  return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + title + '</title>' +
    '<style>' +
    'body{font-family:Segoe UI,Microsoft YaHei,sans-serif;margin:32px;color:#222}' +
    'table{border-collapse:collapse;margin:16px 0}th,td{border:1px solid #ccc;padding:6px 12px;font-size:14px}' +
    'th{background:#f5f5f5}label{display:inline-block;min-width:90px;margin-right:8px}' +
    'input,select,textarea{padding:6px 8px;margin:4px 8px 4px 0}' +
    'button{padding:6px 16px;margin-right:8px}code{background:#f0f0f0;padding:2px 4px}' +
    '.row{margin:8px 0}.err{color:#c00}' +
    '#hoverMenu{display:inline-block;padding:6px 12px;border:1px solid #888;cursor:pointer;background:#eee}' +
    '#hoverPanel{display:none;margin-top:8px;padding:8px;border:1px dashed #888}' +
    '#hoverMenu:hover ~ #hoverPanel{display:block}' +
    '#hoverPanel:hover{display:block}' +
    '.spacer{height:1600px}' +
    '</style></head><body>' + body + '</body></html>';
}

export function createDemoServer() {
  const COOKIE = 'demo_session=ok';
  let flakyHits = 0;   // 每个 server 实例独立计数
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const q = url.searchParams;
    const authed = String(req.headers.cookie || '').includes(COOKIE);

    const html = (body, code) => {
      res.writeHead(code || 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const redirect = (to) => { res.writeHead(302, { Location: to }); res.end(); };

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (p === '/login') {
          const empNo = form.get('empNo') || '';
          const pwd = form.get('pwd') || '';
          if (!empNo || !pwd) {
            return html(layout('登录失败', '<h1>登录失败</h1><p data-testid="loginError">工号和密码不能为空</p><a href="/">返回</a>'));
          }
          res.writeHead(302, { 'Set-Cookie': COOKIE + '; Path=/', Location: '/report' });
          res.end();
          return;
        }
        if (p === '/submit') {
          const no = form.get('orderNo') || '';
          if (!no) return html(layout('提交失败', '<h1>B系统</h1><p data-testid="submitError" class="err">单号不能为空</p>'));
          return html(layout('提交结果', '<h1>B系统</h1><p data-testid="submitOk">提交成功</p><p>单号：' + no + '</p><a href="/submit">继续</a>'));
        }
        html(layout('未找到', '<h1>404</h1>'), 404);
      });
      return;
    }

    /* ---------------- 登录 / 报表 / 导出（原有链路） ---------------- */

    if (p === '/' || p === '/login') {
      return html(layout('A系统 登录', '<h1>A系统 登录</h1>' +
        '<form method="POST" action="/login">' +
        '<div><label for="empNo">工号</label><input id="empNo" name="empNo" data-testid="empNo" placeholder="请输入工号"></div>' +
        '<div><label for="pwd">密码</label><input id="pwd" name="pwd" type="password" placeholder="请输入密码"></div>' +
        '<button type="submit" data-testid="loginBtn">登录</button></form>'));
    }

    if (p === '/report') {
      if (!authed) return redirect('/');
      const date = q.get('date') || todayIso();
      const rows = rowsFor(date, q.get('empty') === '1');
      const tbody = rows.length
        ? rows.map((r) => '<tr><td>' + r.no + '</td><td>' + r.cust + '</td><td>' + r.amount + '</td><td>' + r.status + '</td></tr>').join('')
        : '<tr><td colspan="4" style="text-align:center;color:#999" data-testid="emptyRow">暂无数据</td></tr>';
      return html(layout('订单日报', '<h1>订单日报</h1>' +
        '<form method="GET" action="/report">' +
        '<label for="reportDate">报表日期</label><input id="reportDate" name="date" data-testid="reportDate" value="' + date + '">' +
        '<button type="submit" data-testid="queryBtn">查询</button></form>' +
        (q.get('date') ? '<p data-testid="queryDone">查询完成</p>' : '') +
        '<table id="tbl"><thead><tr><th>订单号</th><th>客户</th><th>金额</th><th>状态</th></tr></thead><tbody>' + tbody + '</tbody></table>' +
        '<form method="GET" action="/export"><input type="hidden" name="date" value="' + date + '">' +
        '<button type="submit" data-testid="exportBtn">导出</button></form>' +
        '<p><a href="/submit" data-testid="goSubmit">去 B 系统提交单号</a></p>'));
    }

    if (p === '/export') {
      if (!authed) return redirect('/');
      const date = q.get('date') || todayIso();
      const rows = rowsFor(date, q.get('empty') === '1');
      const csv = ['订单号,客户,金额,状态'].concat(rows.map((r) => [r.no, r.cust, r.amount, r.status].join(','))).join('\r\n');
      const body = Buffer.from('\uFEFF' + csv, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="orders-' + date + '.csv"',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }

    if (p === '/submit') {
      if (!authed) return redirect('/');
      return html(layout('B系统 提交', '<h1>B系统 提交</h1>' +
        '<form method="POST" action="/submit">' +
        '<label for="orderNo">订单号</label><input id="orderNo" name="orderNo" data-testid="orderNo" placeholder="粘贴订单号">' +
        '<button type="submit" data-testid="submitBtn">提交</button></form>'));
    }

    /* ---------------- 富控件表单：select / radio / checkbox / textarea / file / hover / scroll ---------------- */

    if (p === '/form') {
      return html(layout('B系统 工单提交', '<h1>B系统 工单提交</h1>' +
        '<form method="GET" action="/form-result">' +
        '<div class="row"><label for="orderNo">订单号</label><input id="orderNo" name="orderNo" data-testid="orderNo" placeholder="请输入订单号"></div>' +
        '<div class="row"><label for="reason">原因</label><select id="reason" name="reason" data-testid="reason">' +
        '<option value="">请选择</option><option value="refund">退款</option><option value="exchange">换货</option><option value="repair">维修</option>' +
        '</select></div>' +
        '<div class="row"><span>优先级</span>' +
        '<label><input type="radio" name="priority" value="normal" data-testid="prioNormal" checked> 普通</label>' +
        '<label><input type="radio" name="priority" value="urgent" data-testid="prioUrgent"> 紧急</label></div>' +
        '<div class="row"><label><input type="checkbox" id="agree" name="agree" data-testid="agree"> 我已核对</label></div>' +
        '<div class="row"><label for="note">备注</label><textarea id="note" name="note" data-testid="note" rows="2"></textarea></div>' +
        '<div class="row"><label for="attach">附件</label><input type="file" id="attach" name="attach" data-testid="attach">' +
        '<span id="fileInfo" data-testid="fileInfo">未选择文件</span></div>' +
        '<button type="submit" data-testid="formSubmit">提交工单</button>' +
        '</form>' +
        '<hr>' +
        '<div id="hoverMenu" data-testid="hoverMenu">更多操作</div>' +
        '<div id="hoverPanel" data-testid="hoverPanel"><button type="button" id="hoverAction" data-testid="hoverAction">导出明细</button>' +
        '<p id="hoverResult" data-testid="hoverResult"></p></div>' +
        '<hr>' +
        '<p><a href="/download?rows=3" data-testid="dlLink3">下载 3 行明细</a></p>' +
        '<p><a href="/download?rows=0" data-testid="dlLink0">下载空明细</a></p>' +
        '<div class="spacer"></div>' +
        '<button type="button" id="deepBtn" data-testid="deepBtn">页面底部按钮</button>' +
        '<p id="deepResult" data-testid="deepResult"></p>' +
        '<script>' +
        'document.getElementById("attach").addEventListener("change", function(){' +
        '  document.getElementById("fileInfo").textContent = "已选择: " + (this.files[0] ? this.files[0].name : "无");' +
        '});' +
        'document.getElementById("hoverAction").addEventListener("click", function(){' +
        '  document.getElementById("hoverResult").textContent = "已点击导出明细";' +
        '});' +
        'document.getElementById("deepBtn").addEventListener("click", function(){' +
        '  document.getElementById("deepResult").textContent = "底部按钮已点击";' +
        '});' +
        '</script>'));
    }

    if (p === '/form-result') {
      const orderNo = q.get('orderNo') || '';
      const agree = q.get('agree');
      if (!orderNo) return html(layout('提交失败', '<h1>提交失败</h1><p data-testid="formError" class="err">订单号不能为空</p>'));
      if (agree !== 'on') return html(layout('提交失败', '<h1>提交失败</h1><p data-testid="formError" class="err">请先核对信息</p>'));
      return html(layout('工单结果', '<h1>工单结果</h1>' +
        '<p data-testid="formOk">工单提交成功</p>' +
        '<p>订单号：<span data-testid="echoOrderNo">' + orderNo + '</span></p>' +
        '<p>原因：<span data-testid="echoReason">' + (q.get('reason') || '') + '</span></p>' +
        '<p>优先级：<span data-testid="echoPriority">' + (q.get('priority') || '') + '</span></p>' +
        '<p>备注：<span data-testid="echoNote">' + (q.get('note') || '') + '</span></p>'));
    }

    /* ---------------- iframe 内嵌页面 ---------------- */

    if (p === '/frame') {
      return html(layout('带 iframe 的页面', '<h1>外层页面</h1><p data-testid="outerReady">外层就绪</p>' +
        '<iframe id="innerFrame" name="innerFrame" data-testid="innerFrame" src="/frame-inner" width="520" height="220"></iframe>'));
    }

    if (p === '/frame-inner') {
      return html(layout('内层', '<h2>内层页面</h2>' +
        '<button type="button" id="innerBtn" data-testid="innerBtn">内层按钮</button>' +
        '<p id="innerResult" data-testid="innerResult">内层未点击</p>' +
        '<script>document.getElementById("innerBtn").addEventListener("click", function(){' +
        '  document.getElementById("innerResult").textContent = "内层已点击"; });</script>'));
    }

    /* ---------------- 慢加载 / 错误提示 ---------------- */

    if (p === '/slow') {
      const ms = Number(q.get('ms') || 2500);
      return html(layout('慢加载', '<h1>慢加载页面</h1>' +
        '<p data-testid="slowPending">数据加载中...</p>' +
        '<div id="slot"></div>' +
        '<script>setTimeout(function(){' +
        '  document.getElementById("slot").innerHTML = "<button type=\\"button\\" id=\\"slowBtn\\" data-testid=\\"slowBtn\\">延迟出现的按钮</button><p id=\\"slowDone\\" data-testid=\\"slowDone\\">加载完成</p>";' +
        '  document.getElementById("slowBtn").addEventListener("click", function(){' +
        '    document.getElementById("slowDone").textContent = "延迟按钮已点击"; });' +
        '}, ' + ms + ');</script>'));
    }

    if (p === '/error') {
      return html(layout('错误页', '<h1>错误页</h1>' +
        '<div class="error-message" data-testid="errBanner">系统异常：E5003 请稍后重试</div>'));
    }

    /* ---------------- 串联：源页 / 目标页 ---------------- */

    if (p === '/chain/source') {
      return html(layout('串联源页', '<h1>取数页</h1>' +
        '<p>单号：<span data-testid="srcOrderNo">SO20261003</span></p>' +
        '<p>令牌：<span data-testid="srcToken">TK-8891</span></p>' +
        '<a href="/chain/target" data-testid="toTarget">去目标页</a>'));
    }

    if (p === '/chain/target') {
      const orderNo = q.get('orderNo') || '';
      const token = q.get('token') || '';
      return html(layout('串联目标页', '<h1>目标页</h1>' +
        '<p>收到单号：<span data-testid="dstOrderNo">' + orderNo + '</span></p>' +
        '<p>收到令牌：<span data-testid="dstToken">' + token + '</span></p>' +
        (orderNo && token ? '<p data-testid="chainOk">串联数据已接收</p>' : '<p data-testid="chainMissing" class="err">缺少串联数据</p>')));
    }

    /* ---------------- 可控行数下载 ---------------- */

    if (p === '/download') {
      const n = Math.max(0, Number(q.get('rows') || 3));
      const lines = ['序号,值'];
      for (let i = 1; i <= n; i++) lines.push(i + ',值' + i);
      const body = Buffer.from('\uFEFF' + lines.join('\r\n'), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="rows-' + n + '.csv"',
        'Content-Length': body.length,
      });
      res.end(body);
      return;
    }

    /* ---------------- 列表页（含空状态占位行） ---------------- */

    if (p === '/list') {
      const n = Math.max(0, Number(q.get('n') === null ? 3 : q.get('n')));
      const items = n
        ? Array.from({ length: n }, (_, i) => '<li>条目 ' + (i + 1) + '</li>').join('')
        : '<li data-testid="listEmpty">暂无记录</li>';
      return html(layout('列表页', '<h1>列表页</h1><p data-testid="listReady">列表就绪</p>' +
        '<ul id="ul" data-testid="list">' + items + '</ul>'));
    }

    /* ---------------- 首次请求直接断连（验证步骤重试） ---------------- */

    if (p === '/flaky') {
      flakyHits++;
      if (flakyHits === 1) {
        // 直接断开 socket：page.goto 会抛网络错误，这样才能触发"步骤重试"
        req.socket.destroy();
        return;
      }
      return html(layout('已恢复', '<h1>已恢复</h1><p data-testid="flakyReady">服务已恢复</p>'));
    }

    /* ---------------- 需要人工接管的页面（1.5s 后自行就绪） ---------------- */

    if (p === '/handoff') {
      return html(layout('需要人工', '<h1>需要人工处理</h1>' +
        '<p data-testid="handoffPending">请完成人工校验</p><div id="hx"></div>' +
        '<script>setTimeout(function(){' +
        '  document.getElementById("hx").innerHTML = "<p data-testid=\\\"handoffDone\\\">人工处理完成</p>";' +
        '}, 1500);</script>'));
    }

    /* ---------------- 补充页：弹窗 / Shadow DOM / 滚动加载 ---------------- */

    const extra = extraPage(p, q, layout, req);
    if (extra) return html(extra);

    if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
  });
}

export function startDemoServer(port) {
  const server = createDemoServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port || 0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port, url: 'http://127.0.0.1:' + addr.port });
    });
  });
}

if (process.argv[1] && process.argv[1].endsWith('app.mjs')) {
  const port = Number(process.argv[2]) || 4321;
  startDemoServer(port).then((s) => {
    process.stdout.write('演示站点已启动: ' + s.url + '\n');
    process.stdout.write('  登录页   ' + s.url + '/\n');
    process.stdout.write('  报表页   ' + s.url + '/report\n');
    process.stdout.write('  富控件   ' + s.url + '/form\n');
    process.stdout.write('  iframe   ' + s.url + '/frame\n');
    process.stdout.write('  慢加载   ' + s.url + '/slow\n');
    process.stdout.write('  错误页   ' + s.url + '/error\n');
    process.stdout.write('  串联源   ' + s.url + '/chain/source\n');
    process.stdout.write('  空数据   ' + s.url + '/report?date=&empty=1\n');
  }).catch((e) => {
    process.stderr.write('启动失败: ' + String(e && e.message ? e.message : e) + '\n');
    process.exit(1);
  });
}
