# 爆款复刻工作台 · 桌面版

把一条带货爆款视频，换成你自己的模特和商品，复刻成一条新视频。全程在你自己的电脑上跑，Key 存在本机。

## 仓库结构

```
├─ build/              Electron 外壳与打包配置
│  ├─ main.js            主进程：拉起本地服务、开窗口
│  ├─ assets/            图标与安装器物料
│  └─ legacy/            已停用的旧脚本，留档
├─ workbench/          工作台本体（界面、拆解流水线、模型网关）
│  ├─ web/               用户看到的网页界面
│  ├─ console/           拆解流水线与各步骤逻辑
│  ├─ engine/            生图生视频脚本
│  └─ code-update.json   代码更新清单，应用内更新读它
└─ .github/workflows/  打 tag 自动双平台出包
```

**runtime 与模型不在仓库里。** 它们约 2GB，由用户首次启动时按需下载到自己选的数据目录。

## 打包

本地自测：

- macOS：双击 `build/build.command`
- Windows：双击 `build/build.bat`

正式发版不用手动打包、也不用手动上传：

```bash
git tag v1.3.0
git push --tags
```

GitHub Actions 会在 macOS 和 Windows 上各打一份，自动传到 Releases，并生成 electron-updater 要用的 `latest.yml` / `latest-mac.yml`。

## 三条独立的更新通道

| 更新什么 | 体积 | 怎么走 |
|---|---|---|
| 工作台代码 | 约 8MB | 应用内一键，`updater.py` 按 `code-update.json` 校验哈希后替换，不用重装。**macOS 打包版暂不支持**，见下方说明 |
| Electron 外壳 | 整包 | electron-updater 从 Releases 取，后台下载，重启生效。很少发生 |
| 识别模型 | 0.15～1.5GB | 用户在设置里换档位时才下，不跟版本绑定 |

绝大多数迭代只走第一条，用户点一下几秒完成。

> **macOS 打包版的例外**：代码装在 `.app` 内部，原地改写会破坏签名封印；用户直接从 dmg 里打开时系统还会把应用放在只读挂载点上运行。所以目前 mac 打包版检查到新版本时只提示下载新安装包，不做原地更新。Windows 按用户安装、以及源码直跑不受影响。要恢复 mac 上的 8MB 更新，需要把代码更新装进数据目录的覆盖层，见 `docs/specs/数据与运行时目录迁移.md` 的 T8。

## 许可证

本项目基于 [Hypit](https://github.com/hypit-ai/hypit) 的方法与部分提示词模板，按其修改版 Apache 2.0 以**同样的许可证**发布。详见 `LICENSE` 与 `THIRD_PARTY_NOTICES.md`。

可以自用、可以改、可以再发布；**不可**收费分发，**不可**做成多租户或托管服务——除非取得 Hypit.AI 的书面商业授权。
