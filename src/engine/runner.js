'use strict';
// 화면(렌더러)에서 부르는 작업 흐름. 브라우저 창과 사람 확인(ui)은 main.js 가 넣어준다.

const path = require('path');
const R = require('./rules');
const { Amaranth } = require('./gw');
const { lookupFare } = require('./naver');
const { applyPayload, reportPayload } = require('./editorFill');

function planApply(data, cfg) {
  const a = R.parseApply(data);
  if (R.TRANSPORT_MODES[a.transport.mode].autoFare && !a.transport.total) throw new R.InputError('교통비는 필수예요. [네이버 지도 조회]를 누르거나 직접 입력해 주세요.');
  return {
    title: R.applyTitle(a.reason), period: a.period,
    transport: { ...a.transport, from: a.transport.from || cfg.defaultOrigin },
    expenses: a.expenses, subtotal: a.expenses.reduce((s, e) => s + e.amount, 0),
  };
}

async function runFare(env, { mode, to, from }) {
  const { cfg, store, ui, log } = env;
  if (mode !== 'car' && mode !== 'transit') return { total: 0, describe: '법인차량은 교통비를 자동 계산하지 않습니다.' };
  if (!to) throw new R.InputError('도착지를 입력해 주세요.');
  const origin = from || cfg.defaultOrigin;
  const cached = store.getFare(mode, origin, to);
  if (cached && !env.force) { log(`교통비(최근 조회값): ${cached.describe}`); return { ...cached, source: 'cache' }; }
  const shot = path.join(store.tripsDir, '_fare', `교통비_${mode}_${Date.now()}.png`);
  const r = await lookupFare({ makeWindow: env.makeNaverWindow, mode, origin, dest: to, shotPath: shot, ui, log, debugDir: env.debugDir, creds: env.creds });
  store.putFare(mode, origin, to, r);
  log(`교통비: ${r.describe}`);
  return r;
}

/** 취소·오류로 중단: 작성 팝업 닫고 그룹웨어에 만들어 둔 품의 삭제. 취소 뒤엔 log 가 던지므로 logs 에 직접 남긴다 */
async function abort(env, gw) {
  const msg = await gw.rollback();
  if (msg && Array.isArray(env.ui.logs)) env.ui.logs.push(msg);
}

async function runApply(env, data, { save = true } = {}) {
  const { cfg, store, ui, log } = env;
  const a = R.parseApply(data);
  const id = store.newId(a.start, a.reason);
  const title = R.applyTitle(a.reason);
  log(`[신청서] ${title}`);
  const rec = { id, created: new Date().toISOString(), apply: a, title, status: '작성중' };
  store.save(id, rec);

  // 교통비: 화면에서 조회/입력한 값이 있으면 그대로, 없으면 지금 조회
  let fare = null;
  if (a.transport.total !== null) fare = { total: a.transport.total, screenshot: a.transport.screenshot, source: 'input', describe: `왕복 ${a.transport.total.toLocaleString('ko-KR')}원` };
  else if (R.TRANSPORT_MODES[a.transport.mode].autoFare) fare = await runFare(env, { mode: a.transport.mode, to: a.transport.to, from: a.transport.from });
  const expenses = [...a.expenses];
  if (fare && fare.total) { expenses.unshift(R.transportExpense(a, fare.total)); rec.fare = fare; }
  rec.expenses = expenses;
  store.save(id, rec);

  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui, log, debugDir: env.debugDir, creds: env.creds });
  try {
    await gw.ensureLogin();
    await gw.enterBudget(cfg.budgetDept, expenses, { memo: R.budgetMemo(title) });
    if (gw.lastBudget) { rec.gwApply = gw.lastBudget; store.save(id, rec); }   // 그룹웨어 품의와 연결 (목록·삭제용)
    const popup = await gw.openApproval(R.APPLY_FORM, title);
    await gw.fillAndKeep(popup, { title, probe: '출장일', payload: applyPayload(a), save });
  } catch (e) { await abort(env, gw); if (ui.cancelled) store.remove(id); throw e; }
  rec.status = save ? '보관됨' : '입력됨(미보관)';
  store.save(id, rec);
  log(`완료. 출장 ID: ${id}`);
  return { id };
}

function reportDraft(store, cfg, id) {
  const r = store.load(id);
  const a = r.apply;
  const days = [];
  for (let d = new Date(a.start + 'T00:00:00'); d <= new Date(a.end + 'T00:00:00'); d.setDate(d.getDate() + 1))
    days.push(`${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`);
  return {
    trip_id: id, reason: a.reason, name: cfg.name, companions: a.companions, category: '로봇',
    project: a.project || '', destination: a.destination, visit_org: a.destination,
    period: `${a.start.replace(/-/g, '.')}${a.start_time ? ' ' + a.start_time : ''} - ${a.end.replace(/-/g, '.')}${a.end_time ? ' ' + a.end_time : ''}`,
    purpose: a.purpose, report: '',
    schedule: days.map(date => ({ date, place: a.destination, detail: '' })),
    expenses: (r.expenses || a.expenses).map(({ item, amount, memo }) => ({ item, amount, memo,
      proofs: item === 'domestic_transport' && r.fare && r.fare.screenshot ? [r.fare.screenshot] : [] })),   // 교통비 증빙 = 네이버 지도 캡처
    attachments: [],
  };
}

