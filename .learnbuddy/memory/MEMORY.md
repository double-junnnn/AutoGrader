# AutoGrader 项目 · 长期笔记

## 项目定位
中文实验报告智能评阅 Web 应用，给高校教师用。粤港澳大湾区 AI Coding 创新大赛参赛作品（方向一：AI + 教学管理助手）。
线上：`https://aa05c82aff428371d.app.workbuddy.host`

## 不可动摇的架构约束（改前先读 HANDOVER 第 4 节）
- **零依赖、可离线**：无框架、无构建、无 CDN、无后端，解压双击 HTML 即用。
- **IIFE + 全局 `window.AG` 命名空间**，不用 ES Module —— ES Module 在 `file://` 下会被 CORS 拦截，
  改了直接毁掉「双击即用」这个核心卖点。
- PDF 导出自研（Canvas + 手工字节流），图表手写 SVG，不引 jsPDF / ECharts / Chart.js。
- 模块顺序 = index.html 中 `<script src>` 的顺序，不可随意调换（全局命名空间依赖）。

## 关键机制
- **打包可逆**：`build-single.py` 会给每个模块插入 `/* ===== <name>.js ===== */` 边界注释，
  所以单文件版可以反推回多文件源码（`tools/unbuild-single.py`）。
  单文件版因此也是**可用的灾备副本**。
- **改完源码必须重跑 `python3 build-single.py`**（产物写在 `autograder/` 上一级）。
- **改完人格词库/文案必须跑 `node tools/scan-banned-words.mjs`**，期望 0 处一级。

## 已知坑（HANDOVER 第 5 节，别重踩）
1. `response_format: json_object` **不能无条件带** —— 连通性测试（「请只回复 OK」）和答疑（自然语言）
   的 prompt 里没有 json 字样，会被 OpenAI 规范判 400。只有评分与量表生成才开，且带自动降级。
2. `file://` 下 `blob:` 下载会被浏览器拦 —— 导出走 `a[download]` + 环境检测，别改成 blob 直下。
3. `state.currentId` 不落 localStorage，刷新后由 `init()` 兜底。
4. 本地引擎对英文报告必然失真（中文信号词典漏匹配），已如实提示用户，**不是 bug**。

## 用户偏好（来自 HANDOVER 第 6 节）
- 全程中文，代码注释也中文。
- **不要用违禁词**、风格要收敛 —— 这类硬约束要落成**可复跑的检查**，不是口头承诺。
- 喜欢**有观点**的建议：说清推荐哪个、为什么，别列一堆选项让他自己挑。
- 交付标准：① 双版本 `file://` 全绿零错误 ② 违禁词 0 处一级 ③ 重建单文件版/样例/zip ④ 更新 README 并提交 git。

## 版权红线（不可让步）
README 第 8.1 节已公开承诺：吉祥物「形象本身为原创，**不使用任何影视剧角色**，规避版权风险」。
这是参赛材料的既有风险控制，**不要因为「好看」而用知名 IP 角色**（如《恶搞之家》的 Stewie）。
可以借鉴的是「神态」（半睁的傲慢眼、半边坏笑、抱臂），**头型、服装、五官组合、配色必须原创**。

## 美术工作流
改吉祥物 / 图标 / 任何 SVG 美术：先渲染成 PNG 自己看，再改，再交付。
- 技能 `svg-artwork-self-check`：SVG 美术自检（sharp 环境、双描边画肢体、半睁眼画法、头身比与线宽规格表）
- 技能 `raster-face-retouch`：位图角色改表情（ASCII 量坐标 → 按行插值补肤 → 重绘 → 取样配色）

## 吉祥物现状（2026-09-17 接入，位图）
资源在 `assets/js/mascots.js`，**base64 内联**（24 KB，256 色调色板 PNG）。
- **必须 base64**：PDF 印章要画进 Canvas，`file://` 下外链本地图片被判跨源 → 画布被污染 →
  `toDataURL` 抛错 → 整个导出报废。代价：单文件版 451 KB → 490 KB（+8.8%）。
- **只在「动画卡通」主题出现**：位图是暖色调，压进晴空蓝/深空霓虹的冷色渐变会像贴纸。
  切换逻辑在 `app.js` 的 `renderLogo()`；`theme.js` 保留一对 SVG 常量仅作兜底。
- 改图流程：`design/mascot/` 改图 → `_design/make-assets.mjs` 压图 →
  `_design/gen-mascots.mjs` 重新生成 `mascots.js` → 重建单文件版。

## 回归手段（三件套）
- `node tools/scan-banned-words.mjs` → 期望 0 处一级
- `python3 build-single.py` → 重建单文件版
- **jsdom 冒烟测试**（`_design/smoke.mjs`）：把单文件版真跑起来，15 项断言、零运行期错误。
  坑：jsdom 必须给 `url: 'http://localhost/'`，否则 localStorage 被禁、主题读写静默失效。
