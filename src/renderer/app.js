'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let META = {items:{}, config:{}};
let currentTrip = null;
let reportAttachments = [];
let fareShot = "";

async function rpc(path, body){
  return window.api.call(path, body === undefined ? {} : body);
}
const won = n => (Number(n)||0).toLocaleString('ko-KR') + '원';
const num = s => Number(String(s||'').replace(/[^\d]/g,'')) || 0;
const radio = name => (document.querySelector(`input[name=${name}]:checked`)||{}).value;
const setRadio = (name, v) => { const el = document.querySelector(`input[name=${name}][value="${v}"]`); if(el) el.checked = true; };
const list = s => String(s||'').split(',').map(x=>x.trim()).filter(Boolean);

/* ---------- 탭 ---------- */
$$('nav button').forEach(b => b.onclick = () => {
  $$('nav button').forEach(x => x.classList.toggle('on', x===b));
  ['apply','trips','settings'].forEach(t => $('#tab-'+t).classList.toggle('hidden', t!==b.dataset.tab));
  if(b.dataset.tab==='trips'){ $('#tripList').classList.remove('hidden'); $('#reportView').classList.add('hidden'); loadTrips(); autoGwCheck(true); }   // 탭에 들어올 때마다 그룹웨어에서 다시 읽기 (저장된 목록은 먼저 보여줌)
});

/* ---------- 경비 표 ---------- */
function expRow(tbody, e={}, onchange){
  const tr = document.createElement('tr');
  const tid = tbody.closest('table').id;   // a_exp(신청) / r_exp(보고)
  const opts = Object.entries(META.items).filter(([k]) => tid!=='a_exp' || k!=='domestic_transport')
    .map(([k,v]) => `<option value="${k}">${v.replace('여비교통비(판)_','')}</option>`).join('');
  const proofCell = tid === 'r_exp' ? '<td class="proof"><button class="btn small add">+ 증빙 첨부</button><div class="files"></div></td>' : '';
  tr.innerHTML = `<td><select>${opts}</select></td><td><input inputmode="numeric"></td><td><input placeholder="비우면 자동"></td>${proofCell}<td><button class="btn small del">✕</button></td>`;
  const [sel, amt, memo] = tr.querySelectorAll('select,input');
  if(proofCell){   // 정산 경비 증빙: 줄마다 1개 이상, 전부 보고서 첨부로 올라감
    let proofs = (e.proofs || []).slice(0, 1);   // 경비 한 줄에 증빙 1개
    const draw = () => {
      const box = tr.querySelector('.files'); box.innerHTML = '';
      if(!proofs.length){ const s = document.createElement('div'); s.className = 'empty'; s.textContent = '증빙 필수 · 영수증 사진이나 PDF'; box.appendChild(s); }
      proofs.forEach((p, i) => {
        const chip = document.createElement('div'); chip.className = 'chip';
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = (/\.pdf$/i.test(p) ? '📄 ' : '🖼️ ') + p.split(/[\\/]/).pop(); nm.title = p + ' (눌러서 열기)'; nm.onclick = () => rpc('/api/open', {path: p});
        const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '✕'; x.title = '빼기'; x.onclick = () => { proofs.splice(i, 1); draw(); };
        chip.append(nm, x); box.appendChild(chip);
      });
      tr.dataset.proofs = JSON.stringify(proofs);
      const add = tr.querySelector('.add'); add.classList.toggle('hidden', proofs.length > 0); add.classList.toggle('need', !proofs.length && num(amt.value) > 0);
    };
    tr.querySelector('.add').onclick = async () => { const {paths} = await rpc('/api/pick-proofs'); if(paths.length){ proofs = [paths[0]]; draw(); } };
    draw();
  }
  sel.value = e.item || (tid==='a_exp' ? 'domestic_lodging' : 'domestic_transport');
  amt.value = e.amount ? Number(e.amount).toLocaleString('ko-KR') : '';
  memo.value = e.memo || '';
  amt.oninput = () => { amt.value = amt.value ? num(amt.value).toLocaleString('ko-KR') : ''; if(tid==='a_exp') autoExp = false; onchange(); if(tr.querySelector('.add')) tr.querySelector('.add').classList.toggle('need', num(amt.value) > 0 && !JSON.parse(tr.dataset.proofs || '[]').length); };
  sel.onchange = memo.oninput = onchange;
  tr.querySelector('.del').onclick = () => { tr.remove(); onchange(); };
  tbody.appendChild(tr); onchange();
}
const readExp = tbody => [...tbody.querySelectorAll('tr')].map(tr => {
  const [sel, amt, memo] = tr.querySelectorAll('select,input');
  const e = {item: sel.value, amount: num(amt.value), memo: memo.value.trim()};
  if(tr.dataset.proofs) e.proofs = JSON.parse(tr.dataset.proofs);
  return e;
}).filter(e => e.amount > 0);

