'use strict';
// 화면(렌더러)에서 부르는 작업 흐름. 브라우저 창과 사람 확인(ui)은 main.js 가 넣어준다.

const path = require('path');
const R = require('./rules');
const { Amaranth } = require('./gw');
const AI = require('./ai');
const { lookupFare, carBasis } = require('./naver');
const { searchPlaces } = require('./places');
const { applyPayload, reportPayload, puiPayload, purchasePayload, visitorPayload } = require('./editorFill');

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

/** 최근 조회값(30일): 자차는 지금 설정한 내 차 기준(차종·연료)으로 조회한 것만 — [자동 작성]도 같은 기준 */
const cachedFare = (store, cfg, mode, from, to) => { const c = store.getFare(mode, from, to); return c && (mode !== 'car' || c.basis === carBasis({ type: cfg.carType, fuel: cfg.carFuel })) ? c : null; };
async function runFare(env, { mode, to, from, place = null, fuelOnly = false }) {
  const { cfg, store, ui, log } = env;
  if (mode !== 'car' && mode !== 'transit') return { total: 0, describe: '법인차량은 교통비를 자동 계산하지 않습니다.' };
  if (!to) throw new R.InputError('도착지를 입력해 주세요.');
  const origin = from || cfg.defaultOrigin;
  if (!origin) throw new R.InputError('출발지가 없어요. 설정의 기본 출발지나 교통·경비의 출발지를 넣어 주세요.');
  const cached = cachedFare(store, cfg, mode, origin, to);
  if (cached && !env.force) { log(`교통비(최근 조회값): ${cached.describe}`); return { ...cached, source: 'cache' }; }   // 자차는 연비 8km/L 로 조회한 값만
  const shot = path.join(store.tripsDir, '_fare', `교통비_${mode}_${Date.now()}.png`);
  const r = await lookupFare({ makeWindow: env.makeNaverWindow, mode, origin, dest: to, shotPath: shot, ui, log, debugDir: env.debugDir, creds: env.creds, car: { type: cfg.carType, fuel: cfg.carFuel },
    destPlace: place, fuelOnly: Boolean(fuelOnly) && mode === 'car', places: env.naverKeys ? q => searchPlaces(q, { keys: env.naverKeys, fetch: env.fetch }) : null });
  if (r.source !== 'manual') store.putFare(mode, origin, to, r);   // 사람이 직접 넣은 값은 다음 출장에 '최근 조회값'(증빙)으로 쓰지 않는다
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
  await gw.fillAndKeep(popup, { title: pu.title, probe: '구매목적', payload: purchasePayload(pu, { shotDataUrl }), attachments: [pu.file, shotDataUrl && pu.link.shot].filter(Boolean), save: false,   /* 캡처 파일이 지워졌으면(예전 기록 다시 불러오기) 첨부에서 빼야 파일 넣기가 안 막힘 */
    beforeShow: () => gw.addRecipients(popup, R.PURCHASE_RECIPIENTS, { withDept: true }) });   // 수신및참조까지 다 넣고 나서 창을 띄움
  env.store.addPurchase({ title: pu.title, created: new Date().toISOString(), data, total: pu.total, vendor: pu.vendor.name, items: pu.items.length });   // 다시 불러오기·목록용
  return { title: pu.title };
}

/** 외부 방문객 내부 공간 출입 신청서: 결재작성 › 양식을 열어 본문·수신및참조(경영지원부)를 채운다. 결재선·[상신]은 사람이 */
async function runVisitor(env, data) {
  const { cfg, ui, log } = env;
  const v = R.parseVisitor(data);
  log(`[방문객 신청] 유형 ${v.type} · ${v.title}`);
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui, log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  const popup = await gw.openForm(R.VISITOR_FORM);
  await gw.fillAndKeep(popup, { title: v.title, probe: '방문자 성명', payload: visitorPayload(v), save: false,
    beforeShow: () => gw.addRecipients(popup, R.VISITOR_RECIPIENTS) });
  const steps = R.VISITOR_LINES[v.type];
  const after = v.type === 'A' ? [] : [`결재 완료되면 앱의 '신청한 방문'에서 신청서와 보안 준수 서약서(${v.count}부)를 인쇄해요. 신청서는 경영지원부에 내고 방문증을 받고, 서약서는 방문객 각자에게 서명을 받아 출입증을 반납할 때 내요.`];
  await gw.showNote(popup, { title: `유형 ${v.type} 결재선 — 직접 지정하고 [상신]`, steps,
    lines: [v.type === 'C' ? '방문 사무실 사업부서장을 꼭 추가해요.' : '', '앱은 결재선을 넣지 않아요.', ...after].filter(Boolean) }).catch(e => log(`(결재선 안내 못 띄움: ${e.message})`));
  log(`결재선: ${steps.join(' → ')} (최종). 작성 창에서 직접 지정하고 [상신]을 눌러 주세요.`);
  for (const a of after) log(a);
  return { title: v.title };
}

