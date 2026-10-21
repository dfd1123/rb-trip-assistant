'use strict';
// 자동 업데이트. 이 저장소 최신 Release 의 버전을 앱을 켤 때·창에 다시 들어올 때 확인하고,
// 새 버전이 있으면 화면에서 물어본 뒤 [업데이트]를 누르면 이 PC에 맞는 설치 파일을 받아 설치하고 다시 켠다.
// - Windows: NSIS 설치 파일 실행 / Linux: AppImage 덮어쓰기, deb·rpm 은 관리자 암호 한 번 받고 설치 (RB Management 방식 + deb·rpm 자동화)
// - macOS: Release 의 mac zip 을 받아 앱이 꺼진 뒤 .app 을 바꿔 끼우고 다시 연다 (서명 여부와 무관하게 동작)

const { app, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

// 배포: 이 저장소(공개) Release 'v<버전>' 에 설치 파일들 + version.json 을 올린다 (scripts/deploy.sh)
// releases/latest/download/… 는 최신 Release 파일로 바로 넘어가는 주소라 GitHub API 횟수 제한(같은 IP 시간당 60회)에 안 걸린다
const RELEASE_REPO = 'dfd1123/rb-trip-assistant';
const VERSION_URL = `https://github.com/${RELEASE_REPO}/releases/latest/download/version.json`;
const CHECK_GAP = 10 * 60 * 1000;   // 창에 다시 들어올 때마다 확인하되 10분에 한 번만
const state = { status: 'idle', version: '', current: '', notes: '', url: `https://github.com/${RELEASE_REPO}/releases`, percent: 0, error: '' };
let release = null, lastCheck = 0;

const newer = (a, b) => {   // a > b ?
  const pa = String(a).replace(/^v/, '').split('.').map(Number), pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};


/** 최신 버전 확인. force 가 아니면 10분에 한 번만 */
async function check(force = false) {
  state.current = app.getVersion();
  if (!app.isPackaged || process.env.TRIP_ASSISTANT_NO_UPDATE) return state;
  if (['downloading', 'installing'].includes(state.status)) return state;
  if (!force && Date.now() - lastCheck < CHECK_GAP) return state;
  lastCheck = Date.now();
  try {
    const res = await fetch(VERSION_URL, { cache: 'no-store' });
    if (!res.ok) return state;
    const v = await res.json();   // { version, notes, assets: [{ name, url }], updated_at }
    release = { tag_name: v.version, assets: (v.assets || []).map(a => ({ name: a.name, browser_download_url: a.url })) };
    if (newer(v.version, state.current) && !hasAssetForThisPC()) { Object.assign(state, { status: 'latest', version: '' }); return state; }   // 이 OS 파일이 빠진 배포(예: 맥 빼고 배포) → 이전 버전 유지
    if (newer(v.version, state.current)) Object.assign(state, { status: 'available', version: String(v.version).replace(/^v/, ''), notes: String(v.notes || '').slice(0, 1500),
      url: `https://github.com/${RELEASE_REPO}/releases/tag/v${String(v.version).replace(/^v/, '')}`, error: '' });
    else Object.assign(state, { status: 'latest', version: '' });
  } catch (e) { state.error = e.message; }
  return state;
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(file);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length; if (total) state.percent = Math.round(got / total * 100);
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
  }
  await new Promise((r, j) => out.end(e => e ? j(e) : r()));
  if (total && got !== total) throw new Error(`다운로드가 중간에 끊겼어요 (${got}/${total} bytes). 다시 시도해 주세요.`);
}

/** 받은 설치 파일 실행. Windows 는 방금 받은 exe 를 백신이 검사하는 동안 잠가 둬서 spawn EBUSY 가 난다 → 잠깐씩 기다리며 다시 시도 */
async function launchDetached(cmd, args = []) {
  let last;
  for (let i = 0; i < 20; i++) {
    try {
      const c = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      await new Promise((r, j) => { c.once('spawn', r); c.once('error', j); });
      c.unref(); return;
    } catch (e) { last = e; if (!/EBUSY|EPERM|EACCES/.test(String(e.code || e.message))) throw e; await new Promise(r => setTimeout(r, 1000)); }
  }
  throw new Error(`설치 파일을 실행하지 못했어요 (${last && (last.code || last.message)}). 백신이 검사 중일 수 있어요 — 잠시 뒤 [업데이트]를 다시 눌러 주세요.`);
}

/** macOS: zip 받기 → 풀기 → 앱이 꺼지면 .app 교체 후 다시 열기 */
async function installMac() {
  const appPath = path.resolve(process.execPath, '../../..');   // …/와니의 결재 도우미.app
  if (!appPath.endsWith('.app')) throw new Error('앱 위치를 찾지 못했어요');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const asset = (release.assets || []).find(a => a.name.endsWith(`-mac-${arch}.zip`)) || (release.assets || []).find(a => /mac.*\.zip$/.test(a.name));
  if (!asset) throw new Error('맥용 설치 파일(zip)이 Release 에 없어요');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-update-'));
  const zip = path.join(dir, asset.name);
  state.status = 'downloading'; state.percent = 0;
  await download(asset.browser_download_url, zip);
  state.status = 'installing';
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, path.join(dir, 'new')]);
  const newApp = fs.readdirSync(path.join(dir, 'new')).find(n => n.endsWith('.app'));
  if (!newApp) throw new Error('받은 파일에 앱이 없어요');
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, `#!/bin/bash
# 앱이 완전히 꺼질 때까지 기다렸다가 바꿔 끼우고 다시 연다
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
rm -rf "${appPath}.old"
mv "${appPath}" "${appPath}.old" && mv "${path.join(dir, 'new', newApp)}" "${appPath}" || { mv "${appPath}.old" "${appPath}"; open "${appPath}"; exit 1; }
xattr -dr com.apple.quarantine "${appPath}" 2>/dev/null
rm -rf "${appPath}.old"
open "${appPath}"
`, { mode: 0o755 });
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 300);
}