/* ---------- 신청서 ---------- */
function applyData(){
  const mode = radio('a_mode');
  const t = {mode};
  if(mode==='corporate'){ if($('#a_corporate_car').value) t.corporate_car = $('#a_corporate_car').value; }
  else { t.to = $('#a_to').value.trim() || $('#a_destination').value.trim(); t.from = $('#a_from').value.trim(); }
  if($('#a_fare').value) t.total = num($('#a_fare').value);
  if(fareShot) t.screenshot = fareShot;
  return {
    reason: $('#a_reason').value.trim(), destination: $('#a_destination').value.trim(),
    dates: {start: $('#a_start').value, end: $('#a_end').value || $('#a_start').value, start_time: $('#a_start_time').value, end_time: $('#a_end_time').value},
    category: radio('a_category'), project: $('#a_project').value.trim(),
    transport: t, companions: list($('#a_companions').value),
    companion_purpose: $('#a_companion_purpose').value.trim(),
    purpose: $('#a_purpose').value.trim(), expenses: readExp($('#a_exp tbody')),
  };
}
function fillApply(d){
  $('#a_reason').value = d.reason||''; $('#a_destination').value = d.destination||'';
  const dt = d.dates || {start: d.start, end: d.end, start_time: d.start_time, end_time: d.end_time};
  $('#a_start').value = dt.start||''; $('#a_end').value = dt.end||''; $('#a_start_time').value = dt.start_time||''; $('#a_end_time').value = dt.end_time||'';
  setRadio('a_category', d.category||'일반'); $('#a_project').value = d.project||'';
  const t = d.transport||{}; setRadio('a_mode', t.mode||'car');
  $('#a_to').value = t.to||''; if(t.from) $('#a_from').value = t.from;
  $('#a_fare').value = t.total ? Number(t.total).toLocaleString('ko-KR') : ''; fareShot = t.screenshot || ''; $('#a_fare_desc').textContent = '';
  if(t.corporate_car) $('#a_corporate_car').value = t.corporate_car;
  $('#a_companions').value = (d.companions||[]).join(', ');
  $('#a_companion_purpose').value = d.companion_purpose||''; $('#a_purpose').value = d.purpose||'';
  $('#a_exp tbody').innerHTML = '';
  (d.expenses||[]).filter(e=>e.item!=='domestic_transport').forEach(e => expRow($('#a_exp tbody'), e, refreshApply));
  refreshApply();
}
/** 신청서 전체 비우기 ([새로 작성], 그룹웨어 입력이 끝났을 때) */
function resetApply(){
  fillApply({}); autoExp = true; fareShot = '';
  $('#q_memo').value = ''; $('#q_status').textContent = ''; $('#a_err').textContent = '';
  markNeed([]); showMealPlan(null);
}
$('#btnNewApply').onclick = () => { resetApply(); $('#q_memo').focus(); };
let titleTimer;
function refreshApply(){
  const mode = radio('a_mode');
  $('#a_project').classList.toggle('hidden', radio('a_category')!=='연구과제');
  $('#a_cp_row').classList.toggle('hidden', !list($('#a_companions').value).length);
  $('#a_route').classList.toggle('hidden', mode==='corporate');
  $('#a_car_row').classList.toggle('hidden', mode!=='corporate');
  const fare = mode==='corporate' ? 0 : num($('#a_fare').value);
  const sum = readExp($('#a_exp tbody')).reduce((s,e)=>s+e.amount,0) + fare;
  $('#a_total').textContent = won(sum) + (mode!=='corporate' && !fare ? ' + 교통비' : '');
  clearTimeout(titleTimer);
  titleTimer = setTimeout(async () => {
    const r = await rpc('/api/title', {reason: $('#a_reason').value});
    $('#a_title').textContent = r.apply || '사유를 입력하면 표시됩니다';
  }, 250);
}
$$('#tab-apply input, #tab-apply textarea, #tab-apply select').forEach(el => el.addEventListener('input', refreshApply));
$$('#tab-apply input[type=radio]').forEach(el => el.addEventListener('change', refreshApply));
$('#btnAddExp').onclick = () => expRow($('#a_exp tbody'), {}, refreshApply);
$('#a_fare').addEventListener('input', () => { const v=$('#a_fare'); v.value = v.value ? num(v.value).toLocaleString('ko-KR') : ''; fareShot=''; $('#a_fare_desc').textContent='직접 입력'; });

$('#btnPrompt').onclick = async () => {
  const memo = $('#q_memo').value.trim();
  if(!memo){ $('#copied').textContent = '위 "한 줄로 신청" 칸에 출장 메모를 먼저 써 주세요.'; $('#q_memo').classList.add('need'); $('#q_memo').focus(); return; }
  const r = await rpc('/api/prompt', {memo}); await rpc('/api/copy', {text: r.text});
  $('#copied').textContent = '메모까지 포함해 복사됨. AI 채팅에 붙여 넣고 보내세요.';
};
$('#q_memo').addEventListener('input', () => $('#q_memo').classList.remove('need'));
$('#btnFill').onclick = async () => {
  $('#aiErr').textContent = '';
  try { fillApply((await rpc('/api/parse', {text: $('#aiPaste').value})).data); }
  catch(e){ $('#aiErr').textContent = e.message; }
};
function setFare(r, label = ''){
  if(!r || !r.total) return;
  $('#a_fare').value = r.total.toLocaleString('ko-KR'); fareShot = r.screenshot||'';
  $('#a_fare_desc').innerHTML = '<b></b> <span></span> <a href="#">캡처 보기</a>';
  $('#a_fare_desc b').textContent = r.describe; $('#a_fare_desc span').textContent = label;
  $('#a_fare_desc a').onclick = e => { e.preventDefault(); rpc('/api/open', {path: fareShot}); };
  refreshApply();
}
function lookupFare(force){
  const d = applyData();
  if(d.transport.mode==='corporate' || !d.transport.to) return;
  runJob('교통비 조회 (네이버 지도)', '/api/job/fare', {mode: d.transport.mode, to: d.transport.to, from: d.transport.from, force}, r => setFare(r, r && r.source==='cache' ? '(최근 30일 내 조회값)' : ''));
}
$('#btnFare').onclick = () => lookupFare(true);
// 교통편을 바꾸면 이전 교통비는 무효 → 비우고 자동 재조회 (법인차량은 교통비 없음)
$$('input[name=a_mode]').forEach(r => r.addEventListener('change', () => {
  $('#a_fare').value = ''; fareShot = ''; $('#a_fare_desc').textContent = ''; refreshApply();
  lookupFare(false);
}));

/* ---------- 한 줄 자동 작성 ---------- */
let autoExp = true;
async function recalcExpenses(){
  const start = $('#a_start').value, end = $('#a_end').value || start;
  if(!start) return;
  const r = await rpc('/api/expenses', {start, end, start_time: $('#a_start_time').value, end_time: $('#a_end_time').value, reason: $('#a_reason').value.trim()});
  $('#a_exp tbody').innerHTML = '';
  r.expenses.forEach(e => expRow($('#a_exp tbody'), e, refreshApply));
  showMealPlan(r); autoExp = true; refreshApply();
}
function showMealPlan(m){
  $('#a_meal_plan').textContent = m && m.summary ? `식대 내역: ${m.summary}${m.timed ? '' : '  (출발·복귀 시각을 넣으면 첫날·마지막 날 끼니를 정확히 계산해요)'}` : '';
}
['#a_start','#a_end','#a_start_time','#a_end_time'].forEach(id => $(id).addEventListener('change', () => { if(autoExp) recalcExpenses(); }));
$('#btnRecalc').onclick = recalcExpenses;
function markNeed(missing){
  const map = {'날짜': ['#a_start','#a_end'], '출발 시각': ['#a_start_time'], '복귀 시각': ['#a_end_time'], '출장지': ['#a_destination'], '사유': ['#a_reason'], '교통비': ['#a_fare'], '과제명': ['#a_project']};
  $$('.need').forEach(el => el.classList.remove('need'));
  missing.forEach(m => (map[m]||[]).forEach(id => $(id).classList.add('need')));
}
$$('#a_start,#a_end,#a_start_time,#a_end_time,#a_destination,#a_reason,#a_fare,#a_project').forEach(el => ['input','change'].forEach(ev => el.addEventListener(ev, () => el.classList.remove('need'))));
/* 이전에 입력한 한 줄 문장: localStorage 에 최근 30개 */
const HIST_MAX = 30;
const histLoad = () => { try { return JSON.parse(localStorage.q_hist || '[]'); } catch(e){ return []; } };
function histRender(){
  const sel = $('#q_hist'); sel.length = 1;
  histLoad().forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = m.length > 60 ? m.slice(0, 60) + '…' : m; sel.appendChild(o); });
  sel.style.display = sel.length > 1 ? '' : 'none';
}
function histSave(memo){
  try { localStorage.q_hist = JSON.stringify([memo, ...histLoad().filter(m => m !== memo)].slice(0, HIST_MAX)); } catch(e){ /* 저장 공간 없음 */ }
  histRender();
}
$('#q_hist').onchange = () => { if($('#q_hist').value){ $('#q_memo').value = $('#q_hist').value; $('#q_memo').focus(); } $('#q_hist').value = ''; };
histRender();

