# -*- coding: utf-8 -*-
"""
把 answers.txt 编译成 js/answers.js

用途：方案 c 的兜底数据源。
页面启动时会先 fetch('answers.txt')（http 环境下可拿到最新条目），
失败则回落到本脚本生成的 js/answers.js（file:// 双击打开时必须依赖它）。

用法：
    双击 build.bat     （推荐）
    或 python tools/build_data.py
"""

import os
import sys
import json
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "answers.txt")
DST = os.path.join(ROOT, "js", "answers.js")


def load_answers(path):
    """一行一条。忽略空行，忽略以 # 开头的注释行。"""
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read().splitlines()

    items = []
    for line in raw:
        s = line.strip()
        if not s:
            continue
        if s.startswith("#"):
            continue
        items.append(s)
    return items


def build_js(items):
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    body = ",\n".join("  " + json.dumps(s, ensure_ascii=False) for s in items)
    return (
        "/* 本文件由 tools/build_data.py 自动生成，请勿手改。\n"
        " * 数据源：answers.txt\n"
        " * 编译时间：%s\n"
        " * 条目数：%d\n"
        " */\n" % (stamp, len(items))
        + "window.ANSWERS = [\n" + body + "\n];\n"
        + "window.ANSWERS_BUILT_AT = %s;\n" % json.dumps(stamp)
    )


def main():
    if not os.path.exists(SRC):
        print("[ERR] 找不到 answers.txt：%s" % SRC)
        return 1

    items = load_answers(SRC)
    if not items:
        print("[ERR] answers.txt 里没有有效条目（空行和 # 开头的行会被忽略）")
        return 1

    os.makedirs(os.path.dirname(DST), exist_ok=True)
    with open(DST, "w", encoding="utf-8") as f:
        f.write(build_js(items))

    print("[OK] 已编译 %d 条 -> js/answers.js" % len(items))
    print("     双击 index.html 即可预览最新内容。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
