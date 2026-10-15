'use strict';
// 와니의 결재 도우미 - Electron 메인 프로세스
// 화면(렌더러) ↔ 작업(엔진) 중계. 그룹웨어와 네이버 지도는 앱 안의 별도 창(내장 Chromium)에서 조작한다.

const { app, BrowserWindow, ipcMain, clipboard, shell, safeStorage } = require('electron');
const path = require('path');
const R = require('./engine/rules');
const runner = require('./engine/runner');
const { Store } = require('./engine/store');
const Q = require('./engine/quick');
const AI = require('./engine/ai');
const updater = require('./updater');

const ICON = path.join(__dirname, '..', 'assets', 'icon-512.png');
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
    width: 1500, height: 950, icon: ICON, title: '아마란스 — 와니의 결재 도우미가 입력 중', autoHideMenuBar: true,
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
class Cancelled extends Error { constructor() { super('취소했어요.'); } }
class Job {
  constructor(kind, title) { this.kind = kind; this.title = title || kind; this.logs = []; this.state = 'running'; this.result = null; this.error = ''; this.question = null; this._resolve = null; this._reject = null; this.cancelled = false; }
  info(msg) { if (this.cancelled) throw new Cancelled(); this.logs.push(...String(msg).split('\n')); }
  _ask(type, text) {
    if (this.cancelled) return Promise.reject(new Cancelled());
    this.state = 'waiting'; this.question = { type, text };
    return new Promise((r, j) => {
      this._resolve = v => { this.question = null; this.state = 'running'; r(v); };
      this._reject = e => { this.question = null; j(e); };
    });
  }
  cancel() {
    this.cancelled = true;
    if (this._reject) { const f = this._reject; this._resolve = this._reject = null; f(new Cancelled()); }
  }
  async assist(msg) { this.info(`⚠ ${msg}`); await this._ask('assist', msg); }
  async confirm(text) { return Boolean(await this._ask('confirm', text)); }
  async askInt(text) { return Number(await this._ask('int', text)); }
  async pause(text) { await this._ask('pause', text); }
  answer(v) { if (this._resolve) { const f = this._resolve; this._resolve = this._reject = null; f(v); } }
  snapshot(since = 0) { return { kind: this.kind, title: this.title, state: this.state, logs: this.logs.slice(since), next: this.logs.length, question: this.question, result: this.result, error: this.error }; }
}
let job = null;

function startJob(kind, fn, title) {
  if (job && job.state === 'waiting') job.cancel();          // 사람 입력만 기다리던 이전 작업은 취소
  else if (job && job.state === 'running') throw new Error('이전 작업이 아직 진행 중이에요. 작업창의 [취소]를 누른 뒤 다시 시도해 주세요.');
  const j = job = new Job(kind, title);
  const env = { cfg: store.config(), store, ui: j, log: m => j.info(m), gwWindow, makeNaverWindow };
  (async () => {
    try { j.result = await fn(env); j.state = 'done'; j.info('✔ 완료'); }
    catch (e) { j.error = e instanceof R.InputError ? `입력 오류: ${e.message}` : e.message; j.state = j.cancelled ? 'cancelled' : 'error'; }
    finally { if (mainWin && !mainWin.isDestroyed()) mainWin.focus(); }
  })();
  return { ok: true };
}

// ---------- AI 키 (OS 보안 저장소로 암호화) ----------
function aiSettings(cfg) {
  if (!cfg.aiProvider || !cfg.aiKeyEnc) return null;
  try {
    const buf = Buffer.from(cfg.aiKeyEnc, 'base64');
    const key = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
    return { provider: cfg.aiProvider, model: cfg.aiModel, key };
  } catch (e) { return null; }
}
function encryptKey(key) {
  return (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8')).toString('base64');
}
const publicConfig = c => { const { aiKeyEnc, ...rest } = c; return { ...rest, aiKeySet: Boolean(aiKeyEnc) }; };

/** 한 줄 메모 → 신청서. AI 가 있으면 문장/추론은 AI, 금액·출장지 이름은 항상 규칙. */
async function quick(memo) {
  const cfg = store.config();
  const places = store.places();
  const ctx = { today: new Date(), places, rates: cfg.rates, mealTimes: cfg.mealTimes, origin: cfg.defaultOrigin, defaults: { mode: store.lastMode() } };
  const base = Q.quickApply(memo, ctx);
  const ai = aiSettings(cfg);
  let data = base.data, source = 'template', note = '';
  if (ai) {
    try {
      const d = await AI.draftApply(ai, memo, { places });
      data = Q.mergeAi(base.data, d, places, cfg);
      source = AI.PROVIDERS[ai.provider].label;
    } catch (e) { note = `AI 작성 실패로 템플릿을 썼어요: ${e.message}`; }
  }
  let meals = null;
  if (data.dates.start && data.reason) {
    meals = Q.computeExpenses({ start: data.dates.start, end: data.dates.end || data.dates.start, startTime: data.dates.start_time, endTime: data.dates.end_time, reason: data.reason, rates: cfg.rates, mealTimes: cfg.mealTimes });
    data.expenses = meals.expenses;
  }
  const missing = [];
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
      const d = await AI.draftReport(ai, draft, memo);
      return { data: { ...draft, ...d, expenses: d.expenses || draft.expenses, attachments: draft.attachments, trip_id: id }, source: AI.PROVIDERS[ai.provider].label };
    } catch (e) { return { data: Q.quickReport(draft, memo), source: 'template', note: `AI 작성 실패로 템플릿을 썼어요: ${e.message}` }; }
  }
  return { data: Q.quickReport(draft, memo), source: 'template' };
}