$('#btnQuick').onclick = async () => {
  const memo = $('#q_memo').value.trim();
  if(!memo){ $('#q_memo').focus(); return; }
  histSave(memo);
  $('#btnQuick').disabled = true; $('#q_status').textContent = '작성 중…';
  try {
    const r = await rpc('/api/quick', {memo});
    fillApply(r.data); autoExp = true; markNeed(r.missing); showMealPlan(r.meals);
    const by = r.source === 'template' ? '템플릿으로 작성' : `${r.source}로 작성`;
    $('#q_status').innerHTML = '';
    const b = document.createElement('b'); b.textContent = by; $('#q_status').append(b,
      r.missing.length ? ` · 확인 필요: ${r.missing.join(', ')} (주황색 칸)` : ' · 내용 확인 후 [그룹웨어에 입력하기]를 누르세요',
      r.note ? ` · ${r.note}` : '', r.source === 'template' && !META.config.aiKeySet ? ' · 설정에서 AI 키를 넣으면 문장이 더 자연스러워져요' : '');
    if(r.fare) setFare(r.fare, '(최근 30일 내 조회값)');
    else if(r.data.transport.mode !== 'corporate' && r.data.transport.to && !r.missing.includes('출장지')) lookupFare(false);
  } catch(e){ $('#q_status').textContent = e.message; }
  finally { $('#btnQuick').disabled = false; }
};
$('#q_memo').addEventListener('keydown', e => { if(e.key==='Enter' && (e.metaKey||e.ctrlKey)) $('#btnQuick').click(); });
$('#btnApply').onclick = async () => {
  $('#a_err').textContent = '';
  const data = applyData();
  const need = [];
  if(!data.dates.start || !$('#a_end').value) need.push('날짜');
  if(!data.dates.start_time) need.push('출발 시각');
  if(!data.dates.end_time) need.push('복귀 시각');
  if(data.transport.mode !== 'corporate' && !data.transport.total) need.push('교통비');
  if(data.category === '연구과제' && !data.project) need.push('과제명');
  if(need.length){ markNeed(need); $('#a_err').textContent = `${need.join(', ')}을(를) 넣어 주세요.`; return; }
  try { await rpc('/api/plan', data); } catch(e){ $('#a_err').textContent = e.message; return; }
  runJob('출장신청서 입력', '/api/job/apply', {data}, () => { loadTrips(); resetApply(); gwMap = null; });   // 끝나면 폼 비움, 상태는 다음에 탭 열 때 그룹웨어에서 다시
};

