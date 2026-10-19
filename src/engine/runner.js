'use strict';
// 화면(렌더러)에서 부르는 작업 흐름. 브라우저 창과 사람 확인(ui)은 main.js 가 넣어준다.

const path = require('path');
const R = require('./rules');
const { Amaranth } = require('./gw');
const { lookupFare, carBasis } = require('./naver');
const { searchPlaces } = require('./places');
const { applyPayload, reportPayload, purchasePayload } = require('./editorFill');

function planApply(data, cfg) {
  if (!cfg.budgetDept) throw new R.InputError('설정에서 예산 부서를 골라 주세요. (그룹웨어에 로그인하면 목록을 받아와요)');
  const a = R.parseApply(data);
  if (R.TRANSPORT_MODES[a.transport.mode].autoFare && a.transport.total === null) throw new R.InputError('교통비는 필수예요. [네이버 지도 조회]를 누르거나 직접 입력해 주세요.');
  return {
    title: R.applyTitle(a.reason), period: a.period,
    transport: { ...a.transport, from: a.transport.from || cfg.defaultOrigin },
    expenses: a.expenses, subtotal: a.expenses.reduce((s, e) => s + e.amount, 0),
  };
}

async function runFare(env, { mode, to, from, place = null }) {
  const { cfg, store, ui, log } = env;
  if (mode !== 'car' && mode !== 'transit') return { total: 0, describe: '법인차량은 교통비를 자동 계산하지 않습니다.' };
  if (!to) throw new R.InputError('도착지를 입력해 주세요.');
  const origin = from || cfg.defaultOrigin;
  if (!origin) throw new R.InputError('출발지가 없어요. 설정의 기본 출발지나 교통·경비의 출발지를 넣어 주세요.');
  const cached = store.getFare(mode, origin, to);
  if (cached && !env.force && (mode !== 'car' || cached.basis === carBasis({ type: cfg.carType, fuel: cfg.carFuel }))) { log(`교통비(최근 조회값): ${cached.describe}`); return { ...cached, source: 'cache' }; }   // 자차는 연비 8km/L 로 조회한 값만
  const shot = path.join(store.tripsDir, '_fare', `교통비_${mode}_${Date.now()}.png`);
  const r = await lookupFare({ makeWindow: env.makeNaverWindow, mode, origin, dest: to, shotPath: shot, ui, log, debugDir: env.debugDir, creds: env.creds, car: { type: cfg.carType, fuel: cfg.carFuel },
    destPlace: place, places: env.naverKeys ? q => searchPlaces(q, { keys: env.naverKeys, fetch: env.fetch }) : null });
  store.putFare(mode, origin, to, r);
  log(`교통비: ${r.describe}`);
  return r;
}

/** 구매의뢰서: 품의 입력 없이 결재작성 › 구매의뢰서 양식을 열어 본문을 채우고 발주서를 첨부한다. [보관]·[상신]은 사람이 */
async function runPurchase(env, data) {
  const { cfg, ui, log } = env;
  const pu = R.parsePurchase(data);
  log(`[구매의뢰서] ${pu.title}`);
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui, log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  const popup = await gw.openForm(R.PURCHASE_FORM);
  const fs = require('fs');
  const shotDataUrl = pu.link && pu.link.shot && fs.existsSync(pu.link.shot) ? `data:image/png;base64,${fs.readFileSync(pu.link.shot).toString('base64')}` : '';   // 페이지 캡처는 본문에 그림으로도, 첨부로도
  await gw.fillAndKeep(popup, { title: pu.title, probe: '구매목적', payload: purchasePayload(pu, { shotDataUrl }), attachments: [pu.file, pu.link && pu.link.shot].filter(Boolean), save: false,
    beforeShow: () => gw.addRecipients(popup, R.PURCHASE_RECIPIENTS, { withDept: true }) });   // 수신및참조까지 다 넣고 나서 창을 띄움
  env.store.addPurchase({ title: pu.title, created: new Date().toISOString(), data, total: pu.total, vendor: pu.vendor.name, items: pu.items.length });   // 다시 불러오기·목록용
  return { title: pu.title };
}

