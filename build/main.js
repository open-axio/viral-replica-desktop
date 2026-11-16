// 爆款复刻工作台 - Electron 桌面外壳
// 职责：启动随包分发的 workbench 本地服务，就绪后开窗显示网页，退出时干净关闭服务。
// 所有拆解/复刻/Key 都在用户本地，Electron 只做一个可见窗口，不上传任何数据。

const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

const PORT = 8765;
let serverProc = null;
let mainWindow = null;

// workbench 与 .app 同级放在同一文件夹里。
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

function startServer(workbench) {
  const venvPy = path.join(workbench, 'runtime', 'venv', 'bin', 'python');
  const ffDir = path.join(workbench, 'runtime', 'ffmpeg');
  const useExe = process.platform === 'win32';
  const py = useExe
    ? path.join(workbench, 'runtime', 'venv', 'Scripts', 'python.exe')
    : venvPy;

  if (!fs.existsSync(py)) {
    throw new Error('找不到本地运行环境：\n' + py + '\n请确认随包的 workbench/runtime 完整。');
  }

  const env = Object.assign({}, process.env);
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: '爆款复刻工作台',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
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
      '找不到工作台文件',
      '请把 workbench 文件夹和本应用放在同一个文件夹里，再重新启动。\n\n已查找这些位置：\n' + tried
    );
    return app.quit();
  }
  try {
    startServer(workbench);
    await waitForPort(PORT, 90000);
    createWindow();
  } catch (err) {
    dialog.showErrorBox('启动失败', String(err && err.message || err));
    app.quit();
  }
}

app.whenReady().then(bootstrap);

function shutdown() {
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