/* ---------- 내 출장 / 보고서 ---------- */
let gwMap = null;            // 그룹웨어 품의 상태 (key → 행). [그룹웨어 상태 확인] 후 채워짐
let gwAll = [];
/* 상태는 그룹웨어 기준: 품의가 그룹웨어에 있으면 그 결재상태, 없으면 '그룹웨어에 없음', 연결 자체가 없으면 '미입력' */
const REJECTED = /반려|문서삭제/;   // 결재반려·반려취소, 또는 결재 문서가 지워져 품의만 남은 상태
const gwPill = (label, link) => {
  if(!link) return '';
  const r = gwMap && gwMap[link.key];
  if(!r) return `<span class="pill">${label} 순번 ${link.seq}</span>`;
  const cls = REJECTED.test(r.status || '') ? 'bad' : r.locked ? 'ok' : '';
  return `<span class="pill ${cls}">${label} 순번 ${link.seq} · ${r.status || '-'}</span>`;
};
async function loadTrips(){
  let {trips} = await rpc('/api/trips');
  trips.filter(t => !t.gwApply).forEach(t => rpc('/api/trip/forget', {id: t.id}));   // 순번 없는 기록(중간에 멈춘 입력)은 정리
  if(!gwMap){ $('#trips').innerHTML = '<p class="sub">그룹웨어 상태를 확인하는 중이에요…</p>'; renderOrphans([]); return; }
  // 목록은 그룹웨어 품의가 기준: 적요에 '출장'이 든 품의. 앱 기록(출장 기간·보고서 초안)은 순번으로 붙인다
  const byApply = {}, byReport = {};
  trips.forEach(t => { if(t.gwApply && !byApply[t.gwApply.key]) byApply[t.gwApply.key] = t; if(t.gwReport) byReport[t.gwReport.key] = t; });
  // 연결이 끊긴 보고 품의(적요 = "…로 인한 출장 보고")를 같은 출장에 다시 붙인다 (예: 보고서 올리다 앱을 끈 경우)
  for(const r of gwAll){
    if(byReport[r.key] || !(r.trip === 'report' || /출장\s*보고/.test(r.memo || ''))) continue;
    const t = trips.find(x => x.gwApply && !x.gwReport && gwMap[x.gwApply.key] && x.reportMemo === (r.memo || '').trim());
    if(t){ t.gwReport = { key: r.key, ym: r.ym, day: r.day, seq: r.seq }; byReport[r.key] = t; rpc('/api/trip/link-report', {id: t.id, row: r}); }
  }
  const stOf = k => ((gwMap[k] || {}).status || '');
  const isRejected = r => { const t = byApply[r.key]; return REJECTED.test(stOf(r.key)) || !!(t && t.gwReport && REJECTED.test(stOf(t.gwReport.key))); };
  const allDone = r => { const t = byApply[r.key]; return !!(t && t.gwReport && /완료/.test(stOf(r.key)) && /완료/.test(stOf(t.gwReport.key))); };   // 신청·보고 결재 둘 다 끝남
  let rows = gwAll.filter(r => (r.trip ? r.trip === 'apply' : /출장/.test(r.memo || '')) && !byReport[r.key])   // 결재양식이 '출장신청…'인 품의 (상신 전엔 적요로)
    .sort((a, b) => (b.ym + b.day.padStart(2, '0') + b.seq.padStart(5, '0')).localeCompare(a.ym + a.day.padStart(2, '0') + a.seq.padStart(5, '0')))
    .sort((a, b) => Number(isRejected(b)) - Number(isRejected(a)));   // 반려된 출장이 맨 위
  const done = rows.filter(allDone);
  if(!showDone) rows = rows.filter(r => !allDone(r));
  $('#trips').innerHTML = rows.length ? '' : '<p class="sub">진행 중인 출장 품의가 없어요.</p>';
  rows.forEach(r => {
    const t = byApply[r.key];
    const el = document.createElement('div'); el.className = 'item';
    const links = t ? [t.gwApply, t.gwReport].filter(Boolean) : [{ key: r.key, seq: r.seq }];
    const locked = links.some(l => gwMap[l.key] && gwMap[l.key].locked);
    const approved = /완료/.test(stOf(r.key));   // 신청 결재가 종결(결재완료)돼야 보고서를 쓸 수 있다
    const applyRejected = REJECTED.test(stOf(r.key));
    const reportSt = t && t.gwReport ? stOf(t.gwReport.key) : '';
    const reportRejected = REJECTED.test(reportSt), reportDone = /완료/.test(reportSt);
    // 신청 반려 → 고쳐서 [다시 신청]. 보고 반려 → [보고서 다시 올리기](전에 쓴 내용 그대로 열림, 이전 보고 품의는 지우고 새로)
    const repLabel = reportRejected ? '보고서 고쳐서 다시 올리기' : t && t.report ? '보고서 이어서 작성' : '보고서 작성';
    if(applyRejected || reportRejected) el.classList.add('rejected');
    el.innerHTML = `<div><b></b>${gwPill('신청', links[0])}${t && (t.gwReport || t.report) ? gwPill('보고', t.gwReport) : ''}
      <div class="sub" style="margin:2px 0 0"></div>${applyRejected ? '<div class="err" style="margin-top:4px">신청이 반려됐어요. 반려 사유를 그룹웨어에서 확인하고 [다시 신청]으로 고쳐 올리세요. 반려된 품의는 [삭제]로 지울 수 있어요.</div>' : reportRejected ? '<div class="err" style="margin-top:4px">보고서가 반려됐어요. 반려 사유를 확인하고 고쳐서 다시 올리세요.</div>' : ''}</div>
      <div class="inline"><button class="btn small danger del">삭제</button>${t ? `<button class="btn again ${applyRejected ? 'primary' : ''}">다시 신청</button>` : ''}${approved && !reportDone ? `<button class="btn primary rep">${repLabel}</button>` : ''}</div>`;
    el.querySelector('b').textContent = (r.docTitle || r.memo || '').replace(/^\[[^\]]*\]\s*/, '');
    el.querySelector('.sub').textContent = t ? `${t.start} ~ ${t.end} · ${r.total}원` : `${r.ym} ${r.day}일 품의 · ${r.total}원${r.docNo ? ' · ' + r.docNo : ''}`;
    if(t) el.querySelector('.again').onclick = () => repeatTrip(t.id, applyRejected);
    if(el.querySelector('.rep')) el.querySelector('.rep').onclick = async () => {   // 이 PC 기록이 없거나 그룹웨어에서 들여온 기록이면 결재 문서 본문을 (다시) 읽어 채운다
      if(t && t.status !== '그룹웨어') return openReport(t.id);
      const {id, filled, note} = await rpc('/api/trip/adopt', {row: r});
      if(!filled) alertErr(`결재 문서 본문을 읽지 못했어요${note ? ' (' + note + ')' : ''}. 기간·출장지는 직접 채워 주세요.`);
      openReport(id);
    };
    const del = el.querySelector('.del');
    if(locked){ del.disabled = true; del.title = '결재가 진행 중이거나 끝난 품의가 있어 삭제할 수 없어요'; }
    del.onclick = () => t ? deleteTrip(t, links) : deleteGwRows([r]);
    $('#trips').appendChild(el);
  });
  if(done.length){
    const p = document.createElement('p'); p.className = 'sub'; p.style.marginTop = '10px';
    const a = document.createElement('a'); a.href = '#'; a.textContent = showDone ? `결재가 모두 끝난 출장 ${done.length}건 숨기기` : `결재가 모두 끝난 출장 ${done.length}건 보기`;
    a.onclick = e => { e.preventDefault(); showDone = !showDone; loadTrips(); };
    p.appendChild(a); $('#trips').appendChild(p);
  }
  renderOrphans(trips, new Set(rows.map(r => r.key)));
}
let showDone = false;   // 신청·보고 결재가 모두 끝난 출장은 기본으로 숨김
function deleteTrip(t, links){
  const msg = links.length
    ? `'${t.reason}' 출장을 삭제할까요?\n\n그룹웨어 품의(${links.map(l => '순번 ' + l.seq).join(', ')})도 함께 삭제돼요. 결재가 진행 중이면 삭제하지 않아요. 되돌릴 수 없어요.`
    : `'${t.reason}' 출장 기록을 이 PC에서 지울까요? (그룹웨어와 연결된 품의 기록은 없어요)`;
  if(!confirm(msg)) return;
  if(!links.length) return rpc('/api/trip/forget', {id: t.id}).then(loadTrips);
  runJob('출장 삭제', '/api/job/trip-delete', {id: t.id}, () => { loadTrips(); autoGwCheck(true); });
}
function setGw(rows){ gwAll = rows || []; gwMap = Object.fromEntries(gwAll.map(r => [r.key, r])); try { localStorage.gw_rows = JSON.stringify(gwAll); } catch(e){ /* 저장 공간 없음 */ } }
try { if(localStorage.gw_rows) setGw(JSON.parse(localStorage.gw_rows)); } catch(e){ /* 캐시 없음 */ }   // 지난 결과를 먼저 보여주고 뒤에서 갱신
function renderOrphans(trips, shown = new Set()){
  if(!gwMap){ $('#gwOrphans').classList.add('hidden'); return; }
  const linked = new Set(trips.flatMap(t => [t.gwApply, t.gwReport].filter(Boolean).map(l => l.key)));
  const rows = gwAll.filter(r => !linked.has(r.key) && !shown.has(r.key) && (r.trip || /출장/.test(r.memo || '')));   // 출장 관련(결재양식·적요)인데 위 목록에 안 붙은 품의만. 적요 없는 다른 품의는 건드리지 않음
  $('#gwOrphans').classList.toggle('hidden', !rows.length);
  const box = $('#gwRows'); gwRows = rows;
  box.innerHTML = '<table class="gw"><thead><tr><th style="width:28px"><input type="checkbox" id="gwAllCb" style="width:auto"></th><th>품의일</th><th>순번</th><th>적요</th><th class="num">총금액</th><th>결재상태</th></tr></thead><tbody></tbody></table>';
  const tb = box.querySelector('tbody');
  rows.forEach(r => {
    const tr = document.createElement('tr'); if(r.locked) tr.className = 'locked';
    tr.innerHTML = '<td><input type="checkbox" style="width:auto"></td><td></td><td></td><td></td><td class="num"></td><td></td>';
    const cb = tr.querySelector('input'); cb.dataset.key = r.key; cb.disabled = r.locked; cb.title = r.locked ? '결재가 진행 중이거나 끝나서 삭제할 수 없어요' : '';
    const td = tr.querySelectorAll('td');
    td[1].textContent = `${r.ym} ${r.day}일`; td[2].textContent = r.seq; td[3].textContent = r.memo || '(적요 없음)'; td[4].textContent = r.total; td[5].textContent = (r.status || '-') + (r.locked ? ' (삭제 불가)' : '');
    tb.appendChild(tr);
  });
  const sync = () => { $('#btnGwDel').disabled = !$$('#gwRows tbody input:checked').length; };
  tb.querySelectorAll('input').forEach(c => c.onchange = sync);
  $('#gwAllCb').onchange = e => { tb.querySelectorAll('input:not(:disabled)').forEach(c => c.checked = e.target.checked); sync(); };
  sync();
}
let gwRows = [];
let gwAutoAt = 0;
async function autoGwCheck(force){   // 탭을 열 때 그룹웨어 상태를 조용히 확인 (1분에 한 번, 다른 작업 중이면 건너뜀)
  if((!force && Date.now() - gwAutoAt < 60 * 1000) || !$('#gwPill').classList.contains('ok')) return;
  const cur = await rpc('/api/job').catch(() => null);
  if(cur && (cur.state === 'running' || cur.state === 'waiting')) return;
  gwAutoAt = Date.now();
  runJob('그룹웨어 상태 확인', '/api/job/gw-list', {}, r => { setGw(r.rows); loadTrips(); }, {quiet: true});
}
$('#btnGwList').onclick = () => runJob('그룹웨어 상태 확인', '/api/job/gw-list', {}, r => { setGw(r.rows); loadTrips(); }, {quiet: true});
function deleteGwRows(pick){
  if(!pick.length) return;
  const keys = pick.map(r => r.key);
  const lines = pick.map(r => `· ${r.ym} ${r.day}일 순번 ${r.seq}  ${r.memo || ''}  ${r.total}`).join('\n');
  if(!confirm(`그룹웨어에서 품의 ${pick.length}건을 삭제할까요? 되돌릴 수 없어요.\n\n${lines}`)) return;
  runJob(`품의 ${pick.length}건 삭제`, '/api/job/gw-delete', { keys }, () => autoGwCheck(true));
};

