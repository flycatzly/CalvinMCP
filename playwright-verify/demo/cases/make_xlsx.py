from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = "回归用例"
ws.append(["用例编号", "用例名称", "前置条件", "步骤", "预期结果", "环境", "账号", "优先级"])
ws.append([
    "TC-001", "登录成功", "已打开登录页",
    "1. 打开 /login\n2. 在账号输入框输入 u1\n3. 在密码输入框输入 secret_sauce\n4. 点击 登录 按钮",
    "看到 用户菜单", "test", "u1", "P0",
])
ws.append([
    "TC-002", "结算金额正确", "已加购 SKU_A",
    "1. 打开 /checkout\n2. 点击 去结算 按钮",
    "校验 订单金额 等于 ¥99.00", "test", "u1", "P0",
])
ws.append([
    "TC-003", "这条故意写得无法映射", "",
    "1. 摸摸鱼\n2. 等待系统心情变好",
    "校验 心情 等于 愉快", "test", "u1", "P2",
])
ws.append([])
ws.append([None, "空行与缺列也要能容忍"])
wb.save("demo/cases/regression.xlsx")
print("xlsx written")
