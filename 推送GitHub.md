# 把 AutoGrader 推到 GitHub，并开通可协作的线上地址

> 这份文档解决的是「**怎么让线上跟着代码走**」。
> 本地 git 仓库已经建好（2 次提交、62 个文件、2.85 MB），**只差推送这一步**。

---

## 先说清楚一件事：静态站点没有「在线编辑」

AutoGrader 是一包静态文件（HTML + CSS + JS），不存在一个"后台"能让你点进去改。

所谓**「直接改线上」**，本质是让线上跟着**某个共享源头**走。所以问题不是"能不能在线改"，
而是**源头放哪儿、谁来触发更新**。想通了这一步，剩下的都是配置。

| 方案 | 能在线改吗 | 链接会变吗 | 适合什么 |
| --- | --- | --- | --- |
| CloudStudio 沙箱（现在那个链接） | ❌ 每次部署都是**新工作区、新链接**，工具不支持原地更新 | 会变 | 临时预览、发给评委看一眼 |
| **GitHub 仓库 + Pages** | ✅ 改完 `git push`，1 分钟后线上就变 | **固定** | **长期协作主站** |
| Gitee Pages | ✅ 同上 | 固定 | 国内访问快，但免费版要实名 + 手动点部署 |

沙箱那条路走不通的原因很实在：它是**临时环境**，有生命周期，而且每次部署都生成新链接 ——
别人收藏的旧链接会失效，也没法多人同时改。

---

## 一、建空仓库（30 秒，网页操作）

1. 登录 <https://github.com>，右上角 `+` → **New repository**
2. **Repository name** 填 `AutoGrader`
3. 选 **Public**（公开）
   —— 评委点开就能看；而且只有公开仓库才能免费用 Pages
4. 下面三个勾（README / .gitignore / License）**一个都别勾** —— 我们本地都有了，勾了会冲突
5. 点 **Create repository**

创建完会停在一个空仓库页面，**把页面上显示的仓库地址复制下来**（形如
`https://github.com/你的用户名/AutoGrader.git`）。

---

## 二、推送（二选一）

### 路线 A：你自己执行（推荐，最安全）

在本机终端里跑这两条，走一遍就完事：

```bash
cd "C:\Users\周俊宏\LearnBuddy\2026-09-17-19-03-05"
git remote add origin https://github.com/你的用户名/AutoGrader.git
git push -u origin main
```

第一次推送会弹出登录窗口（Git Credential Manager），用浏览器授权一次即可，
之后不用再输密码。

### 路线 B：让 AI 代推（需要你给一个 Token）

AI 的运行环境**能连通 GitHub**（已实测：`git ls-remote` 成功、API 可达），所以技术上可以代推。
但认证绕不开你：

1. 打开 <https://github.com/settings/tokens> → **Generate new token (classic)**
2. 勾选 **repo** 权限，有效期选 7 天就够
3. 把 token 发给 AI，让它在推送时临时使用
4. **推完立刻去同一个页面把这个 token 删掉**

> Token 等同于你的账号写权限。路线 A 不需要交出任何凭据，更稳妥 ——
> 但如果你就是想省事，路线 B 也完全可行，用完即撤销即可。

---

## 三、开通线上地址（Pages）

推上去之后：

1. 打开仓库页 → **Settings**
2. 左侧栏 → **Pages**
3. **Source** 选 `Deploy from a branch`
4. **Branch** 选 `main`，目录选 `/ (root)` → **Save**
5. 等 1~2 分钟，访问：

```
https://你的用户名.github.io/AutoGrader/
```

**这一步有个坑，我们已经提前填好了**：Pages 的根路径只认根目录下的 `index.html`，
而应用真正的入口在 `autograder/` 子目录里。仓库根目录那份 `index.html` 就是为此准备的
（由 `build-single.py` 与 `AutoGrader-单文件版.html` 同时产出，内容完全一致，不会脱节）。

—— 所以你不需要像早先那份说明里讲的那样手动去改文件名。

---

## 四、之后怎么「改线上」

这就变成一条命令的事：

```bash
cd autograder && python3 build-single.py   # ① 改完源码，重建单文件版（顺带刷新根 index.html）
node tools/scan-banned-words.mjs           # ② 违禁词体检，期望 0 处一级
git add -A && git commit -m "说明改了什么"  # ③ 提交
git push                                   # ④ 推上去，1 分钟后线上自动更新
```

**第 ① 步不能省。** 根目录的 `index.html` 是打包产物，源码改完不重跑，
线上会一直显示旧版——这是最容易犯的错。

### 多人协作

仓库页 → **Settings → Collaborators → Add people**，把队友的 GitHub 账号加进来，
他们就能直接 push。冲突用普通的 `git pull` / 分支合并处理。

---

## 五、如果想更省事：换掉发布方式

GitHub 的另一个用法是**不用本地 git**：直接在网页上编辑文件、拖拽上传，效果一样。
缺点是每次都要手动传、容易和本地版本不一致。

真正常用的省事做法是**接自动部署**：

- **Vercel / Netlify / Cloudflare Pages** 都能绑定仓库，push 后自动构建发布（本项目无构建步骤，直接发布）
- 好处是不依赖 GitHub Pages 的国内访问速度，且能自定义域名

要接的话说一声，我可以把配置文件写好。

---

## 附：为什么这次能连 GitHub，上次不能

上一份说明里写「运行环境访问不到 github.com（DNS 解析到黑洞地址 198.18.0.20）」——
那是**另一台机器**的网络策略。本次所在的运行环境实测：

```
git ls-remote https://github.com/git/git HEAD   → 成功返回 commit
curl https://api.github.com/rate_limit          → 返回 JSON
```

所以推送这一步在技术上是通的，只卡在**认证需要你本人授权**。