/** 신청한 구매의뢰 목록: 그룹웨어 결재 문서(양식 '구매의뢰서') + 이 PC 기록(아직 상신 안 한 것) */
async function runPurchaseList(env, { from = '', to = '' } = {}) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  const r = listRange(from, to);
  const nz = x => String(x || '').replace(/\s/g, '');
  let docs = [];
  try { docs = (await gw.apiApprovalDocs(r.from.replace(/-/g, ''), r.to.replace(/-/g, ''))).filter(d => d.form === R.PURCHASE_FORM); }
  catch (e) { env.log(`(결재 문서 목록 못 읽음: ${String(e.message).slice(0, 120)})`); }
  const mine = env.store.purchases();
  const rows = docs.map(d => ({ docNo: d.docNo, title: d.title, status: d.status, date: d.date, local: mine.find(m => nz(m.title) === nz(d.title)) || null }));
  for (const m of mine) if (!rows.some(x => x.local === m)) rows.push({ docNo: '', title: m.title, status: '', date: m.created.slice(0, 10), local: m });   // 작성 창만 열고 아직 상신 안 함 (또는 기간 밖)
  env.log(`구매의뢰서 ${docs.length}건 (그룹웨어) · 이 PC 기록 ${mine.length}건`);
  return { rows: rows.map(x => ({ ...x, local: x.local ? { created: x.local.created, data: x.local.data } : null })), from: r.from, to: r.to };
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
  const expenses = [...a.expenses];   // 0원 줄도 사용자가 넣은 그대로 올림
  if (fare && (fare.total || (fare.source === 'input' && fare.total === 0))) { expenses.unshift(R.transportExpense(a, fare.total, fare.total ? cfg.rates.fareMargin : 0)); rec.fare = fare; }   // 직접 넣은 0원도 교통비 줄로 (여유분 없이)
  rec.expenses = expenses;
  store.save(id, rec);

  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui, log, debugDir: env.debugDir, creds: env.creds });
  try {
    await gw.ensureLogin();
    await gw.enterBudget(cfg.budgetDept, expenses, { memo: R.budgetMemo(title) });
    if (gw.lastBudget) { rec.gwApply = gw.lastBudget; store.save(id, rec); }   // 그룹웨어 품의와 연결 (목록·삭제용)
    const popup = await gw.openApproval(R.APPLY_FORM, title);
    await gw.fillAndKeep(popup, { title, probe: '출장일', payload: applyPayload(a), attachments: a.overseas && a.overseas.rateShot ? [a.overseas.rateShot] : [], save });   // 해외: 수출입은행 환율 조회 결과 이미지 첨부 필수
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
    project: a.project || '', destination: a.destination, visit_org: a.destination.replace(/\s*\([^)]*\)\s*$/, ''),   // 방문기관 = 출장지에서 (주소) 뺀 이름
    period: `${a.start.replace(/-/g, '.')}${a.start_time ? ' ' + a.start_time : ''} - ${a.end.replace(/-/g, '.')}${a.end_time ? ' ' + a.end_time : ''}`,
    purpose: a.purpose, report: '',
    schedule: days.map(date => ({ date, place: a.destination, detail: '' })),
    transport: a.transport ? { mode: a.transport.mode, from: a.transport.from || '', to: a.transport.to || '', place: a.transport.place || (r.fare && r.fare.place && r.fare.place.lng ? r.fare.place : null) } : null,
    // 교통비는 신청 때 더한 여유분 없이 실제(네이버 지도) 금액으로, 증빙은 지도 캡처. 자차는 내 차 기준(8km/L)으로 조회한 것만 증빙이 되고,
    // 정산엔 유류대만 넣는다 (통행료·하이패스는 영수증으로 따로 — 지도 추정값은 증빙이 안 됨)
    expenses: (r.expenses || a.expenses).map(({ item, amount, memo }) => item === 'domestic_transport' && r.fare && r.fare.total && (a.transport.mode !== 'car' || r.fare.basis === carBasis({ type: cfg.carType, fuel: cfg.carFuel }))
      ? (a.transport.mode === 'car' ? R.fuelOnlyExpense(r.fare) : { item, amount: r.fare.total, memo: memo.replace(/ \+ 여유 [\d,]+원/, ''), proofs: r.fare.screenshot ? [r.fare.screenshot] : [] })
      : { item, amount, memo, proofs: [] }),
    attachments: [],
  };
}

/** 출장보고서(정산). 새 품의를 만들지 않고, 승인된 신청 품의로 지출결의를 한다 (사용자가 알려 준 회사 절차):
 *  품의서승인(복수) → 신청 품의 체크 → [결의서전송/취소] → 지출결의서·집행용도 → 예산 줄 결제수단·과세구분 → 채주내역(영수증마다) → [환원]
 *  → 사람이 확인하고 [전송]. 이어지는 결의서입력 → 결재상신 → 출장보고서 본문은 다음 단계에서 자동화한다. */
