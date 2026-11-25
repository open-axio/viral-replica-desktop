// node build/test_pack_files.js
// 主进程打进 asar 的 js 里，所有 require('./…') 都必须出现在 electron-builder.yml 的 files 白名单里。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BUILD_DIR = __dirname;
const YML = path.join(BUILD_DIR, 'electron-builder.yml');
const REQUIRE_RE = /require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g;

function parseFilesList(ymlText) {
  const files = [];
  let inFiles = false;
  for (const line of ymlText.split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    if (/^\S/.test(line) && line.trim() !== '') break;
    const m = line.match(/^\s+-\s+(\S+)/);
    if (m) files.push(m[1]);
  }
  return files;
}

function localRequires(jsText) {
  const out = [];
  REQUIRE_RE.lastIndex = 0;
  let m;
  while ((m = REQUIRE_RE.exec(jsText))) out.push(m[2]);
  return out;
}

function resolvePackedName(fromFile, reqPath) {
  const abs = path.resolve(BUILD_DIR, path.dirname(fromFile), reqPath);
  let rel = path.relative(BUILD_DIR, abs).split(path.sep).join('/');
  if (!path.extname(rel)) rel += '.js';
  return rel;
}

function isListed(filesList, name) {
  return filesList.includes(name) || filesList.includes(name.replace(/\.js$/, ''));
}

function findMissing(filesList, sources) {
  const missing = [];
  const packedJs = filesList.filter((f) => f.endsWith('.js') || !path.extname(f));
  for (const file of packedJs) {
    const text = sources[file];
    if (text == null) continue;
    for (const req of localRequires(text)) {
      const name = resolvePackedName(file, req);
      if (!isListed(filesList, name)) missing.push({ file, req, name });
    }
  }
  return missing;
}

function loadPackedSources(filesList) {
  const sources = {};
  for (const file of filesList) {
    if (!file.endsWith('.js')) continue;
    const srcPath = path.join(BUILD_DIR, file);
    assert.ok(fs.existsSync(srcPath), `files 白名单有 ${file}，但磁盘上没有这个文件`);
    sources[file] = fs.readFileSync(srcPath, 'utf8');
  }
  return sources;
}

// 漏了必须红：browse.js 依赖 login-state.js，白名单里没有就失败
const fixtureSrc = { 'browse.js': "const x = require('./login-state');\n" };
assert.deepStrictEqual(
  findMissing(['browse.js', 'login-state.js'], fixtureSrc),
  [],
  '白名单齐全时不应报漏',
);
const leaked = findMissing(['browse.js'], fixtureSrc);
assert.strictEqual(leaked.length, 1, '漏了 login-state.js 时检查应该红');
assert.strictEqual(leaked[0].name, 'login-state.js');

const yml = fs.readFileSync(YML, 'utf8');
const files = parseFilesList(yml);
assert.ok(files.includes('login-state.js'), 'files 白名单必须包含 login-state.js');

const sources = loadPackedSources(files);
const missing = findMissing(files, sources);
assert.deepStrictEqual(missing, [], `打进包的 js 漏了本地模块: ${JSON.stringify(missing)}`);

const withoutLogin = files.filter((f) => f !== 'login-state.js');
const shouldFail = findMissing(withoutLogin, sources);
assert.ok(
  shouldFail.some((m) => m.name === 'login-state.js'),
  '从白名单去掉 login-state.js 后，检查应该红',
);

console.log(`pack files check ok (${files.length} entries)`);