async function runReport(env, data, { save = true } = {}) {
  const { cfg, store, ui, log } = env;
  const rep = R.parseReport(data);
  const title = R.reportTitle(rep.reason);
  log(`[보고서] ${title}`);
  let rec = null;
  if (rep.trip_id) { try { rec = store.load(rep.trip_id); rec.report = data; store.save(rep.trip_id, rec); } catch (e) { rec = null; } }   // 작성한 내용은 먼저 저장 (중간에 꺼도 다시 열면 그대로)
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui, log, debugDir: env.debugDir, creds: env.creds });
  try {
    await gw.ensureLogin();
    if (rec && rec.gwReport) {   // 전에 올린 보고 품의가 있으면: 상신 전이면 지우고 새로, 결재 중이면 멈춤
      const old = (await gw.listBudgetRows({ date: rec.gwReport.key.split('|').slice(0, 2) })).find(r => r.key === rec.gwReport.key);
      if (old && old.locked) throw new Error(`이 출장의 보고 품의(순번 ${old.seq})는 이미 '${old.status}' 상태라 다시 올릴 수 없어요.`);
      if (old) { log(`이전 보고 품의(순번 ${old.seq})를 지우고 새로 올려요.`); await gw.deleteBudgetRows([old.key]); }
      delete rec.gwReport; store.save(rep.trip_id, rec);
    }
    await gw.enterBudget(cfg.budgetDept, rep.expenses, { memo: R.budgetMemo(title) });
    const popup = await gw.openApproval(R.REPORT_FORM, title);
    await gw.fillAndKeep(popup, { title, probe: '출장일시', payload: reportPayload(rep), attachments: rep.attachments, save });
  } catch (e) { await abort(env, gw); throw e; }
  if (rec) { try { const r2 = store.load(rep.trip_id); if (gw.lastBudget) r2.gwReport = gw.lastBudget; r2.reportStatus = save ? '보관됨' : '입력됨(미보관)'; r2.report = data; store.save(rep.trip_id, r2); } catch (e) { /* 기록 없음 */ } }
  log('완료.');
  return {};
}

async function runLogin(env) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  env.log('로그인 상태 확인됨');
  return {};
}

/** 품의 행에 전자결재 문서(결재양식·제목·결재상태)를 문서번호로 붙이고, 양식으로 출장 신청/보고를 표시한다. 상신 전(문서번호 없음)은 적요로 짐작 */
async function attachApprovalDocs(gw, rows, log) {
  const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const to = new Date(), from = new Date(to.getFullYear(), to.getMonth() - 3, 1);
  let docs = [];
  try { docs = await gw.apiApprovalDocs(ymd(from), ymd(to)); } catch (e) { log(`(결재문서 목록 못 읽음: ${String(e.message).slice(0, 120)} — 적요로 판단해요)`); }
  const byNo = Object.fromEntries(docs.filter(d => d.docNo).map(d => [d.docNo, d]));
  for (const r of rows) {
    const d = r.docNo && byNo[r.docNo];
    if (d) { r.form = d.form; r.docTitle = d.title; r.docStatus = d.status; r.docId = d.docId; r.formId = d.formId; r.trip = /출장\s*신청/.test(d.form) ? 'apply' : /출장\s*보고/.test(d.form) ? 'report' : ''; }
    else r.trip = /출장\s*보고/.test(r.memo || '') ? 'report' : /출장/.test(r.memo || '') ? 'apply' : '';
  }
  return docs.length;
}

/** 이 PC에 보고서 내용이 없는데 그룹웨어에 보고 품의(상신 전)가 있으면: 그 품의의 예산 줄을 경비로 되살린다.
 *  담당업무·세부 활동 내용은 작성 창에서 [보관]하지 않았으면 그룹웨어에 남지 않아 되살릴 수 없다 */
async function runLoadReport(env, id) {
  const { store, cfg, log } = env;
  const rec = store.load(id);
  const draft = reportDraft(store, cfg, id);
  if (rec.report || !rec.gwReport) return { draft: rec.report ? { ...draft, ...rec.report, trip_id: id } : draft, resumed: !!rec.report };
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui: env.ui, log, debugDir: env.debugDir, creds: env.creds });
  log(`그룹웨어 보고 품의(순번 ${rec.gwReport.seq})에서 경비를 불러와요.`);
  let lines = [];
  try { await gw.ensureLogin(); lines = await gw.budgetLines(rec.gwReport.key); }
  catch (e) { log(`(경비를 못 불러왔어요: ${e.message} — 직접 넣어 주세요)`); return { draft, resumed: false, fromGw: 0 }; }
  const byLabel = Object.entries(R.BUDGET_ITEMS);
  const expenses = lines.map(l => { const hit = byLabel.find(([, [code, label]]) => l.label.includes(label) || l.label.includes(code));
    return hit ? { item: hit[0], amount: l.amount, memo: l.memo, proofs: [] } : null; }).filter(Boolean);
  log(`경비 ${expenses.length}줄 불러옴 (증빙은 다시 붙여 주세요)`);
  return { draft: { ...draft, expenses: expenses.length ? expenses : draft.expenses }, resumed: false, fromGw: expenses.length };
}

