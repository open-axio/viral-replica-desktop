// 爆款复刻工作台 - Electron 桌面外壳
// 职责：启动随包分发的 workbench 本地服务，就绪后开窗显示网页，退出时干净关闭服务。
// 所有拆解/复刻/Key 都在用户本地，Electron 只做一个可见窗口，不上传任何数据。

const { app, BrowserWindow, dialog, shell, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const datadir = require('./datadir');

const PORT = 8765;
let serverProc = null;
let mainWindow = null;
let setupWin = null;
let installProc = null;

// workbench 随包装在 Contents/Resources 下（只读）。开发时则在仓库里与 build/ 同级。
// 不依赖 app.isPackaged（手动组装的 .app 该值为 false），从 main.js 实际所在位置
// 和 process.resourcesPath 两个基准分别向上逐级找，命中含 server.py 的目录即用。
function findWorkbench() {
  const candidates = [];
  const bases = [__dirname];
  if (process.resourcesPath) bases.push(process.resourcesPath);
  for (const base of bases) {
    candidates.push(path.resolve(base, 'workbench'));
    candidates.push(path.resolve(base, '../workbench'));
    candidates.push(path.resolve(base, '../../workbench'));
    candidates.push(path.resolve(base, '../../../workbench'));
    candidates.push(path.resolve(base, '../../../../workbench'));
  }
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'server.py'))) return c;
  }
  return null;
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) return reject(new Error('服务启动超时'));
        setTimeout(tryOnce, 400);
      });
      sock.setTimeout(1000, () => { sock.destroy(); });
    };
    tryOnce();
  });
}

