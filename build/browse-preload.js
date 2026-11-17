// 「找爆款」窗口顶栏用的桥：只能控制本窗口里的网页（前进后退、搜索、同款复刻）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browseUI', {
  act: (action, arg) => ipcRenderer.invoke('browse:toolbar', action, arg),
  onState: (cb) => ipcRenderer.on('browse:state', (_e, s) => cb(s)),
});
