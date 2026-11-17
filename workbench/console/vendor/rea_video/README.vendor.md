# rea-video（节选）

来源：https://github.com/JuneYaooo/rea-video ，commit `07dd587119e884f7c50fbfae92e47840de86bea5`（2026-11-16），版本 0.1.0。
许可：Apache License 2.0，原文见同目录 `LICENSE`，版权声明见 `NOTICE`。

## 带了哪些文件

只带「逐镜拍摄方式取证」用得到的 11 个模块，文件内容与上游该 commit **逐字节相同，未做修改**：

`__init__.py` `classify.py` `features.py` `shots.py` `transitions.py` `media.py` `probe.py` `i18n.py` `util.py` `faces.py` `overlay.py`

没带的（切镜、OCR、语音识别、人声分离、VLM、报告生成、复刻规划等）在这里一概不可用。`overlay.py` 里 OCR 相关函数引用了未带的 `stems` 模块，工作台只调用其中的 `static_overlays`，不会走到那条路径。

## 工作台怎么用它

调用方是 `console/forensics.py`（工作台自己的代码，不属于 rea-video）：

- 不用 rea-video 自己的切镜，直接把「03 切点检测」的镜头表喂给它的逐镜取证，输出按 03 镜号 1:1 排列；
- 只用像素取证（`classify.deterministic`），不启用 VLM；
- 把 11 个细分标签归成「实拍 / AI 生成 / 图文动画」三类；
- 人脸检测模型（YuNet，约 230 KB）首次使用时下载到运行时目录 `runtime/models/rea-video`，下载不了时退回 OpenCV 自带的 Haar 检测。

运行依赖：`numpy`、`opencv-python-headless`（由 install.sh / install.ps1 安装）。

## 更新

从上游换新版本时，整文件覆盖这 11 个模块并更新本文件里的 commit；若需要改动其中任何文件，按 Apache 2.0 §4(b) 在被改文件顶部注明改动。