async function repeatTrip(id, keep = false){
  const {data} = await rpc('/api/repeat', {id, keep});
  $$('nav button')[0].click();
  fillApply(data); autoExp = true; markNeed(keep ? [] : ['날짜']); showMealPlan(null);
  if(keep) recalcExpenses();
  $('#q_status').textContent = keep ? '반려된 신청을 그대로 불러왔어요. 반려 사유대로 고친 뒤 [그룹웨어에 입력하기]를 누르세요. 반려된 품의는 목록에서 [삭제]로 지울 수 있어요.' : '지난 출장 내용을 불러왔어요. 날짜만 고르면 경비는 규정대로 다시 계산돼요.';
  $('#a_start').focus();
  lookupFare(false);   // 교통비는 다시 조회 (최근 30일 조회값 있으면 바로, 없으면 네이버 지도)
}
function schedRow(r={}){
  const tr = document.createElement('tr');
  tr.innerHTML = `<td><input></td><td><input></td><td><textarea style="min-height:38px"></textarea></td><td><button class="btn small">✕</button></td>`;
  const [d,p,x] = tr.querySelectorAll('input,textarea'); d.value=r.date||''; p.value=r.place||''; x.value=r.detail||'';
  tr.querySelector('button').onclick = () => tr.remove();
  $('#r_sched tbody').appendChild(tr);
}
const refreshReport = () => { $('#r_total').textContent = won(readExp($('#r_exp tbody')).reduce((s,e)=>s+e.amount,0)); };
let reportPrompt = '';
function fillReport(d){
  setRadio('r_category', d.category||'로봇');
  for(const k of ['project','period','destination','visit_org','purpose','report']) $('#r_'+k).value = d[k]||'';
  $('#r_companions').value = (d.companions||[]).join(', ');
  $('#r_sched tbody').innerHTML = ''; (d.schedule||[]).forEach(schedRow);
  $('#r_exp tbody').innerHTML = ''; (d.expenses||[]).forEach(e => expRow($('#r_exp tbody'), e, refreshReport));
  reportAttachments = d.attachments||[];
  $('#r_attach').textContent = reportAttachments.length ? `첨부: ${reportAttachments.map(p=>p.split(/[\\/]/).pop()).join(', ')}` : '';
  refreshReport();
}
async function openReport(id){
  const {trips} = await rpc('/api/trips'); const t = trips.find(x => x.id === id);
  if(t && t.gwReport && !t.report){   // 이 PC엔 내용이 없고 그룹웨어에 보고 품의가 있음 → 경비를 그룹웨어에서
    return runJob('보고서 불러오기', '/api/job/report-load', {id}, async res => { const pr = await rpc('/api/draft', {id}); showReport(id, {...pr, draft: res.draft}, res.fromGw ? ` · 그룹웨어 보고 품의에서 경비 ${res.fromGw}줄을 불러왔어요. 증빙과 보고사항은 다시 넣어 주세요` : ''); }, {quiet: true});
  }
  showReport(id, await rpc('/api/draft', {id}));
}
async function showReport(id, r, extra = ''){
  currentTrip = r.draft; reportPrompt = r.prompt;
  $('#r_heading').textContent = r.draft.reason; $('#r_trip').textContent = `신청 ID ${id}` + (r.resumed ? ' · 전에 작성하던 보고서를 불러왔어요' : '') + extra;
  $('#r_title').textContent = (await rpc('/api/title', {reason: r.draft.reason})).report;
  fillReport(r.draft);
  $('#tripList').classList.add('hidden'); $('#reportView').classList.remove('hidden');
}
function reportData(){
  return {...currentTrip, category: radio('r_category'), project: $('#r_project').value.trim(),
    period: $('#r_period').value.trim(), destination: $('#r_destination').value.trim(),
    visit_org: $('#r_visit_org').value.trim(), companions: list($('#r_companions').value),
    purpose: $('#r_purpose').value.trim(), report: $('#r_report').value.trim(),
    schedule: [...$('#r_sched tbody').querySelectorAll('tr')].map(tr => { const [d,p,x]=tr.querySelectorAll('input,textarea'); return {date:d.value, place:p.value, detail:x.value}; }),
    expenses: readExp($('#r_exp tbody')), attachments: reportAttachments};
}
$('#btnRQuick').onclick = async () => {
  if(!currentTrip) return;
  if(!$('#rq_memo').value.trim()){ $('#rq_memo').focus(); $('#rq_status').textContent = '출장에서 한 일을 한 줄 적어 주세요. 그걸로 보고사항과 날짜별 일정을 써요.'; return; }
  $('#btnRQuick').disabled = true; $('#rq_status').textContent = '작성 중…';
  try {
    const r = await rpc('/api/report-quick', {id: currentTrip.trip_id, memo: $('#rq_memo').value});
    const cur = reportData();
    fillReport({...cur, ...r.data, expenses: cur.expenses.length ? cur.expenses : r.data.expenses, attachments: cur.attachments});   // 화면에서 고친 경비·증빙은 유지
    $('#rq_status').textContent = (r.source === 'template' ? '템플릿으로 작성' : `${r.source}로 작성`) + (r.note ? ` · ${r.note}` : '') + ' · 확인 후 [그룹웨어에 입력하기]';
  } catch(e){ $('#rq_status').textContent = e.message; }
  finally { $('#btnRQuick').disabled = false; }
};
$('#btnAddDay').onclick = () => schedRow();
$('#btnAddRExp').onclick = () => expRow($('#r_exp tbody'), {}, refreshReport);
$('#btnBack').onclick = () => { $('#reportView').classList.add('hidden'); $('#tripList').classList.remove('hidden'); };
$('#btnRPrompt').onclick = async () => {
  const memo = $('#rq_memo').value.trim();
  if(!memo){ $('#rcopied').textContent = '위 "한 줄 메모" 칸에 한 일을 먼저 써 주세요.'; $('#rq_memo').focus(); return; }
  await rpc('/api/copy', {text: reportPrompt + memo + '\n'}); $('#rcopied').textContent = '메모까지 포함해 복사됨';
};
$('#btnRFill').onclick = async () => {
  $('#rErr').textContent = '';
  try { const d = (await rpc('/api/parse', {text: $('#rPaste').value})).data; fillReport({...reportData(), ...d}); }
  catch(e){ $('#rErr').textContent = e.message; }
};
$('#reportView').addEventListener('input', e => { if(e.target.classList) e.target.classList.remove('need'); });   // 입력 시작하면 빈 칸 표시 해제
$('#btnReport').onclick = () => {
  $('#r_err').textContent = '';
  const d = reportData();
  if(!d.report){ $('#r_err').textContent = '담당업무 및 보고사항을 입력해 주세요.'; $('#r_report').classList.add('need'); return; }
  $$('#r_sched textarea').forEach(x => x.classList.toggle('need', !x.value.trim()));
  if(!d.schedule.length || d.schedule.some(r => !r.detail)){ $('#r_err').textContent = '출장일정의 세부 활동 내용을 날짜마다 적어 주세요.'; return; }
  if(!d.expenses.length){ $('#r_err').textContent = '경비를 한 줄 이상 넣어 주세요.'; return; }
  $$('#r_exp tbody tr').forEach(tr => { const b = tr.querySelector('.add'); if(b) b.classList.toggle('need', !JSON.parse(tr.dataset.proofs || '[]').length); });
  const noProof = d.expenses.findIndex(e => !(e.proofs || []).length);
  if(noProof >= 0){ $('#r_err').textContent = `정산 경비 ${noProof + 1}번째 줄에 증빙(이미지·PDF)을 첨부해 주세요.`; return; }
  runJob('출장보고서 입력', '/api/job/report', {data: d}, () => { loadTrips(); gwMap = null; });
};

