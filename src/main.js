'use strict';
// 와니의 결재 도우미 - Electron 메인 프로세스
// 화면(렌더러) ↔ 작업(엔진) 중계. 그룹웨어와 네이버 지도는 앱 안의 별도 창(내장 Chromium)에서 조작한다.

const { app, BrowserWindow, ipcMain, clipboard, shell, safeStorage, dialog } = require('electron');
try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch (e) { /* 개발용 .env 없음 (배포본엔 없음) */ }
const path = require('path');
const R = require('./engine/rules');
const runner = require('./engine/runner');
const { Store } = require('./engine/store');
const Q = require('./engine/quick');
const AI = require('./engine/ai');
const updater = require('./updater');
const GW = require('./engine/gw');

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
// 그룹웨어 창은 기본으로 숨긴 채(백그라운드) 작업한다. 사람이 봐야 할 때만 [그룹웨어 창 열기]로 띄운다.
// 숨겨도 입력 이벤트·화면 갱신이 멈추지 않도록 backgroundThrottling 을 끈다.
const gwPopups = new Set();
let quitting = false;
app.on('before-quit', () => { quitting = true; });
function gwWindow(show = false) {
  if (gwWin && !gwWin.isDestroyed()) { if (show) showGw(); return gwWin; }
  gwWin = new BrowserWindow({
    show: false, width: 1500, height: 950, icon: ICON, title: '아마란스 — 와니의 결재 도우미가 입력 중', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:gw', contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // 결재 작성 팝업(window.open)도 숨긴 채 같은 세션으로 연다
  gwWin.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: { show: false, width: 1100, height: 1000, icon: ICON, autoHideMenuBar: true, webPreferences: { backgroundThrottling: false } },
  }));
  gwWin.webContents.on('did-create-window', w => {
    gwPopups.add(w); w.on('closed', () => gwPopups.delete(w));
    w.on('close', e => { if (!quitting && jobBusy()) { e.preventDefault(); w.hide(); } });   // 작업 중 닫으면 숨기기만
  });
  gwWin.on('close', e => { if (!quitting) { e.preventDefault(); gwWin.hide(); } });            // 닫기 = 숨기기 (로그인·작업 상태 유지)
  if (show) showGw();
  return gwWin;
}
function showGw() {
  if (!gwWin || gwWin.isDestroyed()) gwWindow(false);
  gwWin.show();
  const pops = [...gwPopups].filter(w => !w.isDestroyed());
  for (const w of pops) w.show();
  (pops.pop() || gwWin).focus();
}
function hideGw() {
  for (const w of gwPopups) if (!w.isDestroyed()) w.hide();
  if (gwWin && !gwWin.isDestroyed()) gwWin.hide();
}

