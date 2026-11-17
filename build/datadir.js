// 数据目录的解析与记忆。与 workbench/console/paths.py 的规则保持一致。
//
// 代码装在应用内部（macOS 是 .app/Contents/Resources，只读；往签名过的 bundle
// 里写东西会让签名失效），而 Key、项目和运行时都要可写，所以落在应用外部。

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ENV_NAME = 'VIRALREPLICA_DATA_DIR';

// 用户在向导里选的目录记在这里。这个文件本身由 Electron 管，始终可写。
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {};
  } catch (e) {
    return {};
  }
}

function writeSettings(patch) {
  const next = Object.assign(readSettings(), patch);
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// 平台默认位置，和 paths.py 的 _platform_data_dir 一一对应
function platformDefault() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'ViralReplica');
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'ViralReplica');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'ViralReplica');
}

// 旧布局：runtime 和 console.env 就在 server.py 同级。老用户升级后要继续能用。
function legacyDir(workbench) {
  if (!workbench) return null;
  const markers = ['console.env', 'runtime', 'projects'];
  return markers.some((n) => fs.existsSync(path.join(workbench, n))) ? workbench : null;
}

// 优先级：环境变量 > 用户选过的 > 旧布局 > 平台默认
function resolve(workbench) {
  const env = (process.env[ENV_NAME] || '').trim();
  if (env) return { dir: env, source: 'env' };

  const saved = readSettings().dataDir;
  if (saved && typeof saved === 'string') return { dir: saved, source: 'saved' };

  const legacy = legacyDir(workbench);
  if (legacy) return { dir: legacy, source: 'legacy' };

  return { dir: platformDefault(), source: 'default' };
}

function pythonPath(dataDir) {
  return process.platform === 'win32'
    ? path.join(dataDir, 'runtime', 'venv', 'Scripts', 'python.exe')
    : path.join(dataDir, 'runtime', 'venv', 'bin', 'python');
}

// 运行时装好了没。只看 python 在不在——装到一半的目录里 python 还没生成。
function runtimeReady(dataDir) {
  try {
    return fs.existsSync(pythonPath(dataDir));
  } catch (e) {
    return false;
  }
}

// 粗略估算可用空间，给向导显示。拿不到就返回 null，界面上就不显示。
function freeSpaceGB(dir) {
  try {
    let probe = dir;
    while (probe && !fs.existsSync(probe)) probe = path.dirname(probe);
    const st = fs.statfsSync(probe);
    return Math.round((st.bavail * st.bsize) / 1073741824);
  } catch (e) {
    return null;
  }
}

module.exports = {
  ENV_NAME,
  platformDefault,
  resolve,
  pythonPath,
  runtimeReady,
  freeSpaceGB,
  readSettings,
  writeSettings,
};
