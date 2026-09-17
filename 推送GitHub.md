# AutoGrader 的线上与协作

> **当前状态（2026-09-17 20:30）**
>
> | 项 | 状态 |
> | --- | --- |
> | 本地 git 仓库 | ✅ 已建，4 次提交，62 个文件 / 2.86 MB |
> | 代码推送 | ✅ **已推上 GitHub**，远端 62 文件与本地一致 |
> | 远端地址 | ⚠️ `https://github.com/zhoujunhong678-commits/-` —— **仓库名是 `-`**，需要改（见下） |
> | GitHub Pages | ❌ 未开启（当前 token 无此权限，需你手动点几下） |

---

## 一、先改仓库名（30 秒，必须做）

推送时用的是你账号里一个**已存在但完全为空**的仓库，它原本叫 `-` ——
当前这个 token 只有「内容读写」权限，**建仓库、改名、开 Pages 都被 GitHub 拒了**
（这是精细授权 token 的平台限制，不是配置问题）。

那个名字对参赛材料来说不能用（Pages 地址会变成 `.../github.io/-/`），所以请改掉：

1. 打开 https://github.com/zhoujunhong678-commits/-/settings
2. 最上面的 **Repository name** 输入框，把 `-` 改成 `AutoGrader`
3. 点右边的 **Rename**

**不用重新推送** —— GitHub 会自动把旧地址重定向到新地址，代码还在里面。

改完地址变成：`https://github.com/zhoujunhong678-commits/AutoGrader`

---

## 二、开通在线演示（Pages，1 分钟）

1. 打开 https://github.com/zhoujunhong678-commits/AutoGrader/settings/pages
2. **Source** 选 `Deploy from a branch`
3. **Branch** 选 `main`，目录选 `/ (root)` → **Save**
4. 等 1~2 分钟，访问：

```
https://zhoujunhong678-commits.github.io/AutoGrader/
```

> 仓库根目录的 `index.html` 就是为此准备的（Pages 的根路径只认根目录的 index.html，
> 而应用真正的入口在 `autograder/` 子目录）。它由 `build-single.py` 与
> `AutoGrader-单文件版.html` 同时产出，内容逐字节相同，不会脱节。

---

## 三、之后怎么「改线上」

```bash
cd autograder && python3 build-single.py   # ① 改完源码，重建单文件版（顺带刷新根 index.html）
node tools/scan-banned-words.mjs           # ② 违禁词体检，期望 0 处一级
cd .. && git add -A && git commit -m "…" && git push      # ③ 提交并推送
```

**第 ① 步不能省** —— 根目录的 `index.html` 是打包产物，源码改完不重跑，线上会一直是旧版。

### 推送时怎么认证

当前这台机器的 git 是 LearnBuddy 自带的可移植版（`~/.learnbuddy/vendor/PortableGit/`），
**没装凭据管理器**，所以命令行 push 会要账号密码 —— 而 GitHub 早已不支持密码推送。

三个办法，任选：

1. **用已装的 GitHub Desktop**（`%LOCALAPPDATA%\GitHubDesktop\app-3.6.5\GitHubDesktop.exe`）
   —— 加本地仓库后点 Commit / Push，认证由它接管，最省事
2. **换一个 classic token**（勾 `repo` 权限）：它比精细授权 token 权限更全，
   能建仓库、改名、开 Pages，还能配好 git 凭据
3. 临时把 token 写进推送 URL：
   `git push https://x-access-token:<token>@github.com/zhoujunhong678-commits/AutoGrader.git main`
   —— 用完记得去撤销 token

---

## 四、多人协作

仓库页 → **Settings → Collaborators → Add people**，把队友的 GitHub 账号加进来即可。
冲突用常规 `git pull` / 分支合并处理。

---

## 五、为什么静态站点没有「在线编辑」

AutoGrader 是一包静态文件（HTML + CSS + JS），不存在一个"后台"能让你点进去改。
所谓**「直接改线上」**，本质是让线上跟着**某个共享源头**走 —— 源头就是 Git 仓库，
`git push` 即触发更新。想通了这一步，剩下的都是配置。

顺带说明：早先那个 `aa05c82aff428371d.app.workbuddy.host` 是 **CloudStudio 沙箱**，
每次部署都是**新工作区、新链接**，不支持原地更新，且有生命周期 —— 只适合临时预览，
不适合当协作主站。

---

## 附：本次推送用到的凭据处理

- token 只写进了项目**外**的临时文件，用后已清空并删除
- `.git/config` 里的远端地址是**不含 token** 的干净地址（已核验：0 处匹配）
- token 未写入任何入库文件、未进入提交历史

> **建议你仍然去 https://github.com/settings/tokens 把这个 token 撤销掉** ——
> 它已经出现在聊天记录里了。之后按上面第三节的方案 1（GitHub Desktop）继续即可。
