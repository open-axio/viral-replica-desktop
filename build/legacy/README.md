# 已停用的脚本

单仓库合并（2026-11-17）之后这三个脚本都不再需要，留档备查。

| 脚本 | 为什么不用了 |
|---|---|
| `build.sh` | 旧架构：手工拼 Electron.app 骨架，把 workbench 作为**同级文件夹**塞进 dmg。现在 workbench 走 electron-builder 的 `extraResources` 进 `Contents/Resources`，不再需要同级摆放 |
| `patch-workbench.sh` | 旧流程：打包时给上游代码打 `pagePrompt` 补丁。合并后补丁已经是仓库里的源码，不用再打 |
| `prepare-workbench.sh` | 旧流程：从别处取源码再剥 runtime。现在 workbench 就在同一个仓库里，electron-builder 直接按 filter 取 |

现在打包只有一步：`npm install` 之后 `npx electron-builder`。
