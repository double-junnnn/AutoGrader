# -*- coding: utf-8 -*-
"""把多文件版 AutoGrader 内联打包成单文件 HTML。

用法：
    cd autograder && python3 build-single.py

产物（都写在本目录的上一级，两份内容完全相同）：
    AutoGrader-单文件版.html   项目内的正式叫法，README / HANDOVER 都指向它
    index.html                 给静态托管用的入口 —— GitHub Pages 等托管只认根目录的
                               index.html，而真正的应用入口在 autograder/ 子目录里，
                               所以必须有这么一份落在根上。两份由本脚本同时产出，不会脱节。

（CSS 与全部 JS 已内联，双击即用，不依赖 assets/ 目录）

内联格式（与 assets 目录一一对应，可被 tools/unbuild-single.py 反向拆分）：
    <link rel="stylesheet" href="assets/css/main.css">
        -> <style>\\n{css}\\n</style>
    <script src="assets/js/x.js"></script>
        -> <script>\\n/* ===== x.js ===== */\\n{js}\\n</script>
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ENTRY = ROOT / "index.html"
OUT = ROOT.parent / "AutoGrader-单文件版.html"
OUT_WEB = ROOT.parent / "index.html"

CSS_RE = re.compile(r'<link\s+rel="stylesheet"\s+href="(assets/css/[^"]+)"\s*/?>')
JS_RE = re.compile(r'<script\s+src="(assets/js/[^"]+)"></script>')


def read_text(rel: str) -> str:
    p = ROOT / rel
    if not p.exists():
        sys.exit("[ERROR] 缺少文件：%s" % p)
    # 统一换行 + 末尾保留单个换行，保证跨平台打包产物一致
    return p.read_text(encoding="utf-8").replace("\r\n", "\n").rstrip("\n") + "\n"


def main() -> None:
    if not ENTRY.exists():
        sys.exit("[ERROR] 找不到 index.html：%s" % ENTRY)
    html = ENTRY.read_text(encoding="utf-8").replace("\r\n", "\n")

    stats = {"css": 0, "js": 0}

    def css_sub(m):
        css = read_text(m.group(1))
        stats["css"] += 1
        return "<style>\n%s\n</style>" % css

    def js_sub(m):
        rel = m.group(1)
        name = Path(rel).name
        js = read_text(rel)
        # JS 里若出现 </script> 会提前终止脚本块，转义后语义等价
        js = js.replace("</script>", "<\\/script>")
        stats["js"] += 1
        return "<script>\n/* ===== %s ===== */\n%s\n</script>" % (name, js)

    html = CSS_RE.sub(css_sub, html)
    html = JS_RE.sub(js_sub, html)

    leftover = CSS_RE.findall(html) + JS_RE.findall(html)
    if leftover:
        sys.exit("[ERROR] 以下引用未被内联（检查路径/引号）：%s" % leftover)

    # 两份内容完全相同：一份是项目内的正式叫法，一份给静态托管当入口
    OUT.write_text(html, encoding="utf-8", newline="")
    OUT_WEB.write_text(html, encoding="utf-8", newline="")
    size = len(html.encode("utf-8"))
    print("打包完成：%s" % OUT)
    print("          %s  （静态托管入口）" % OUT_WEB)
    print("  内联 CSS %d 个 · JS %d 个 · 共 %d 字节（%.0f KB）" % (stats["css"], stats["js"], size, size / 1024))


if __name__ == "__main__":
    main()
