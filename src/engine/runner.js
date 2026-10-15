'use strict';
// 화면(렌더러)에서 부르는 작업 흐름. 브라우저 창과 사람 확인(ui)은 main.js 가 넣어준다.

const path = require('path');
const R = require('./rules');
const { Amaranth } = require('./gw');
const { lookupFare } = require('./naver');
const { applyPayload, reportPayload } = require('./editorFill');

function planApply(data, cfg) {
  const a = R.parseApply(data);
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
  await gw.ensureLogin();
  await gw.enterBudget(cfg.budgetDept, expenses);
  const popup = await gw.openApproval(R.APPLY_FORM, title);
  await gw.fillAndKeep(popup, { title, probe: '출장일', payload: applyPayload(a), save });
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
    expenses: (r.expenses || a.expenses).map(({ item, amount, memo }) => ({ item, amount, memo })),
    attachments: r.fare && r.fare.screenshot ? [r.fare.screenshot] : [],
  };
}

async function runReport(env, data, { save = true } = {}) {
  const { cfg, store, ui, log } = env;
  const rep = R.parseReport(data);
  const title = R.reportTitle(rep.reason);
  log(`[보고서] ${title}`);
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui, log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  await gw.enterBudget(cfg.budgetDept, rep.expenses);
  const popup = await gw.openApproval(R.REPORT_FORM, title);
  await gw.fillAndKeep(popup, { title, probe: '출장일시', payload: reportPayload(rep), attachments: rep.attachments, save });
  if (rep.trip_id) {
    try { const rec = store.load(rep.trip_id); rec.reportStatus = save ? '보관됨' : '입력됨(미보관)'; rec.report = data; store.save(rep.trip_id, rec); } catch (e) { /* 기록 없음 */ }
  }
  log('완료.');
  return {};
}

async function runLogin(env) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  env.log('로그인 상태 확인됨');
  return {};
}

async function runListBudget(env) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  const rows = await gw.listBudgetRows();
  env.log(`품의 ${rows.length}건 (삭제 가능 ${rows.filter(r => !r.locked).length}건)`);
  return { rows };
}

async function runDeleteBudget(env, keys) {
  if (!Array.isArray(keys) || !keys.length) throw new Error('삭제할 품의를 골라 주세요.');
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  const r = await gw.deleteBudgetRows(keys);
  return { ...r, rows: r.rows || await gw.listBudgetRows() };
}

module.exports = { planApply, runFare, runApply, reportDraft, runReport, runLogin, runListBudget, runDeleteBudget };