async function runReport(env, data) {
  const { cfg, store, ui, log } = env;
  const rep = R.parseReport(data);
  log(`[보고서] ${rep.reason}`);
  let rec = null;
  if (rep.trip_id) { try { rec = store.load(rep.trip_id); rec.report = data; store.save(rep.trip_id, rec); } catch (e) { rec = null; } }   // 작성한 내용은 먼저 저장 (중간에 꺼도 다시 열면 그대로)
  const apply = rec && rec.gwApply;
  if (!apply || !apply.ym || !apply.seq) throw new R.InputError('이 출장의 신청 품의를 몰라요. [내 출장보고서] 목록에서 그룹웨어 신청 품의와 연결된 출장으로 보고서를 써 주세요.');
  const payee = cfg.name || rep.name;
  if (!payee) throw new R.InputError('그룹웨어 이름을 몰라요. 설정에서 그룹웨어에 로그인해 내 정보를 불러와 주세요.');
  const usedOn = (/(\d{4})[.-](\d{2})[.-](\d{2})/.exec(rep.period) || []).slice(1).join('-');   // 출장 시작일 (법인카드 자금계획일 기준)
  const lines = rep.expenses.map(e => ({ label: e.label, pay: e.pay, noVat: e.noVat, amount: e.amount, supply: R.supplyAmount(e.amount, e.pay, e.noVat), vat: R.vatAmount(e.amount, e.pay, e.noVat), memo: e.memo, planDate: R.fundPlanDate(e.pay, { usedOn }), proof: (e.proofs || [])[0] || '' }));
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui, log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  // 1~2단계: 결의서전송 (이미 전송한 출장이면 건너뜀 — 다시 돌릴 때)
  // 이미 전송했어도 결의서전송 창은 한 번 연다: 그 안에서 전송 여부를 보고, 환원이 빠져 있으면 다시 [환원]만 한다 (기록에 기대지 않음)
  let resNo = '';
  {
    await gw.openApprovedBudget(apply);
    const st = await gw.settleTransfer({ purpose: R.APPLY_FORM, payee, fund: rep.fund, lines });
    // [전송]까지 앱이 한다 (사용자 요청 2026-10-16). 채주 저장 확인이 안 됐으면 보내지 않는다
    resNo = st && st.resNo ? st.resNo : st && st.ok ? await gw.transferResolution() : '';
    if (rec) { try { const r2 = store.load(rep.trip_id); r2.report = data; r2.reportStatus = resNo ? `결의 전송됨(${resNo})` : '결의 입력(전송 전)'; if (resNo) r2.resolutionNo = resNo; store.save(rep.trip_id, r2); } catch (e) { /* 기록 없음 */ } }
    if (!resNo) { env.showGw(); await ui.pause('[전송]을 하지 않았어요. 결의서전송 창에서 채주·첨부·환원을 확인하고 직접 [전송]한 뒤 여기서 [계속]을 눌러 주세요. 결의서입력부터는 다음에 [그룹웨어에 정산 입력하기]를 다시 누르면 이어서 해요.'); return {}; }
  }
  // 3~4단계: 결의서입력 → [결재상신] → 결재양식 '출장보고서 및 경비정산 지출결의서' → 출장보고서 본문. [상신]은 사람이
  const title = R.reportTitle(rep.reason);
  await gw.openResolution(resNo);
  const popup = await gw.openApproval(R.REPORT_FORM, title, { category: '결의서입력' });
  await gw.fillAndKeep(popup, { title, probe: '출장일시', payload: reportPayload(rep), attachments: [], save: false });   // 영수증은 채주 첨부로 이미 결재 문서에 딸려 온다 → 다시 안 올림
  if (rec) { try { const r2 = store.load(rep.trip_id); r2.reportStatus = '보고서 작성 창 열림(상신 전)'; store.save(rep.trip_id, r2); } catch (e) { /* */ } }
  log('출장보고서 작성 창을 띄웠어요. 결재라인 확인하고 [상신]은 직접 눌러 주세요.');
  return { resolutionNo: resNo };
}

async function runLogin(env) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  env.log('로그인 상태 확인됨');
  return {};
}