// ---------- dev: 파일이 바뀌면 자동 반영 ----------
// 화면(renderer) 파일 → 창 새로고침, 엔진/메인 파일 → 앱 재시작
function watchForDev() {
  const fs = require('fs');
  let timer = null;
  const on = (dir, action) => {
    try {
      fs.watch(dir, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(action, 200); });
    } catch (e) { console.warn('watch 실패:', dir, e.message); }
  };
  on(path.join(__dirname, 'renderer'), () => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.reloadIgnoringCache(); });
  on(path.join(__dirname, 'engine'), () => { app.relaunch(); app.exit(0); });
  for (const f of ['main.js', 'preload.js', 'updater.js'])
    fs.watch(path.join(__dirname, f), () => { clearTimeout(timer); timer = setTimeout(() => { app.relaunch(); app.exit(0); }, 200); });
  console.log('[dev] 파일 변경 감시 중 (renderer → 새로고침, engine/main → 재시작)');
}

// ---------- 화면 API ----------
async function route(p, body = {}) {
  const cfg = store.config();
  switch (p) {
    case '/api/meta':
      return { config: publicConfig(cfg), configured: store.hasConfig(), items: Object.fromEntries(Object.entries(R.BUDGET_ITEMS).map(([k, v]) => [k, v[1]])),
        version: app.getVersion(), providers: Object.fromEntries(Object.entries(AI.PROVIDERS).map(([k, v]) => [k, v])), places: store.places().slice(0, 8) };
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
    case '/api/expenses': { const r = Q.computeExpenses({ start: body.start, end: body.end || body.start, startTime: body.start_time, endTime: body.end_time, reason: body.reason || '', rates: cfg.rates, mealTimes: cfg.mealTimes }); return { expenses: r.expenses, summary: r.summary, timed: r.timed }; }
    case '/api/repeat': { const a = store.load(body.id).apply; return { data: { ...a, dates: { start: '', end: '' }, transport: { ...a.transport, total: null, screenshot: '' } } }; }
    case '/api/prompt': return { text: R.applyPrompt() + String(body.memo || '').trim() + '\n' };
    case '/api/parse': return { data: R.extractYaml(body.text || '') };
    case '/api/title': { const r = String(body.reason || '').trim(); return { apply: r ? R.applyTitle(r) : '', report: r ? R.reportTitle(r) : '' }; }
    case '/api/plan': return runner.planApply(body, cfg);
    case '/api/trips': return { trips: store.list() };
    case '/api/draft': { const d = runner.reportDraft(store, cfg, body.id); return { draft: d, prompt: R.reportPrompt(d) }; }
    case '/api/update': return { ...updater.state, current: app.getVersion() };
    case '/api/update/install': return { restarting: updater.install() };
    case '/api/copy': clipboard.writeText(String(body.text || '')); return { ok: true };
    case '/api/open': if (body.path) shell.openPath(body.path); return { ok: true };
    case '/api/job/login': return startJob('login', env => runner.runLogin(env), body.title);
    case '/api/job/fare': return startJob('fare', env => runner.runFare({ ...env, force: Boolean(body.force) }, body), body.title);
    case '/api/job/apply': runner.planApply(body.data, cfg); return startJob('apply', env => runner.runApply(env, body.data, { save: body.save !== false }), body.title);
    case '/api/job/report': R.parseReport(body.data); return startJob('report', env => runner.runReport(env, body.data, { save: body.save !== false }), body.title);
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
  store = new Store(process.env.TRIP_ASSISTANT_DATA || app.getPath('userData'));
  createMain();
  updater.start();
  if (!app.isPackaged) watchForDev();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMain(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