/* ---------- 설정 ---------- */
$('#btnSave').onclick = async () => {
  await rpc('/api/config', {name: $('#s_name').value.trim(), budgetDept: $('#s_dept').value.trim(), defaultOrigin: $('#s_origin').value.trim()});
  $('#s_msg').textContent = '저장됨'; META = await rpc('/api/meta'); $('#a_from').value ||= META.config.defaultOrigin;
};
$('#btnLogin').onclick = () => runJob('로그인 확인', '/api/job/login', {}, () => checkGw(false));
function loadAiSettings(){
  const c = META.config, sel = $('#s_ai');
  sel.innerHTML = '<option value="none">사용 안 함 (템플릿)</option>' + Object.entries(META.providers).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('');
  sel.value = c.aiProvider || (c.aiBuiltin ? 'gemini' : 'none'); $('#s_model').value = c.aiModel || '';
  $('#s_model').placeholder = META.providers[sel.value] ? `기본: ${META.providers[sel.value].model}` : '비우면 기본 모델';
  $('#s_key').value = ''; $('#s_key').placeholder = c.aiBuiltin ? '팀 공용 Gemini 키 사용 중 (개인 키를 넣으면 그게 우선)' : c.aiKeySet ? '저장됨 (바꾸려면 새 키 입력)' : 'API 키 붙여넣기';

  const r = c.rates; $('#s_lodging').value = r.lodgingPerNight; $('#s_breakfast').value = r.breakfast; $('#s_lunch').value = r.lunch; $('#s_dinner').value = r.dinner;
  const mt = c.mealTimes; [['bf','breakfast'],['lu','lunch'],['di','dinner']].forEach(([a,k]) => { $(`#s_${a}_from`).value = mt[k][0]; $(`#s_${a}_to`).value = mt[k][1]; });
}
$('#s_ai').onchange = () => { const k = $('#s_ai').value; $('#s_model').placeholder = META.providers[k] ? `기본: ${META.providers[k].model}` : '비우면 기본 모델'; };
$('#btnAiSave').onclick = async () => {
  const body = {aiProvider: $('#s_ai').value, aiModel: $('#s_model').value.trim()};
  if($('#s_key').value.trim()) body.aiKey = $('#s_key').value.trim();
  await rpc('/api/config', body); META = await rpc('/api/meta'); loadAiSettings(); $('#s_ai_msg').textContent = '저장됨';
};
$('#btnAiClear').onclick = async () => { await rpc('/api/config', {clearAiKey: true}); META = await rpc('/api/meta'); loadAiSettings(); $('#s_ai_msg').textContent = '키 삭제됨'; };
$('#btnAiTest').onclick = async () => {
  $('#s_ai_msg').textContent = '확인 중…';
  try { const r = await rpc('/api/ai/test'); $('#s_ai_msg').textContent = `연결됨: "${r.reply}"`; } catch(e){ $('#s_ai_msg').textContent = e.message; }
};
$('#btnRateSave').onclick = async () => {
  const rates = {lodgingPerNight: num($('#s_lodging').value), breakfast: num($('#s_breakfast').value), lunch: num($('#s_lunch').value), dinner: num($('#s_dinner').value)};
  const mealTimes = Object.fromEntries([['bf','breakfast'],['lu','lunch'],['di','dinner']].map(([a,k]) => [k, [$(`#s_${a}_from`).value, $(`#s_${a}_to`).value]]));
  await rpc('/api/config', {rates, mealTimes}); META = await rpc('/api/meta'); $('#s_rate_msg').textContent = '저장됨';
};