// 네이버 지도 창도 숨긴 채 돌리고, 자동 검색이 안 될 때 작업창 [네이버 지도 열기]로만 띄운다
let naverWin = null;
function makeNaverWindow() {
  naverWin = new BrowserWindow({
    show: false, width: 1300, height: 900, icon: ICON, title: '네이버 지도 — 교통비 조회', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:naver', contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  return naverWin;
}
function showNaver() { if (naverWin && !naverWin.isDestroyed()) { naverWin.show(); naverWin.focus(); return true; } return false; }

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
  else if (job && job.state === 'running' && job.kind === 'fare') job.cancel();   // 교통비 조회는 새 조회가 덮어씀 (교통편 연달아 바꿀 때)
  else if (job && job.state === 'running') throw new Error('이전 작업이 아직 진행 중이에요. 작업창의 [취소]를 누른 뒤 다시 시도해 주세요.');
  const j = job = new Job(kind, title);
  const env = { debugDir: app.isPackaged ? path.join(app.getPath('userData'), 'debug') : path.join(__dirname, '..', 'debug'), cfg: store.config(), store, ui: j, log: m => j.info(m), gwWindow: () => gwWindow(false), showGw, makeNaverWindow, creds: gwCreds };
  (async () => {
    try { j.result = await fn(env); j.state = 'done'; j.info('✔ 완료'); }
    catch (e) { j.error = e instanceof R.InputError ? `입력 오류: ${e.message}` : e.message; j.state = j.cancelled ? 'cancelled' : 'error'; }
    finally { if (j.state !== 'done' && mainWin && !mainWin.isDestroyed()) mainWin.focus(); }   // 성공 시엔 작성 팝업이 앞
  })();
  return { ok: true };
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
const gwFor = (show, extra = {}) => new GW.Amaranth({ win: gwWindow(show), baseUrl: store.config().baseUrl, ui: { info() {}, async assist() {} }, log: () => {}, creds: gwCreds, ...extra });

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
  if (jobBusy()) throw new Error('작업이 진행 중이에요. 끝난 뒤 다시 해 주세요.');
  const gw = gwFor(false);
  if (await gw.loginNeeded()) {
    if (!(await gw.autoLogin(id, pw))) return { loggedIn: false, error: '로그인에 실패했어요. 아이디·비밀번호를 확인하거나 [그룹웨어 창에서 직접 로그인]을 써 주세요.' };
  }
  let note = '';
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
const publicConfig = c => { const { aiKeyEnc, gwPwEnc, ...rest } = c; return { ...rest, aiKeySet: Boolean(aiKeyEnc) || Boolean(aiSettings(c)), aiBuiltin: !aiKeyEnc && Boolean(aiSettings(c)), gwSaved: Boolean(c.gwId && gwPwEnc) }; };

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
  // 개발 모드(yarn dev)에서 코드를 고치면 반영: renderer → 새로고침, engine/main → 앱 재시작.
  // macOS 파일 감시는 켜자마자 '방금 전 변경'을 다시 알려 줘서 재시작이 무한 반복될 수 있다 →
  // 실제로 이 앱이 켜진 뒤에 수정된 소스 파일(.js/.html/.css)일 때만 반응한다. 작업 중이면 끝날 때까지 미룬다.
  const fs = require('fs');
  const started = Date.now();
  let timer = null, pending = false;
  const changedSinceStart = file => { try { return fs.statSync(file).mtimeMs > started; } catch (e) { return false; } };
  const restart = () => { if (jobBusy()) { if (!pending) { pending = true; console.log('[dev] 작업 중이라 끝나면 재시작'); } return setTimeout(restart, 2000); } app.relaunch(); app.exit(0); };
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
  watch(path.join(__dirname, 'engine'), true, restart);
  for (const f of ['main.js', 'preload.js', 'updater.js']) watch(path.join(__dirname, f), false, restart);
  console.log('[dev] 파일 변경 감시 중 (renderer → 새로고침, engine/main → 재시작, 작업 중엔 미룸)');
}

// ---------- 화면 API ----------
async function route(p, body = {}) {
  const cfg = store.config();
  switch (p) {
    case '/api/meta':
      return { config: publicConfig(cfg), configured: store.hasConfig(), items: Object.fromEntries(Object.entries(R.BUDGET_ITEMS).map(([k, v]) => [k, v[1]])),
        version: app.getVersion(), providers: Object.fromEntries(Object.entries(AI.PROVIDERS).map(([k, v]) => [k, v])) };
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
    case '/api/repeat': { const a = store.load(body.id).apply;   // keep: 반려돼서 고쳐 올릴 땐 날짜·시각 그대로
      const dates = body.keep ? { start: a.start, end: a.end, start_time: a.start_time, end_time: a.end_time } : { start: '', end: '' };
      return { data: { ...a, dates, transport: { ...a.transport, total: null, screenshot: '' } } }; }
    case '/api/prompt': return { text: R.applyPrompt() + String(body.memo || '').trim() + '\n' };
    case '/api/parse': return { data: R.extractYaml(body.text || '') };
    case '/api/title': { const r = String(body.reason || '').trim(); return { apply: r ? R.applyTitle(r) : '', report: r ? R.reportTitle(r) : '' }; }
    case '/api/plan': return runner.planApply(body, cfg);
    case '/api/trips': return { trips: store.list().map(t => ({ ...t, reportMemo: R.budgetMemo(R.reportTitle(t.reason || '')) })) };   // reportMemo: 보고 품의 적요 (연결이 끊긴 보고 품의를 찾는 데 씀)
    case '/api/draft': {   // 전에 작성한 보고서가 있으면 그대로, 없으면 신청 내용으로 초안
      const base = runner.reportDraft(store, cfg, body.id); const saved = store.load(body.id).report;
      const d = saved ? { ...base, ...saved, trip_id: body.id } : base;
      return { draft: d, prompt: R.reportPrompt(d), resumed: !!saved };
    }
    case '/api/trip/link-report': { const rec = store.load(body.id); const r = body.row; rec.gwReport = { key: r.key, ym: r.ym, day: String(r.day), seq: String(r.seq) }; store.save(body.id, rec); return { ok: true }; }
    case '/api/update': return { ...updater.state, current: app.getVersion(), platform: process.platform };
    case '/api/update/check': return { ...(await updater.check(!!body.force)), current: app.getVersion() };
    case '/api/update/install': return await updater.install();
    case '/api/copy': clipboard.writeText(String(body.text || '')); return { ok: true };
    case '/api/open': if (body.path) shell.openPath(body.path); return { ok: true };
    case '/api/pick-proofs': {   // 정산 증빙: 이미지·PDF 1개
      const r = await dialog.showOpenDialog(mainWin, { title: '증빙 자료 선택 (이미지·PDF 1개)', properties: ['openFile'],
        filters: [{ name: '이미지·PDF', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'pdf'] }] });
      return { paths: r.canceled ? [] : r.filePaths };
    }
    case '/api/gw/status': return gwStatus();
    case '/api/gw/login': return gwLogin(body);
    case '/api/gw/forget': sessionCreds = null; store.saveConfig({ gwId: '', gwPwEnc: '' }); return { ok: true };
    case '/api/gw/show': if (job && job.kind === 'fare' && showNaver()) return { ok: true }; showGw(); return { ok: true };
    case '/api/gw/hide': hideGw(); return { ok: true };
    case '/api/job/gw-list': return startJob('gw-list', env => runner.runListBudget(env), body.title);
    case '/api/job/gw-profile': return startJob('gw-profile', env => runner.runProfile(env, { force: !!body.force }), body.title);
    case '/api/job/report-load': return startJob('report-load', env => runner.runLoadReport(env, String(body.id)), body.title);
    case '/api/job/trip-delete': return startJob('trip-delete', env => runner.runDeleteTrip(env, body.id), body.title);
    case '/api/trip/forget': store.remove(String(body.id)); return { ok: true };
    case '/api/trip/adopt': {   // 그룹웨어에만 있는 출장 신청 품의 → 이 PC 기록. 결재 문서 본문을 읽어 출장지·기간·동행자·목적을 채운다
      const r = body.row; const pday = `${r.ym}-${String(r.day).padStart(2, '0')}`;
      const reason = String(r.docTitle || r.memo || '출장').replace(/^\[[^\]]*\]\s*/, '').replace(/(으로|로) 인한 출장의 건$/, '').replace(/\s*출장의 건$/, '').trim() || '출장';
      let f = null, note = '';
      if (r.docId) { try { const { Amaranth } = require('./engine/gw'); const gw = new Amaranth({ win: gwWindow(false), baseUrl: cfg.baseUrl, ui: null, log: () => {}, debugDir: null, creds: gwCreds }); f = await gw.apiApplyDocFields(r.docId, r.formId); } catch (e) { note = e.message; } }
      const prev = store.list().find(t => t.gwApply && t.gwApply.key === r.key);   // 이미 들여온 기록이면 그 자리에 덮어쓴다 (본문 다시 읽기)
      const id = prev ? prev.id : store.newId((f && f.start) || pday, reason);
      const keep = prev ? (({ report, gwReport, reportStatus }) => ({ report, gwReport, reportStatus }))(store.load(id)) : {};   // 작성 중이던 보고서·보고 품의 연결은 유지
      store.save(id, { ...keep, id, created: new Date().toISOString(), title: R.applyTitle(reason), status: '그룹웨어', gwApply: { key: r.key, ym: r.ym, day: String(r.day), seq: String(r.seq) },
        apply: { reason, destination: (f && f.destination) || '', start: (f && f.start) || pday, end: (f && f.end) || pday, start_time: (f && f.start_time) || '', end_time: (f && f.end_time) || '',
          category: (f && f.category) || '일반', project: (f && f.project) || '', transport: { mode: (f && f.transport) || 'car', to: '', from: '', total: null },
          companions: (f && f.companions) || [], companion_purpose: (f && f.companion_purpose) || '', purpose: (f && f.purpose) || '', expenses: [] } });
      return { id, filled: !!f, note };
    }
    case '/api/job/gw-delete': return startJob('gw-delete', env => runner.runDeleteBudget(env, body.keys), body.title);
    case '/api/job/login': return startJob('login', env => runner.runLogin(env), body.title);
    case '/api/job/fare': return startJob('fare', env => runner.runFare({ ...env, force: Boolean(body.force) }, body), body.title);
    case '/api/job/apply': runner.planApply(body.data, cfg); return startJob('apply', env => runner.runApply(env, body.data, { save: false }), body.title);     // 보관·상신은 사람이
    case '/api/job/report': R.parseReport(body.data); return startJob('report', env => runner.runReport(env, body.data, { save: false }), body.title);
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