async function runListBudget(env) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  // 1) API 로 바로 (화면 없이 수백 ms). 최근 3개월은 월 단위로, 앱 기록에 있는 날들 + 오늘은 날짜별로(월 단위가 안 될 때 대비)
  const today = new Date(); const days = new Set([`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}|${today.getDate()}`]);
  const months = [0, 1, 2].map(i => { const d = new Date(today.getFullYear(), today.getMonth() - i, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; });
  for (const t of env.store.list()) for (const l of [t.gwApply, t.gwReport]) if (l && l.ym && l.day) days.add(`${l.ym}|${Number(l.day)}`);
  let user = env.cfg.gwUser || null, apiError = '';
  const t0 = Date.now();
  try {
    if (!user) { user = await gw.apiUser(); if (user) env.store.saveConfig({ gwUser: user }); }
    if (!user) throw new Error('사용자 정보를 아직 못 읽음');
    const rows = await gw.apiBudgetRows(user, { months, days: [...days] });
    await attachApprovalDocs(gw, rows, env.log);
    env.log(`API 로 품의 ${rows.length}건 읽음 (${((Date.now() - t0) / 1000).toFixed(1)}초, 삭제 가능 ${rows.filter(r => !r.locked).length}건)`);
    if (env.debugDir) await gw.diagApprovalList().catch(() => {});   // 한 번만(파일 없을 때): 전자결재 상신문서 목록 API 기록 (결재양식으로 출장 판별하기 위함, 10초쯤)
    return { rows, via: 'api', ms: Date.now() - t0 };
  } catch (e) {
    env.log(`(빠른 조회 실패: ${String(e.message).slice(0, 160)} — 화면에서 읽어요)`); apiError = String(e.message);
    try { require('fs').mkdirSync(env.debugDir, { recursive: true }); require('fs').appendFileSync(require('path').join(env.debugDir, 'api-error.log'), `${new Date().toISOString()} ${e.message}\n`); } catch (e2) { /* */ }
  }
  // 2) 화면에서 읽기 (첫 실행·세션 만료)
  await gw.ensureLogin();
  const rows = await gw.listBudgetRows();
  await attachApprovalDocs(gw, rows, env.log).catch(() => {});
  if (!user) { user = await gw.apiUser(); if (user) env.store.saveConfig({ gwUser: user }); }   // 다음부턴 API 로
  env.log(`화면에서 품의 ${rows.length}건 읽음 (${((Date.now() - t0) / 1000).toFixed(1)}초, 삭제 가능 ${rows.filter(r => !r.locked).length}건)`);
  return { rows, via: 'screen', ms: Date.now() - t0, apiError };
}

async function runDeleteBudget(env, keys) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('삭제할 품의를 골라 주세요.');
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  const r = await gw.deleteBudgetRows(keys);
  return { ...r, rows: r.rows || await gw.listBudgetRows() };
}

/** 출장 기록 삭제. 연결된 그룹웨어 품의(신청·보고)도 결재 전이면 함께 삭제 */
async function runDeleteTrip(env, id) {
  const { store, log } = env;
  const rec = store.load(id);
  const keys = [rec.gwApply, rec.gwReport].filter(Boolean).map(b => b.key);
  let rows = null;
  if (keys.length) {
    const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log, debugDir: env.debugDir, creds: env.creds });
    await gw.ensureLogin();
    const now = [];   // 화면은 품의일 하루치만 보여 주므로 연결된 품의의 날짜마다 읽는다
    for (const d of [...new Set(keys.map(k => k.split('|').slice(0, 2).join('|')))]) now.push(...await gw.listBudgetRows({ date: d.split('|') }));
    const linked = now.filter(r => keys.includes(r.key));
    const locked = linked.filter(r => r.locked);
    if (locked.length) throw new Error(`결재가 진행 중인 품의가 있어 삭제하지 않았어요 (순번 ${locked.map(r => r.seq).join(', ')}: ${locked.map(r => r.status).join(', ')}).`);
    if (linked.length) rows = (await gw.deleteBudgetRows(linked.map(r => r.key))).rows;
    else { log('그룹웨어에서 연결된 품의를 찾지 못했어요 (이미 지워졌을 수 있음).'); rows = now; }
  }
  store.remove(id);
  log(`출장 기록 삭제: ${rec.apply.reason}`);
  return { rows };
}

module.exports = { runLoadReport, planApply, runFare, runApply, reportDraft, runReport, runLogin, runListBudget, runDeleteBudget, runDeleteTrip };
