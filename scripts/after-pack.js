'use strict';

/*
 * electron-builder hook: после упаковки .app его нужно подписать заново.
 * Electron поставляется с ad-hoc подписью, но упаковка меняет бандл,
 * и без повторной подписи macOS (особенно на Apple Silicon) отказывается
 * запускать приложение: "code has no resources but signature indicates they must be present".
 *
 * Полноценной подписи разработчика здесь нет, поэтому ставим ad-hoc подпись "-".
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(command, args) {
  execFileSync(command, args, { stdio: 'inherit' });
}

function signTarget(target) {
  if (!fs.existsSync(target)) return;
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', target]);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    console.warn(`[after-pack] не найден ${appPath}, подпись пропущена`);
    return;
  }

  const frameworksDir = path.join(appPath, 'Contents', 'Frameworks');
  const helpersDir = path.join(appPath, 'Contents', 'MacOS');

  // Сначала вложенные бинарники, потом сам бандл: подпись родителя ломается при правке детей.
  if (fs.existsSync(frameworksDir)) {
    for (const entry of fs.readdirSync(frameworksDir)) {
      if (entry.endsWith('.dylib')) signTarget(path.join(frameworksDir, entry));
    }
    for (const entry of fs.readdirSync(frameworksDir)) {
      const full = path.join(frameworksDir, entry);
      if (!fs.statSync(full).isDirectory()) continue;
      if (entry.endsWith('.framework')) signTarget(full);
      else if (entry.endsWith('.app')) signTarget(full);
    }
  }
  if (fs.existsSync(helpersDir)) {
    for (const entry of fs.readdirSync(helpersDir)) {
      if (entry.endsWith('Helper') || entry.includes('Helper')) {
        signTarget(path.join(helpersDir, entry));
      }
    }
  }

  signTarget(appPath);

  try {
    run('codesign', ['--verify', '--verbose=2', appPath]);
    console.log(`[after-pack] ad-hoc подпись установлена: ${appName}`);
  } catch (error) {
    console.error('[after-pack] проверка подписи не прошла:', error.message);
    throw error;
  }
};
