'use strict';
// 출장 결재 도우미 - Electron 메인 프로세스
// 화면(렌더러) ↔ 작업(엔진) 중계. 그룹웨어와 네이버 지도는 앱 안의 별도 창(내장 Chromium)에서 조작한다.

const { app, BrowserWindow, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const R = require('./engine/rules');
const runner = require('./engine/runner');
const { Store } = require('./engine/store');

const ICON = path.join(__dirname, '..', 'assets', 'icon-512.png');
let mainWin = null, gwWin = null, store = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); } });

function createMain() {
  mainWin = new BrowserWindow({
    width: 1200, height: 880, minWidth: 900, minHeight: 640, icon: ICON, title: '출장 결재 도우미',
    autoHideMenuBar: true, backgroundColor: '#f4f6f9',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
function gwWindow() {
  if (gwWin && !gwWin.isDestroyed()) return gwWin;
  gwWin = new BrowserWindow({
    width: 1500, height: 950, icon: ICON, title: '아마란스 — 출장 결재 도우미가 입력 중', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:gw', contextIsolation: true, sandbox: true },
  });
  // 결재 작성 팝업(window.open)은 앱 창으로 열고 같은 세션을 쓴다
  gwWin.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { width: 1100, height: 1000, icon: ICON, autoHideMenuBar: true },
  }));
  return gwWin;
}

function makeNaverWindow() {
  return new BrowserWindow({
    width: 1300, height: 900, icon: ICON, title: '네이버 지도 — 교통비 조회', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:naver', contextIsolation: true, sandbox: true },
  });
}

// ---------- 작업 1건 (사람 확인 포함) ----------
class Job {
  constructor(kind) { this.kind = kind; this.logs = []; this.state = 'running'; this.result = null; this.error = ''; this.question = null; this._resolve = null; }
  info(msg) { this.logs.push(...String(msg).split('\n')); }
  _ask(type, text) { this.state = 'waiting'; this.question = { type, text }; return new Promise(r => { this._resolve = v => { this.question = null; this.state = 'running'; r(v); }; }); }
  async assist(msg) { this.info(`⚠ ${msg}`); await this._ask('assist', msg); }
  async confirm(text) { return Boolean(await this._ask('confirm', text)); }
  async askInt(text) { return Number(await this._ask('int', text)); }
  async pause(text) { await this._ask('pause', text); }
  answer(v) { if (this._resolve) { const f = this._resolve; this._resolve = null; f(v); } }
  snapshot(since = 0) { return { kind: this.kind, state: this.state, logs: this.logs.slice(since), next: this.logs.length, question: this.question, result: this.result, error: this.error }; }
}
let job = null;

function startJob(kind, fn) {
  if (job && (job.state === 'running' || job.state === 'waiting')) throw new Error('이미 진행 중인 작업이 있습니다.');
  const j = job = new Job(kind);
  const env = { cfg: store.config(), store, ui: j, log: m => j.info(m), gwWindow, makeNaverWindow };
  (async () => {
    try { j.result = await fn(env); j.state = 'done'; j.info('✔ 완료'); }
    catch (e) { j.error = e instanceof R.InputError ? `입력 오류: ${e.message}` : e.message; j.state = 'error'; }
    finally { if (mainWin && !mainWin.isDestroyed()) mainWin.focus(); }
  })();
  return { ok: true };
}

// ---------- 화면 API ----------
async function route(p, body = {}) {
  const cfg = store.config();
  switch (p) {
    case '/api/meta':
      return { config: cfg, configured: store.hasConfig(), items: Object.fromEntries(Object.entries(R.BUDGET_ITEMS).map(([k, v]) => [k, v[1]])), version: app.getVersion() };
    case '/api/config': return store.saveConfig(body);
    case '/api/prompt': return { text: R.applyPrompt() };
    case '/api/parse': return { data: R.extractYaml(body.text || '') };
    case '/api/title': { const r = String(body.reason || '').trim(); return { apply: r ? R.applyTitle(r) : '', report: r ? R.reportTitle(r) : '' }; }
    case '/api/plan': return runner.planApply(body, cfg);
    case '/api/trips': return { trips: store.list() };
    case '/api/draft': { const d = runner.reportDraft(store, cfg, body.id); return { draft: d, prompt: R.reportPrompt(d) }; }
    case '/api/copy': clipboard.writeText(String(body.text || '')); return { ok: true };
    case '/api/open': if (body.path) shell.openPath(body.path); return { ok: true };
    case '/api/job/login': return startJob('login', env => runner.runLogin(env));
    case '/api/job/fare': return startJob('fare', env => runner.runFare(env, body));
    case '/api/job/apply': runner.planApply(body.data, cfg); return startJob('apply', env => runner.runApply(env, body.data, { save: body.save !== false }));
    case '/api/job/report': R.parseReport(body.data); return startJob('report', env => runner.runReport(env, body.data, { save: body.save !== false }));
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
  store = new Store(process.env.TRIP_ASSISTANT_DATA || app.getPath('userData'));
  createMain();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMain(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