/** 품의 행에 전자결재 문서(결재양식·제목·결재상태)를 문서번호로 붙이고, 양식으로 출장 신청/보고를 표시한다. 상신 전(문서번호 없음)은 적요로 짐작 */
async function attachApprovalDocs(gw, rows, log, range = null) {
  const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const r = range || listRange('', '');
  let docs = [];
  try { docs = await gw.apiApprovalDocs(r.from.replace(/-/g, ''), r.to.replace(/-/g, '')); } catch (e) { log(`(결재문서 목록 못 읽음: ${String(e.message).slice(0, 120)} — 적요로 판단해요)`); }
  const byNo = Object.fromEntries(docs.filter(d => d.docNo).map(d => [d.docNo, d]));
  for (const r of rows) {
    const d = r.docNo && byNo[r.docNo];
    if (d) { r.form = d.form; r.docTitle = d.title; r.docStatus = d.status; r.docId = d.docId; r.formId = d.formId; r.trip = /출장\s*신청/.test(d.form) ? 'apply' : /출장\s*보고/.test(d.form) ? 'report' : ''; }
    else r.trip = /출장\s*보고/.test(r.memo || '') ? 'report' : /출장/.test(r.memo || '') ? 'apply' : '';
  }
  return docs;
}
/** 결의서입력에서 올린 출장보고서 결재 문서 (양식 '출장보고서 및 경비정산 지출결의서') — 목록에서 보고 진행 상태를 보여 주는 데 씀 */
const reportDocsOf = docs => (docs || []).filter(d => d.form === R.REPORT_FORM).map(({ docNo, title, status, date }) => ({ docNo, title, status, date }));

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

/** 그룹웨어에서 내 정보 받아오기: 이름·품의부서(기본 예산 부서)·사업코드 목록. 비어 있는 설정만 채운다 (force 면 이름·부서도 다시) */
async function runProfile(env, { force = false } = {}) {
  const { store, cfg, log } = env;
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui: env.ui, log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  log('그룹웨어에서 내 정보를 읽어요.');
  const me = await gw.readProfile();
  let depts = [];
  try { depts = await gw.budgetDeptList(); } catch (e) { log(`(사업코드 목록을 못 읽었어요: ${e.message})`); }
  if (me.deptName && !depts.includes(me.deptName)) depts.unshift(me.deptName);
  const patch = { budgetDepts: depts };
  if (me.empName && (force || !cfg.name)) patch.name = me.empName;
  if (me.deptName && (force || !cfg.budgetDept)) patch.budgetDept = me.deptName;
  if (me.coCd && me.deptCd && me.empCd) patch.gwUser = { coCd: me.coCd, deptCd: me.deptCd, empCd: me.empCd };
  store.saveConfig(patch);
  log(`이름 ${patch.name || cfg.name || '-'} · 예산 부서 ${patch.budgetDept || cfg.budgetDept || '-'} · 고를 수 있는 부서 ${depts.length}개`);
  return { name: patch.name || cfg.name, budgetDept: patch.budgetDept || cfg.budgetDept, budgetDepts: depts };
}

/** 조회 기간 정리: from~to (YYYY-MM-DD). 비면 오늘부터 3개월 전, 1년을 넘으면 to 기준 1년으로 */
function listRange(from, to) {
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ok = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const today = new Date(); const def = new Date(today); def.setMonth(def.getMonth() - 3);
  to = ok(to) ? to : ymd(today); from = ok(from) ? from : ymd(def);
  if (from > to) [from, to] = [to, from];
  const lim = new Date(`${to}T00:00:00`); lim.setFullYear(lim.getFullYear() - 1);
  if (from < ymd(lim)) from = ymd(lim);
  const months = []; for (let d = new Date(`${to.slice(0, 7)}-01T00:00:00`); ymd(d).slice(0, 7) >= from.slice(0, 7); d.setMonth(d.getMonth() - 1)) months.push(ymd(d).slice(0, 7));
  return { from, to, months };
}