function hasAssetForThisPC() {
  if (process.platform === 'darwin') { const arch = process.arch === 'arm64' ? 'arm64' : 'x64'; return (release.assets || []).some(a => a.name.endsWith(`-mac-${arch}.zip`)); }
  if (process.platform === 'win32') return !!pickAsset('exe');
  if (process.platform === 'linux') return !!pickAsset(process.env.APPIMAGE ? 'appimage' : fs.existsSync('/usr/bin/dpkg') ? 'deb' : 'rpm');
  return false;
}

/** 이 PC에 맞는 설치 파일 (Release asset) — 운영체제·아키텍처·설치 형식별 */
function pickAsset(kind) {
  const as = (release.assets || []).filter(a => !/\.blockmap$|\.yml$/.test(a.name));
  const archRe = process.arch === 'arm64' ? /(arm64|aarch64)/i : /(x64|x86_64|amd64)/i;
  const ext = { exe: /\.exe$/i, appimage: /\.AppImage$/i, deb: /\.deb$/i, rpm: /\.rpm$/i }[kind];
  const cands = as.filter(a => ext.test(a.name));
  return cands.find(a => archRe.test(a.name)) || (kind === 'exe' ? cands[0] : null);   // Windows 설치 파일은 x64·arm64 겸용일 수 있음
}

/** Windows · Linux: 설치 파일을 받아서 실행 (참고: RB Management 와 같은 방식)
 *  - exe(NSIS 원클릭): 실행하면 백그라운드 설치 후 앱이 다시 켜짐
 *  - AppImage: 지금 AppImage 파일에 덮어쓰고 다시 실행
 *  - deb·rpm: 관리자 암호 한 번 받고(pkexec) 설치한 뒤 다시 실행 */
async function installDownload() {
  const kind = process.platform === 'win32' ? 'exe' : process.env.APPIMAGE ? 'appimage' : fs.existsSync('/usr/bin/dpkg') ? 'deb' : 'rpm';
  const asset = pickAsset(kind);
  if (!asset) throw new Error(`이 PC용 설치 파일(${kind})이 Release 에 없어요`);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-update-')), asset.name);
  state.status = 'downloading'; state.percent = 0;
  await download(asset.browser_download_url, file);
  state.status = 'installing';
  const launch = async (cmd, args = []) => { await launchDetached(cmd, args); setTimeout(() => app.quit(), 300); };
  if (kind === 'exe') await launch(file, ['/S', '--force-run']);   // 조용히 설치하고 실행
  else if (kind === 'appimage') { fs.chmodSync(file, 0o755); fs.copyFileSync(file, process.env.APPIMAGE); await launch(process.env.APPIMAGE); }
  else await installPackage(kind, file);
}

/** deb·rpm: 관리자 암호 창(pkexec) 한 번 → 패키지 설치 → 새 버전으로 다시 켜기. pkexec 가 없거나 실패하면 설치 프로그램으로 연다 */
async function installPackage(kind, file) {
  const has = c => fs.existsSync(c);
  if (!has('/usr/bin/pkexec')) { spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref(); throw new Error('관리자 권한 도구(pkexec)가 없어 설치 프로그램으로 열었어요. 설치 후 앱을 다시 켜 주세요.'); }
  const cmd = kind === 'deb'
    ? 'apt-get install -y "$1" 2>/dev/null || dpkg -i "$1"'
    : 'dnf install -y "$1" 2>/dev/null || zypper --non-interactive install --allow-unsigned-rpm "$1" 2>/dev/null || rpm -U --force "$1"';
  const code = await new Promise(res => spawn('/usr/bin/pkexec', ['/bin/sh', '-c', cmd, 'sh', file], { stdio: 'ignore' }).on('exit', res).on('error', () => res(-1)));
  if (code === 126 || code === 127) throw new Error('관리자 암호 입력을 취소했어요.');
  if (code !== 0) throw new Error(`패키지 설치 실패 (코드 ${code})`);
  app.relaunch(); app.quit();   // 같은 경로의 실행 파일이 새 버전으로 바뀌어 있다
}

/** 화면에서 [업데이트]를 눌렀을 때 */
async function install() {
  if (state.status !== 'available' || !release) await check(true);
  if (state.status !== 'available') return { started: false };
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) { shell.openExternal(state.url); return { started: false, opened: true }; }
  (process.platform === 'darwin' ? installMac() : installDownload()).catch(e => {
    Object.assign(state, { status: 'error', error: e.message });
  });
  return { started: true };
}

function start() {
  state.current = app.getVersion();
  if (!app.isPackaged || process.env.TRIP_ASSISTANT_NO_UPDATE) return;
  setTimeout(() => check(true), 3000);
  setInterval(() => check(true), 6 * 60 * 60 * 1000);
}

module.exports = { start, check, install, state, newer };
