# activeContext · 交接

更新：2026-11-23 ｜ 进行中：首页改版（规格 `docs/specs/首页改版.md`）｜ 分支 `feat/home-redesign`

## 当前

T1、T2、T7 已验收；T3、T4、T5 实现验收通过，任务清单暂不勾，正式收口等真机，可跟 T6 一起过。T6 已实现、尚未推送。分支 `feat/home-redesign`。T6：已登录且还没成功做过同款、也没关掉过提示时，工具条下出现可关闭轻提示「看中了就点同款，会自动拆给你看」；关掉后或成功做过同款后不再出现。分享链接仍在找爆款区域；已登录时在首页内容区打开，不新开浏览窗口；未登录先走「去登录」，登完在内嵌区打开该链接，不在隐藏视图里默默加载。登录窗没有登录成功就关掉时，清空主进程 `pendingAfterLogin` 和页面侧 `fvPendingShareUrl`；本次 `startLogin` 若没有 afterUrl，也不沿用上一次记下的链接。未登录说明、登录成功短确认、介绍关闭后的「自己放一条视频进来」和「最近的项目」保持原样。推送和开 PR 等点头。

验证：`node workbench/tools/test_home_login_ui.js` 13 条通过（含未登录说明、短确认、轻提示可关/同款成功后不再出现、已登录分享链接走 open、未登录分享链接先 startLogin 且不 open、未成功登录关窗后再去登录不带旧链接）；`test_home_about_ui.js` 6 条通过（含介绍关闭后可见自己放一条和最近的项目）；`node build/test_browse.js` 通过（含登完打开分享链接而不是只回平台首页；未成功登录就关掉后，再一次不带 afterUrl 的去登录成功回到平台首页，不得打开旧分享链接）；`test_home_embed_ui.js` 8、`test_login_state.js`、`test_round24_16_ui.js` 13 回归通过。

真机：T3 三家登录态、T4 至少完整走通抖音、T5 打开一条正在播放的视频点同款能建项目并进入该项目、T6 轻提示与分享链接（未登录先登录再打开该链接），以及高缩放对位和浮层遮挡：not run — 本环境无桌面真机会话。小红书、B 站 T4 真机：not run — 同上。同款仍然只认当前页能读到的播放地址，真机时要先让视频播起来再点。

---

# 此前交接（至 2026-11-17）

更新：2026-11-17 15:35 ｜ main = `c8da595` ｜ 进行中：`feat/free-steps-without-key` @ `8d51651`（PR #7）

## 一句话现状

桌面版瘦安装包 + 首次启动向导已在用户 Mac 上真机跑通。正在验证「没填 Key 也能先跑完免费三步」。

## 已合并（main）

| PR | 内容 |
|---|---|
| #1 | workbench 并入单仓库；`updater.py` 指向本仓库（`SUBDIR = 'workbench/'`）；瘦包；CI；全套图标 |
| #3 | `console/paths.py` 引入 DATA_DIR，数据与运行时移出 .app；首次启动向导（`build/setup.html`、`datadir.js`） |
| #4 | CI：未配证书时 unset 空的 `CSC_LINK` |
| #5 | 不往 bundle 里写：updater 状态目录改到 DATA_DIR；mac 打包版禁用原地代码更新 |
| #6 | 无证书时 `afterpack-adhoc.js` 做 ad-hoc 签名，修复「已损坏，无法打开」 |

## 进行中

**PR #7 免费三步不要 Key**：Key 检查从拆解开头挪到第 04 步前，没 Key 时停在 `free_done`；并删掉 `server.py` analyze 接口里提前查 Key 的那句。CI 绿，测试包 run `44038737937`。**等用户真机确认后合并。**

## 验证情况

| 项 | 结论 |
|---|---|
| 向导、启动服务、数据外移、ad-hoc 签名 | passed（用户 Mac 真机） |
| PR #7 端到端（真实 HTTP：建项目→上传→POST /analyze→free_done） | passed（云端容器） |
| PR #7 真机 | not run — 等用户安装测试包 |
| 既有测试差分 | passed — 前后均为 1199 / 408 失败 / 110 错误 / 5 跳过。基线非全绿：容器缺 runtime |
| `install.ps1` 改动 | not run — 无 Windows 环境 |
| Windows 安装包 | CI 构建 passed；未真机安装 |

## 下一步

1. 用户确认 PR #7 → 合并
2. `docs/specs/rea-video并入拆解.md`：作为免费区第四步「认拍摄方式」。**镜号对齐是关键**：吃 03 的切点，按 03 镜号 1:1 输出
3. `docs/specs/界面与流程重写.md`：按 Claude Design 画板「爆款复刻工作台 · 交互与界面重设计」实现

## 遗留风险与工作约定

- **改了 `workbench/` 下被 `code-update.json` 收录的文件，必须重建清单**，`VERSION` 与清单版本号同步。新增文件要加进清单。脚本见 `打包说明.md`
- **测试要走真实 HTTP**。写请求需带页面版本头 `X-Server-Build` / `X-Web-Build`（取自 `GET /api/status`）。只调函数会绕过接口层的检查——PR #7 第一版就栽在这里
- 环境分工：代码修改、推送、开 PR、触发 CI 都在云端做。连接用户 Mac 的通道是受限 Linux 虚拟机，只看得到授权文件夹，连不上 GitHub/npm，也跑不了 macOS 二进制
- Agent 自己开的 PR 不能自己合，需用户明确说「合吧」
- mac 打包版暂无 8MB 应用内代码更新，恢复方案为覆盖层（spec T8）
- 签名证书未申请；Hypit 许可 (b) 条：不可收费分发、不可做多租户
- 用户桌面 `repo/` 是 #1 时的旧快照，已建议用 `git clone` 替换
- 已废弃未删的分支：`feat/monorepo-thin-package`、`feat/data-dir-migration`、`feat/data-dir-on-main`
