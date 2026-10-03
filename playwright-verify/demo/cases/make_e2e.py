from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = "回归用例"
ws.append(["用例编号", "用例名称", "步骤", "预期结果", "环境", "账号"])
ws.append([
  "TC-101", "登录后出现用户菜单",
  "1. 打开 file:///D:/Users/DeepSeekWeb/playwright-verify-mcp/demo/site/index.html\n"
  "2. 在账号输入框输入 u1\n"
  "3. 在密码输入框输入 secret_sauce\n"
  "4. 点击 登录 按钮",
  "看到 用户菜单", "test", "u1",
])
ws.append([
  "TC-102", "结算金额等于 99 元",
  "1. 打开 file:///D:/Users/DeepSeekWeb/playwright-verify-mcp/demo/site/index.html",
  "校验 订单金额 等于 ¥99.00", "test", "u1",
])
wb.save("demo/cases/e2e.xlsx"); print("e2e.xlsx written")
