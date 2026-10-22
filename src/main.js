'use strict';
// 와니의 결재 도우미 - Electron 메인 프로세스
// 화면(렌더러) ↔ 작업(엔진) 중계. 그룹웨어와 네이버 지도는 앱 안의 별도 창(내장 Chromium)에서 조작한다.

const { app, BrowserWindow, ipcMain, clipboard, shell, safeStorage, dialog, session, net } = require('electron');
try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch (e) { /* 개발용 .env 없음 (배포본엔 없음) */ }
// 우분투 24.04 이상 AppImage: AppArmor 가 user namespace 를 막고 AppImage 는 SUID 샌드박스도 못 쓰니 샌드박스 없이 켠다
// (deb·rpm 은 설치 스크립트가 AppArmor 프로필을 넣어 샌드박스를 그대로 쓴다)
if (process.platform === 'linux' && process.env.APPIMAGE) {
  try { if (require('fs').readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1') app.commandLine.appendSwitch('no-sandbox'); } catch (e) { /* 제한 없음 */ }
}
const path = require('path');
let R = require('./engine/rules');
let runner = require('./engine/runner');
const { Store } = require('./engine/store');
let Q = require('./engine/quick');
let AI = require('./engine/ai');
const updater = require('./updater');
let GW = require('./engine/gw');
/** 개발 중: 엔진 코드가 바뀌면 앱을 다시 켜지 않고 모듈만 다시 읽는다 (작업이 없을 때만) */
function reloadEngine() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(__dirname, 'engine') + path.sep) && k.endsWith('.js')) delete require.cache[k];
  R = require('./engine/rules'); runner = require('./engine/runner'); Q = require('./engine/quick'); AI = require('./engine/ai'); GW = require('./engine/gw');
  console.log('[dev] 엔진 코드 다시 읽음');
}

const ICON = path.join(__dirname, '..', 'assets', 'icon-512.png');
app.setName('와니의 결재 도우미');   // 개발 모드에서도 메뉴·알림에 앱 이름
let mainWin = null, gwWin = null, store = null;

