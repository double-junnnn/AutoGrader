# -*- coding: utf-8 -*-
"""unbuild-single.py —— 把单文件版反推回多文件源码结构（build-single.py 的逆操作）。

为什么留着：单文件版是内联产物，一旦多文件源码丢失，它就是唯一完整副本。
本脚本证明了「源码 → 单文件 → 源码」是可逆的，用于灾备恢复。

用法：
    python3 tools/unbuild-single.py <单文件版.html> <输出目录>

示例：
    python3 tools/unbuild-single.py ../AutoGrader-单文件版.html ./restored

校验（推荐）：还原后立刻重新打包，与原件比对哈希，一致才算还原成功：
    cd restored && python3 build-single.py
"""
import hashlib
import re
import sys
from pathlib import Path

CSS_TAG = '<link rel="stylesheet" href="assets/css/main.css">'
JSMARK = re.compile(r"<script>\n/\* ===== ([A-Za-z0-9\-_.]+\.js) ===== \*/\n(.*?)\n</script>", re.S)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)

    src = Path(sys.argv[1]).resolve()
    out = Path(sys.argv[2]).resolve()
    s = src.read_text(encoding="utf-8")

    if not s.startswith("<!DOCTYPE html>"):
        sys.exit("[ERROR] 输入不是 HTML 单文件版")
    if JSMARK.search(s) is None:
        sys.exit("[ERROR] 未找到模块边界注释，可能不是本项目产物")

    # 1) CSS
    m = re.search(r"<style>\n(.*?)\n</style>", s, re.S)
    if not m:
        sys.exit("[ERROR] 未找到 <style> 块")
    css = m.group(1).rstrip("\n") + "\n"
    s = s[: m.start()] + CSS_TAG + s[m.end():]

    # 2) JS
    files = {}

    def take(mo):
        files[mo.group(1)] = mo.group(2).rstrip("\n") + "\n"
        return '<script src="assets/js/%s"></script>' % mo.group(1)

    s, n = JSMARK.subn(take, s)
    if n == 0:
        sys.exit("[ERROR] 未匹配到任何模块块")

    # 3) 落盘
    (out / "assets" / "css").mkdir(parents=True, exist_ok=True)
    (out / "assets" / "js").mkdir(parents=True, exist_ok=True)
    (out / "assets" / "css" / "main.css").write_text(css, encoding="utf-8", newline="")
    for name, body in files.items():
        (out / "assets" / "js" / name).write_text(body, encoding="utf-8", newline="")
    (out / "index.html").write_text(s, encoding="utf-8", newline="")

    print("还原完成 → %s" % out)
    print("  index.html %d 字节 · main.css %d 字节 · JS 模块 %d 个"
          % (len(s.encode("utf-8")), len(css.encode("utf-8")), len(files)))
    print("  源文件 sha256: %s" % hashlib.sha256(src.read_bytes()).hexdigest()[:16])


if __name__ == "__main__":
    main()
