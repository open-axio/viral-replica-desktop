# 爆款复刻工作台 · 桌面版（viral-replica-desktop）

把 [viral-replica-workbench](https://github.com/alyunzhangu/viral-replica-workbench) 包装成一个「双击即用」的桌面 App：用户不用装 Python、不用敲命令、不用懂 Agent，打开窗口即可完成对标视频的拆解与复刻。**视频处理、Key、项目数据全部留在用户本机**，Electron 只提供一个窗口。

## 它怎么工作

```
ViralReplica.app  ──拉起──>  workbench/server.py（本地服务，用内置 runtime）
      │                              │
      └──显示窗口──> 127.0.0.1:8765  └──Key 存本地 console.env，项目存 projects/
```

架构采用「Electron 外壳 + 同级 workbench 文件夹」：workbench（含 Python/ffmpeg/模型）作为可写文件夹与 .app 放在一起，而不是塞进只读的 .app 包内——这样 Key 和项目数据才有地方写。

## 目录

| 路径 | 说明 |
|---|---|
| `build/main.js` | Electron 主进程：启动本地服务、就绪后开窗、退出时清理 |
| `build/package.json` | Electron 版本声明 |
| `build/build.sh` | macOS 一键打包脚本（产出 .dmg） |
| `build/build.bat` | Windows 打包脚本（产出 .exe，需在 Windows 运行） |
| `build/electron-builder.yml` | electron-builder 配置（Windows/Linux 用） |
| `使用说明.txt` | 终端用户：安装、启动、配 Key、常见问题 |
| `打包说明.md` | 开发者：重新打包步骤、Windows 构建法、合规提醒 |

## 快速打包（macOS）

```bash
cd build
npm install                 # 首次，下载 Electron
chmod +x build.sh
./build.sh                  # 产出上级目录的 ViralReplica.dmg
```

打包脚本会先把 workbench 复制进来并**自动排除 console.env / projects / library / .git / 日志**，再 ad-hoc 签名、用 hdiutil 生成 dmg。使用前请把 `build.sh` 顶部的 `WORKBENCH_SRC` 指向你本机的 viral-replica-workbench 目录。

打好的 dmg 里包含 `ViralReplica.app` 和 `workbench` 文件夹，用户必须把两者放在一起。详细见 `使用说明.txt` 和 `打包说明.md`。

## 限制与合规

- **.dmg 只能在 macOS 构建，.exe 只能在 Windows 构建**（Electron 不支持跨平台编译）。
- macOS 上 ad-hoc 签名的 App 首次打开需右键 → 打开；正式分发需 Apple 开发者账号签名公证。
- 本项目沿用上游 Hypit 修改版 Apache 2.0 许可证：**禁止多租户 / hosted / SaaS 形式对外提供，不论是否收费**。桌面版属于「用户本机自用」，符合许可；若要做成在线服务，需向 Hypit.AI 取得书面授权。分发时请保留 LICENSE 与 THIRD_PARTY_NOTICES.md。
- 本仓库**不含**打好的 dmg 和 workbench runtime（体积过大）。请自行按上述步骤打包。

## 相关项目

- [viral-replica-workbench](https://github.com/alyunzhangu/viral-replica-workbench) — 被包装的核心工作台
- [rea-video](https://github.com/JuneYaooo/rea-video) — 另一种视频逆向拆解工具（Apache 2.0，可商用）