// 데이터 폴더는 앱 이름과 무관하게 고정 (이름을 바꿔도 설정·로그인 유지). 예전 이름 폴더가 있으면 옮겨온다.
{
  const fs = require('fs');
  const dataDir = path.join(app.getPath('appData'), 'trip-assistant');
  const oldDir = path.join(app.getPath('appData'), '출장 결재 도우미');
  if (!fs.existsSync(dataDir) && fs.existsSync(oldDir)) { try { fs.cpSync(oldDir, dataDir, { recursive: true }); } catch (e) { /* 새로 시작 */ } }
  app.setPath('userData', dataDir);
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

function createMain() {
  mainWin = new BrowserWindow({
    width: 1200, height: 880, minWidth: 900, minHeight: 640, icon: ICON, title: '와니의 결재 도우미',
    autoHideMenuBar: true, backgroundColor: '#f4f6f9',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('closed', () => { mainWin = null; if (process.platform !== 'darwin') app.quit(); });   // 숨긴 그룹웨어 창이 있어도 종료
  if (process.env.TRIP_ASSISTANT_SMOKE) {           // CI/개발용: 화면 캡처 후 종료
    mainWin.webContents.on('console-message', (...a) => { const m = a[0] && a[0].message !== undefined ? a[0].message : a[2]; console.log('[renderer]', m); });
    mainWin.webContents.once('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 1500));
      const js = process.env.TRIP_ASSISTANT_SMOKE_JS;
      if (js) { await mainWin.webContents.executeJavaScript(js); await new Promise(r => setTimeout(r, 1200)); }
      require('fs').writeFileSync(process.env.TRIP_ASSISTANT_SMOKE, (await mainWin.webContents.capturePage()).toPNG());
      app.quit();
    });
  }
  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

/** 그룹웨어 창. 로그인 세션은 persist:gw 파티션(이 PC)에만 저장된다. */
// 그룹웨어 창은 기본으로 숨긴 채(백그라운드) 작업한다. 사람이 봐야 할 때만 [작업 중인 창 열기]로 띄운다.
// 숨겨도 입력 이벤트·화면 갱신이 멈추지 않도록 backgroundThrottling 을 끈다.
const gwPopups = new Set();
let quitting = false;
// 숨긴 창: 맥은 hide() 로도 입력·포커스가 되지만, 윈도우·리눅스는 한 번도 화면에 안 그려진 창에 클릭·키 입력이 제대로 안 들어가
// 드롭다운·코드도움 선택이 실패한다 → 화면 밖(-32000)에 띄워 둔다 (작업표시줄에도 안 보임). 보여 줄 땐 화면 가운데로.
const PARK = process.platform !== 'darwin';
let gwShown = false;   // 사람이 [작업 중인 창 열기]로 보고 있는 중이면 팝업(문서 보기 등)도 바로 보이게
function park(w) { if (!w || w.isDestroyed()) return; if (!PARK) return w.hide(); w.setSkipTaskbar(true); w.setPosition(-32000, -32000); if (!w.isVisible()) w.showInactive(); }
function unpark(w) { if (!w || w.isDestroyed()) return; if (PARK) { w.setSkipTaskbar(false); w.center(); } w.show(); }
app.on('before-quit', () => { quitting = true; });
function gwWindow(show = false) {
  if (gwWin && !gwWin.isDestroyed()) { if (show) showGw(); return gwWin; }
  gwWin = new BrowserWindow({
    show: false, width: 1500, height: 950, icon: ICON, title: '아마란스 — 와니의 결재 도우미가 입력 중', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:gw', contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // 결재 작성 팝업(window.open)도 숨긴 채 같은 세션으로 연다
  gwWin.webContents.setWindowOpenHandler(({ url }) => /[?&](art_seq_no|boardNo)=|portlet=true/.test(String(url)) ? { action: 'deny' } : ({   // 로그인 뒤 뜨는 공지사항 팝업은 막음 (작업 창과 섞이고 포커스를 뺏음)
    action: 'allow',
    overrideBrowserWindowOptions: { show: false, width: 1100, height: 1000, icon: ICON, autoHideMenuBar: true, webPreferences: { backgroundThrottling: false } },
  }));
  gwWin.webContents.on('did-create-window', w => {
    gwPopups.add(w); w.on('closed', () => gwPopups.delete(w));
    if (gwShown) { unpark(w); w.focus(); } else park(w);   // 직접 보는 중에 연 팝업(문서번호 클릭 등)은 보이게, 작업 중 연 건 숨김
    w.on('close', e => { if (!quitting && jobBusy()) { e.preventDefault(); park(w); } });   // 작업 중 닫으면 숨기기만
  });
  gwWin.on('close', e => { if (!quitting) { e.preventDefault(); gwShown = false; park(gwWin); } });   // 닫기 = 숨기기 (로그인·작업 상태 유지)
  park(gwWin);
  if (show) showGw();
  return gwWin;
}
function showGw() {
  if (!gwWin || gwWin.isDestroyed()) gwWindow(false);
  gwShown = true; unpark(gwWin);
  const pops = [...gwPopups].filter(w => !w.isDestroyed());
  for (const w of pops) unpark(w);
  (pops.pop() || gwWin).focus();
}
function hideGw() {
  gwShown = false;
  for (const w of gwPopups) park(w);
  park(gwWin);
}

/** 사람이 직접 쓰는 그룹웨어 창. 앱이 뒤에서 작업하는 창(gwWin)과는 따로 열리고 로그인 세션(persist:gw)만 같이 쓴다.
 *  문서번호 클릭 같은 팝업은 평소처럼 보이고, 닫으면 진짜 닫힌다 */
let viewWin = null;
function openGwViewer(url) {
  if (viewWin && !viewWin.isDestroyed()) { if (viewWin.isMinimized()) viewWin.restore(); viewWin.show(); viewWin.focus(); return viewWin; }
  viewWin = new BrowserWindow({ width: 1500, height: 950, icon: ICON, title: '그룹웨어', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:gw', contextIsolation: true, sandbox: true } });
  viewWin.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 1000, icon: ICON, autoHideMenuBar: true } }));
  viewWin.on('closed', () => { viewWin = null; });
  viewWin.loadURL(url);
  watchPwPrompt(viewWin);
  return viewWin;
}
/** 그룹웨어 창에서 '비밀번호 입력' 창(임직원업무관리 개인정보 화면 등, 로그인 비밀번호 재확인)이 뜨면 저장된 비밀번호로 채워 [확인] — 사용자 요청 2026-10-22.
 *  저장된 계정이 없으면 아무것도 안 함. 1초마다 보고, 창이 닫히면 멈춤 */
function watchPwPrompt(win) {
  const { Page, sleep } = require('./engine/driver');
  const p = new Page(win);
  let busy = false;
  const timer = setInterval(async () => {
    if (win.isDestroyed()) return clearInterval(timer);
    if (busy) return; busy = true;
    try {
      const c = gwCreds();
      const field = () => { const d = dialog('비밀번호 입력'); return d ? all('input[type=password]', d).find(vis) : null; };
      if (!c || !c.pw || !(await p.eval(`() => { const field = ${field}; return !!field(); }`).catch(() => false))) return;
      await p.clickWhere(`() => { const field = ${field}; return field(); }`);
      await p.eval(`() => { const el = (${field})(); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); }`);
      await p.type(c.pw);
      if (!(await p.eval(`v => (${field})().value === v`, c.pw))) return;   // 다르게 들어갔으면 건드리지 않음 (사람이 직접)
      await p.clickWhere(`() => { const d = dialog('비밀번호 입력'); return d && all('button', d).find(b => vis(b) && norm(b.textContent) === '확인'); }`);
      await sleep(1500);
    } catch (e) { /* 창이 닫혔거나 화면이 바뀜 — 다음 턴에 다시 */ }
    finally { busy = false; }
  }, 1000);
  win.on('closed', () => clearInterval(timer));
}

// 네이버 지도 창도 숨긴 채 돌리고, 자동 검색이 안 될 때 작업창 [네이버 지도 열기]로만 띄운다
let naverWin = null;
function makeNaverWindow() {
  naverWin = new BrowserWindow({
    show: false, width: 1300, height: 900, icon: ICON, title: '네이버 지도 — 교통비 조회', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:naver', contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  park(naverWin);
  return naverWin;
}
function showNaver() { if (naverWin && !naverWin.isDestroyed()) { unpark(naverWin); naverWin.focus(); return true; } return false; }

// ---------- 작업 1건 (사람 확인 포함) ----------
class Cancelled extends Error { constructor() { super('취소했어요.'); } }
class Job {
  constructor(kind, title) { this.startedAt = Date.now(); this.reported = new Set(); this.kind = kind; this.title = title || kind; this.logs = []; this.state = 'running'; this.result = null; this.error = ''; this.question = null; this._resolve = null; this._reject = null; this.cancelled = false; }
  info(msg) {
    if (this.cancelled) throw new Cancelled();
    this.logs.push(...String(msg).split('\n'));
    if (!app.isPackaged) { try { const d = path.join(__dirname, '..', 'debug'); require('fs').mkdirSync(d, { recursive: true }); require('fs').appendFileSync(path.join(d, 'job.log'), `${new Date().toISOString()} [${this.kind}] ${msg}\n`); } catch (e) { /* 개발용 기록 */ } }   // 개발 중엔 작업 기록을 파일로도 (원인 찾기용)
  }
  _ask(type, text, def) {
    if (this.cancelled) return Promise.reject(new Cancelled());
    this.state = 'waiting'; this.question = { type, text, def };
    return new Promise((r, j) => {
      this._resolve = v => { this.question = null; this.state = 'running'; r(v); };
      this._reject = e => { this.question = null; j(e); };
    });
  }
  cancel() {
    this.cancelled = true;
    if (this._reject) { const f = this._reject; this._resolve = this._reject = null; f(new Cancelled()); }
  }
  async assist(msg) { this.info(`⚠ ${msg}`); reportJob(this, 'stuck', msg); await this._ask('assist', msg); }   // 사람에게 넘긴 지점 = 자동화가 막힌 곳 → 개발자에게
  async confirm(text) { return Boolean(await this._ask('confirm', text)); }
  async askInt(text) { return Number(await this._ask('int', text)); }
  async askText(text, def = '') { return String(await this._ask('text', text, def) ?? ''); }
  async askChoice(text, options) { return this._ask('choice', text, options); }   // 고른 번호(0부터), '' 이면 안 고름
  async pause(text) { await this._ask('pause', text); }
  answer(v) { if (this._resolve) { const f = this._resolve; this._resolve = this._reject = null; f(v); } }
  snapshot(since = 0) { return { kind: this.kind, title: this.title, state: this.state, logs: this.logs.slice(since), next: this.logs.length, question: this.question, result: this.result, error: this.error }; }
}
let job = null;

// 화면에 안 보이게 도는 작업(목록 갱신·환원 점검 등). 사람이 시킨 작업이 오면 양보한다 — 전엔 "작업창의 [취소]를 누르라"고 했는데 숨은 작업이라 누를 곳이 없었음
const BACKGROUND_JOBS = new Set(['gw-list', 'gw-profile', 'refund-check', 'purchase-list', 'report-load']);
async function startJob(kind, fn, title) {
  const yieldTo = job && ((job.state === 'waiting') || (job.state === 'running' && (job.kind === 'fare' || (BACKGROUND_JOBS.has(job.kind) && !BACKGROUND_JOBS.has(kind)))));
  if (yieldTo) {   // 사람 입력만 기다리던 작업·교통비 조회(새 조회가 덮어씀)·뒤에서 돌던 작업은 취소하고, 같은 창을 동시에 만지지 않게 멈출 때까지 기다림
    const old = job; old.cancel();
    await Promise.race([old.done, new Promise(r => setTimeout(r, 20000))]);
  } else if (job && job.state === 'running') {
    if (BACKGROUND_JOBS.has(kind)) return { ok: false, skipped: true };   // 뒤에서 하는 확인은 다음에 (알림 안 띄움)
    throw new Error('이전 작업이 아직 진행 중이에요. 작업창의 [취소]를 누른 뒤 다시 시도해 주세요.');
  }
  const j = job = new Job(kind, title);
  const env = { debugDir: app.isPackaged ? path.join(app.getPath('userData'), 'debug') : path.join(__dirname, '..', 'debug'), cfg: store.config(), store, ui: j, log: m => j.info(m), naverKeys: naverKeys(), fetch: net.fetch, gwWindow: () => gwWindow(false), showGw, makeNaverWindow, creds: gwCreds };
  j.done = (async () => {
    try { j.result = await fn(env); j.state = 'done'; j.info('✔ 완료'); }
    catch (e) { j.error = e instanceof R.InputError ? `입력 오류: ${e.message}` : e.message; j.state = j.cancelled ? 'cancelled' : 'error';
      if (j.state === 'error' && !(e instanceof R.InputError)) reportJob(j, 'error', e.stack || e.message); }   // 입력 검증 오류는 사람 실수라 안 보냄
    finally { if (j.state !== 'done' && mainWin && !mainWin.isDestroyed()) mainWin.focus(); }   // 성공 시엔 작성 팝업이 앞
  })();
  return { ok: true };
}

// ---------- 실패·막힘 기록을 개발자 슬랙으로 (끌 수 없음. 설정 화면에 알림) ----------
const slackKeys = () => { const b = (() => { try { return require('./engine/builtin-key.json'); } catch (e) { return {}; } })();
  return { token: (process.env.SLACK_BOT_TOKEN || b.slackToken || '').trim(), channel: (process.env.SLACK_CHANNEL || b.slackChannel || '').trim() }; };
/** 지금 열린 창들(작업용 그룹웨어·작성 창·네이버 지도) 캡처 + 화면 HTML */
async function captureWindows() {
  const { scrubHtml } = require('./engine/errreport');
  const wins = [['gw', gwWin], ...[...gwPopups].map((w, i) => [`popup${i + 1}`, w]), ['naver', naverWin]].filter(([, w]) => w && !w.isDestroyed());
  const out = [];
  for (const [name, w] of wins) {
    try { out.push({ name: `${name}.png`, data: (await w.webContents.capturePage()).toPNG() }); } catch (e) { /* 캡처 실패 */ }
    try {
      const frames = await w.webContents.executeJavaScript(`[document.documentElement.outerHTML, ...[...document.querySelectorAll('iframe')].map(f => { try { return f.contentDocument.documentElement.outerHTML; } catch (e) { return ''; } })]`);
      out.push({ name: `${name}.html`, data: scrubHtml(`<!-- ${w.webContents.getURL()} -->\n` + frames.filter(Boolean).join('\n<!-- ===== iframe ===== -->\n')) });
    } catch (e) { /* HTML 실패 */ }
  }
  return out;
}
/** kind: 'error'(작업 실패) | 'stuck'(사람에게 넘김). 같은 작업에서 같은 내용은 한 번만 */
async function reportJob(j, kind, detail) {
  try {
    const { token, channel } = slackKeys(); if (!token || !channel) return;
    // 정상 안내는 안 보냄: 로그인이 안 돼 있어 사람에게 로그인 맡김 (비밀번호 미저장·세션 만료는 고칠 게 아님)
    if (kind === 'stuck' && /로그인되어 있지 않아요|직접 로그인해 주세요|로그인이 필요/.test(String(detail))) return;
    const key = `${kind}:${String(detail).slice(0, 200)}`; if (j.reported.has(key) || j.reported.size >= 5) return; j.reported.add(key);
    const fs = require('fs'), cfg = store.config(), dir = app.isPackaged ? path.join(app.getPath('userData'), 'debug') : path.join(__dirname, '..', 'debug');
    let dumps = [];
    try { dumps = fs.readdirSync(dir).map(n => path.join(dir, n)).filter(f => /\.(png|html|json)$/.test(f) && fs.statSync(f).mtimeMs >= j.startedAt - 1000 && fs.statSync(f).size < 8e6)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 12).map(f => ({ name: path.basename(f), data: fs.readFileSync(f) })); } catch (e) { /* 진단 폴더 없음 */ }
    const head = `${kind === 'error' ? '🚨 작업 실패' : '⚠️ 자동화가 막힘 (사람에게 넘김)'} · ${j.title}\n`
      + `${cfg.name || '(이름 없음)'} · ${cfg.budgetDept || '-'} · 계정 ${cfg.lastLoginId || cfg.gwId || '-'} · v${app.getVersion()} · ${process.platform} ${process.arch}\n`
      + `${kind === 'error' ? '오류' : '안내'}: ${String(detail).split('\n')[0].slice(0, 500)}\n`
      + '```' + j.logs.slice(-15).join('\n').slice(-1800) + '```';
    const files = [{ name: 'job-log.txt', data: `${j.title} (${j.kind}) · ${new Date(j.startedAt).toISOString()}\n\n${j.logs.join('\n')}\n\n--- ${kind} ---\n${detail}` },
      ...(await captureWindows()), ...dumps];
    const r = await require('./engine/errreport').sendReport({ token, channel, fetch: net.fetch, text: head, files });
    if (r && r.ts) j.logs.push(kind === 'error' ? '✉ 오류 기록을 개발자에게 보냈어요 (고치는 데 써요)' : '✉ 막힌 곳 기록을 개발자에게 보냈어요');
  } catch (e) { console.log('[report] 보내기 실패:', e.message); }
}

// ---------- 영수증 자동 분류 ----------
const PROOF_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf' };
/** 고른 뒤 옮기거나 지운 파일: 작업을 시작하기 전에 이름을 알려 준다 ("ENOENT: no such file…" 대신) */
function assertFilesExist(paths, what) {
  const fs = require('fs');
  const gone = [...new Set((paths || []).map(String).filter(Boolean))].filter(p => !fs.existsSync(p));
  if (gone.length) throw new R.InputError(`${what} 파일을 찾을 수 없어요 (옮겼거나 지웠어요): ${gone.map(p => path.basename(p)).join(', ')}. 다시 골라 주세요.`);
}
async function readReceipts(env, ai, paths, period) {
  const fs = require('fs');
  const items = Object.fromEntries(Object.entries(R.BUDGET_ITEMS).map(([k, [, label]]) => [k, label.replace('여비교통비(판)_', '')]));
  const out = [];
  let i = 0;
  const one = async p => {
    const name = path.basename(p), ext = path.extname(p).slice(1).toLowerCase();
    const mime = PROOF_MIME[ext];
    if (!mime) return out.push({ path: p, error: '이미지나 PDF가 아니에요 (BMP·TIFF 는 PNG·JPG 로 바꿔 주세요)' });
    if (!fs.existsSync(p)) return out.push({ path: p, error: '파일을 찾을 수 없어요 (옮겼거나 지웠어요)' });   // 한 장 때문에 전체가 멈추지 않게
    const size = fs.statSync(p).size;
    if (size > 15 * 1024 * 1024) return out.push({ path: p, error: '파일이 너무 커요 (15MB 이하)' });
    try {
      const rows = await AI.readReceipt(ai, { mime, data: fs.readFileSync(p).toString('base64') }, items, period, store.config().rates);
      env.log(`${++i}/${paths.length} ${name}: ${rows.length ? rows.map(r => `${items[r.item] || '?'} ${r.amount.toLocaleString('ko-KR')}원`).join(', ') : '영수증을 못 찾음'}`);
      out.push({ path: p, rows });
    } catch (e) { env.log(`${++i}/${paths.length} ${name}: 실패 (${e.message})`); out.push({ path: p, error: e.message }); }
  };
  for (let k = 0; k < paths.length; k += 3) await Promise.all(paths.slice(k, k + 3).map(one));   // 3개씩 동시에
  // 파일 순서대로 펼침 — 표에는 영수증마다 한 줄 (한 파일에 영수증 여러 장이면 증빙은 첫 줄에만). 같은 날 식대 묶기는 채주내역 넣을 때 (runner)
  const seen = new Set();
  const proofOf = p => (seen.has(p) ? [] : (seen.add(p), [p]));
  const flat = paths.map(p => out.find(o => o.path === p)).flatMap(o => o.rows && o.rows.length
    ? o.rows.map(r => ({ ...r, path: o.path, proofs: proofOf(o.path) }))
    : [{ path: o.path, item: '', amount: 0, failed: o.error || '영수증을 못 찾음', proofs: proofOf(o.path) }]);
  // 표는 날짜·시각 순 (시각 없으면 끼니 순서, 그래도 없으면 읽은 순서). 못 읽은 줄은 맨 뒤
  const MEAL_ORDER = { 조식: '08:00', 중식: '12:00', 석식: '18:00' };
  const key = r => r.failed ? '9' : `${r.date || '9'} ${r.time || MEAL_ORDER[r.meal] || '23:59'}`;
  flat.forEach((r, i) => { r._i = i; });
  flat.sort((a, b) => key(a).localeCompare(key(b)) || a._i - b._i);
  flat.forEach(r => { delete r._i; });
  return { rows: flat };
}

// ---------- 그룹웨어 계정 (비밀번호는 OS 보안 저장소로 암호화해서만 저장) ----------
let sessionCreds = null;   // 저장 안 함을 고른 경우 앱이 켜져 있는 동안만 기억
function gwCreds() {
  if (sessionCreds) return sessionCreds;
  const c = store.config();
  if (!c.gwId || !c.gwPwEnc || !safeStorage.isEncryptionAvailable()) return null;
  try { return { id: c.gwId, pw: safeStorage.decryptString(Buffer.from(c.gwPwEnc, 'base64')) }; } catch (e) { return null; }
}
const jobBusy = () => job && (job.state === 'running' || job.state === 'waiting');
const devLog = m => { if (!app.isPackaged) { try { const d = path.join(__dirname, '..', 'debug'); require('fs').mkdirSync(d, { recursive: true }); require('fs').appendFileSync(path.join(d, 'job.log'), `${new Date().toISOString()} [gw] ${m}\n`); } catch (e) { /* */ } } };
const gwFor = (show, extra = {}) => new GW.Amaranth({ win: gwWindow(show), baseUrl: store.config().baseUrl, ui: { info() {}, async assist() {} }, log: devLog, debugDir: app.isPackaged ? null : path.join(__dirname, '..', 'debug'), creds: gwCreds, ...extra });   // 로그인 확인·로그인 창: 개발 중엔 기록·진단 파일 남김

async function gwStatus() {
  const saved = Boolean(store.config().gwId && store.config().gwPwEnc);
  if (jobBusy()) return { loggedIn: true, busy: true, saved };
  const gw = gwFor(false);
  if (!(await gw.loginNeeded())) return { loggedIn: true, saved };
  const c = gwCreds();
  if (c && await gw.autoLogin(c.id, c.pw)) return { loggedIn: true, saved, auto: true };
  return { loggedIn: false, saved, failed: Boolean(c), id: store.config().gwId || '' };
}

async function gwLogin({ id, pw, save }) {
  id = String(id || '').trim(); pw = String(pw || '');
  if (!id || !pw) throw new Error('아이디와 비밀번호를 입력해 주세요.');
  // 작업이 '로그인을 기다리며 멈춰 있는' 상태(질문 대기)면 막지 않는다: 여기서 로그인하면 그 작업이 로그인을 감지하고 알아서 이어간다
  if (jobBusy() && job.state !== 'waiting') throw new Error('작업이 진행 중이에요. 끝난 뒤 다시 해 주세요.');
  const gw = gwFor(false);
  if (await gw.loginNeeded()) {
    if (!(await gw.autoLogin(id, pw))) return { loggedIn: false, error: '로그인에 실패했어요. 아이디·비밀번호를 확인하거나 [그룹웨어 창에서 직접 로그인]을 써 주세요.' };
  }
  let note = '';
  store.saveConfig({ lastLoginId: id });   // 지금 로그인한 계정 (비밀번호 저장 안 해도) — 내 정보가 이 계정 것인지 비교용
  if (save) {
    if (safeStorage.isEncryptionAvailable()) { store.saveConfig({ gwId: id, gwPwEnc: safeStorage.encryptString(pw).toString('base64') }); sessionCreds = null; }
    else { sessionCreds = { id, pw }; note = '이 PC는 보안 저장소를 쓸 수 없어서 앱을 끄면 잊어버려요.'; }
  } else sessionCreds = { id, pw };
  return { loggedIn: true, saved: Boolean(save && !note), note };
}

// ---------- AI 키 (OS 보안 저장소로 암호화) ----------
// 팀 공용 기본 키: 빌드 때 GEMINI_API_KEY 환경변수를 src/engine/builtin-key.json 에 써 넣는다 (scripts/write-builtin-key.js, git 제외).
// 개발 중엔 환경변수 GEMINI_API_KEY 를 바로 쓴다. 설정에서 개인 키를 넣으면 그게 우선.
function builtinAi() {
  const key = process.env.GEMINI_API_KEY || (() => { try { return require('./engine/builtin-key.json').key; } catch (e) { return ''; } })();
  return key ? { provider: 'gemini', model: '', key } : null;
}
function aiSettings(cfg) {
  if (cfg.aiProvider === 'none') return null;                       // 설정에서 '사용 안 함'을 고른 경우
  if (!cfg.aiKeyEnc) return !cfg.aiProvider || cfg.aiProvider === 'gemini' ? builtinAi() : null;   // 팀 공용 키는 Gemini 만. Claude·OpenAI 는 개인 키 필요
  if (!cfg.aiProvider) return null;
  try {
    const buf = Buffer.from(cfg.aiKeyEnc, 'base64');
    const key = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    return { provider: cfg.aiProvider, model: cfg.aiModel, key };
  } catch (e) { return null; }
}
function encryptKey(key) {
  return (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8')).toString('base64');
}
// 한국수출입은행 환율 키: 개발 중엔 .env 의 OPEN_API_KEY, 배포본엔 빌드 때 builtin-key.json 에 내장 (팀 공용)
const fxKey = () => (process.env.OPEN_API_KEY || (() => { try { return require('./engine/builtin-key.json').fxKey; } catch (e) { return ''; } })() || '').trim();
// 네이버 지역 검색 키 (출장지 자동완성·좌표): 개발 중엔 .env, 배포본엔 builtin-key.json (팀 공용)
const naverKeys = () => { const b = (() => { try { return require('./engine/builtin-key.json'); } catch (e) { return {}; } })(); const id = (process.env.NAVER_CLIENT_ID || b.naverId || '').trim(), secret = (process.env.NAVER_CLIENT_SECRET || b.naverSecret || '').trim(); return id && secret ? { id, secret } : null; };
const publicConfig = c => { const { aiKeyEnc, gwPwEnc, ...rest } = c; return { ...rest, fxKeySet: Boolean(fxKey()), placesOn: Boolean(naverKeys()), aiKeySet: Boolean(aiKeyEnc) || Boolean(aiSettings(c)), aiBuiltin: !aiKeyEnc && Boolean(aiSettings(c)), gwSaved: Boolean(c.gwId && gwPwEnc) }; };

/** 한 줄 메모 → 신청서. AI 가 있으면 문장/추론은 AI, 금액·출장지 이름은 항상 규칙. */
/** 한 줄 자동 작성은 템플릿이 있으니 AI 를 오래 기다리지 않는다 (AI 시간 초과 45초 × 모델 2개 = 90초 동안 '작성 중…' 이던 문제) */
const AI_QUICK_MS = 20000;
const withDeadline = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`AI 응답이 ${ms / 1000}초 넘게 없어요`)), ms))]);
async function quick(memo) {
  const cfg = store.config();
  const places = store.places();
  const ctx = { today: new Date(), places, rates: cfg.rates, rank: cfg.rank, origin: cfg.defaultOrigin, defaults: { mode: store.lastMode() } };
  const base = Q.quickApply(memo, ctx);
  const ai = aiSettings(cfg);
  let data = base.data, source = 'template', note = '';
  if (ai) {
    try {
      const d = await withDeadline(AI.draftApply(ai, memo, { places }), AI_QUICK_MS);
      data = Q.mergeAi(base.data, d, places, cfg);
      source = AI.PROVIDERS[ai.provider].label;
    } catch (e) { note = `AI 작성 실패로 템플릿을 썼어요: ${e.message}`; }
  }
  let meals = null;
  if (data.dates.start && data.reason) {
    meals = Q.computeExpenses({ start: data.dates.start, end: data.dates.end || data.dates.start, startTime: data.dates.start_time, endTime: data.dates.end_time, reason: data.reason, rates: cfg.rates, rank: cfg.rank });
    data.expenses = meals.expenses;
  }
  // 해외출장: 메모·출장지로 판단 → 국내 교통편·식대 계산 대신 화면에서 규정대로(일비·숙박·우버…) 계산
  const ov = R.overseasGuess(`${memo} ${data.destination || ''}`);
  if (ov.overseas) {
    data.scope = '해외'; data.grade = ov.grade; data.transport = { mode: 'overseas', to: '', from: '' }; data.expenses = [];
    const missing = [];
    if (!data.dates.start) missing.push('날짜');
    if (!data.destination) missing.push('출장지');
    return { data, missing, source, note, meals: null, fare: null };
  }
  data.scope = '국내';
  // 교통편은 메모에 적혀 있을 때만 정한다 (자차·대중교통·법인차량). 아니면 비워 두고 사람이 고르면 그때 교통비를 계산
  const said = Q.parseMode(memo);
  const noCar = cfg.hasCar === false;   // 자차 없음(설정·첫 로그인 질문) → 기본 대중교통, 자차는 못 고름
  if (noCar && said.mode === 'car') said.mode = 'transit';
  if (!said.mode) data.transport = noCar ? { ...data.transport, mode: 'transit', corporate_car: undefined } : { ...data.transport, mode: '', corporate_car: undefined };
  else if (said.mode !== data.transport.mode) data.transport = { ...data.transport, mode: said.mode, ...(said.corporate_car ? { corporate_car: said.corporate_car } : {}) };
  const missing = [];
  if (!data.transport.mode) missing.push('교통편');
  if (!data.dates.start) missing.push('날짜');
  if (!data.dates.start_time) missing.push('출발 시각');
  if (!data.dates.end_time) missing.push('복귀 시각');
  if (!data.destination) missing.push('출장지');
  if (source === 'template' && base.missing.includes('사유')) missing.push('사유');
  const t = data.transport;
  const fare = (t.mode === 'car' || t.mode === 'transit') && t.to ? store.getFare(t.mode, t.from || cfg.defaultOrigin, t.to) : null;
  return { data, missing, source, note, fare, meals: meals && { summary: meals.summary, timed: meals.timed } };
}

