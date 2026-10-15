'use strict';
// 자동 업데이트. GitHub Releases(공개)에서 새 버전을 확인한다.
// - Windows(NSIS) · Linux(AppImage): 백그라운드로 받아두고 [지금 재시작]으로 적용
// - macOS(코드서명 없음) · Linux(deb): 자동 설치가 막혀 있어서 "새 버전 → 다운로드" 알림만

const { app, shell } = require('electron');

const REPO = 'dfd1123/rb-trip-assistant';
const state = { status: 'idle', version: '', url: `https://github.com/${REPO}/releases/latest`, error: '' };
let autoUpdater = null;

const newer = (a, b) => {   // a > b ?
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

async function manualCheck() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) return;
    const rel = await res.json();
    if (newer(rel.tag_name, app.getVersion())) Object.assign(state, { status: 'available', version: rel.tag_name.replace(/^v/, ''), url: rel.html_url });
  } catch (e) { state.error = e.message; }
}

function canAutoInstall() {
  if (process.platform === 'win32') return true;
  if (process.platform === 'linux') return Boolean(process.env.APPIMAGE);
  return false;   // macOS: 서명 없는 앱은 Squirrel.Mac 이 설치를 거부
}

function check() {
  if (autoUpdater) autoUpdater.checkForUpdates().catch(() => manualCheck());
  else manualCheck();
}

function start() {
  if (!app.isPackaged || process.env.TRIP_ASSISTANT_NO_UPDATE) return;
  if (canAutoInstall()) {
    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.autoDownload = true;
      autoUpdater.on('update-available', i => Object.assign(state, { status: 'downloading', version: i.version }));
      autoUpdater.on('update-downloaded', i => Object.assign(state, { status: 'downloaded', version: i.version }));
      autoUpdater.on('error', e => { state.error = e.message; autoUpdater = null; manualCheck(); });
    } catch (e) { autoUpdater = null; }
  }
  setTimeout(check, 5000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

function install() {
  if (state.status === 'downloaded' && autoUpdater) { autoUpdater.quitAndInstall(); return true; }
  shell.openExternal(state.url);
  return false;
}

module.exports = { start, install, state, newer };
