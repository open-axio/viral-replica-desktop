// 没有开发者证书时，给 .app 补一个 ad-hoc 签名。
//
// electron-builder 在没有证书时会直接跳过签名。但它打包时改过 Electron 原本的
// 程序包（改名、加资源、改 Info.plist），Electron 自带的签名随之失效。Apple 芯片
// 的 Mac 拒绝运行签名失效的程序，用户下载后就会看到「已损坏，无法打开」。
//
// afterPack 在打成 dmg 之前执行，所以签好的 .app 会被原样装进 dmg。
// 有证书时什么都不做，交给 electron-builder 正常签名公证。
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • 无开发者证书，做 ad-hoc 签名  app=${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  // 签坏了就让构建直接失败，别把打不开的包发出去
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