async function quickReport(id, memo) {
  const cfg = store.config();
  const draft = runner.reportDraft(store, cfg, id);
  const ai = aiSettings(cfg);
  if (ai && memo.trim()) {
    try {
      const d = await withDeadline(AI.draftReport(ai, draft, memo), AI_QUICK_MS);
      // AI 가 비워서 돌려준 칸(출장지·기간 등)이 신청서 값을 지우지 않게: 값이 있는 것만 덮어씀 (실제로 출장지가 지워져 "출장지을 넣어 주세요" 로 막혔음)
      const filled = Object.fromEntries(Object.entries(d || {}).filter(([, v]) => v !== '' && v != null && !(Array.isArray(v) && !v.length)));
      return { data: { ...draft, ...filled, expenses: draft.expenses, attachments: draft.attachments, trip_id: id }, source: AI.PROVIDERS[ai.provider].label };
    } catch (e) { return { data: Q.quickReport(draft, memo), source: 'template', note: `AI 작성 실패로 템플릿을 썼어요: ${e.message}` }; }
  }
  return { data: Q.quickReport(draft, memo), source: 'template' };
}

// ---------- dev: 파일이 바뀌면 자동 반영 ----------
// 화면(renderer) 파일 → 창 새로고침, 엔진/메인 파일 → 앱 재시작
function watchForDev() {
  // 개발 모드(yarn dev)에서 코드를 고치면 반영: renderer → 새로고침, engine/main → 앱 재시작.
  // macOS 파일 감시는 켜자마자 '방금 전 변경'을 다시 알려 줘서 재시작이 무한 반복될 수 있다 →
  // 실제로 이 앱이 켜진 뒤에 수정된 소스 파일(.js/.html/.css)일 때만 반응한다. 작업 중이면 끝날 때까지 미룬다.
  const fs = require('fs');
  const started = Date.now();
  let timer = null, pending = false;
  const changedSinceStart = file => { try { return fs.statSync(file).mtimeMs > started; } catch (e) { return false; } };
  // 엔진: 앱을 다시 켜지 않고 모듈만 다시 읽는다 (작업 중이면 끝난 뒤 조용히). main/preload/updater: 한가하면 바로 다시 켜고, 작업 중이면 띠만 띄움
  const reload = () => { if (jobBusy()) { if (!pending) { pending = true; console.log('[dev] 작업 중 — 끝나면 엔진 다시 읽음'); } return setTimeout(reload, 1000); } pending = false; try { reloadEngine(); } catch (e) { console.error('[dev] 엔진 다시 읽기 실패:', e.message); } };
  const restart = () => { if (jobBusy()) { console.log('[dev] main 코드가 바뀌었어요 — 작업 중이라 띠만 띄움'); if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('dev-stale'); return; } app.relaunch(); app.exit(0); };
  const watch = (target, recursive, action) => {
    try {
      fs.watch(target, { recursive }, (_ev, f) => {
        const file = recursive ? path.join(target, f || '') : target;
        if (!/\.(js|html|css)$/.test(file) || /builtin-key/.test(file) || !changedSinceStart(file)) return;
        console.log('[dev] 바뀜:', path.relative(__dirname, file));
        clearTimeout(timer); timer = setTimeout(action, 300);
      });
    } catch (e) { console.warn('watch 실패:', target, e.message); }
  };
  watch(path.join(__dirname, 'renderer'), true, () => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.reloadIgnoringCache(); });
  watch(path.join(__dirname, 'engine'), true, reload);
  for (const f of ['main.js', 'preload.js', 'updater.js']) watch(path.join(__dirname, f), false, restart);
  console.log('[dev] 파일 변경 감시 중 (renderer → 새로고침, engine → 모듈 다시 읽기, main → 재시작)');
}

