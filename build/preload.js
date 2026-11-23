// 覆盖被 Electron 默认禁用的原生 prompt/confirm/alert。
// 工作台源码用同步 prompt("项目名称",...) 新建项目；Electron 默认让 prompt 返回 null，
// 导致点击按钮后毫无反应。这里用同步 IPC 转发到主进程的原生对话框/模态输入框。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__dlg', {
  prompt: (message, defaultValue) => ipcRenderer.sendSync('dlg-prompt', { message, defaultValue }),
  confirm: (message) => ipcRenderer.sendSync('dlg-confirm', { message }),
  alert: (message) => ipcRenderer.sendSync('dlg-alert', { message })
});

// 「找爆款」：把平台页嵌进首页；点「同款复刻」建好项目后通知页面打开它。搜索不再新开窗口。
contextBridge.exposeInMainWorld('__browse', {
  available: true,
  open: (opts) => ipcRenderer.invoke('browse:open', opts),
  layout: (bounds) => ipcRenderer.invoke('browse:layout', bounds),
  hide: () => ipcRenderer.invoke('browse:hide'),
  debug: () => ipcRenderer.invoke('browse:debug'),
  act: (action, arg) => ipcRenderer.invoke('browse:toolbar', action, arg),
  startLogin: (opts) => ipcRenderer.invoke('browse:startLogin', opts),
  onState: (cb) => ipcRenderer.on('browse:state', (_e, s) => cb(s)),
  onImported: (cb) => ipcRenderer.on('browse:imported', (_e, project) => cb(project)),
  onLoggedIn: (cb) => ipcRenderer.on('browse:logged-in', (_e, s) => cb(s)),
});

// contextIsolation 下 preload 的 window 与页面主世界隔离，需注入脚本到主世界覆盖原生方法。
const patch = document.createElement('script');
patch.textContent = `
(function () {
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  window.alert = function(message){ if(window.__dlg) window.__dlg.alert(String(message??'')); };
  window.confirm = function(message){ return window.__dlg ? window.__dlg.confirm(String(message??'')) : true; };
  window.prompt = function(message, defaultValue){
    if(!window.__dlg) return null;
    return window.__dlg.prompt(String(message??''), String(defaultValue??''));
  };
})();
`;
(document.head || document.documentElement).appendChild(patch);
patch.remove();