async function runListBudget(env, { from = '', to = '' } = {}) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  // API 로 바로 (화면 없이 수백 ms). 기간의 달들은 월 단위로, 앱 기록에 있는 날들 + 오늘은 날짜별로(월 단위가 안 될 때 대비)
  const range = listRange(from, to); ({ from, to } = range); const months = range.months;
  const today = new Date(); const days = new Set([`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}|${today.getDate()}`]);
  for (const t of env.store.list()) for (const l of [t.gwApply, t.gwReport]) if (l && l.ym && l.day) days.add(`${l.ym}|${Number(l.day)}`);
  let user = env.cfg.gwUser || null;
  const t0 = Date.now();
  const readUser = async () => {   // 회계단위·부서·사원 코드: 화면 세션에서, 없으면 품의서입력 머리 칸에서 한 번 읽어 저장 (목록은 항상 API)
    let u = await gw.apiUser();
    if (!u) { await gw.ensureLogin(); const pr = await gw.readProfile(); if (pr.coCd && pr.deptCd && pr.empCd) u = { coCd: pr.coCd, deptCd: pr.deptCd, empCd: pr.empCd }; }
    if (u) env.store.saveConfig({ gwUser: u });
    return u;
  };
  try {
    if (!user) user = await readUser();
    if (!user) throw new Error('사용자 정보(회계단위·부서·사원 코드)를 못 읽었어요');
    let rows;
    const inRange = r => { const d = `${r.ym}-${String(r.day).padStart(2, '0')}`; return d >= from && d <= to; };
    try { rows = (await gw.apiBudgetRows(user, { months, days: [...days] })).filter(inRange); }
    catch (e) {   // 세션 만료 등 → 로그인하고 한 번 더
      env.log(`(API 조회 실패: ${String(e.message).slice(0, 100)} — 로그인 확인 후 다시)`);
      await gw.ensureLogin(); user = await readUser(); if (!user) throw e;
      rows = (await gw.apiBudgetRows(user, { months, days: [...days] })).filter(inRange);
    }
    const docs = await attachApprovalDocs(gw, rows, env.log, { from, to });
    env.log(`API 로 품의 ${rows.length}건 읽음 (${((Date.now() - t0) / 1000).toFixed(1)}초, 삭제 가능 ${rows.filter(r => !r.locked).length}건)`);
    if (env.debugDir) await gw.diagApprovalList().catch(() => {});
    if (env.debugDir) await gw.diagReportFlow().catch(() => {});
    if (env.debugDir) await gw.diagResolutionInput().catch(() => {});   // 한 번만: 결의서입력 화면 구조 기록 (보고서 3단계 개발용, 읽기만)   // 한 번만: 결의서전송 화면 구조 기록 (보고서 자동화 개발용, 읽기만)   // 한 번만(파일 없을 때): 전자결재 상신문서 목록 API 기록 (결재양식으로 출장 판별하기 위함, 10초쯤)
    return { rows, reportDocs: reportDocsOf(docs), via: 'api', ms: Date.now() - t0 };
  } catch (e) {
    try { require('fs').mkdirSync(env.debugDir, { recursive: true }); require('fs').appendFileSync(require('path').join(env.debugDir, 'api-error.log'), `${new Date().toISOString()} ${e.message}\n`); } catch (e2) { /* */ }
    throw new Error(`품의 목록을 API 로 못 읽었어요: ${String(e.message).slice(0, 160)}`);   // 화면 읽기로 후퇴하지 않는다 (느리고 불안정)
  }
}

/** 뒤에서 조용히: 정산 결의를 전송한 출장의 환원이 빠지지 않았는지 결의서전송 창에서 확인하고, 빠졌으면 [환원]만 다시 (출장마다 한 번, 세 번 실패하면 그만) */
async function runRefundCheck(env) {
  const todo = env.store.list().filter(t => t.resolutionNo && !t.refundChecked && t.gwApply);
  if (!todo.length) return { checked: 0 };
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  let n = 0;
  for (const t of todo) {
    const rec = env.store.load(t.id);
    if ((rec.refundCheckTries || 0) >= 3) continue;
    env.log(`정산 점검: ${t.reason || t.title} (결의 ${t.resolutionNo}) 환원 확인`);
    try { if (await gw.repairRefund(t.gwApply)) { rec.refundChecked = new Date().toISOString(); n++; } }
    catch (e) { rec.refundCheckTries = (rec.refundCheckTries || 0) + 1; env.log(`(환원 점검 실패: ${e.message} — 다음에 다시 확인해요)`); }
    env.store.save(t.id, rec);
  }
  return { checked: n };
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

module.exports = { listRange, runRefundCheck, runProfile, runLoadReport, planApply, runFare, runApply, runPurchase, runPurchaseList, reportDraft, runReport, runLogin, runListBudget, runDeleteBudget, runDeleteTrip };