/** 신청한 방문 목록: 그룹웨어 결재 문서(양식 '외부 방문객…'). 결재 끝난 문서는 본문에서 인원·서약서 대상(B·C) 여부를 읽음 */
async function runVisitorList(env, { from = '', to = '' } = {}) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  const r = listRange(from, to);
  const docs = (await gw.apiApprovalDocs(r.from.replace(/-/g, ''), r.to.replace(/-/g, ''))).filter(d => d.form === R.VISITOR_FORM);
  const rows = [];
  for (const d of docs) {
    let info = null;
    if (/완료|종결/.test(d.status)) try { info = await gw.apiVisitorDoc(d.docId, d.formId); } catch (e) { env.log(`(본문 못 읽음 ${d.docNo}: ${String(e.message).slice(0, 80)})`); }
    rows.push({ docId: d.docId, formId: d.formId, docNo: d.docNo, title: d.title, status: d.status, date: d.date, count: info ? info.count : 0, pledge: info ? info.pledge : null });
  }
  env.log(`방문객 신청서 ${docs.length}건`);
  return { rows, from: r.from, to: r.to };
}

/** 신청한 구매의뢰 목록: 그룹웨어 결재 문서(양식 '구매의뢰서') + 이 PC 기록(아직 상신 안 한 것) */
async function runPurchaseList(env, { from = '', to = '' } = {}) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  const r = listRange(from, to);
  const nz = x => String(x || '').replace(/\s/g, '');
  let docs = [];
  try { docs = (await gw.apiApprovalDocs(r.from.replace(/-/g, ''), r.to.replace(/-/g, ''))).filter(d => d.form === R.PURCHASE_FORM); }
  catch (e) { env.log(`(결재 문서 목록 못 읽음: ${String(e.message).slice(0, 120)})`); }
  let mine = []; try { mine = env.store.purchases(); } catch (e) { env.log(`(${e.message})`); }
  // 결재 문서 ↔ 이 PC 기록: 전에 맞춘 문서번호가 있으면 그것, 없으면 같은 제목이면서 문서 날짜 이전에 만든 기록 중 가장 최근 것 (한 기록은 한 문서에만)
  const used = new Set();
  // 문서번호 없는 문서는 번호로 맞추지 않음 ('' 끼리 같다고 보면 엉뚱한 기록이 붙음)
  const pick = d => (d.docNo && mine.find(m => m.docNo === d.docNo)) || mine.filter(m => !m.docNo && !used.has(m) && nz(m.title) === nz(d.title) && String(m.created).slice(0, 10) <= String(d.date || '9999'))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)))[0] || null;
  const localOf = new Map();
  for (const d of [...docs].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {   // 오래된 문서부터 맞춰야 예전 기록이 예전 문서로
    const m = pick(d); if (!m) continue; used.add(m); localOf.set(d, m);
    if (!m.docNo && d.docNo) try { env.store.linkPurchase(m.created, d.docNo); } catch (e) { /* 다음에 다시 맞춤 */ }
  }
  const rows = docs.map(d => ({ docNo: d.docNo, title: d.title, status: d.status, date: d.date, local: localOf.get(d) || null }));
  for (const m of mine) if (!rows.some(x => x.local === m)) rows.push({ docNo: m.docNo || '', title: m.title, status: '', date: m.created.slice(0, 10), local: m });   // 작성 창만 열고 아직 상신 안 함 (문서번호가 있으면 조회 기간 밖)
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
    trip_id: id, reason: a.reason, name: cfg.name, companions: a.companions,   // 출장구분(category)은 넣지 않음 — 사람이 고름 (기본값 로봇을 모르고 올렸음, 사용자 요청 2026-11-10)
    project: a.project || '', destination: a.destination, visit_org: a.destination.replace(/\s*\([^)]*\)\s*$/, ''),   // 방문기관 = 출장지에서 (주소) 뺀 이름
    period: `${a.start.replace(/-/g, '.')}${a.start_time ? ' ' + a.start_time : ''} - ${a.end.replace(/-/g, '.')}${a.end_time ? ' ' + a.end_time : ''}`,
    purpose: a.purpose, report: '',
    schedule: days.map(date => ({ date, place: a.destination, detail: '' })),
    transport: a.transport ? { mode: a.transport.mode, from: a.transport.from || '', to: a.transport.to || '', place: a.transport.place || (r.fare && r.fare.place && r.fare.place.lng ? r.fare.place : null) } : null,
    // 자차 유류비는 초안에 넣지 않는다 — 보고서 화면이 네이버 지도로 유류대를 새로 조회해 넣고 그 캡처를 증빙으로 붙인다 (app.js lookupFuel).
    // 신청 금액(유류비+통행료)을 넣어 두면 조회가 안 될 때 영수증 없는 통행료가 그대로 청구됐음 (사용자 확인 2026-11-10)
    // 그 밖의 줄(대중교통·식대·숙박)은 신청 금액을 자리만 잡아 둔다: 증빙이 없어 영수증을 붙이기 전엔 정산에 안 들어감. 교통비는 여유분을 빼고
    expenses: (r.expenses || a.expenses).filter(e => !(e.item === 'domestic_transport' && (a.transport || {}).mode === 'car')).map(({ item, amount, memo }) => {
      if (item !== 'domestic_transport') return { item, amount, memo, proofs: [] };
      const margin = /\+ 여유 ([\d,]+)원/.exec(memo || '');
      return { item, amount: r.fare && r.fare.total ? r.fare.total : margin ? Math.max(0, amount - Number(margin[1].replace(/,/g, ''))) : amount, memo: String(memo || '').replace(/ \+ 여유 [\d,]+원/, ''), proofs: [] };
    }),
    attachments: [],
  };
}

