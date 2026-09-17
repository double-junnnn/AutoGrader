# AutoGrader 的线上与协作

> **当前状态（2026-09-17 21:15）**
>
> | 项 | 状态 |
> | --- | --- |
> | 本地 git 仓库 | ✅ 6 次提交，62 个文件 |
> | 代码推送 | ✅ **已推上 GitHub**，远端与本地完全同步（`26593c4`） |
> | 远端地址 | ✅ `https://github.com/zhoujunhong678-commits/AutoGrader` |
> | GitHub Pages 配置 | ✅ 已启用（源 = `main` / `(root)`） |
> | **Pages 站点可访问** | ❌ **仍 404** —— 根因已查明，见第一节 |

---

## 一、Pages 404 的根因：**构建一次都没跑过**

已用 API 查得确凿数据：

```
/repos/.../pages          → has_pages = true · build_type = legacy · source = {main, /}
/repos/.../pages/builds   → （无任何构建记录）        ← 关键
/repos/.../actions/runs   → total_count: 0            ← 关键
```

**Pages 配置本身完全正确，但构建从未被触发。** 更关键的是：
**在启用 Pages 之后推送 `.nojekyll` 也没触发任何构建** —— 说明
**整个 GitHub Actions 在这个账号上跑不起来**，Pages 因此永远构建不出来，站点必然 404。

### 最可能的原因：账号太新

GitHub API 返回该账号 `created_at = 2026-09-16T16:01:39Z` —— **注册仅一天**。
GitHub 对新建账号运行 Actions 有门槛，**首要一条是邮箱必须已验证**；
未通过之前工作流不会运行。

### 请按顺序做这两件事

1. **验证邮箱** → https://github.com/settings/emails
   看有没有「Verify」字样。有就先点验证 —— 这是最常见的卡点。
2. **检查 Actions 开关** → https://github.com/zhoujunhong678-commits/AutoGrader/settings/actions
   看 **Actions permissions** 是不是被设成了 `Disable actions`。若是，改成
   `Allow all actions and reusable workflows` → Save。

做完任一项后，回到 https://github.com/zhoujunhong678-commits/AutoGrader/actions
应该能看到 `pages build and deployment` 开始跑。**跑绿之后站点就会在 1~2 分钟内上线。**

> 如果这两步都做了、Actions 里仍然一条记录都没有，那就属于账号级限制，
> 通常需要等账号「养熟」一两天；期间可以先用沙箱链接应急（见第五节）。

---

## 二、之后怎么「改线上」

```bash
cd autograder && python3 build-single.py   # ① 改完源码，重建单文件版（顺带刷新根 index.html）
node tools/scan-banned-words.mjs           # ② 违禁词体检，期望 0 处一级
cd .. && git add -A && git commit -m "…" && git push      # ③ 提交并推送
```

**第 ① 步不能省** —— 根目录的 `index.html` 是打包产物，源码改完不重跑，线上会一直是旧版。

Pages 正常后，演示地址是：

```
https://zhoujunhong678-commits.github.io/AutoGrader/
```


---

## 三、推送时怎么认证

当前这台机器的 git 是 LearnBuddy 自带的可移植版（`~/.learnbuddy/vendor/PortableGit/`），
**没装凭据管理器**，所以命令行 push 会要账号密码 —— 而 GitHub 早已不支持密码推送。

三个办法，任选：

1. **用已装的 GitHub Desktop**（`%LOCALAPPDATA%\GitHubDesktop\app-3.6.5\GitHubDesktop.exe`）
   —— 加本地仓库后点 Commit / Push，认证由它接管，最省事
2. **换一个 classic token**（勾 `repo` 权限）：比精细授权 token 权限更全，
   能建仓库、改名、开 Pages，还能配好 git 凭据
3. 临时把 token 写进推送 URL：
   `git push https://x-access-token:<token>@github.com/zhoujunhong678-commits/auto-grader.git main`
   —— 用完立刻去撤销 token

> ⚠️ **精细授权 token（`github_pat_` 开头）能力有限**：实测建仓库 / 改名 / 开 Pages
> **全部 403**，只能读写「已存在且已授权」仓库的内容。要全自动必须用 classic token。

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
