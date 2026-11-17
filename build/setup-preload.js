// 首次启动向导的 IPC 桥。向导页面不开 nodeIntegration，只经由这里和主进程说话。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupApi', {
  // 向导打开时问一次：默认装到哪、那块盘还剩多少
  initial: () => ipcRenderer.invoke('setup:initial'),
  // 让用户挑个文件夹
  pickDir: (current) => ipcRenderer.invoke('setup:pick-dir', current),
  // 开始安装（可重复调用，安装脚本是幂等的）
  install: (opts) => ipcRenderer.send('setup:install', opts),
  // 进度：{ step?: number, line?: string }
  onProgress: (fn) => ipcRenderer.on('setup:progress', (_e, p) => fn(p)),
  // 结束：{ ok: boolean, message?: string }
  onDone: (fn) => ipcRenderer.on('setup:done', (_e, r) => fn(r)),
});