/* ---------- 작업 패널 ---------- */
let jobTimer = null, jobSince = 0;
async function runJob(title, path, body, onDone, opt = {}){
  try { await rpc(path, {...body, title}); } catch(e){ alertErr(e.message); return; }
  watchJob(title, onDone, opt);
}
/** 진행 중인 작업 화면에 붙기 (새 작업 시작, 또는 새로고침 후 이어보기) */
function watchJob(title, onDone, {quiet = false} = {}){
  $('#jobTitle').textContent = title; $('#jobLog').textContent = ''; jobSince = 0;
  if(quiet){ $('#gwRefreshIcon').classList.add('on'); $('#btnGwList').disabled = true; }
  if(!quiet) $('#jobPanel').style.display = 'block';   // quiet: 물어볼 게 있거나 실패할 때만 창을 띄움
  const dimQuiet = quiet && !gwMap;   // 조용한 갱신은 보여줄 게 없을 때만 딤
  if(!quiet || dimQuiet){ $('#dim').classList.add('on'); $('#dimStep').textContent = quiet ? '잠시만 기다려 주세요' : ''; }
  $('#jobCancel').classList.remove('hidden'); $('#jobSpin').classList.add('on'); $$('main .btn.primary').forEach(b => b.disabled = true);
  clearInterval(jobTimer);
  jobTimer = setInterval(async () => {
    const s = await rpc('/api/job', {since: jobSince});
    if(s.logs && s.logs.length){ $('#jobLog').textContent += s.logs.join('\n') + '\n'; $('#jobLog').scrollTop = 1e9; jobSince = s.next; if(!quiet) $('#dimStep').textContent = s.logs[s.logs.length - 1].replace(/^[⚠✔—]\s*/, ''); }
    const q = s.question;
    $('#jobShow').textContent = s.kind === 'fare' ? '네이버 지도 열기' : '그룹웨어 창 열기';
    const what = {apply: '와니가 작성 중', report: '와니가 작성 중', fare: '와니가 교통비 조회 중', 'trip-delete': '와니가 삭제 중', 'gw-delete': '와니가 삭제 중', 'gw-list': '그룹웨어 로그인·품의 상태를 확인 중이에요', 'report-load': '그룹웨어에서 보고서를 불러오는 중이에요', login: '그룹웨어 로그인 상태를 확인 중이에요'}[s.kind] || '와니가 처리 중';
    $('#dimWhat').textContent = what; $('.wani .pen').textContent = /삭제/.test(what) ? '🧹' : /조회|확인/.test(what) ? '🔍' : '✍️';
    $('#jobAsk').style.display = q ? 'block' : 'none';
    $('#jobSpin').classList.toggle('on', !q && s.state === 'running');   // 사람 입력 기다릴 땐 멈춤
    if(!quiet || dimQuiet) $('#dim').classList.toggle('on', !q && s.state === 'running');   // 사람 입력 기다릴 땐 딤 해제 (화면 손봐야 하니)
    if(q || s.state==='error') $('#jobPanel').style.display = 'block';
    if(q){
      $('#jobQ').textContent = q.text;
      $('#jobInput').classList.toggle('hidden', q.type!=='int');
      $('#jobNo').classList.toggle('hidden', q.type!=='confirm');
      $('#jobYes').textContent = q.type==='confirm' ? '예' : q.type==='int' ? '입력' : '계속';
    }
    if(s.state==='done' || s.state==='error' || s.state==='cancelled' || s.state==='none'){
      clearInterval(jobTimer); $$('main .btn.primary').forEach(b => b.disabled = false); $('#btnGwList').disabled = false; $('#gwRefreshIcon').classList.remove('on'); $('#jobCancel').classList.add('hidden'); $('#jobSpin').classList.remove('on'); $('#dim').classList.remove('on'); $('#jobAsk').style.display='none';
      if(s.state==='error') $('#jobLog').textContent += '\n✖ ' + s.error + '\n';
      if(s.state==='cancelled') $('#jobLog').textContent += '\n— 취소했어요.\n';
      if(s.state==='done' && onDone) onDone(s.result);
    }
  }, 700);
}
async function answer(v){ $('#jobAsk').style.display='none'; await rpc('/api/job/answer', {value: v}); }
$('#jobYes').onclick = () => {
  if(!$('#jobInput').classList.contains('hidden')){ const n = num($('#jobInput').value); if(!n && $('#jobInput').value!=='0') return; $('#jobInput').value=''; return answer(n); }
  answer(true);
};
$('#jobNo').onclick = () => answer(false);
$('#jobClose').onclick = () => { rpc('/api/job/cancel'); $('#jobPanel').style.display = 'none'; $('#dim').classList.remove('on'); };   // 닫기 = 진행 중이던 작업 취소(그룹웨어 품의도 삭제)
$('#jobCancel').onclick = () => rpc('/api/job/cancel');
$('#jobShow').onclick = () => rpc('/api/gw/show');
function alertErr(m){ $('#jobPanel').style.display='block'; $('#jobTitle').textContent='오류'; $('#jobLog').textContent = m; $('#jobAsk').style.display='none'; }