// ---------- 화면 API ----------
async function route(p, body = {}) {
  const cfg = store.config();
  switch (p) {
    case '/api/meta':
      return { config: publicConfig(cfg), configured: store.hasConfig(), items: Object.fromEntries(Object.entries(R.BUDGET_ITEMS).map(([k, v]) => [k, v[1]])), purchase: { purposes: R.PURCHASE_PURPOSES, projects: R.PURCHASE_PROJECTS },
        version: app.getVersion(), dev: !app.isPackaged, providers: Object.fromEntries(Object.entries(AI.PROVIDERS).map(([k, v]) => [k, v])) };
    case '/api/config': {
      const patch = { ...body };
      if ('aiKey' in patch) { const k = String(patch.aiKey || '').trim(); delete patch.aiKey; if (k) patch.aiKeyEnc = encryptKey(k); }
      if (patch.clearAiKey) { patch.aiKeyEnc = ''; delete patch.clearAiKey; }
      return publicConfig(store.saveConfig(patch));
    }
    case '/api/ai/test': {
      const ai = aiSettings(cfg); if (!ai) throw new Error('AI 제공사와 키를 먼저 저장해 주세요.');
      const t = await AI.complete(ai, '한 단어로만 답해: 준비됐어?'); return { reply: String(t).trim().slice(0, 60) };
    }
    case '/api/quick': return quick(String(body.memo || ''));
    case '/api/report-quick': return quickReport(body.id, String(body.memo || ''));
    case '/api/overseas-expenses': {   // 해외출장 품의 경비 줄 (규정: 등급별 일비·숙박 한도, 신청일 환율)
      const n = v => (v === undefined || v === null || v === '') ? null : Number(String(v).replace(/[^\d.]/g, '')) || 0;
      return R.overseasExpenses({ start: body.start, end: body.end || body.start, name: cfg.name || '출장자', people: 1, rank: cfg.rank, grade: body.grade, rate: Number(body.rate) || 0,
        airfare: n(body.airfare), lodging: n(body.lodging), uberUsd: n(body.uber), roaming: n(body.roaming), insurance: n(body.insurance) });
    }
    case '/api/expenses': { const r = Q.computeExpenses({ start: body.start, end: body.end || body.start, startTime: body.start_time, endTime: body.end_time, reason: body.reason || '', rates: cfg.rates, rank: cfg.rank }); return { expenses: r.expenses, summary: r.summary, timed: r.timed }; }
    case '/api/repeat': { const a = store.load(body.id).apply;   // keep: 반려돼서 고쳐 올릴 땐 날짜·시각 그대로
      const dates = body.keep ? { start: a.start, end: a.end, start_time: a.start_time, end_time: a.end_time } : { start: '', end: '' };
      return { data: { ...a, dates, transport: { ...a.transport, total: null, screenshot: '' } } }; }
    case '/api/prompt': return { text: R.applyPrompt() + String(body.memo || '').trim() + '\n' };
    case '/api/parse': return { data: R.extractYaml(body.text || '') };
    case '/api/title': { const r = String(body.reason || '').trim(); return { apply: r ? R.applyTitle(r) : '', report: r ? R.reportTitle(r) : '' }; }
    case '/api/plan': return runner.planApply(body, cfg);
    case '/api/trips': return { trips: store.list().map(t => ({ ...t, reportMemo: R.budgetMemo(R.reportTitle(t.reason || '')), reportDocTitle: R.reportTitle(t.reason || '') })) };   // reportDocTitle: 출장보고서 결재 문서 제목 (목록에서 보고 상태 찾기)   // reportMemo: 보고 품의 적요 (연결이 끊긴 보고 품의를 찾는 데 씀)
    case '/api/report-preview': {   // 보내기 전 확인 화면: 실제로 채주에 들어갈 줄 (같은 날 식대 묶음·식대 한도 반영 — runReport 와 같은 계산)
      const rep = R.parseReport(body.data || {});
      return { lines: runner.settleLines(rep, cfg).map(l => ({ item: l.item, label: l.label, memo: l.memo, amount: l.amount, pay: l.pay, noVat: l.noVat, proofs: (l.proofs || []).length, dup: l.dup })) };
    }
    case '/api/draft': {   // 전에 작성한 보고서가 있으면 그대로, 없으면 신청 내용으로 초안
      const base = runner.reportDraft(store, cfg, body.id); const saved = body.fresh ? null : store.load(body.id).report;   // fresh: 작성하던 내용 무시하고 신청 내용으로 새로
      const d = saved ? { ...base, ...saved, trip_id: body.id, transport: base.transport } : base;
      return { draft: d, prompt: R.reportPrompt(d), resumed: !!saved };
    }
    case '/api/trip/link-report': { const rec = store.load(body.id); const r = body.row; rec.gwReport = { key: r.key, ym: r.ym, day: String(r.day), seq: String(r.seq) }; store.save(body.id, rec); return { ok: true }; }
    case '/api/update': return { ...updater.state, current: app.getVersion(), platform: process.platform };
    case '/api/update/check': return { ...(await updater.check(!!body.force)), current: app.getVersion() };
    case '/api/update/install': return await updater.install();
    case '/api/copy': clipboard.writeText(String(body.text || '')); return { ok: true };
    case '/api/open': if (body.path) shell.openPath(body.path); return { ok: true };
    case '/api/pick-po': {   // 발주서 1개: PDF·워드·엑셀·이미지
      const r = await dialog.showOpenDialog(mainWin, { title: '발주서·견적서 선택 (PDF·워드·엑셀·이미지 1개)', properties: ['openFile'], filters: [{ name: '발주서', extensions: ['pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'webp'] }] });
      return { path: r.canceled ? '' : r.filePaths[0] };
    }
    case '/api/pick-proofs': {   // 정산 증빙: 이미지·PDF 1개
      const r = await dialog.showOpenDialog(mainWin, { title: body.many ? '영수증·증빙 선택 (여러 개)' : '증빙 자료 선택 (이미지·PDF 1개)', properties: body.many ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [{ name: '이미지·PDF', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'pdf'] }] });
      return { paths: r.canceled ? [] : r.filePaths };
    }
    case '/api/gw/status': return gwStatus();
    case '/api/gw/login': return gwLogin(body);
    case '/api/gw/forget': sessionCreds = null; store.saveConfig({ gwId: '', gwPwEnc: '' }); return { ok: true };
    case '/api/gw/logout': {   // 그룹웨어 로그아웃: 로그인 세션·저장된 비밀번호·이 사람 정보(이름·부서)를 지운다. 아이디는 다음 로그인 편하게 남김
      if (jobBusy()) throw new Error('작업이 진행 중이에요. 끝난 뒤 로그아웃해 주세요.');
      for (const w of gwPopups) if (!w.isDestroyed()) w.destroy();
      if (gwWin && !gwWin.isDestroyed()) gwWin.destroy();
      gwWin = null;
      const ses = session.fromPartition('persist:gw');
      await ses.clearStorageData(); await ses.clearCache();
      sessionCreds = null;
      store.saveConfig({ gwPwEnc: '', gwUser: null, name: '', budgetDept: '', budgetDepts: [], profileOf: '', hasCar: null });   // 자차 여부도 사람마다 다르니 다시 물어봄
      return { ok: true };
    }
    case '/api/gw/show': if (showNaver()) return { ok: true }; showGw(); return { ok: true };
    case '/api/gw/open': openGwViewer(cfg.baseUrl); return { ok: true };   // 상단 [그룹웨어 열기]: 사람이 쓰는 별도 창 (작업 창과 로그인만 공유)
    case '/api/gw/hide': hideGw(); return { ok: true };
    case '/api/job/gw-list': return startJob('gw-list', env => runner.runListBudget(env, { from: String(body.from || ''), to: String(body.to || '') }), body.title);   // 조회 기간(YYYY-MM-DD), 기본 최근 3개월·최대 1년
    case '/api/receipt-memo': {   // 경비 줄 하나의 증빙 → 적요("9/28 1인 석식"). 적요는 그대로 채주 거래처비고가 된다
      const ai = aiSettings(cfg); if (!ai) return { memo: '' };
      const f = String(body.path || ''), ext = path.extname(f).slice(1).toLowerCase(), mime = PROOF_MIME[ext];
      if (!mime) return { memo: '' };
      const items = Object.fromEntries(Object.entries(R.BUDGET_ITEMS).map(([k, [, label]]) => [k, label.replace('여비교통비(판)_', '')]));
      const rows = await AI.readReceipt(ai, { mime, data: require('fs').readFileSync(f).toString('base64') }, items, String(body.period || ''), cfg.rates);
      const r = rows.find(x => x.item === body.item) || rows[0];
      if (!r) return { memo: '' };
      const md = r.date ? r.date.slice(5).split('-').map(Number).join('/') : '';
      return { memo: [md, r.memo || r.vendor].filter(Boolean).join(' '), people: r.people || 0, date: r.date || '', meal: r.meal || '' };
    }
    case '/api/job/po-read': {   // 발주서(PDF·이미지) 1개 → AI 가 거래처·품목·금액 읽기
      const ai = aiSettings(cfg); if (!ai) throw new Error('발주서 읽기는 AI 가 있어야 해요. 설정 › AI 문장 작성에서 Gemini 를 골라 주세요.');
      const f = String(body.path || ''), ext = path.extname(f).slice(1).toLowerCase(), mime = PROOF_MIME[ext], office = ext === 'docx' || ext === 'xlsx';
      if (!mime && !office) throw new Error('발주서는 PDF·이미지·워드(.docx)·엑셀(.xlsx) 파일이어야 해요.');
      assertFilesExist([f], '발주서');
      return startJob('po-read', async env => {
        env.log(`발주서 읽는 중: ${path.basename(f)}`);
        const po = office ? await AI.readPurchaseOrder(ai, null, require('./engine/office').officeText(f)) : await AI.readPurchaseOrder(ai, { mime, data: require('fs').readFileSync(f).toString('base64') });
        env.log(`거래처 ${po.vendor.name || '?'} · 품목 ${po.items.length}건 · 합계 ${po.total.toLocaleString('ko-KR')}원`); return { ...po, file: f };
      }, body.title);
    }
    case '/api/job/url-read': {   // 제품 페이지 주소 → 숨긴 창에서 열어 캡처·글자 → AI 가 품목·가격·판매처
      const ai = aiSettings(cfg); if (!ai) throw new Error('페이지 읽기는 AI 가 있어야 해요. 설정 › AI 문장 작성에서 Gemini 를 골라 주세요.');
      const url = String(body.url || '').trim(); if (!/^https?:\/\//i.test(url)) throw new Error('주소는 http:// 또는 https:// 로 시작해야 해요.');
      return startJob('url-read', async env => {
        env.log(`페이지 여는 중: ${url}`);
        const w = new BrowserWindow({ show: false, width: 1200, height: 1400, webPreferences: { partition: 'persist:web', contextIsolation: true, sandbox: true, backgroundThrottling: false } });
        // 쇼핑몰 페이지가 알림창(alert)·창 닫기·새 창을 띄워도 멈추지 않게: 알림은 바로 닫고, 닫기·새 창은 막는다
        let done = false; w.on('close', e => { if (!done) e.preventDefault(); });
        w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const dbg = w.webContents.debugger; let alerts = [];
        try {
          dbg.attach('1.3');
          dbg.on('message', (_e, m, p) => { if (m === 'Page.javascriptDialogOpening') { alerts.push(p.message); dbg.sendCommand('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); } });
          dbg.sendCommand('Page.enable').catch(() => {});   // 빈 창에서 await 하면 멈춤
        } catch (e) { /* 디버거 없이도 진행 */ }
        try {
          // 광고·추적 스크립트 때문에 '다 열림' 신호가 늦거나 안 오는 쇼핑몰이 많다 → 본문이 뜨면(dom-ready) 진행, 최대 20초
          const ready = new Promise(r => w.webContents.once('dom-ready', r));
          const load = w.loadURL(url).catch(e => { if (!/ERR_ABORTED/.test(e.message)) throw new Error(`페이지를 열 수 없어요 (${String(e.message).split(' loading')[0]})`); });
          await Promise.race([Promise.all([ready, load]), ready.then(() => new Promise(r => setTimeout(r, 6000))), new Promise((_, j) => setTimeout(() => j(new Error('페이지가 20초 안에 안 열렸어요. 주소를 확인하거나 잠시 뒤 다시 해 주세요.')), 20000))]);
          await new Promise(r => setTimeout(r, 2500));
          const info = await w.webContents.executeJavaScript(`({ title: document.title, text: document.body.innerText })`);
          if (alerts.length) env.log(`(페이지 알림: ${alerts.join(' / ').slice(0, 120)})`);
          if (!info.text || info.text.trim().length < 30) throw new Error(`페이지 내용이 거의 없어요${alerts.length ? ` (사이트 알림: ${alerts[0].slice(0, 80)})` : ''}. 주소가 맞는지 확인해 주세요.`);
          const fs = require('fs'), dir = path.join(store.tripsDir, '_po'); fs.mkdirSync(dir, { recursive: true });
          const shot = path.join(dir, `제품페이지_${Date.now()}.png`);
          fs.writeFileSync(shot, (await w.webContents.capturePage()).toPNG());
          env.log('캡처 완료 · AI 가 읽는 중');
          const r = await AI.readProductPage(ai, { url, title: info.title, text: info.text, shot: { mime: 'image/png', data: fs.readFileSync(shot).toString('base64') } });
          env.log(`${r.name || '제품 ?'} · ${r.unit_price.toLocaleString('ko-KR')}원 · 판매처 ${r.vendor.name || '?'}`);
          return { ...r, url, title: info.title, shot };
        } finally { done = true; try { dbg.detach(); } catch (e) { /* */ } if (!w.isDestroyed()) w.destroy(); }
      }, body.title);
    }
    case '/api/purchase/draft': {   // 메모 + 발주 내용 → 제목 설명·구매 상세 사유
      const ai = aiSettings(cfg); if (!ai) throw new Error('자동 작성은 AI 가 있어야 해요. 설정 › AI 문장 작성에서 Gemini 를 골라 주세요.');
      return AI.draftPurchase(ai, { memo: String(body.memo || ''), purpose: String(body.purpose || ''), project: String(body.project || ''), vendor: String(body.vendor || ''), items: Array.isArray(body.items) ? body.items : [] });
    }
    case '/api/purchase/title': return { title: R.purchaseTitle(String(body.tag || ''), String(body.desc || '')) };
    case '/api/job/purchase-list': return startJob('purchase-list', env => runner.runPurchaseList(env, { from: String(body.from || ''), to: String(body.to || '') }), body.title);
    case '/api/purchase/forget': store.removePurchase(String(body.title || '')); return { ok: true };
    case '/api/job/purchase': { const pu = R.parsePurchase(body.data); assertFilesExist([pu.file].filter(Boolean), '발주서'); return startJob('purchase', env => runner.runPurchase(env, body.data), body.title); }   // 보관·상신은 사람이
    case '/api/job/receipts': {   // 영수증·증빙 여러 개 → AI 가 예산과목·금액·날짜 분류
      const ai = aiSettings(cfg);
      if (!ai) throw new Error('영수증 자동 분류는 AI 가 있어야 해요. 설정 › AI 문장 작성에서 Gemini 를 골라 주세요.');
      return startJob('receipts', env => readReceipts(env, ai, (body.paths || []).map(String), String(body.period || '')), body.title);
    }
    case '/api/places': {   // 출장지 자동완성 (네이버 지역 검색). 키가 없으면 items: null
      const items = await require('./engine/places').searchPlaces(String(body.q || ''), { keys: naverKeys(), fetch: net.fetch });
      return { items };
    }
    case '/api/fx/rate': {   // 한국수출입은행 USD 매매기준율 + 결재 첨부용 조회 결과 이미지
      const FX = require('./engine/fx');
      const r = await FX.usdRate(fxKey(), { fetch: net.fetch });
      const shot = await FX.saveProof(r, path.join(store.tripsDir, '_fx', `환율_USD_${r.date}_${Date.now()}.png`));
      return { rate: r.rate, date: r.date, screenshot: shot };
    }
    case '/api/job/refund-check': return startJob('refund-check', env => runner.runRefundCheck(env), body.title);
    case '/api/job/gw-profile': return startJob('gw-profile', env => runner.runProfile(env, { force: !!body.force }), body.title);
    case '/api/job/report-load': return startJob('report-load', env => runner.runLoadReport(env, String(body.id)), body.title);
    case '/api/job/trip-delete': return startJob('trip-delete', env => runner.runDeleteTrip(env, body.id), body.title);
    case '/api/trip/forget': store.remove(String(body.id)); return { ok: true };
    case '/api/trip/adopt': {   // 그룹웨어에만 있는 출장 신청 품의 → 이 PC 기록. 결재 문서 본문을 읽어 출장지·기간·동행자·목적을 채운다
      const r = body.row; const pday = `${r.ym}-${String(r.day).padStart(2, '0')}`;
      const reason = String(r.docTitle || r.memo || '출장').replace(/^\[[^\]]*\]\s*/, '').replace(/(으로|로) 인한 출장의 건$/, '').replace(/\s*출장의 건$/, '').trim() || '출장';
      let f = null, note = '';
      if (r.docId) { try { const { Amaranth } = require('./engine/gw'); const gw = new Amaranth({ win: gwWindow(false), baseUrl: cfg.baseUrl, ui: null, log: () => {}, debugDir: null, creds: gwCreds }); f = await gw.apiApplyDocFields(r.docId, r.formId); } catch (e) { note = e.message; } }
      if (f) { const pd = R.parseTripPeriod(f.period, pday); if (pd.start) Object.assign(f, pd); else { f.start = f.start || ''; f.end = f.end || ''; } }   // 출장일 글자를 여러 꼴로 다시 읽음
      if (f && !f.start) note = note || `출장일을 읽지 못했어요 (본문: "${String(f.period || '').slice(0, 40)}") — 보고서에서 기간을 직접 넣어 주세요`;
      const prev = store.list().find(t => t.gwApply && t.gwApply.key === r.key);   // 이미 들여온 기록이면 그 자리에 덮어쓴다 (본문 다시 읽기)
      const id = prev ? prev.id : store.newId((f && f.start) || pday, reason);
      const old = prev ? store.load(id) : {};
      const keep = prev ? (({ report, gwReport, reportStatus, resolutionNo }) => ({ report, gwReport, reportStatus, resolutionNo }))(old) : {};   // 작성 중이던 보고서·보고 품의 연결·전송한 결의번호는 유지
      const pa = old.apply || {};   // 본문을 이번에 못 읽었거나 빈 칸이면 전에 읽어 둔 값을 그대로 (다시 읽다 실패하면 출장지·기간이 지워졌음 — UI 테스트로 발견 2026-10-23)
      const or = (v, p) => (v !== '' && v != null && !(Array.isArray(v) && !v.length)) ? v : p;
      store.save(id, { ...keep, id, created: new Date().toISOString(), title: R.applyTitle(reason), status: '그룹웨어', gwApply: { key: r.key, ym: r.ym, day: String(r.day), seq: String(r.seq) },
        apply: { reason, destination: or(f && f.destination, pa.destination || ''), start: or(f && f.start, pa.start || pday), end: or(f && f.end, pa.end || pday), start_time: or(f && f.start_time, pa.start_time || ''), end_time: or(f && f.end_time, pa.end_time || ''),
          category: or(f && f.category, pa.category || '일반'), project: or(f && f.project, pa.project || ''), transport: f && f.transport ? { mode: f.transport, to: '', from: '', total: null } : (pa.transport || { mode: '', to: '', from: '', total: null }),   // 본문을 못 읽으면 교통편 모름 (보고서에서 자차·대중교통 둘 다 안내)
          companions: or(f && f.companions, pa.companions || []), companion_purpose: or(f && f.companion_purpose, pa.companion_purpose || ''), purpose: or(f && f.purpose, pa.purpose || ''), expenses: pa.expenses || [] } });
      return { id, filled: !!f || !!pa.destination, note };   // 전에 읽어 둔 값이 있으면 '못 읽었다' 알림은 안 띄움
    }
    case '/api/job/gw-delete': return startJob('gw-delete', env => runner.runDeleteBudget(env, body.keys), body.title);
    case '/api/job/login': return startJob('login', env => runner.runLogin(env), body.title);
    case '/api/job/fare': return startJob('fare', env => runner.runFare({ ...env, force: Boolean(body.force) }, body), body.title);
    case '/api/job/apply': runner.planApply(body.data, cfg); return startJob('apply', env => runner.runApply(env, body.data, { save: false }), body.title);     // 보관·상신은 사람이
    case '/api/job/report': { const rep = R.parseReport(body.data); assertFilesExist(rep.expenses.flatMap(e => e.proofs || []), '증빙'); } return startJob('report', env => runner.runReport(env, body.data), body.title);
    case '/api/job/cancel': if (job) job.cancel(); return { ok: true };
    case '/api/job': return job ? job.snapshot(Number(body.since || 0)) : { state: 'none' };
    case '/api/job/answer': if (job) job.answer(body.value); return { ok: true };
    default: throw new Error(`알 수 없는 요청: ${p}`);
  }
}

ipcMain.handle('api', async (_e, p, body) => {
  try { return { ok: true, data: await route(p, body) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

app.whenReady().then(() => {
  // macOS Dock 아이콘은 번들 아이콘(build/icon.png, 애플 규격대로 둘레 여백 있음)을 그대로 쓴다.
  // 여기서 setIcon(꽉 찬 icon-512)으로 덮으면 다른 앱보다 크게 보인다. 개발 모드는 brand-dev-electron.js 가 같은 아이콘을 넣어 둔다.
  store = new Store(process.env.TRIP_ASSISTANT_DATA || app.getPath('userData'));
  createMain();
  updater.start();
  if (!app.isPackaged) watchForDev();
  app.on('activate', () => { if (!mainWin || mainWin.isDestroyed()) createMain(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
