#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
validate_ci.py — 校验 .github/workflows/ci.yml 的结构

为什么不装 PyYAML：本项目「零运行时依赖」是设计原则，为一个校验脚本引入解析库
不划算。CI 工作流的结构是规整的，按缩进层级做一次结构化解析足够可靠，
而且失败时能直接指出**第几行**有问题 —— 这比一个泛泛的 "YAML 解析错误" 有用得多。

校验项（每一项都对应一种「CI 静默失效」）：
  1. 无制表符（YAML 禁止，且报错信息极难懂）
  2. 每个作业都有 runs-on 与 steps
  3. 每个步骤要么有 uses，要么有 run（不能两者都无，也不能两者都有）
  4. 触发器存在
  5. 关键作业存在（gate / verify / portable）
  6. verify 有 matrix，且 fail-fast: false
  7. 断言门禁作业**真的在验证退出码**（而不是只跑一遍就算过）

用法：python validate_ci.py [路径]
退出码：0 通过 / 1 结构问题 / 2 文件缺失
"""
import os
import re
import sys


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else ".github/workflows/ci.yml"
    if not os.path.exists(path):
        print("找不到工作流文件: %s" % path)
        return 2

    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    lines = raw.split("\n")

    problems = []

    # 1) 制表符
    for i, ln in enumerate(lines, 1):
        if "\t" in ln:
            problems.append("第 %d 行含制表符（YAML 禁止用 tab 缩进）" % i)

    # 2) 顶层键
    top = {}
    for i, ln in enumerate(lines, 1):
        m = re.match(r"^([A-Za-z_][\w-]*):", ln)
        if m:
            top[m.group(1)] = i
    for key in ("name", "on", "jobs"):
        if key not in top:
            problems.append("缺顶层键: %s" % key)

    # 3) 解析 jobs
    jobs_start = top.get("jobs")
    if jobs_start is None:
        print("\n".join(problems) or "无问题")
        return 1

    jobs = {}
    current = None
    for i in range(jobs_start, len(lines)):
        ln = lines[i]
        m = re.match(r"^  ([A-Za-z_][\w-]*):\s*$", ln)
        if m:
            current = m.group(1)
            jobs[current] = {"line": i + 1, "raw": []}
            continue
        if current and (ln.startswith("    ") or ln.strip() == ""):
            jobs[current]["raw"].append(ln)

    for name, j in jobs.items():
        body = "\n".join(j["raw"])
        if "runs-on:" not in body:
            problems.append("作业 %s（第 %d 行）缺 runs-on" % (name, j["line"]))
        if "steps:" not in body:
            problems.append("作业 %s（第 %d 行）缺 steps" % (name, j["line"]))
            continue
        # 步骤以「- 」开头（缩进 6 空格）
        steps = re.findall(r"^      - ", body, re.M)
        if not steps:
            problems.append("作业 %s 没有解析到步骤" % name)
        # 每个步骤块
        blocks = re.split(r"^      - ", body, flags=re.M)[1:]
        for idx, b in enumerate(blocks):
            has_uses = "uses:" in b
            has_run = re.search(r"^\s+run:", b, re.M) is not None
            if has_uses and has_run:
                problems.append("作业 %s 步骤 %d 同时有 uses 与 run" % (name, idx + 1))
            if not has_uses and not has_run:
                problems.append("作业 %s 步骤 %d 既无 uses 也无 run" % (name, idx + 1))

    for required in ("gate", "verify", "portable"):
        if required not in jobs:
            problems.append("缺作业: %s" % required)

    # 4) matrix / fail-fast
    verify_body = "\n".join(jobs.get("verify", {}).get("raw", []))
    if "matrix:" not in verify_body:
        problems.append("verify 作业缺 matrix")
    if "fail-fast: false" not in verify_body:
        problems.append("verify 的 strategy 应显式 fail-fast: false（否则一个平台失败会掩盖其它平台）")

    # 5) 门禁作业必须真的校验退出码，而不是「跑一遍就算过」
    gate_body = "\n".join(jobs.get("gate", {}).get("raw", []))
    if "code=$?" not in gate_body:
        problems.append("gate 作业没有校验退出码 —— 门禁若不能阻断，等于没有门禁")
    if "node skill/playwright-verify/scripts/check_config.mjs" not in gate_body:
        problems.append("gate 作业没有调用 check_config（配置体检应放最前面）")
    if "node skill/playwright-verify/scripts/lint_spec.mjs" not in gate_body:
        problems.append("gate 作业没有调用 lint_spec")

    # 6) 结果
    print("CI 工作流校验: %s" % path)
    print("  行数 %d，作业: %s" % (len(lines), ", ".join(jobs.keys())))
    if "verify" in jobs and "matrix:" in verify_body:
        mm = re.search(r"matrix:\n((?:        \w+:.*\n)+)", verify_body)
        if mm:
            print("  verify matrix:\n" + mm.group(1).rstrip())
    print()
    if problems:
        print("发现问题 %d 个:" % len(problems))
        for p in problems:
            print("  - " + p)
        return 1
    print("结构校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