/* ---------- 그룹웨어 로그인 ---------- */
let gwChecked = 0;
function setGwPill(st){
  const p = $('#gwPill'); p.classList.toggle('ok', st === 'ok'); p.classList.toggle('bad', st === 'bad');
  p.querySelector('span').textContent = st === 'ok' ? '그룹웨어 로그인됨' : st === 'bad' ? '그룹웨어 로그인 필요' : '그룹웨어 확인 중';
}
function showGwSaved(){ $('#s_gw').textContent = META.config.gwSaved ? `저장된 계정: ${META.config.gwId}` : '저장된 계정 없음'; }
function openLogin(msg){
  $('#lg_err').textContent = msg || ''; $('#lg_id').value = $('#lg_id').value || META.config.gwId || '';
  $('#loginModal').classList.add('on'); ($('#lg_id').value ? $('#lg_pw') : $('#lg_id')).focus();
}
const closeLogin = () => { $('#loginModal').classList.remove('on'); $('#lg_pw').value = ''; };
async function checkGw(openIfNeeded = true){
  setGwPill('');
  // 확인하는 동안 딤 (작업 중이 아닐 때만 — 작업 딤은 폴링이 관리)
  const dimMine = !$('#dim').classList.contains('on'); if(dimMine){ $('#dimWhat').textContent = '그룹웨어 로그인 상태를 확인 중이에요'; $('#dimStep').textContent = '잠시만 기다려 주세요'; $('.wani .pen').textContent = '🔍'; $('#dim').classList.add('on'); }
  const st = await rpc('/api/gw/status').catch(e => ({ loggedIn: false, error: e.message }));
  if(dimMine) $('#dim').classList.remove('on');
  gwChecked = Date.now();
  setGwPill(st.loggedIn ? 'ok' : 'bad');
  if(!st.loggedIn && openIfNeeded) openLogin(st.failed ? '저장된 계정으로 로그인하지 못했어요. 비밀번호가 바뀌었다면 다시 입력해 주세요.' : '');
  return st;
}
$('#gwPill').onclick = () => $('#gwPill').classList.contains('ok') ? checkGw() : openLogin();
$('#loginForm').onsubmit = async e => {
  e.preventDefault();
  $('#lg_ok').disabled = true; $('#lg_ok').textContent = '로그인 중…'; $('#lg_err').textContent = '';
  try {
    const r = await rpc('/api/gw/login', { id: $('#lg_id').value, pw: $('#lg_pw').value, save: $('#lg_save').checked });
    if(r.loggedIn){ closeLogin(); setGwPill('ok'); META = await rpc('/api/meta'); showGwSaved(); if(r.note) alertErr(r.note); }
    else $('#lg_err').textContent = r.error;
  } catch(err){ $('#lg_err').textContent = err.message; }
  finally { $('#lg_ok').disabled = false; $('#lg_ok').textContent = '로그인'; }
};
$('#lg_close').onclick = closeLogin;
$('#lg_manual').onclick = () => { closeLogin(); runJob('로그인 확인', '/api/job/login', {}, () => checkGw(false)); };
$('#btnGwLogin').onclick = () => openLogin();
$('#btnGwForget').onclick = async () => { await rpc('/api/gw/forget'); META = await rpc('/api/meta'); showGwSaved(); };
window.addEventListener('focus', () => { if(Date.now() - gwChecked > 20 * 60 * 1000 && !$('#loginModal').classList.contains('on')) checkGw(); });

/* ---------- 시작 ---------- */
(async () => {
  META = await rpc('/api/meta');
  const c = META.config; $('#ver').textContent = 'v' + META.version;
  $('#s_name').value = c.name; $('#s_dept').value = c.budgetDept; $('#s_origin').value = c.defaultOrigin;
  $('#a_from').value = c.defaultOrigin;
  loadAiSettings();
  // 업데이트: 켤 때·창에 다시 들어올 때 최신 버전 확인 → 있으면 물어보고 → [업데이트]면 받아서 설치·재시작
  let updLater = '', updTimer = null;
  const askUpdate = async (force) => {
    const u = await rpc('/api/update/check', {force}).catch(() => null);
    if(!u || u.status !== 'available' || updLater === u.version || $('#updModal').classList.contains('on')) return;
    $('#updMsg').textContent = `v${u.version}이 나왔어요 (지금 v${u.current}). 지금 업데이트할까요? 받는 동안 기다리면 앱이 다시 켜져요.`;
    $('#updNotes').textContent = u.notes || ''; $('#updNotes').classList.toggle('hidden', !u.notes);
    $('#updErr').textContent = ''; $('#updProg').style.display = 'none'; $('#updGo').disabled = false; $('#updLater').disabled = false;
    $('#updModal').classList.add('on');
  };
  $('#updLater').onclick = async () => { const u = await rpc('/api/update').catch(() => ({})); updLater = u.version || ''; $('#updModal').classList.remove('on'); };   // 이번에 켜 있는 동안은 같은 버전을 다시 묻지 않음
  $('#updGo').onclick = async () => {
    $('#updGo').disabled = true; $('#updLater').disabled = true; $('#updErr').textContent = '';
    const r = await rpc('/api/update/install').catch(e => ({error: e.message}));
    if(r.error){ $('#updErr').textContent = r.error; $('#updGo').disabled = false; $('#updLater').disabled = false; return; }
    if(!r.started){ $('#updModal').classList.remove('on'); return; }   // 자동 설치가 안 되는 환경: 다운로드 페이지가 열림
    $('#updProg').style.display = 'block';
    clearInterval(updTimer);
    updTimer = setInterval(async () => {
      const u = await rpc('/api/update').catch(() => null); if(!u) return;
      $('#updProg i').style.width = (u.percent || 0) + '%';
      $('#updMsg').textContent = u.status === 'downloading' ? `v${u.version} 받는 중… ${u.percent || 0}%` : u.status === 'installing' ? (u.platform === 'linux' ? '설치하고 다시 켜는 중이에요… (관리자 암호 창이 뜨면 입력해 주세요)' : '설치하고 다시 켜는 중이에요…') : $('#updMsg').textContent;
      if(u.status === 'error'){ clearInterval(updTimer); $('#updErr').textContent = `업데이트 실패: ${u.error}`; $('#updGo').disabled = false; $('#updLater').disabled = false; }
    }, 500);
  };
  setTimeout(() => askUpdate(true), 3000);
  window.addEventListener('focus', () => askUpdate(false));   // 다시 들어올 때 (메인 쪽에서 10분에 한 번만 실제 조회)
  const cur = await rpc('/api/job').catch(() => null);          // 새로고침 전 작업이 남아 있으면 이어서 보여주기
  if(cur && (cur.state === 'running' || cur.state === 'waiting')) watchJob(cur.title || '진행 중인 작업', cur.kind === 'fare' ? r => setFare(r) : (cur.kind === 'apply' || cur.kind === 'report') ? () => loadTrips() : null);
  $('#q_memo').focus();
  showGwSaved(); checkGw();
  if(!META.configured || !c.name){ $$('nav button')[2].click(); $('#s_msg').textContent = '처음이면 이름부터 저장해 주세요'; }
})();