/** 보고서 경비 → 채주로 넣을 줄 (날짜 채우기 → 식대 규정 한도 → 같은 날 식대 한 줄 → 날짜순). 보내기 전 확인 화면도 이걸로 보여 줘서 실제와 같게 */
function settleLines(rep, cfg, log = () => {}) {
  const usedOn = (/(\d{4})[.-](\d{2})[.-](\d{2})/.exec(rep.period) || []).slice(1).join('-');   // 출장 시작일 (법인카드 자금계획일 기준)
  // 같은 날 식대 영수증 여러 장 → 채주 한 줄 (영수증 날짜 필드로. 직접 쓴 줄은 적요 앞 "10/20" + 출장 연도)
  const year = usedOn.slice(0, 4) || String(new Date().getFullYear());
  const startM = Number(usedOn.slice(5, 7)) || 0;
  const endY = Number(([...String(rep.period).matchAll(/(\d{4})[.-]\d{2}[.-]\d{2}/g)].pop() || [])[1]) || +year;   // 기간 끝 날짜의 해
  const endM = Number(([...String(rep.period).matchAll(/\d{4}[.-](\d{2})[.-]\d{2}/g)].pop() || [])[1]) || 12;   // 기간 끝 달 (해를 넘긴 출장에서 1월 영수증만 다음 해 — 12/30~1/2 출장의 '11/20 예매' 는 그해)
  const noProof = rep.expenses.filter(e => !R.claimable(e, rep.transport_mode));
  noProof.forEach(e => log(`${e.memo || e.item} ${Number(e.amount).toLocaleString('ko-KR')}원: 영수증이 없어 정산에서 뺌`));
  const dated = rep.expenses.filter(e => R.claimable(e, rep.transport_mode)).map(e => R.vehicleItem(e, rep.transport_mode)).map(e => { if (e.date) return e; const m = /^(\d{1,2})\/(\d{1,2})\b/.exec(e.memo || ''); const y = m && startM && +m[1] < startM && endY > +year && +m[1] <= endM ? +year + 1 : year;   // 12/30~1/2 출장의 '1/1' 은 다음 해 (해를 넘긴 출장일 때만 — 10월 출장의 '9/28' 예매 영수증은 그해)
    const d = m ? `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
    return { ...e, date: d && !isNaN(Date.parse(`${d}T00:00:00`)) && new Date(`${d}T00:00:00`).getDate() === +m[2] ? d : '' }; });   // '10/32' 같은 오타는 날짜 없음으로   // 날짜는 AI 가 읽은 필드 우선, 없으면(직접 쓴 줄) 적요 앞 M/D
  const capped = R.capMealRows(dated, cfg.rates);
  capped.filter(e => e.capped).forEach(e => log(`${e.memo}: ${e.paid.toLocaleString('ko-KR')}원 → 식대 규정 한도 ${e.amount.toLocaleString('ko-KR')}원으로 조정`));
  const merged = R.mergeMealRows(capped).sort((a, b) => (a.date || '').localeCompare(b.date || ''));   // 품의 한도는 앞 날짜부터 채움 (뒤 날짜가 깎이거나 빠짐)
  merged.filter(e => e.dup).forEach(e => log(`${e.date} 식대 ${e.dup}건 → 채주 한 줄로 묶음 (${e.amount.toLocaleString('ko-KR')}원, 증빙 ${e.proofs.length}개)`));
  return merged.map(e => ({ item: e.item, kind: e.kind || '', dup: e.dup || 0, label: e.label, pay: e.pay, noVat: e.noVat, amount: e.amount, date: e.date, supply: R.supplyAmount(e.amount, e.pay, e.noVat), vat: R.vatAmount(e.amount, e.pay, e.noVat), memo: e.memo, planDate: R.fundPlanDate(e.pay, { usedOn: e.date || usedOn }) /* 법인카드: 그 영수증을 쓴 달 기준 (10/30~11/2 출장의 11/1 영수증 = 12/23) */, proofs: e.proofs || [] }));
}

/** 출장보고서(정산). 새 품의를 만들지 않고, 승인된 신청 품의로 지출 결의를 한다 (사용자가 알려 준 회사 절차):
 *  품의서승인(복수) → 신청 품의 체크 → [결의서전송/취소] → 지출 결의서·집행용도 → 예산 줄 결제수단·과세구분 → 채주내역(영수증마다) → [환원]
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
  const lines = settleLines(rep, cfg, log);
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
  // 3~4단계: 결의서입력 → [결재상신] → 결재양식 '출장보고서 및 경비정산 지출 결의서' → 출장보고서 본문. [상신]은 사람이
  const title = R.reportTitle(rep.reason);
  const opened = await gw.openResolution(resNo);
  if (opened && opened.submitted) {   // 지난번에 [상신]까지 끝낸 결의: 다시 올릴 게 없다 (전엔 '이미 결재진행 상태' 오류로만 끝나 뭘 해야 할지 몰랐음 — 2026-11-06)
    log(`이 출장의 보고서 결의(${resNo})는 이미 결재상신돼 '${opened.status}' 이에요${opened.docNo ? ` (문서번호 ${opened.docNo})` : ''}. 그룹웨어 전자결재에서 진행 상황을 확인해 주세요.`);
    if (rec) { try { const r2 = store.load(rep.trip_id); r2.reportStatus = `보고 ${opened.status}${opened.docNo ? `(${opened.docNo})` : ''}`; store.save(rep.trip_id, r2); } catch (e) { /* */ } }
    return { resolutionNo: resNo, submitted: true, status: opened.status, docNo: opened.docNo };
  }
  const popup = await gw.openApproval(R.REPORT_FORM, title, { category: '결의서입력' });
  await gw.fillAndKeep(popup, { title, probe: '출장일시', payload: reportPayload(rep), attachments: [], save: false });   // 영수증은 채주 첨부로 이미 결재 문서에 딸려 온다 → 다시 안 올림
  if (rec) { try { const r2 = store.load(rep.trip_id); r2.reportStatus = '보고서 작성 창 열림(상신 전)'; store.save(rep.trip_id, r2); } catch (e) { /* */ } }
  log('출장보고서 작성 창을 띄웠어요. 결재라인 확인하고 [상신]은 직접 눌러 주세요.');
  return { resolutionNo: resNo };
}

/** 지출 결의(개인카드/개인지출): 승인 품의 하나를 골라 결의서전송 창에 지출 결의서·채주·환원까지 채우고 멈춘다.
 *  [전송]은 사람이 (새 금전 유형이라 전송 전 확인). 세금계산서·법인카드·결재상신은 다음 단계. */
async function runSettle(env, data) {
  const { cfg, ui, log } = env;
  const s = R.parseSettle(data);
  const payee = cfg.name;
  if (!payee) throw new R.InputError('그룹웨어 이름을 몰라요. 설정에서 그룹웨어에 로그인해 내 정보를 불러와 주세요.');
  log(`[지출 결의] 품의 ${s.pui.ym}-${s.pui.day} 순번 ${s.pui.seq} · ${s.purpose}`);
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui, log, debugDir: env.debugDir, creds: env.creds });
  await gw.ensureLogin();
  // 출장 보고와 같은 길 (사용자 2026-11-16): 결의서전송(채주·환원·[전송]) → 결의서입력 → [결재상신] → 결의서 작성 창
  await gw.openApprovedBudget(s.pui);
  const st = await gw.settleTransfer({ purpose: s.purpose, payee, fund: s.fund, lines: s.lines });
  const resNo = st && st.resNo ? st.resNo : st && st.ok ? await gw.transferResolution() : '';   // 채주 저장 확인이 안 됐으면 보내지 않는다
  if (!resNo) { env.showGw(); await ui.pause('[전송]을 하지 않았어요. 결의서전송 창에서 채주·첨부·환원을 확인하고 직접 [전송]한 뒤 [계속]을 눌러 주세요. 결의서입력부터는 다시 [그룹웨어에 지출 결의서 채우기]를 누르면 이어서 해요.'); return {}; }
  const opened = await gw.openResolution(resNo);
  if (opened && opened.submitted) { log(`이 결의(${resNo})는 이미 결재상신돼 '${opened.status}' 이에요${opened.docNo ? ` (문서번호 ${opened.docNo})` : ''}.`); return { resolutionNo: resNo, submitted: true }; }
  const popup = await gw.openApproval('', s.title || s.purpose, { category: '결의서입력' });   // 양식은 그룹웨어가 고른 그대로
  popup.setSkipTaskbar(false); popup.center(); popup.show(); popup.focus();
  log('지출 결의서 작성 창을 띄웠어요. 본문·결재선 확인하고 [상신]은 직접 눌러 주세요.');
  return { resolutionNo: resNo };
}

/** 지출 품의 올리기 (지출 결의 앞 단계): 품의·예산 줄 → [결재상신] 양식·제목 → 본문 → [보관].
 *  결재선·[상신]은 사람이 — 결재선이 복사로 안 따라와 기본값으로 상신되면 회수해야 함 */
async function runPui(env, data) {
  const { cfg, ui, log } = env;
  if (!cfg.budgetDept) throw new R.InputError('설정에서 예산 부서를 골라 주세요. (그룹웨어에 로그인하면 목록을 받아와요)');
  const p = R.parsePui(data);
  log(`[지출 품의] ${p.title}`);
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: cfg.baseUrl, ui, log, debugDir: env.debugDir, creds: env.creds });
  try {
    await gw.ensureLogin();
    await gw.enterBudget(cfg.budgetDept, p.lines, { memo: p.memo });
    const popup = await gw.openApproval(R.PUI_FORM, p.title);
    await gw.fillAndKeep(popup, { title: p.title, probe: '1. 품의목적', payload: puiPayload(p), attachments: [...p.files, ...p.proofs] });
  } catch (e) { await abort(env, gw); throw e; }
  return { seq: gw.lastBudget ? gw.lastBudget.seq : '' };
}

/** usd 가 있는 줄을 그날(from) 수출입은행 매매기준율로 원화로 + 조회 결과 이미지 (해외출장과 같은 증빙) */
async function usdToWon(env, lines, from = new Date()) {
  const FX = require('./fx');
  const r = await FX.usdRate(env.fxKey, { from, fetch: env.fetch });
  const shot = await FX.saveProof(r, path.join(env.store.tripsDir, '_fx', `환율_USD_${r.date}_${Date.now()}.png`));
  env.log(`USD → 원화: ${r.date} 매매기준율 ${r.rate}원`);
  return { fx: { rate: r.rate, date: r.date, shot },
    lines: lines.map(l => l.usd === '' || l.usd == null ? l : { ...l, amount: Math.round(Number(l.usd) * r.rate) }) };   // 환율은 적요가 아니라 본문 지출 세부내역에
}


/** 예산과목 목록만 (화면 드롭다운용) */
async function runBudgetItems(env) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  return { items: await budgetItems(env, gw) };
}

/** 회사 예산과목 목록 [{code, name, path}] — 그룹웨어 API 로 (못 받으면 지난번 목록) */
async function budgetItems(env, gw) {
  const year = String(new Date().getFullYear()), cfg = env.store.config();
  let items = [];
  try {
    const user = cfg.gwUser || await gw.apiUser();
    if (!user) throw new Error('사용자 정보(회계단위·부서·사원 코드)를 못 읽었어요');
    let gisu = cfg.gisuOf && cfg.gisuOf.year === year ? cfg.gisuOf.gisu : '';   // 기수는 해마다 바뀜 → 그해 처음 한 번만 화면에서 읽음
    if (!gisu) { gisu = await gw.readGisu(); if (gisu) env.store.saveConfig({ gisuOf: { year, gisu } }); }
    if (!gisu) throw new Error('품의서입력 화면에서 회계 기수를 못 읽었어요');   // 기수 없이 부르면 빈 목록이 옴
    items = await gw.apiBudgetItems(user, gisu);
  } catch (e) { env.log(`(예산과목 목록을 못 읽었어요: ${e.message})`); }
  if (items.length) env.store.saveConfig({ budgetItems: items });
  else items = cfg.budgetItems || [];   // 못 읽으면 지난번 목록
  env.log(`예산과목 목록 ${items.length}개`);
  return items;
}

/** 청구서 및 견적서 + 한 줄 메모 → 지출 품의 칸. 비슷한 이전 품의의 예산 줄을 틀로, 없으면 회사 예산과목 목록에서 AI 가 고름.
 *  USD 청구서는 청구일 수출입은행 매매기준율로 원화 환산하고 그 조회 결과 이미지를 증빙으로 (해외출장과 같음) */
async function runPuiDraft(env, memo, invoices, prev = null) {
  if (!env.ai) throw new R.InputError('한 줄 입력은 AI 가 있어야 해요. 설정 › AI 문장 작성에서 Gemini 를 골라 주세요. (직접 입력은 그대로 돼요)');
  if (!memo) throw new R.InputError('무엇에 쓰려고 사는지 한 줄 적어 주세요.');
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  let lines = [], tpl = null;
  if (prev && (prev.lines || []).length) {   // 매달 알림으로 다시 쓰는 품의: 지난번 예산과목·제목을 틀로 (금액·날짜는 새 청구서에서)
    lines = prev.lines.map(l => ({ code: String(l.code || ''), label: String(l.label || ''), amount: '', memo: String(l.memo || '') }));
    env.log(`틀: 지난번 품의 (${prev.title || prev.memo || ''})`);
  } else {
    const { rows } = await runSettleApprovals(env, { all: true });
    tpl = rows[await AI.pickPui(env.ai, memo, rows)] || null;
  }
  if (tpl) {
    env.log(`틀: ${tpl.ym}-${tpl.day} 순번 ${tpl.seq} · ${tpl.docTitle || tpl.memo}`);
    try { lines = await gw.budgetLines(tpl.key); } catch (e) { env.log(`(이전 품의 줄을 못 읽었어요: ${e.message})`); }
  }
  const items = await budgetItems(env, gw);
  env.log('청구서 및 견적서 읽고 칸 채우는 중');
  const d = await AI.draftPui(env.ai, memo, { lines, items, title: tpl ? tpl.docTitle || '' : (prev && prev.title) || '', invoices });
  env.log(`예산과목: ${d.lines.map(l => l.code ? `${l.label}(${l.code})` : '(못 고름)').join(', ') || '-'}`);
  d.title = R.puiTitle(d.subject, d.lines.map(l => l.date).filter(Boolean).sort().pop() || new Date());   // 연월은 청구서 날짜 기준
  // 줄마다 청구 통화: USD 는 원화로, 그 밖의 외화는 사람이 (금액 비움)
  const other = d.lines.filter(l => l.currency !== 'KRW' && l.currency !== 'USD');
  if (other.length) env.log(`${[...new Set(other.map(l => l.currency))].join(', ')} 청구서는 원화 금액을 직접 넣어 주세요.`);
  d.lines = d.lines.map(l => l.currency === 'USD' && l.amount !== '' ? { ...l, usd: l.amount } : l.currency === 'KRW' ? { ...l, amount: l.amount === '' ? '' : Math.round(l.amount) } : { ...l, amount: '' });
  let fx = null;
  if (d.lines.some(l => l.usd !== '' && l.usd != null)) {   // ponytail: 외화 청구서가 여러 장이면 가장 늦은 청구일 환율 하나로 — 장마다 다른 환율이 필요하면 줄별로
    const last = d.lines.filter(l => l.usd !== '' && l.usd != null).map(l => l.date).filter(Boolean).sort().pop();
    ({ lines: d.lines, fx } = await usdToWon(env, d.lines, last ? new Date(`${last}T12:00:00`) : new Date()));
  }
  return { ...d, fx, items, from: tpl ? `${tpl.ym}-${String(tpl.day).padStart(2, '0')} 순번 ${tpl.seq} · ${tpl.docTitle || tpl.memo}` : '' };
}

/** 기간 안의 승인완료 '품의서입력(복수)지출' 품의, 최근 것부터. all: 상태 무관 — 새 품의 틀용 */
async function runSettleApprovals(env, { from = '', to = '', all = false } = {}) {
  const gw = new Amaranth({ win: env.gwWindow(), baseUrl: env.cfg.baseUrl, ui: env.ui, log: env.log, debugDir: env.debugDir, creds: env.creds });
  const range = listRange(from, to); ({ from, to } = range); const months = range.months;
  const today = new Date(); const days = new Set([`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}|${today.getDate()}`]);
  let user = env.cfg.gwUser || null;
  if (!user) {
    let u = await gw.apiUser();
    if (!u) { await gw.ensureLogin(); const pr = await gw.readProfile(); if (pr.coCd && pr.deptCd && pr.empCd) u = { coCd: pr.coCd, deptCd: pr.deptCd, empCd: pr.empCd }; }
    if (u) { env.store.saveConfig({ gwUser: u }); user = u; }
  }
  if (!user) throw new Error('사용자 정보(회계단위·부서·사원 코드)를 못 읽었어요');
  const inRange = r => { const d = `${r.ym}-${String(r.day).padStart(2, '0')}`; return d >= from && d <= to; };
  let rows;
  try { rows = (await gw.apiBudgetRows(user, { months, days: [...days] })).filter(inRange); }
  catch (e) { env.log(`(조회 실패: ${String(e.message).slice(0, 100)} — 로그인 확인 후 다시)`); await gw.ensureLogin(); rows = (await gw.apiBudgetRows(user, { months, days: [...days] })).filter(inRange); }
  rows = rows.filter(r => r.kind === '지출' && (all || /완료|종결/.test(r.status)));   // 승인 = '결재완료'(approState 1). '승인완료'만 보면 실제 목록에서 하나도 안 걸렸음
  // 품의 목록 API 엔 결재양식이 없다 (출장 신청 품의도 품의구분 '지출') → 결재문서 양식을 문서번호로 붙인다. 상신 전(문서번호 없음)은 양식을 몰라 뺌
  const docs = await attachApprovalDocs(gw, rows, env.log, range);
  if (!docs.length && rows.some(r => r.docNo)) throw new Error('결재문서 목록을 못 읽어 결재양식을 확인하지 못했어요. 잠시 뒤 다시 불러와 주세요.');
  const approved = rows.filter(r => r.form === R.PUI_FORM).sort((a, b) => `${b.ym}-${String(b.day).padStart(2, '0')}`.localeCompare(`${a.ym}-${String(a.day).padStart(2, '0')}`) || Number(b.seq) - Number(a.seq));
  env.log(`${R.PUI_FORM} 품의 ${approved.length}건${all ? '' : ' (승인완료)'} (${from}~${to})`);
  return { rows: approved, from, to };
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
  const reps = docs.filter(d => d.form === R.REPORT_FORM);   // 목록과 보고서 짝짓기가 어긋날 때 볼 수 있게 남김
  log(`결재 문서 ${docs.length}건 (${r.from} ~ ${r.to}) · 출장보고서 ${reps.length}건${reps.length ? ': ' + reps.slice(0, 5).map(d => `${d.title} [${d.status} ${d.date}]`).join(' / ') : ''}`);
  const byNo = Object.fromEntries(docs.filter(d => d.docNo).map(d => [d.docNo, d]));
  for (const r of rows) {
    const d = r.docNo && byNo[r.docNo];
    if (d) { r.form = d.form; r.docTitle = d.title; r.docStatus = d.status; r.docId = d.docId; r.formId = d.formId; r.trip = /출장\s*신청/.test(d.form) ? 'apply' : /출장\s*보고/.test(d.form) ? 'report' : ''; }
    else r.trip = /출장\s*보고/.test(r.memo || '') ? 'report' : /출장/.test(r.memo || '') ? 'apply' : '';
  }
  return docs;
}
/** 결의서입력에서 올린 출장보고서 결재 문서 (양식 '출장보고서 및 경비정산 지출 결의서') — 목록에서 보고 진행 상태를 보여 주는 데 씀 */
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
  const expenses = lines.filter(l => l.amount > 0).map(l => { const hit = byLabel.find(([, [code, label]]) => l.code === code || l.label.includes(label) || l.label.includes(code));
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
  const patch = { budgetDepts: depts, profileOf: env.store.config().lastLoginId || env.store.config().gwId || '' };   // 어느 계정의 정보인지 (다른 계정으로 로그인하면 다시 불러옴)
  if (me.empName && (force || !cfg.name)) patch.name = me.empName;
  if (me.deptName && (force || !cfg.budgetDept)) patch.budgetDept = me.deptName;
  if (me.coCd && me.deptCd && me.empCd) patch.gwUser = { coCd: me.coCd, deptCd: me.deptCd, empCd: me.empCd };
  store.saveConfig(patch);
  await budgetItems(env, gw);
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
    // 개발 중에만 (env.dev): 배포본에도 debugDir 은 있어 진단이 실제 승인 화면의 품의를 체크하고 [결의서전송/취소]를 눌렀음 (2026-11-10)
    if (env.dev && env.debugDir) await gw.diagApprovalList().catch(() => {});
    if (env.dev && env.debugDir) await gw.diagReportFlow().catch(() => {});
    if (env.dev && env.debugDir) await gw.diagResolutionInput().catch(() => {});   // 한 번만: 결의서입력 화면 구조 기록 (보고서 3단계 개발용, 읽기만)   // 한 번만: 결의서전송 화면 구조 기록 (보고서 자동화 개발용, 읽기만)   // 한 번만(파일 없을 때): 전자결재 상신문서 목록 API 기록 (결재양식으로 출장 판별하기 위함, 10초쯤)
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

module.exports = { cachedFare, settleLines, listRange, runRefundCheck, runProfile, runLoadReport, planApply, runFare, runApply, runPurchase, runVisitor, runVisitorList, runPurchaseList, reportDraft, runReport, runSettle, runSettleApprovals, runPui, runPuiDraft, runBudgetItems, runLogin, runListBudget, runDeleteBudget, runDeleteTrip };
