'use strict';
// macOS 개발 모드(yarn start)에서 Dock·메뉴바·Cmd+Tab 에 "Electron" 이름과 기본 아이콘이 뜨는 문제 해결.
// node_modules 안의 Electron.app 의 표시 이름과 아이콘만 바꾼다 (실행 파일·프레임워크는 그대로).
// 배포 빌드(electron-builder)는 productName·build/icon.png 로 따로 만들어지므로 영향 없음.
// postinstall 과 start 전에 자동 실행. macOS 가 아니면 아무것도 안 함.

if (process.platform !== 'darwin') process.exit(0);

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NAME = require('../package.json').productName;
const root = path.join(__dirname, '..');
const app = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(app, 'Contents', 'Info.plist');
const res = path.join(app, 'Contents', 'Resources');
const src = path.join(root, 'build', 'icon.png');
const stamp = path.join(res, '.wani-brand');

if (!fs.existsSync(plist)) process.exit(0);
const want = `${NAME}|${fs.statSync(src).mtimeMs}`;
if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) process.exit(0);

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'ignore' });
try {
  // 1) 이름
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    try { run('plutil', ['-replace', key, '-string', NAME, plist]); }
    catch (e) { run('plutil', ['-insert', key, '-string', NAME, plist]); }
  }
  // 2) 아이콘 (png → icns)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wani-icon-'));
  const set = path.join(tmp, 'icon.iconset');
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    run('sips', ['-z', String(s), String(s), src, '--out', path.join(set, `icon_${s}x${s}.png`)]);
    run('sips', ['-z', String(s * 2), String(s * 2), src, '--out', path.join(set, `icon_${s}x${s}@2x.png`)]);
  }
  run('iconutil', ['-c', 'icns', set, '-o', path.join(res, 'electron.icns')]);
  fs.rmSync(tmp, { recursive: true, force: true });
  // 3) Finder/Dock 캐시 갱신
  run('touch', [app]);
  try { run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app]); } catch (e) { /* 없어도 됨 */ }
  fs.writeFileSync(stamp, want);
  console.log(`✔ 개발용 Electron.app → "${NAME}" 이름·아이콘 적용`);
} catch (e) {
  console.warn('개발용 앱 이름/아이콘 적용 실패 (실행에는 문제 없음):', e.message);
}