// 代码在 workbench（只读），运行时和用户数据在 dataDir（可写）。
function startServer(workbench, dataDir) {
  const py = datadir.pythonPath(dataDir);
  const ffDir = path.join(dataDir, 'runtime', 'ffmpeg');

  if (!fs.existsSync(py)) {
    throw new Error('找不到本地运行环境：\n' + py);
  }

  const env = Object.assign({}, process.env);
  // server.py 侧由 console/paths.py 读这个变量决定 Key、项目和 runtime 的位置
  env[datadir.ENV_NAME] = dataDir;
  if (fs.existsSync(ffDir)) env.PATH = ffDir + path.delimiter + (env.PATH || '');

  serverProc = spawn(py, ['server.py'], {
    cwd: workbench,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', (d) => console.log('[server]', d.toString().trim()));
  serverProc.stderr.on('data', (d) => console.error('[server]', d.toString().trim()));
  serverProc.on('exit', (code) => {
    console.log('server exited with code', code);
    serverProc = null;
  });
}

// ---- 原生对话框：替代 Electron 默认禁用的 prompt/confirm/alert ----
// alert / confirm 用同步原生 box，直接返回。
ipcMain.on('dlg-alert', (event, { message }) => {
  dialog.showMessageBoxSync(mainWindow, { type: 'info', buttons: ['知道了'], message: message || '' });
  event.returnValue = undefined;
});
ipcMain.on('dlg-confirm', (event, { message }) => {
  const r = dialog.showMessageBoxSync(mainWindow, {
    type: 'question', buttons: ['取消', '确认'], defaultId: 1, cancelId: 0, message: message || ''
  });
  event.returnValue = (r === 1);
});
// prompt 需要输入框：弹一个带 input 的模态窗口。
// sendSync 只阻塞渲染进程，主进程事件循环继续运行，模态窗口可正常交互。
ipcMain.on('dlg-prompt', (event, { message, defaultValue }) => {
  const modal = new BrowserWindow({
    parent: mainWindow, modal: true, show: false,
    width: 460, height: 170, resizable: false, maximizable: false,
    title: '输入',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:14px -apple-system,sans-serif;margin:0;padding:18px;background:#fff;color:#222}
    p{margin:0 0 12px;line-height:1.5} input{width:100%;box-sizing:border-box;padding:8px;font-size:14px;border:1px solid #ccc;border-radius:6px}
    .row{margin-top:14px;text-align:right} button{padding:7px 16px;margin-left:8px;border:0;border-radius:6px;cursor:pointer}
    .cancel{background:#eee;color:#333} .ok{background:#1a7f37;color:#fff}
  </style></head><body>
    <p>${esc(message)}</p>
    <input id="v" value="${esc(defaultValue)}" autofocus>
    <div class="row"><button class="cancel" id="c">取消</button><button class="ok" id="o">确定</button></div>
    <script>
      const {ipcRenderer}=require('electron');
      const v=document.getElementById('v');
      function done(val){ipcRenderer.send('dlg-prompt-result',val);}
      document.getElementById('o').onclick=()=>done(v.value);
      document.getElementById('c').onclick=()=>done(null);
      v.addEventListener('keydown',e=>{if(e.key==='Enter')done(v.value);if(e.key==='Escape')done(null);});
      v.focus();v.select();
    <\/script>
  </body></html>`;
  let settled = false;
  const finish = (val) => {
    if (settled) return;
    settled = true;
    event.returnValue = val;
    if (!modal.isDestroyed()) modal.close();
  };
  ipcMain.once('dlg-prompt-result', (e, val) => finish(val));
  modal.on('closed', () => finish(null));
  modal.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  modal.show();
});

// ---- 首次启动向导：把 install.sh / install.ps1 包成图形界面 ----
// 安装逻辑一概不在这里重写：脚本本身已经幂等、带国内镜像回退、支持选模型档位。
// 这里只负责选目录、拼参数、把 stdout 转成进度。
let setupCtx = null;   // { workbench, dir, resolve, settled }

function openSetup(workbench, defaultDir) {
  return new Promise((resolve) => {
    setupCtx = { workbench, dir: defaultDir, resolve, settled: false };
    setupWin = new BrowserWindow({
      width: 980,
      height: 660,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '爆款复刻工作台 · 首次启动',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'setup-preload.js')
      }
    });
    setupWin.loadFile(path.join(__dirname, 'setup.html'));
    setupWin.on('closed', () => {
      setupWin = null;
      // 用户中途关掉：按取消处理，下次启动会重新引导
      if (setupCtx && !setupCtx.settled) {
        setupCtx.settled = true;
        setupCtx.resolve(null);
      }
    });
  });
}

function finishSetup(dir) {
  if (!setupCtx || setupCtx.settled) return;
  setupCtx.settled = true;
  const done = setupCtx.resolve;
  setTimeout(() => {
    if (setupWin && !setupWin.isDestroyed()) setupWin.close();
    done(dir);
  }, 900);   // 让用户看一眼「装好了」
}

ipcMain.handle('setup:initial', () => {
  const dir = (setupCtx && setupCtx.dir) || datadir.platformDefault();
  return { dir, free: datadir.freeSpaceGB(dir) };
});

ipcMain.handle('setup:pick-dir', async (_e, current) => {
  const r = await dialog.showOpenDialog(setupWin, {
    title: '选一个文件夹存数据和模型',
    defaultPath: current || undefined,
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths.length) return null;
  // 用户选的是上层文件夹，统一在里面建一个自己的目录，免得把别人的文件夹搅乱
  const dir = path.join(r.filePaths[0], 'ViralReplica');
  if (setupCtx) setupCtx.dir = dir;
  return { dir, free: datadir.freeSpaceGB(r.filePaths[0]) };
});

ipcMain.on('setup:install', (_e, opts) => {
  if (!setupCtx || installProc) return;
  const dir = (opts && opts.dir) || setupCtx.dir;
  const tier = (opts && opts.tier) || 'small';
  const mirror = !!(opts && opts.mirror);
  setupCtx.dir = dir;

  const workbench = setupCtx.workbench;
  const isWin = process.platform === 'win32';
  const script = path.join(workbench, isWin ? 'install.ps1' : 'install.sh');
  const cmd = isWin ? 'powershell' : 'bash';
  const args = isWin
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
       '-Target', dir, '-Model', tier].concat(mirror ? ['-Mirror'] : [])
    : [script, '--target', dir, '--model', tier].concat(mirror ? ['--mirror'] : []);

  const send = (payload) => {
    if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('setup:progress', payload);
  };
  const finish = (payload) => {
    installProc = null;
    if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('setup:done', payload);
  };

  if (!fs.existsSync(script)) {
    return finish({ ok: false, message: '找不到安装脚本：' + script });
  }

  const env = Object.assign({}, process.env);
  env[datadir.ENV_NAME] = dir;

  try {
    installProc = spawn(cmd, args, { cwd: workbench, env, windowsHide: true,
                                     stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return finish({ ok: false, message: String((err && err.message) || err) });
  }

  // 安装脚本每进一步打一行 "==> N/5 ..."，照这个推进度
  const onChunk = (buf) => {
    const text = buf.toString();
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/==>\s*(\d+)\s*\/\s*5/);
      send(m ? { step: Math.max(0, parseInt(m[1], 10) - 1), line } : { line });
    }
  };
  installProc.stdout.on('data', onChunk);
  installProc.stderr.on('data', onChunk);

  installProc.on('error', (err) => finish({ ok: false, message: String((err && err.message) || err) }));
  installProc.on('exit', (code) => {
    if (code === 0 && datadir.runtimeReady(dir)) {
      send({ step: 5 });
      finish({ ok: true });
      datadir.writeSettings({ dataDir: dir });
      finishSetup(dir);
    } else {
      finish({ ok: false, message: code === 0
        ? '脚本跑完了，但没找到可用的 Python，安装可能只完成了一半。'
        : '安装脚本退出码 ' + code + '。' });
    }
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '爆款复刻工作台',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  // 外部链接用系统浏览器打开，不在应用内跳转
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

async function bootstrap() {
  const workbench = findWorkbench();
  if (!workbench) {
    const tried = [__dirname, process.resourcesPath || '']
      .flatMap(b => ['workbench', '../workbench', '../../workbench', '../../../workbench', '../../../../workbench']
        .map(p => path.resolve(b, p)))
      .filter(Boolean).join('\n');
    dialog.showErrorBox(
      '安装不完整',
      '应用内缺少工作台文件，通常是安装包没装全或被安全软件拦掉了一部分。\n'
      + '请重新下载安装包装一次。\n\n已查找这些位置：\n' + tried
    );
    return app.quit();
  }
  let { dir } = datadir.resolve(workbench);

  // 瘦安装包不带运行时：第一次启动先把它装好，而不是直接报错。
  if (!datadir.runtimeReady(dir)) {
    const chosen = await openSetup(workbench, dir);
    if (!chosen) return app.quit();   // 用户关掉了向导
    dir = chosen;
  }
  datadir.writeSettings({ dataDir: dir });

  try {
    startServer(workbench, dir);
    await waitForPort(PORT, 90000);
    createWindow();
  } catch (err) {
    dialog.showErrorBox('启动失败', String(err && err.message || err));
    app.quit();
  }
}

app.whenReady().then(bootstrap);

function shutdown() {
  if (installProc && !installProc.killed) {
    try { installProc.kill('SIGTERM'); } catch (e) { /* noop */ }
  }
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill('SIGTERM'); } catch (e) { /* noop */ }
    setTimeout(() => {
      if (serverProc && !serverProc.killed) {
        try { serverProc.kill('SIGKILL'); } catch (e) { /* noop */ }
      }
    }, 1500);
  }
}
app.on('before-quit', shutdown);
app.on('window-all-closed', () => { shutdown(); app.quit(); });
