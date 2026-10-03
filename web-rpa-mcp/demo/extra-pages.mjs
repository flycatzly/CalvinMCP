// web-rpa-mcp — 演示站点补充页：浏览器弹窗 / Shadow DOM / 滚动加载
// HTML 属性一律不加引号、脚本内字符串统一用双引号，避免与外层单引号字符串冲突。
export function extraPage(pathname, q, layout, req) {
  if (pathname === '/echo') {
    const ua = String((req && req.headers && req.headers['user-agent']) || '');
    return layout('回声页',
      '<h1>回声页</h1>' +
      '<p data-testid=ua>UA: ' + ua.replace(/</g, '&lt;') + '</p>' +
      '<p data-testid=vp>viewport: 未知</p>' +
      '<p data-testid=ready>回声就绪</p>' +
      '<script>' +
      'document.querySelector("[data-testid=vp]").textContent = "viewport: " + window.innerWidth + "x" + window.innerHeight;' +
      '</script>');
  }

  if (pathname === '/dialog') {
    return layout('弹窗页',
      '<h1>弹窗页</h1>' +
      '<button data-testid=confirmBtn id=confirmBtn type=button>提交并确认</button>' +
      '<button data-testid=alertBtn id=alertBtn type=button>弹出提示</button>' +
      '<p data-testid=confirmed id=confirmed style=display:none>已确认提交</p>' +
      '<p data-testid=cancelled id=cancelled style=display:none>已取消提交</p>' +
      '<p data-testid=alerted id=alerted style=display:none>已看到提示</p>' +
      '<script>' +
      'document.getElementById("confirmBtn").addEventListener("click", function(){' +
      '  if (confirm("确认提交这笔单据吗？")) { document.getElementById("confirmed").style.display = "block"; }' +
      '  else { document.getElementById("cancelled").style.display = "block"; }' +
      '});' +
      'document.getElementById("alertBtn").addEventListener("click", function(){' +
      '  alert("操作已完成");' +
      '  document.getElementById("alerted").style.display = "block";' +
      '});' +
      '</script>');
  }

  if (pathname === '/shadow') {
    return layout('Shadow DOM 页',
      '<h1>Shadow DOM 页</h1><div id=host data-testid=host></div>' +
      '<script>' +
      'var host = document.getElementById("host");' +
      'var root = host.attachShadow({ mode: "open" });' +
      'var b = document.createElement("button");' +
      'b.setAttribute("data-testid", "shadowBtn"); b.setAttribute("id", "sb"); b.textContent = "影子按钮";' +
      'var p = document.createElement("p");' +
      'p.setAttribute("data-testid", "shadowResult"); p.setAttribute("id", "sr"); p.textContent = "影子未点击";' +
      'root.appendChild(b); root.appendChild(p);' +
      'b.addEventListener("click", function(){ p.textContent = "影子已点击"; });' +
      '</script>');
  }

  if (pathname === '/infinite') {
    return layout('滚动加载页',
      '<h1>滚动加载页</h1>' +
      '<p data-testid=loadedCount id=loadedCount>已加载 1 批</p>' +
      '<div id=list><p>第 1 批</p></div>' +
      '<div style=height:2200px></div>' +
      '<button data-testid=bottomBtn id=bottomBtn type=button>底部按钮</button>' +
      '<p data-testid=bottomClicked id=bottomClicked></p>' +
      '<script>' +
      'var batch = 1;' +
      'function grow(){' +
      '  if (batch >= 3) return;' +
      '  batch++;' +
      '  var d = document.createElement("div");' +
      '  d.setAttribute("data-testid", "batch" + batch);' +
      '  d.textContent = "第 " + batch + " 批";' +
      '  document.getElementById("list").appendChild(d);' +
      '  document.getElementById("loadedCount").textContent = "已加载 " + batch + " 批";' +
      '}' +
      'window.addEventListener("scroll", function(){' +
      '  if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 60) grow();' +
      '});' +
      'document.getElementById("bottomBtn").addEventListener("click", function(){' +
      '  document.getElementById("bottomClicked").textContent = "底部按钮已点击"; });' +
      '</script>');
  }

  return null;
}
