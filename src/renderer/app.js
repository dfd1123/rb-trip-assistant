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

/* ---------- 시각 입력: 브라우저 기본 시계 팝업은 [확인]이 없어 불편 → 시·분 선택 상자로 (값은 그대로 'HH:MM') ---------- */
function timeSelect(inp){
  const wrap = document.createElement('span'); wrap.className = 'tsel';
  const h = document.createElement('select'), m = document.createElement('select');
  h.innerHTML = '<option value="">시</option>' + [...Array(24)].map((_, i) => `<option>${String(i).padStart(2, '0')}</option>`).join('');
  m.innerHTML = '<option value="">분</option>' + [...Array(12)].map((_, i) => `<option>${String(i * 5).padStart(2, '0')}</option>`).join('');   // 5분 단위
  h.title = m.title = inp.title || '';
  inp.type = 'hidden'; inp.after(wrap); wrap.append(h, document.createTextNode(':'), m);
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const sync = v => { const [hh, mm] = String(v || '').split(':'); h.value = hh || ''; if(mm && ![...m.options].some(o => o.value === mm)) m.add(new Option(mm, mm)); m.value = mm || ''; };
  Object.defineProperty(inp, 'value', { get(){ return desc.get.call(inp); }, set(v){ desc.set.call(inp, v); sync(v); } });   // 코드에서 값을 넣어도 선택 상자에 보이게
  const push = () => { if(h.value && !m.value) m.value = '00'; desc.set.call(inp, h.value ? `${h.value}:${m.value}` : ''); ['input', 'change'].forEach(ev => inp.dispatchEvent(new Event(ev, {bubbles: true}))); };
  h.onchange = m.onchange = push;
  sync(desc.get.call(inp));
}
$$('input[type=time]').forEach(timeSelect);

/* 개발 중: 엔진 코드가 바뀌면 화면 위에 띠만 띄움 (앱은 스스로 다시 켜지지 않음) */
if(window.api.onDevStale) window.api.onDevStale(() => { if($('#devStale')) return; const b = document.createElement('div'); b.id = 'devStale';
  b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#f59e0b;color:#111;font-size:13px;padding:6px 12px;text-align:center';
  b.textContent = '엔진 코드가 바뀌었어요. 적용하려면 앱을 다시 켜 주세요 (yarn dev).'; document.body.appendChild(b); });

/* ---------- 탭 ---------- */
$$('nav button').forEach(b => b.onclick = () => {
  $$('nav button').forEach(x => x.classList.toggle('on', x===b));
  ['apply','trips','settings'].forEach(t => $('#tab-'+t).classList.toggle('hidden', t!==b.dataset.tab));
  if(b.dataset.tab==='trips'){ $('#tripList').classList.remove('hidden'); $('#reportView').classList.add('hidden'); loadTrips(); autoGwCheck(true); }   // 탭에 들어올 때마다 그룹웨어에서 다시 읽기 (저장된 목록은 먼저 보여줌)
  if(b.dataset.tab==='settings'){ ['#s_msg', '#s_ai_msg', '#s_rate_msg'].forEach(id => $(id).textContent = ''); rpc('/api/meta').then(m => { META = m; renderSettings(); }); }   // 저장된 값으로 다시 그림, '저장됨' 같은 알림은 지움
  if(b.dataset.tab==='apply') rpc('/api/meta').then(m => { META = m; syncApplyDefaults(); });          // 쓰던 신청서는 그대로, 설정에서 온 값만 맞춤
  window.scrollTo(0, 0);   // 메뉴를 바꾸면 맨 위부터
});

/* ---------- 경비 표 ---------- */
function expRow(tbody, e={}, onchange){
  const tr = document.createElement('tr');
  const tid = tbody.closest('table').id;   // a_exp(신청) / r_exp(보고)
  const opts = Object.entries(META.items).filter(([k]) => tid!=='a_exp' || k!=='domestic_transport')
    .map(([k,v]) => `<option value="${k}">${v.replace('여비교통비(판)_','')}</option>`).join('');
  const proofCell = tid === 'r_exp' ? '<td class="proof"><button class="btn small add">+ 증빙 첨부</button><div class="files"></div></td>' : '';
  const payCell = tid === 'r_exp' ? '<td><select class="pay"><option value="personal">개인</option><option value="card">법인카드</option></select><label class="novat hidden" title="항공권·주유비 등 부가세 공제가 안 되는 건: 부가세 0, 공급가액 = 결제 금액"><input type="checkbox" class="nv"> 면세</label></td>' : '';   // 결제: 법인카드면 공급가액 = 합계 − 부가세, 법인카드는 자금계획일이 익월 23일
  tr.innerHTML = `<td><select class="item">${opts}</select></td><td><input class="amt" inputmode="numeric"></td>${payCell}<td>${tid === 'r_exp' ? '<div class="memo-wrap"><span class="ppl-box"><input class="ppl" inputmode="numeric" title="몇 명이 먹었는지 (설정의 식대 기준과 가격으로 짐작해 넣어요)">명</span><input class="memo" placeholder="날짜·내용 (예: 9/28 1인 석식)"></div>' : '<input class="memo" placeholder="비우면 자동">'}</td>${proofCell}<td><button class="btn small del">✕</button></td>`;
  const sel = tr.querySelector('.item'), amt = tr.querySelector('.amt'), memo = tr.querySelector('.memo'), pay = tr.querySelector('.pay');
  if(pay){ pay.value = e.pay || 'personal';
    // 법인카드면 '면세(부가세 불공제)' 체크: 항공권·주유비 등은 기본으로 켬. 개인카드는 공급가액만이라 해당 없음
    const nvBox = tr.querySelector('.novat'), nv = tr.querySelector('.nv');
    const guess = () => sel.value === 'airfare' || /항공|주유|유류|기름|휘발유|경유|LPG|면세|불공제/i.test(memo.value);
    nv.checked = e.noVat === true || e.noVat === false ? e.noVat : guess(); nv.dataset.auto = e.noVat === undefined ? '1' : '';
    const showNv = () => nvBox.classList.toggle('hidden', pay.value !== 'card');
    nv.onchange = () => { nv.dataset.auto = ''; onchange(); };
    memo.addEventListener('input', () => { if(nv.dataset.auto) nv.checked = guess(); });
    pay.onchange = () => { showNv(); onchange(); }; showNv(); }
  const ppl = tr.querySelector('.ppl');
  if(ppl){   // 식대 인원: 적요의 "N인"과 같이 움직인다. 비어 있으면 금액으로 짐작
    const box = tr.querySelector('.ppl-box');
    const show = () => box.classList.toggle('hidden', sel.value !== 'meal');
    ppl.value = e.people || '';
    ppl.oninput = () => { ppl.value = ppl.value.replace(/[^\d]/g, '').slice(0, 2); if(ppl.value) memo.value = withPeople(memo.value, Number(ppl.value)); };
    sel.addEventListener('change', show); show();
  }
  if(proofCell){   // 정산 경비 증빙: 줄마다 1개 이상, 전부 보고서 첨부로 올라감
    let proofs = (e.proofs || []).slice(0, 1);   // 경비 한 줄에 증빙 1개
    const draw = () => {
      const box = tr.querySelector('.files'); box.innerHTML = '';
      if(!proofs.length){ const s = document.createElement('div'); s.className = 'empty'; s.textContent = '영수증 사진이나 PDF (없으면 비워 둠)'; box.appendChild(s); }
      proofs.forEach((p, i) => {
        const chip = document.createElement('div'); chip.className = 'chip';
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = (/\.pdf$/i.test(p) ? '📄 ' : '🖼️ ') + p.split(/[\\/]/).pop(); nm.title = p + ' (눌러서 열기)'; nm.onclick = () => rpc('/api/open', {path: p});
        const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '✕'; x.title = '빼기'; x.onclick = () => { proofs.splice(i, 1); draw(); };
        chip.append(nm, x); box.appendChild(chip);
      });
      tr.dataset.proofs = JSON.stringify(proofs);
      const add = tr.querySelector('.add'); add.classList.toggle('hidden', proofs.length > 0); add.classList.remove('need');
    };
    tr.querySelector('.add').onclick = async () => { const {paths} = await rpc('/api/pick-proofs'); if(paths.length){ proofs = [paths[0]]; draw(); fillMemo(tr); } };
    draw();
  }
  sel.value = e.item || (tid==='a_exp' ? 'domestic_lodging' : 'domestic_transport');
  amt.value = (e.amount === 0 || e.amount) && e.amount !== '' ? Number(e.amount).toLocaleString('ko-KR') : '';   // 0원도 그대로 보임
  memo.value = e.memo || '';
  amt.oninput = () => { amt.value = amt.value ? num(amt.value).toLocaleString('ko-KR') : ''; if(tid==='a_exp') autoExp = false; onchange(); };
  sel.onchange = memo.oninput = onchange;
  tr.querySelector('.del').onclick = () => { tr.remove(); onchange(); };
  tbody.appendChild(tr); onchange();
}
/** 증빙 없이 진행할 때 두 번 확인 (정산할 게 없거나 영수증이 없는 경우) */
function confirmNoProof(what = '영수증·증빙'){
  if(!confirm(`${what} 없이 진행할까요?`)) return false;
  return confirm(`정말 ${what}을(를) 안 넣을 건가요?\n증빙이 없으면 결재 승인이 안 날 수 있어요.`);
}
/** 적요에 인원 넣기: "9/28 1인 석식" → "9/28 2인 석식" (없으면 날짜 뒤에) */
const withPeople = (m, n) => /\d+\s*인/.test(m) ? m.replace(/\d+\s*인/, `${n}인`) : m.replace(/^(\d{1,2}\/\d{1,2})?\s*/, (_, d) => `${d ? d + ' ' : ''}${n}인 `).trim();
/** 가격으로 식대 인원 짐작 (AI 가 없을 때): 설정의 회사 식대 기준(1인 한 끼). 적요에 조식·중식·석식이 있으면 그 기준, 없으면 세 끼 평균 */
const guessPeople = (amount, memo = '') => { const r = (META.config && META.config.rates) || {};
  const per = /조식|아침/.test(memo) ? r.breakfast : /중식|점심/.test(memo) ? r.lunch : /석식|저녁/.test(memo) ? r.dinner : ((r.breakfast || 0) + (r.lunch || 0) + (r.dinner || 0)) / 3;
  return Math.max(1, Math.round((Number(amount) || 0) / (per || 12000))); };
/** 적요가 비었고 증빙이 있으면 AI 가 영수증에서 날짜·내용을 읽어 적요에 ("9/28 1인 석식"). 적요는 그대로 채주 거래처비고가 된다 */
async function fillMemo(tr){
  const memo = tr.querySelector('.memo'), proof = JSON.parse(tr.dataset.proofs || '[]')[0];
  if(!memo || memo.value.trim() || !proof) return;
  memo.placeholder = 'AI 가 영수증 읽는 중…';
  const ppl = tr.querySelector('.ppl'), meal = tr.querySelector('.item').value === 'meal';
  try {
    const r = await rpc('/api/receipt-memo', {path: proof, item: tr.querySelector('.item').value, period: $('#r_period').value});
    if(ppl && meal && !ppl.value) ppl.value = r.people || guessPeople(num(tr.querySelector('.amt').value), r.memo || '');
    if(r.memo && !memo.value.trim()) memo.value = meal && ppl.value ? withPeople(r.memo, Number(ppl.value)) : r.memo;
  } catch(e){ if(ppl && meal && !ppl.value) ppl.value = guessPeople(num(tr.querySelector('.amt').value), memo.value); }   // AI 없음·실패 → 인원만 금액으로, 적요는 직접
  finally { memo.placeholder = '날짜·내용 (예: 9/28 1인 석식)'; }
}
const readExp = tbody => [...tbody.querySelectorAll('tr')].map(tr => {
  const sel = tr.querySelector('.item'), amt = tr.querySelector('.amt'), memo = tr.querySelector('.memo'), pay = tr.querySelector('.pay');
  const e = {item: sel.value, amount: num(amt.value), memo: memo.value.trim()};
  if(pay){ e.pay = pay.value; if(pay.value === 'card') e.noVat = tr.querySelector('.nv').checked; }
  const ppl = tr.querySelector('.ppl'); if(ppl && sel.value === 'meal' && ppl.value) e.people = Number(ppl.value);
  if(tr.dataset.proofs) e.proofs = JSON.parse(tr.dataset.proofs);
  if(amt.value.trim() === '') e.empty = true;
  return e;
}).filter(e => !e.empty);   // 금액을 비운 줄만 뺀다. 0원은 사용자가 넣은 값이라 그대로 올림

/* ---------- 신청서 ---------- */
let placeGeo = null;   // 지역 검색으로 고른 출장지 {name, address, lng, lat} — 좌표로 길찾기를 바로 연다
function applyData(){
  const ovs = isOverseas();
  const mode = ovs ? 'overseas' : radio('a_mode');
  const t = {mode};
  if(mode==='corporate'){ if($('#a_corporate_car').value) t.corporate_car = $('#a_corporate_car').value; }
  else if(mode !== 'overseas'){ t.to = $('#a_to').value.trim() || $('#a_destination').value.trim(); t.from = $('#a_from').value.trim(); if(placeGeoValid()) t.place = placeGeo; }
  if($('#a_fare').value) t.total = num($('#a_fare').value);
  if(fareShot) t.screenshot = fareShot;
  return {
    reason: $('#a_reason').value.trim(), destination: $('#a_destination').value.trim(),
    dates: {start: $('#a_start').value, end: $('#a_end').value || $('#a_start').value, start_time: $('#a_start_time').value, end_time: $('#a_end_time').value},
    scope: ovs ? '해외' : '국내', grade: ovs ? (radio('a_grade') || '') : '', rate: ovs ? Number(String($('#a_rate').value).replace(/,/g, '')) || 0 : 0, rate_date: ovs ? rateInfo.date : '', rate_shot: ovs ? rateInfo.screenshot : '',
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
  const t = d.transport||{}; $$('input[name=a_mode]').forEach(x => x.checked = false); if(t.mode) setRadio('a_mode', t.mode);   // 교통편은 정해졌을 때만 (안 정했으면 비워 둠)
  $('#a_to').value = t.to||''; if(t.from) $('#a_from').value = t.from;
  placeGeo = t.place && t.place.lng ? t.place : null;
  $('#a_fare').value = t.total ? Number(t.total).toLocaleString('ko-KR') : ''; fareShot = t.screenshot || ''; $('#a_fare_desc').textContent = '';
  if(t.corporate_car) $('#a_corporate_car').value = t.corporate_car;
  $('#a_companions').value = (d.companions||[]).join(', ');
  $('#a_companion_purpose').value = d.companion_purpose||''; $('#a_purpose').value = d.purpose||'';
  $('#a_exp tbody').innerHTML = '';
  (d.expenses||[]).filter(e=>e.item!=='domestic_transport').forEach(e => expRow($('#a_exp tbody'), e, refreshApply));
  // 해외출장: 국가 등급·환율 → 규정대로 경비 줄
  const ov = d.scope === '해외' || t.mode === 'overseas';
  setRadio('a_scope', ov ? '해외' : '국내');
  $$('input[name=a_grade]').forEach(x => x.checked = false); if(d.grade) setRadio('a_grade', d.grade);
  if(d.rate) setRate({ rate: d.rate, date: d.rate_date, screenshot: d.rate_shot });
  refreshApply();
  if(ov){ if(!$('#a_uber').value) $('#a_uber').value = (META.config.rates && META.config.rates.uberUsdPerDay) || ''; recalcOverseas(); if(!d.rate && META.config.fxKeySet) lookupRate(); }
}
/** 신청서 전체 비우기 ([새로 작성], 그룹웨어 입력이 끝났을 때) */
function resetApply(){
  fillApply({}); autoExp = true; fareShot = '';
  $('#q_memo').value = ''; $('#q_status').textContent = ''; $('#a_err').textContent = '';
  ['#a_air', '#a_hotel', '#a_roam', '#a_ins'].forEach(id => $(id).value = ''); setRadio('a_scope', '국내'); refreshApply();
  markNeed([]); showMealPlan(null);
}
$('#btnNewApply').onclick = () => { resetApply(); $('#q_memo').focus(); };
let titleTimer;
function refreshApply(){
  const ovs = isOverseas();
  $('#a_ovCard').classList.toggle('hidden', !ovs);
  [$('#a_mode_seg').closest('.row'), $('#btnRecalc')].forEach(el => el && el.classList.toggle('hidden', ovs));
  if(ovs){ $('#a_route').classList.add('hidden'); $('#a_car_row').classList.add('hidden'); }
  const mode = ovs ? 'overseas' : radio('a_mode');
  $('#a_project').classList.toggle('hidden', radio('a_category')!=='연구과제');
  $('#a_cp_row').classList.toggle('hidden', !list($('#a_companions').value).length);
  if(!ovs){ $('#a_route').classList.toggle('hidden', !mode || mode==='corporate');   // 교통편을 고르기 전엔 교통비 칸 숨김
    $('#a_car_row').classList.toggle('hidden', mode!=='corporate'); }
  const fare = mode==='corporate' || ovs ? 0 : num($('#a_fare').value);
  const margin = mode!=='corporate' && !ovs && fare ? (META.config.rates.fareMargin || 0) : 0;   // 자차·대중교통 교통비 여유분
  const sum = readExp($('#a_exp tbody')).reduce((s,e)=>s+e.amount,0) + fare + margin;
  $('#a_total').textContent = won(sum) + (!ovs && mode!=='corporate' && !$('#a_fare').value ? ' + 교통비' : margin ? ` (교통비 여유 ${won(margin)} 포함)` : '');
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
/* ---------- 출장지 자동완성 (네이버 지역 검색) ---------- */
const placeGeoValid = () => !!(placeGeo && placeGeo.lng && $('#a_destination').value.includes(placeGeo.name));   // 출장지 글자를 지우거나 바꾸면 무효
/** 입력칸 아래 네이버 지역 검색 후보 목록. skip() 이 true 면 안 띄움, onPick(place) 로 고른 곳 전달 */
function attachAc(input, box, { onPick, skip = () => false }){
  let timer = null, seq = 0;
  const hide = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  async function search(){
    const q = input.value.trim();
    if(q.length < 2 || !(META.config && META.config.placesOn) || skip()) return hide();
    const my = ++seq;
    let items = null; try { items = (await rpc('/api/places', {q})).items; } catch(e){ return hide(); }
    if(my !== seq || document.activeElement !== input) return;   // 그새 더 쳤거나 칸을 떠남
    box.innerHTML = '';
    if(!items || !items.length){ const d = document.createElement('div'); d.className = 'none'; d.textContent = items ? '지도에서 못 찾았어요 — 주소를 적으면 교통비 조회 때 그 주소로 찾아요' : ''; box.appendChild(d); box.classList.toggle('hidden', !items); return; }
    items.forEach(pl => { const b = document.createElement('button'); b.type = 'button'; b.textContent = pl.name; const sm = document.createElement('small'); sm.textContent = pl.address || pl.category || ''; b.appendChild(sm); b.onmousedown = e => { e.preventDefault(); hide(); onPick(pl); }; box.appendChild(b); });
    box.classList.remove('hidden');
  }
  const later = () => { clearTimeout(timer); timer = setTimeout(search, 350); };
  input.addEventListener('input', later);
  input.addEventListener('focus', () => { if(!skip()) later(); });
  input.addEventListener('blur', () => setTimeout(hide, 150));
  input.addEventListener('keydown', e => {
    if(box.classList.contains('hidden')) return;
    const bs = [...box.querySelectorAll('button')]; if(!bs.length) return;
    let i = bs.findIndex(b => b.classList.contains('on'));
    if(e.key === 'ArrowDown'){ e.preventDefault(); i = (i + 1) % bs.length; bs.forEach((b, j) => b.classList.toggle('on', j === i)); }
    else if(e.key === 'ArrowUp'){ e.preventDefault(); i = (i - 1 + bs.length) % bs.length; bs.forEach((b, j) => b.classList.toggle('on', j === i)); }
    else if(e.key === 'Enter' && i >= 0 && !e.isComposing){ e.preventDefault(); e.stopPropagation(); bs[i].dispatchEvent(new MouseEvent('mousedown')); }
    else if(e.key === 'Escape') hide();
  });
  return { hide };
}
function pickPlace(pl){
  placeGeo = pl; $('#a_destination').value = pl.address ? `${pl.name} (${pl.address})` : pl.name; $('#a_to').value = pl.name;
  $('#a_destination').classList.remove('need'); refreshApply();
  const m = radio('a_mode'); if(!isOverseas() && (m === 'car' || m === 'transit')) lookupFare(true);   // 고른 곳으로 교통비 새로
}
attachAc($('#a_destination'), $('#a_dest_ac'), { onPick: pickPlace, skip: placeGeoValid });
$('#a_destination').addEventListener('input', () => { placeGeo = null; });
/** 네이버 지도에서 찾은 도착지로 출장지 칸 채우기: 검색어(예: KAI) 그대로면 '정식 이름 (주소)', 주소가 없으면 뒤에 (주소) */
function setDestinationFromPlace(place){
  if(!place || !place.address) return;
  const dest = $('#a_destination'), cur = dest.value.trim(), term = ($('#a_to').value.trim() || cur);
  if(/\d/.test(cur) && /(시|군|구|로|길)\s/.test(cur)) return;   // 이미 주소가 들어 있음
  dest.value = !cur || cur === term ? `${place.name} (${place.address})` : `${cur} (${place.address})`;
  dest.classList.remove('need'); refreshApply();
}
function setFare(r, label = ''){
  if(!r || !r.total) return;
  if(r.query && r.query !== ($('#a_to').value.trim() || $('#a_destination').value.trim())){   // 조회 중에 출장지를 고쳐 줬으면 그걸로
    $('#a_to').value = r.query; $('#a_destination').value = r.query;
  }
  setDestinationFromPlace(r.place);
  if(r.place && r.place.lng) placeGeo = r.place;   // 좌표까지 알았으면 다음 조회(보고서 유류대)는 바로 좌표로
  $('#a_fare').value = r.total.toLocaleString('ko-KR'); fareShot = r.screenshot||'';
  $('#a_fare_desc').innerHTML = '<b></b> <span></span> <a href="#">캡처 보기</a>';
  $('#a_fare_desc b').textContent = r.describe; $('#a_fare_desc span').textContent = label;
  $('#a_fare_desc a').onclick = e => { e.preventDefault(); rpc('/api/open', {path: fareShot}); };
  refreshApply();
}
function lookupFare(force){
  const d = applyData();
  if(d.transport.mode==='corporate' || !d.transport.to) return;
  runJob('교통비 조회 (네이버 지도)', '/api/job/fare', {mode: d.transport.mode, to: d.transport.to, from: d.transport.from, place: d.transport.place || null, force}, r => setFare(r, r && r.source==='cache' ? '(최근 30일 내 조회값)' : ''));
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
  if(isOverseas()) return recalcOverseas();   // 해외는 규정이 달라서 따로
  const start = $('#a_start').value, end = $('#a_end').value || start;
  if(!start) return;
  const r = await rpc('/api/expenses', {start, end, start_time: $('#a_start_time').value, end_time: $('#a_end_time').value, reason: $('#a_reason').value.trim()});
  // 규정으로 계산하는 숙박비·식대 줄만 새로 바꾸고, 직접 추가한 다른 경비 줄은 그대로 둔다
  const tb = $('#a_exp tbody'), ruled = new Set(r.expenses.map(e => e.item).concat(['domestic_lodging', 'meal']));
  [...tb.querySelectorAll('tr')].filter(tr => ruled.has(tr.querySelector('.item').value)).forEach(tr => tr.remove());
  const keep = [...tb.querySelectorAll('tr')]; tb.innerHTML = '';
  r.expenses.forEach(e => expRow(tb, e, refreshApply)); keep.forEach(tr => tb.appendChild(tr));
  showMealPlan(r); autoExp = true; refreshApply();
}
/* ---------- 해외출장 ---------- */
const isOverseas = () => radio('a_scope') === '해외';
const OV_ITEMS = new Set(['airfare', 'overseas_per_diem', 'overseas_lodging', 'overseas_transport', 'travel_etc']);
let rateInfo = { date: '', screenshot: '' };
function setRate(r){
  if(r.rate) $('#a_rate').value = Number(r.rate).toLocaleString('en-US', { maximumFractionDigits: 2 });
  rateInfo = { date: r.date || '', screenshot: r.screenshot || '' };
  const d = $('#a_rate_desc'); d.innerHTML = '';
  if(r.rate){ d.append(`한국수출입은행 매매기준율${r.date ? ` (${r.date} 고시)` : ''} · 계산은 ${Math.round(r.rate).toLocaleString('en-US')}원`); if(r.screenshot){ const a = document.createElement('a'); a.href = '#'; a.textContent = ' · 조회 결과 보기 (결재 문서에 첨부)'; a.onclick = e => { e.preventDefault(); rpc('/api/open', {path: r.screenshot}); }; d.append(a); } }
}
// 환율: 한국수출입은행 Open API (설정의 인증키) → 값 + 결재 첨부용 조회 결과 이미지
async function lookupRate(){
  if(!META.config.fxKeySet){ alertErr('환율 API 키가 들어 있지 않은 버전이에요. 관리자에게 알려 주세요.'); return; }
  $('#a_rate_desc').textContent = '환율 불러오는 중…';
  try { setRate(await rpc('/api/fx/rate')); recalcOverseas(); }
  catch(e){ $('#a_rate_desc').textContent = ''; alertErr(e.message); }
}
let ovTimer;
async function recalcOverseas(){
  if(!isOverseas()) return;
  const start = $('#a_start').value, end = $('#a_end').value || start, grade = radio('a_grade'), rate = Number(String($('#a_rate').value).replace(/,/g, ''));
  if(!start || !grade || !(rate > 0)) { refreshApply(); return; }
  const v = id => $(id).value.trim() === '' ? '' : $(id).value;
  const r = await rpc('/api/overseas-expenses', { start, end, grade, rate, airfare: v('#a_air'), lodging: v('#a_hotel'), uber: v('#a_uber'), roaming: v('#a_roam'), insurance: v('#a_ins') });
  const tb = $('#a_exp tbody');
  [...tb.querySelectorAll('tr')].filter(tr => OV_ITEMS.has(tr.querySelector('.item').value) || ['domestic_lodging', 'meal'].includes(tr.querySelector('.item').value)).forEach(tr => tr.remove());   // 규정으로 계산하는 줄만 새로
  const keep = [...tb.querySelectorAll('tr')]; tb.innerHTML = '';
  r.expenses.forEach(e => expRow(tb, e, refreshApply)); keep.forEach(tr => tb.appendChild(tr));
  $('#a_meal_plan').textContent = `해외 ${r.nights}박 ${r.days}일 · ${grade} 등급 일비 $${grade === '가' ? 90 : 50}/일${$('#a_hotel').value.trim() ? '' : ` · 숙박은 한도 $${grade === '가' ? 200 : 150}/박으로 계산 (견적이 있으면 숙박 칸에 넣으세요)`}`;
  refreshApply();
}
['#a_air', '#a_hotel', '#a_uber', '#a_roam', '#a_ins'].forEach(id => $(id).addEventListener('input', () => { if(['#a_air', '#a_hotel', '#a_roam', '#a_ins'].includes(id)){ const x = $(id); x.value = x.value ? num(x.value).toLocaleString('ko-KR') : ''; } clearTimeout(ovTimer); ovTimer = setTimeout(recalcOverseas, 300); }));
$$('input[name=a_grade]').forEach(r => r.addEventListener('change', () => { $('#a_grade_seg').classList.remove('need'); recalcOverseas(); }));
$$('input[name=a_scope]').forEach(r => r.addEventListener('change', () => {
  $('#a_exp tbody').innerHTML = ''; $('#a_meal_plan').textContent = '';
  if(isOverseas()){ if(!$('#a_uber').value) $('#a_uber').value = (META.config.rates && META.config.rates.uberUsdPerDay) || ''; if(!radio('a_grade')){ const g = /미국|유럽|캐나다|싱가포르|영국|프랑스|독일|이탈리아|스페인|네덜란드|스위스/.test($('#a_destination').value) ? '가' : ''; if(g) setRadio('a_grade', g); } recalcOverseas(); if(!$('#a_rate').value && META.config.fxKeySet) lookupRate(); }
  else recalcExpenses();
  refreshApply();
}));
$('#btnRate').onclick = lookupRate;
function showMealPlan(m){
  $('#a_meal_plan').textContent = m && m.summary ? `식대 내역: ${m.summary}${m.timed ? '' : '  (출발·복귀 시각을 넣으면 첫날·마지막 날 끼니를 정확히 계산해요)'}` : '';
}
// 날짜·시각이 바뀌면 숙박비·식대를 규정대로 바로 다시 계산 (입력 중엔 잠깐 기다렸다가)
let recalcTimer = null;
['#a_start','#a_end','#a_start_time','#a_end_time'].forEach(id => ['input', 'change'].forEach(ev => $(id).addEventListener(ev, () => { clearTimeout(recalcTimer); recalcTimer = setTimeout(recalcExpenses, 300); })));
$('#btnRecalc').onclick = recalcExpenses;
function markNeed(missing){
  const map = {'교통편': ['#a_mode_seg'], '국가 등급': ['#a_grade_seg'], '환율': ['#btnRate'], '항공권': ['#a_air'], '날짜': ['#a_start','#a_end'], '출발 시각': ['#a_start_time'], '복귀 시각': ['#a_end_time'], '출장지': ['#a_destination'], '사유': ['#a_reason'], '교통비': ['#a_fare'], '과제명': ['#a_project'], '동행목적': ['#a_companion_purpose']};
  $$('.need').forEach(el => el.classList.remove('need'));
  missing.forEach(m => (map[m]||[]).forEach(id => $(id).classList.add('need')));
}
$$('#a_start,#a_end,#a_start_time,#a_end_time,#a_destination,#a_reason,#a_fare,#a_project,#a_companion_purpose').forEach(el => ['input','change'].forEach(ev => el.addEventListener(ev, () => el.classList.remove('need'))));
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
    else if(r.data.transport.mode && !['corporate', 'overseas'].includes(r.data.transport.mode) && r.data.transport.to && !r.missing.includes('출장지')) lookupFare(false);   // 교통편을 안 정했으면 고를 때 계산
  } catch(e){ $('#q_status').textContent = e.message; }
  finally { $('#btnQuick').disabled = false; }
};
$('#q_memo').addEventListener('keydown', e => { if(e.key==='Enter' && (e.metaKey||e.ctrlKey)) $('#btnQuick').click(); });
/* ---------- 보내기 전 확인 모달 ---------- */
const escH = v => String(v ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function confirmSubmit({ title, html, note, yes = '보내기 ✦' }){
  return new Promise(res => {
    $('#cfTitle').textContent = title; $('#cfBody').innerHTML = html; $('#cfNote').innerHTML = note || ''; $('#cfYes').textContent = yes;
    $('#cfmModal').classList.add('on'); setTimeout(() => $('#cfYes').focus(), 50);
    const done = v => { $('#cfmModal').classList.remove('on'); ['#cfYes', '#cfNo', '#cfX'].forEach(id => $(id).onclick = null); document.removeEventListener('keydown', key); res(v); };
    const key = e => { if(e.key === 'Escape') done(false); };
    $('#cfYes').onclick = () => done(true); $('#cfNo').onclick = $('#cfX').onclick = () => done(false);
    $('#cfmModal').onclick = e => { if(e.target.id === 'cfmModal') done(false); };
    document.addEventListener('keydown', key);
  });
}
const itemName = k => (META.items[k] || k).replace('여비교통비(판)_', '');
const MODE_KO = { car: '🚗 자차', transit: '🚆 대중교통', corporate: '🚐 법인차량', overseas: '✈️ 해외' };

$('#btnApply').onclick = async () => {
  $('#a_err').textContent = '';
  const data = applyData();
  const need = [];
  if(!data.dates.start || !$('#a_end').value) need.push('날짜');
  if(!data.dates.start_time) need.push('출발 시각');
  if(!data.dates.end_time) need.push('복귀 시각');
  if(data.scope === '해외'){ if(!data.grade) need.push('국가 등급'); if(!(data.rate > 0) || !data.rate_shot) need.push('환율'); if(!data.expenses.some(e => e.item === 'airfare')) need.push('항공권'); }   // 조회 결과 이미지 첨부 필수 (사전품의 작성 기준)
  else if(!data.transport.mode) need.push('교통편');
  else if(data.transport.mode !== 'corporate' && data.transport.total === undefined) need.push('교통비');   // 0원은 허용 (비운 것만 막음)
  if(data.category === '연구과제' && !data.project) need.push('과제명');
  if(data.companions.length && !data.companion_purpose.trim()) need.push('동행목적');
  if(need.length){ markNeed(need); $('#a_err').textContent = `${need.join(', ')}을(를) 넣어 주세요.`; return; }
  let plan; try { plan = await rpc('/api/plan', data); } catch(e){ $('#a_err').textContent = e.message; return; }
  // 보낼 내용 확인
  const t = data.transport, fare = t.mode === 'corporate' ? 0 : Number(t.total || 0), margin = t.mode !== 'corporate' && fare ? (META.config.rates.fareMargin || 0) : 0;
  const rows = [...(fare ? [{ item: '교통비', amount: fare + margin, memo: margin ? `왕복 ${won(fare)} + 여유 ${won(margin)}` : '왕복' }] : []), ...plan.expenses.map(e => ({ item: itemName(e.item), amount: e.amount, memo: e.memo }))];
  const sum = rows.reduce((a, r) => a + r.amount, 0);
  const ok = await confirmSubmit({ title: '출장신청, 이대로 올릴까요?', html: `
    <div class="cf-title">${escH(plan.title)}</div>
    <dl class="cf-grid"><dt>출장지</dt><dd>${escH(data.destination)}</dd><dt>기간</dt><dd>${escH(data.dates.start)} ${escH(data.dates.start_time)} ~ ${escH(data.dates.end)} ${escH(data.dates.end_time)}</dd>
      <dt>교통편</dt><dd>${MODE_KO[t.mode] || '-'}${t.mode === 'corporate' && t.corporate_car ? ' · ' + escH(t.corporate_car) : ''}${data.scope === '해외' ? ` · ${escH(data.grade)} 등급 · USD ${Math.round(data.rate).toLocaleString('en-US')}원 (서울외국환중개, ${escH(data.rate_date)} 캡처 첨부)` : ''}</dd>
      <dt>구분</dt><dd>${escH(data.category)}${data.project ? ' · ' + escH(data.project) : ''}</dd>
      ${data.companions.length ? `<dt>동행자</dt><dd>${escH(data.companions.join(', '))} · ${escH(data.companion_purpose)}</dd>` : ''}
      <dt>출장목적</dt><dd>${escH(data.purpose)}</dd></dl>
    <div class="cf-sec">경비 (품의)</div>
    <table class="cf-tbl"><thead><tr><th>예산과목</th><th>적요</th><th style="text-align:right">금액</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td>${escH(r.item)}</td><td>${escH(r.memo || '')}</td><td class="n">${won(r.amount)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="2">합계</td><td class="n">${won(sum)}</td></tr></tfoot></table>`,
    note: '보내면 품의서입력 → 결재상신 → 본문까지 채우고 작성 창을 띄워요. <b>보관·상신은 직접</b> 눌러요.' });
  if(!ok) return;
  runJob('출장신청서 입력', '/api/job/apply', {data}, () => { loadTrips(); resetApply(); gwMap = null; });   // 끝나면 폼 비움, 상태는 다음에 탭 열 때 그룹웨어에서 다시
};

/* ---------- 내 출장 / 보고서 ---------- */
let gwMap = null;            // 그룹웨어 품의 상태 (key → 행). [그룹웨어 상태 확인] 후 채워짐
let gwAll = [];
/* 상태는 그룹웨어 기준: 품의가 그룹웨어에 있으면 그 결재상태, 없으면 '그룹웨어에 없음', 연결 자체가 없으면 '미입력' */
const DONE = /완료|종결/;   // 결재 끝남 (출장보고서 결재 문서는 '종결'로 옴)
const REJECTED = /반려|문서삭제/;   // 결재반려·반려취소, 또는 결재 문서가 지워져 품의만 남은 상태
const stWord = st => DONE.test(st) ? '승인' : REJECTED.test(st) ? '반려' : /상신대기|미상신|^$/.test(st || '') ? '상신 전' : '결재 중';   // 그룹웨어 결재상태 → 쉬운 말
const pill = (label, st, tip) => `<span class="pill ${DONE.test(st) ? 'ok' : REJECTED.test(st) ? 'bad' : ''}" title="${escH(tip || st || '')}">${label} ${stWord(st)}</span>`;
const gwPill = (label, link) => {
  if(!link) return '';
  const r = gwMap && gwMap[link.key];
  return pill(label, r ? r.status || '' : '', `순번 ${link.seq}${r && r.status ? ' · ' + r.status : ''}${r && r.docNo ? ' · ' + r.docNo : ''}`);
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
  const rows0 = () => gwAll.filter(r => (r.trip ? r.trip === 'apply' : /출장/.test(r.memo || '')) && !byReport[r.key]);   // 결재양식이 '출장신청…'인 품의 (상신 전엔 적요로)
  const applyDay = r => r.ym.replace('-', '') + String(r.day).padStart(2, '0');
  const isRejected = r => { const t = byApply[r.key]; return REJECTED.test(stOf(r.key)) || !!(t && t.gwReport && REJECTED.test(stOf(t.gwReport.key))); };
  // 정산(결의서전송)됨 = 그룹웨어 품의의 결의금액 > 0 또는 이 PC 기록의 결의번호. 예전 방식의 '보고 품의'는 이때 무시한다
  const settled = r => { const t = byApply[r.key]; return ((gwMap[r.key] || {}).sent || 0) > 0 || !!(t && t.resolutionNo); };
  const nz = x => String(x || '').replace(/\s/g, '');
  // 올라간 출장보고서 결재 문서: 이 PC에서 올린 건 제목으로. 그룹웨어에서 직접 올린 건(이 PC 기록 없음)은 출장 이름이 같고 신청 뒤에 올라간 보고서를 짝지음
  // (목록 API가 결의 전송 금액을 주지 않아 정산 여부로는 알 수 없음). 같은 이름 출장이 여러 번이면 최근 신청부터 그 뒤 가장 이른 보고서를 하나씩
  // ponytail: 같은 이름 출장 중 앞의 것만 보고서를 늦게 올리면 짝이 바뀔 수 있음 — 결의서입력 API로 품의↔결의를 직접 잇게 되면 그걸로
  const core = x => nz(x).replace(/^(\([^)]*\)|\[[^\]]*\])+/, '').replace(/(로인한)?출장(보고)?(의건)?$/, '');   // '(결재라인수정)[양식] KAI 기술 지원 출장의 건' → 'KAI기술지원'
  const dnum = x => String(x || '').replace(/\D/g, '').slice(0, 8);
  const mine = new Set(), paired = {};
  rows0().forEach(r => { const t = byApply[r.key]; const d = t && gwReportDocs.find(d => nz(d.title) === nz(t.reportDocTitle)); if(d){ paired[r.key] = d; mine.add(d); } });
  rows0().filter(r => !paired[r.key] && DONE.test(stOf(r.key))).sort((a, b) => applyDay(b).localeCompare(applyDay(a))).forEach(r => {
    const c = core(r.docTitle || r.memo);
    const d = c && gwReportDocs.filter(d => !mine.has(d) && core(d.title) === c && dnum(d.date) >= applyDay(r)).sort((a, b) => dnum(a.date).localeCompare(dnum(b.date)))[0];
    if(d){ paired[r.key] = d; mine.add(d); }
  });
  const reportDoc = r => paired[r.key] || null;
  const reportOpened = r => { const t = byApply[r.key]; return !!reportDoc(r) || !!(t && /작성 창 열림|상신/.test(t.reportStatus || '')); };   // 출장보고서 결재 창까지 띄움 → 나머지(결재라인·상신)는 사람
  const allDone = r => { const t = byApply[r.key]; const d = reportDoc(r); if(d) return DONE.test(d.status) && DONE.test(stOf(r.key)); return !!(t && t.gwReport && DONE.test(stOf(r.key)) && DONE.test(stOf(t.gwReport.key))); };   // 신청·보고 결재 둘 다 끝남
  let rows = rows0()
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
    const approved = DONE.test(stOf(r.key));   // 신청 결재가 종결(결재완료)돼야 보고서를 쓸 수 있다
    const applyRejected = REJECTED.test(stOf(r.key));
    const reportSt = t && t.gwReport ? stOf(t.gwReport.key) : '';
    const reportRejected = REJECTED.test(reportSt), reportDone = DONE.test(reportSt);
    // 신청 반려 → 고쳐서 [다시 신청]. 보고 반려 → [보고서 다시 올리기](전에 쓴 내용 그대로 열림, 이전 보고 품의는 지우고 새로)
    const rdoc = reportDoc(r);   // 출장보고서 결재가 올라갔으면 그 상태를 보여 주고, 반려가 아니면 버튼은 안 보임
    const rdocRejected = !!rdoc && REJECTED.test(rdoc.status);
    const isSettled = settled(r) || !!rdoc;
    // 정산 결의를 이미 전송했으면 경비를 다시 쓰지 않는다 → 다음 할 일은 출장보고서 결재 창 올리기(결의서입력 → 결재상신)
    const repLabel = isSettled ? '출장보고서 결재 올리기' : reportRejected ? '보고서 고쳐서 다시 올리기' : t && t.report ? '보고서 이어서 작성' : '보고서 작성';
    if(applyRejected || reportRejected) el.classList.add('rejected');
    el.innerHTML = `<div><b></b>${gwPill('신청', links[0])}${rdoc ? pill('보고', rdoc.status || '', `${rdoc.status || ''} · ${rdoc.docNo}`) : isSettled ? `<span class="pill ok" title="${escH(t && t.resolutionNo || '')}">정산 전송됨</span>` : t && (t.gwReport || t.report) ? gwPill('보고', t.gwReport) : ''}
      <div class="sub" style="margin:2px 0 0"></div>${applyRejected ? '<div class="err" style="margin-top:4px">신청이 반려됐어요. 반려 사유를 그룹웨어에서 확인하고 [다시 신청]으로 고쳐 올리세요. 반려된 품의는 [삭제]로 지울 수 있어요.</div>' : reportRejected ? '<div class="err" style="margin-top:4px">보고서가 반려됐어요. 반려 사유를 확인하고 고쳐서 다시 올리세요.</div>' : ''}</div>
      <div class="inline"><button class="btn small danger del">삭제</button>${t ? `<button class="btn again ${applyRejected ? 'primary' : ''}">다시 신청</button>` : ''}${approved && !reportDone && (!rdoc || rdocRejected) && !(isSettled && reportOpened(r) && !rdocRejected) ? `<button class="btn primary rep">${rdocRejected ? '보고서 고쳐서 다시 올리기' : repLabel}</button>` : ''}</div>`;
    el.querySelector('b').textContent = (r.docTitle || r.memo || '').replace(/^\[[^\]]*\]\s*/, '');
    const md = d => d ? `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일` : '';
    el.querySelector('.sub').textContent = t ? `${md(t.start)}${t.end && t.end !== t.start ? ' ~ ' + md(t.end) : ' 당일'} 출장 · ${r.total}원` : `${Number(r.ym.slice(5, 7))}월 ${r.day}일 신청 · ${r.total}원`;
    if(t) el.querySelector('.again').onclick = () => repeatTrip(t.id, applyRejected);
    if(el.querySelector('.rep')) el.querySelector('.rep').onclick = async () => {   // 이 PC 기록이 없거나 그룹웨어에서 들여온 기록이면 결재 문서 본문을 (다시) 읽어 채운다
      if(t && t.status !== '그룹웨어') return openReport(t.id);
      const {id, filled, note} = await rpc('/api/trip/adopt', {row: r});
      if(!filled) alertErr(`결재 문서 본문을 읽지 못했어요${note ? ' (' + note + ')' : ''}. 기간·출장지는 직접 채워 주세요.`);
      openReport(id);
    };
    const del = el.querySelector('.del');
    if(locked) del.remove();   // 결재가 진행 중이거나 끝난 품의는 지울 수 없으니 버튼도 안 보임
    else del.onclick = () => t ? deleteTrip(t, links) : deleteGwRows([r]);
    $('#trips').appendChild(el);
  });
  if(done.length){
    const p = document.createElement('p'); p.className = 'sub'; p.style.marginTop = '10px';
    const a = document.createElement('a'); a.href = '#'; a.textContent = showDone ? `결재가 모두 끝난 출장 ${done.length}건 숨기기` : `결재가 모두 끝난 출장 ${done.length}건 보기`;
    a.onclick = e => { e.preventDefault(); showDone = !showDone; loadTrips(); };
    p.appendChild(a); $('#trips').appendChild(p);
  }
  renderOrphans(trips, new Set(rows0().map(r => r.key)));
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
/** 개발 중에만: 목록을 API 로 읽었는지 화면에서 읽었는지 표시 */
function showVia(r){ const el = $('#gwVia'); if(!el || !(META.config && META.dev)) return; el.classList.remove('hidden');
  el.textContent = r.via === 'api' ? `API · ${(r.ms / 1000).toFixed(1)}초` : `화면 읽기 · ${(r.ms / 1000).toFixed(1)}초${r.apiError ? ' · API 실패: ' + r.apiError.slice(0, 60) : ''}`;
  el.className = 'pill ' + (r.via === 'api' ? 'ok' : 'bad'); }
let refundChecked = false;   // 환원 점검은 앱 켜고 한 번만, 목록을 보여 준 뒤 뒤에서
function refundCheckOnce(){ if(refundChecked) return; refundChecked = true; setTimeout(() => runJob('정산 환원 점검', '/api/job/refund-check', {}, null, {quiet: true}), 500); }
let gwReportDocs = [];   // 출장보고서 결재 문서 (결의서입력 → 결재상신으로 올린 것)
function setGw(rows, docs){ gwAll = rows || []; gwMap = Object.fromEntries(gwAll.map(r => [r.key, r])); if(docs) gwReportDocs = docs; try { localStorage.gw_rows = JSON.stringify(gwAll); localStorage.gw_rdocs = JSON.stringify(gwReportDocs); } catch(e){ /* 저장 공간 없음 */ } }
try { if(localStorage.gw_rows) setGw(JSON.parse(localStorage.gw_rows), JSON.parse(localStorage.gw_rdocs || '[]')); } catch(e){ /* 캐시 없음 */ }   // 지난 결과를 먼저 보여주고 뒤에서 갱신
function renderOrphans(trips, shown = new Set()){
  if(!gwMap){ $('#gwOrphans').classList.add('hidden'); return; }
  const linked = new Set(trips.flatMap(t => [t.gwApply, t.gwReport].filter(Boolean).map(l => l.key)));
  const rows = gwAll.filter(r => !r.locked && !linked.has(r.key) && !shown.has(r.key) && (r.trip || /출장/.test(r.memo || '')));   // 결재가 걸린 품의는 못 지우니 안 보여 줌   // 출장 관련(결재양식·적요)인데 위 목록에 안 붙은 품의만. 적요 없는 다른 품의는 건드리지 않음
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
  runJob('그룹웨어 상태 확인', '/api/job/gw-list', gwRange(), r => { setGw(r.rows, r.reportDocs); showVia(r); loadTrips(); refundCheckOnce(); }, {quiet: true});
}
$('#btnGwList').onclick = () => runJob('그룹웨어 상태 확인', '/api/job/gw-list', gwRange(), r => { setGw(r.rows, r.reportDocs); showVia(r); loadTrips(); refundCheckOnce(); }, {quiet: true});
/* 조회 기간(날짜): 기본 오늘부터 3개월 전까지, 최대 1년. 바꾸면 바로 다시 읽고, 선택은 이 PC에 기억 */
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function gwRange(){
  const today = new Date(), def = new Date(today); def.setMonth(def.getMonth() - 3);
  let from = $('#gwFrom').value || ymd(def), to = $('#gwTo').value || ymd(today);
  if(from > to) [from, to] = [to, from];
  const lim = new Date(`${to}T00:00:00`); lim.setFullYear(lim.getFullYear() - 1);
  if(from < ymd(lim)) from = ymd(lim);   // 최대 1년
  $('#gwFrom').value = from; $('#gwTo').value = to;
  try { localStorage.gw_from = from; localStorage.gw_to = to; } catch(e){ /* */ }
  // 빠른 버튼 표시: 끝이 오늘이고 시작이 정확히 n개월 전이면 그 버튼을 켬
  $$('#gwRange .quickr .btn').forEach(b => { const d = new Date(today); d.setMonth(d.getMonth() - Number(b.dataset.m)); b.classList.toggle('on', to === ymd(today) && from === ymd(d)); });
  return {from, to};
}
$$('#gwRange .quickr .btn').forEach(b => b.onclick = () => { const today = new Date(), d = new Date(today); d.setMonth(d.getMonth() - Number(b.dataset.m)); $('#gwFrom').value = ymd(d); $('#gwTo').value = ymd(today); gwRange(); $('#btnGwList').click(); });
try { if(localStorage.gw_from && localStorage.gw_to){ $('#gwFrom').value = localStorage.gw_from; $('#gwTo').value = localStorage.gw_to; } } catch(e){ /* */ }
gwRange();
['#gwFrom', '#gwTo'].forEach(id => $(id).onchange = () => { gwRange(); $('#btnGwList').click(); });
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
  $$('input[name=r_fund]').forEach(x => x.checked = x.value === d.fund);   // 자금과목: 출장마다 사람이 고름
  for(const k of ['project','period','destination','visit_org','purpose','report']) $('#r_'+k).value = d[k]||'';
  $('#r_companions').value = (d.companions||[]).join(', ');
  $('#r_sched tbody').innerHTML = ''; (d.schedule||[]).forEach(schedRow);
  $('#r_exp tbody').innerHTML = ''; (d.expenses||[]).forEach(e => expRow($('#r_exp tbody'), e, refreshReport));
  reportAttachments = d.attachments||[];
  reportTransport = d.transport || null;
  const tm = reportTransport && reportTransport.mode;
  $('#btnFuel').classList.toggle('hidden', !(tm === 'car' || !tm));   // 교통편을 모르는 출장(그룹웨어에서 가져옴)도 자차일 수 있으니 보여 줌
  const carWord = (META.config.carFuel === 'electric') ? '내 차 기준 (전기차, 네이버 기본 전비)' : '내 차 연료·연비 8km/L';
  $('#r_fuel_hint').textContent = tm === 'car' ? ` 자차 유류대는 [🚗 유류대 조회]로 네이버 지도(${carWord}) 캡처를 증빙으로 넣어요. 통행료·하이패스는 영수증을 [+ 경비 추가]로 따로 올리세요.` : tm === 'corporate' ? ' 법인차량은 주유소 영수증을 증빙으로 넣어 주세요.' : tm === 'transit' ? ' 대중교통은 승차권·영수증을 증빙으로 넣어 주세요.' : ' 신청서에서 교통편을 못 읽었어요. 자차였으면 [🚗 유류대 조회], 대중교통이면 승차권 영수증을 넣어 주세요.';
  $('#r_attach').textContent = reportAttachments.length ? `첨부: ${reportAttachments.map(p=>p.split(/[\\/]/).pop()).join(', ')}` : '';
  refreshReport();
}
let reportTransport = null;   // 신청 때 교통편 (자차면 유류대 = 네이버 지도 8km/L 캡처가 증빙)
$('#btnFuel').onclick = () => lookupFuel();
function lookupFuel(){
  // 도착지: 신청 때 지도 검색어 → 없으면(그룹웨어에서 가져온 출장) 보고서의 출장지. '이름 (주소)' 꼴이면 주소로 찾는 게 정확
  const t = reportTransport || {}, dest = $('#r_destination').value.trim(), addr = (/\(([^)]*)\)\s*$/.exec(dest) || [])[1];
  const to = t.to || (addr && /\d/.test(addr) ? addr : dest);
  if(!to) return alertErr('출장지를 먼저 적어 주세요. 그 이름으로 네이버 지도에서 찾아요.');
  runJob('유류대 조회 (네이버 지도)', '/api/job/fare', {mode: 'car', to, from: t.from, place: t.place || null, force: true}, r => {
    if(!r || !r.total) return;
    const tb = $('#r_exp tbody');
    const proofName = tr => (JSON.parse(tr.dataset.proofs || '[]')[0] || '').split(/[\\/]/).pop();
    [...tb.querySelectorAll('tr')].filter(tr => tr.querySelector('.item').value === 'domestic_transport' && /^(교통비_car.*)?$/.test(proofName(tr))).forEach(tr => tr.remove());   // 증빙 없는 교통비 줄·이전 지도 캡처 줄은 새 값으로 (영수증 붙은 줄은 그대로)
    expRow(tb, { item: 'domestic_transport', amount: (Number(r.fuel) || 0) * 2, memo: `출장 유류비 (왕복, ${r.basis || '연비 8km/L'} 네이버 지도 기준)`, proofs: r.screenshot ? [r.screenshot] : [] }, refreshReport);   // 유류대만. 통행료·하이패스는 영수증으로
    refreshReport();
  });
}
async function openReport(id){
  const {trips} = await rpc('/api/trips'); const t = trips.find(x => x.id === id);
  if(t && t.gwReport && !t.report){   // 이 PC엔 내용이 없고 그룹웨어에 보고 품의가 있음 → 경비를 그룹웨어에서
    return runJob('보고서 불러오기', '/api/job/report-load', {id}, async res => { const pr = await rpc('/api/draft', {id}); showReport(id, {...pr, draft: res.draft}, res.fromGw ? ` · 그룹웨어 보고 품의에서 경비 ${res.fromGw}줄을 불러왔어요. 증빙과 보고사항은 다시 넣어 주세요` : ''); }, {quiet: true});
  }
  showReport(id, await rpc('/api/draft', {id}));
}
async function showReport(id, r, extra = ''){
  if(!currentTrip || currentTrip.trip_id !== r.draft.trip_id){ rqFiles = []; $('#rq_memo').value = ''; }   // 다른 출장으로 바뀌면 영수증·메모 비움
  currentTrip = r.draft; reportPrompt = r.prompt;
  renderRqFiles();
  $('#r_heading').textContent = r.draft.reason; $('#r_trip').textContent = `신청 ID ${id}` + (r.resumed ? ' · 전에 작성하던 보고서를 불러왔어요' : '') + extra;
  $('#r_title').textContent = (await rpc('/api/title', {reason: r.draft.reason})).report;
  fillReport(r.draft);
  $('#tripList').classList.add('hidden'); $('#reportView').classList.remove('hidden');
  // 자차면 유류대(네이버 지도 8km/L 캡처)를 바로 조회. 이미 증빙 캡처가 붙은 교통비 줄이 있으면 안 함
  const hasFuel = [...$('#r_exp tbody').querySelectorAll('tr')].some(tr => tr.querySelector('.item').value === 'domestic_transport' && JSON.parse(tr.dataset.proofs || '[]').length);
  if(reportTransport && reportTransport.mode === 'car' && !hasFuel) lookupFuel();
}
function reportData(){
  return {...currentTrip, category: radio('r_category'), fund: radio('r_fund') || '', project: $('#r_project').value.trim(),
    period: $('#r_period').value.trim(), destination: $('#r_destination').value.trim(),
    visit_org: $('#r_visit_org').value.trim(), companions: list($('#r_companions').value),
    purpose: $('#r_purpose').value.trim(), report: $('#r_report').value.trim(),
    schedule: [...$('#r_sched tbody').querySelectorAll('tr')].map(tr => { const [d,p,x]=tr.querySelectorAll('input,textarea'); return {date:d.value, place:p.value, detail:x.value}; }),
    expenses: readExp($('#r_exp tbody')), attachments: reportAttachments, transport: reportTransport};
}
/* 보고서 자동 작성: 영수증 파일들 + 한 줄 메모를 다 넣은 뒤 [자동 작성] → 메모로 보고사항·일정, 영수증은 AI 로 경비 줄 */
let rqFiles = [];
const RQ_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|pdf)$/i;   // rules.js PROOF_EXT 와 같게
function renderRqFiles(){
  const box = $('#rq_files'); box.innerHTML = '';
  rqFiles.forEach((f, i) => {
    const c = document.createElement('span'); c.className = 'chip';
    c.innerHTML = '<span class="nm"></span><button title="빼기">×</button>';
    c.querySelector('.nm').textContent = f.split(/[\\/]/).pop(); c.querySelector('.nm').title = f;
    c.querySelector('button').onclick = () => { rqFiles.splice(i, 1); renderRqFiles(); };
    box.appendChild(c);
  });
  syncRQuick();
}
function addRqFiles(paths){
  const bad = paths.filter(p => p && !RQ_EXT.test(p));
  rqFiles = [...new Set([...rqFiles, ...paths.filter(p => p && RQ_EXT.test(p))])];
  renderRqFiles();
  if(bad.length) $('#rq_status').textContent = `이미지·PDF만 넣을 수 있어요 (뺀 파일: ${bad.map(b => b.split(/[\\/]/).pop()).join(', ')})`;
}
function syncRQuick(keepStatus){
  const memo = !!$('#rq_memo').value.trim(), files = rqFiles.length > 0;
  $('#btnRQuick').disabled = !memo || !!$('#btnRQuick').dataset.busy;   // 영수증은 없어도 됨 (누를 때 두 번 확인)
  if(keepStatus || $('#btnRQuick').dataset.busy) return;
  $('#rq_status').textContent = memo ? (files ? '' : '영수증 없이도 작성할 수 있어요 (정산할 게 없으면).') : '② 한 줄 메모를 넣으면 [자동 작성]을 누를 수 있어요.';
}
$('#rq_memo').addEventListener('input', syncRQuick);
$('#btnRQuick').onclick = async () => {
  if(!currentTrip || !$('#rq_memo').value.trim()) return syncRQuick();
  if(!rqFiles.length && !confirmNoProof()) return;
  const btn = $('#btnRQuick'); btn.disabled = true; btn.dataset.busy = '1'; $('#rq_status').textContent = '보고사항 작성 중…';
  try {
    const r = await rpc('/api/report-quick', {id: currentTrip.trip_id, memo: $('#rq_memo').value});
    const cur = reportData();
    fillReport({...cur, ...r.data, expenses: cur.expenses.length ? cur.expenses : r.data.expenses, attachments: cur.attachments});   // 화면에서 고친 경비·증빙은 유지
    const how = (r.source === 'template' ? '템플릿으로 작성' : `${r.source}로 작성`) + (r.note ? ` · ${r.note}` : '');
    $('#rq_status').textContent = how + ' · 영수증 읽는 중…';
    const paths = rqFiles;
    if(!paths.length){ $('#rq_status').textContent = how + ' · 영수증 없이 작성 · 확인 후 [그룹웨어에 정산 입력하기]'; return; }
    runJob(`영수증 ${paths.length}개 읽기`, '/api/job/receipts', {paths, period: receiptPeriod()}, res => {
      applyReceipts(res.results || []);
      rqFiles = []; renderRqFiles(); syncRQuick(true);
      $('#rq_status').textContent = how + ` · 영수증 ${paths.length}개 반영 · 확인 후 [그룹웨어에 입력하기]`;
    });
  } catch(e){ $('#rq_status').textContent = e.message; }
  finally { delete btn.dataset.busy; syncRQuick(true); }
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
/* 영수증: 끌어다 놓기·파일 고르기 → 자동 작성 때 AI 분류 → 경비 줄로 */
function receiptPeriod(){ const d = reportData(); return d.period || ''; }
/** 분류 결과를 경비 표에 반영: 같은 예산과목의 '증빙 없는 줄'(신청 때 예상 금액)은 영수증 줄로 바꾸고, 영수증마다 한 줄 + 증빙 1개 */
function applyReceipts(results){
  const tb = $('#r_exp tbody');
  const rowsOf = () => [...tb.querySelectorAll('tr')].map(tr => ({ tr, item: tr.querySelector('.item').value, proofs: JSON.parse(tr.dataset.proofs || '[]') }));
  const got = results.flatMap(r => (r && r.rows && r.rows.length ? r.rows.map(x => ({ ...x, path: r.path })) : r ? [{ path: r.path, item: '', amount: 0, failed: r.error || '영수증을 못 찾음' }] : []));
  const items = new Set(got.filter(g => g.item).map(g => g.item));
  rowsOf().filter(r => items.has(r.item) && !r.proofs.length).forEach(r => r.tr.remove());   // 예상 금액 줄 → 실제 영수증으로 대체
  // 한 파일에 영수증이 여러 장이면 증빙은 첫 줄에만 (증빙은 줄마다 1개)
  const seen = new Set();
  got.forEach(g => {
    const proofs = seen.has(g.path) ? [] : [g.path]; seen.add(g.path);
    const memo = g.failed ? '' : [g.date && g.date.slice(5).split('-').map(Number).join('/'), g.memo || g.vendor].filter(Boolean).join(' ');   // 거래처비고 형식 "10/2 1인 조식"
    const people = (g.item || 'meal') === 'meal' && !g.failed ? (g.people || guessPeople(g.amount, g.memo || '')) : 0;
    expRow(tb, { item: g.item || 'meal', amount: g.amount || '', memo: people ? withPeople(memo, people) : memo, people, proofs }, refreshReport);
    const tr = tb.lastElementChild; tr.classList.add('fromai');
    if(g.failed || !g.item || !g.amount) tr.querySelectorAll('select,input').forEach(x => x.classList.add('need'));
  });
  refreshReport();
  const bad = got.filter(g => g.failed || !g.item || !g.amount).length;
  $('#r_err').textContent = bad ? `영수증 ${bad}개는 제대로 못 읽었어요 (주황색 칸). 과목·금액을 확인해 주세요.` : '';
  $('#r_exp').scrollIntoView({ block: 'center', behavior: 'smooth' });
}
{
  const dz = $('#r_drop');
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', e => addRqFiles([...e.dataTransfer.files].map(f => window.api.pathForFile(f))));
  $('#btnPickReceipts').onclick = async () => { const {paths} = await rpc('/api/pick-proofs', {many: true}); addRqFiles(paths || []); };
  // 창 아무 데나 떨어뜨려도 앱이 파일을 열어 버리지 않게
  ['dragover', 'drop'].forEach(ev => window.addEventListener(ev, e => { if(!e.target.closest || !e.target.closest('#r_drop')) e.preventDefault(); }));
}
$('#reportView').addEventListener('input', e => { if(e.target.classList) e.target.classList.remove('need'); });   // 입력 시작하면 빈 칸 표시 해제
$$('input[name=r_fund]').forEach(x => x.addEventListener('change', () => $('#r_fund').classList.remove('need')));
$('#btnReport').onclick = async () => {
  $('#r_err').textContent = '';
  const d = reportData();
  if(!d.report){ $('#r_err').textContent = '담당업무 및 보고사항을 입력해 주세요.'; $('#r_report').classList.add('need'); return; }
  $$('#r_sched textarea').forEach(x => x.classList.toggle('need', !x.value.trim()));
  if(!d.schedule.length || d.schedule.some(r => !r.detail)){ $('#r_err').textContent = '출장일정의 세부 활동 내용을 날짜마다 적어 주세요.'; return; }
  if(!d.fund){ $('#r_err').textContent = '자금과목(일반경비·제조경비)을 골라 주세요.'; $('#r_fund').classList.add('need'); return; }
  const noProof = d.expenses.filter(e => !(e.proofs || []).length).length;
  if(noProof && !confirmNoProof(`정산 경비 ${noProof}줄의 증빙`)) return;
  if(!d.expenses.length && !confirm('정산할 경비가 없어요. 신청한 금액을 전부 환원하고 보고서만 올릴까요?')) return;
  // 식대 인원이 빈 줄: 금액으로 짐작해 넣고 적요의 "N인"도 맞춘 뒤 확인받는다
  const noPpl = [...$$('#r_exp tbody tr')].filter(tr => tr.querySelector('.item').value === 'meal' && tr.querySelector('.ppl') && !tr.querySelector('.ppl').value && tr.querySelector('.memo').value.trim());
  noPpl.forEach(tr => { const n = guessPeople(num(tr.querySelector('.amt').value), tr.querySelector('.memo').value); tr.querySelector('.ppl').value = n; tr.querySelector('.memo').value = withPeople(tr.querySelector('.memo').value, n); tr.querySelector('.ppl').classList.add('need'); });
  const empty = [...$$('#r_exp tbody tr')].filter(tr => !tr.querySelector('.memo').value.trim());
  if(noPpl.length && !empty.length){ $('#r_err').textContent = `식대 ${noPpl.length}줄의 인원을 금액으로 짐작해 넣었어요(주황색). 맞는지 보고 다시 눌러 주세요.`; return; }
  if(empty.length){   // 적요(= 거래처비고) 빈 줄은 AI 가 영수증으로 채우고 확인받는다
    $('#btnReport').disabled = true; $('#r_err').textContent = `적요가 빈 ${empty.length}줄을 영수증으로 채우는 중…`;
    try { await Promise.all(empty.map(fillMemo)); } finally { $('#btnReport').disabled = false; }
    const still = empty.filter(tr => !tr.querySelector('.memo').value.trim());
    $('#r_err').textContent = still.length ? `적요를 못 채운 줄이 있어요. 날짜·내용을 적어 주세요 (예: 9/28 1인 석식).` : '적요를 영수증으로 채웠어요. 확인 후 다시 눌러 주세요.';
    still.forEach(tr => tr.querySelector('.memo').classList.add('need'));
    return;
  }
  // 보낼 내용 확인
  const sumR = d.expenses.reduce((a, e) => a + e.amount, 0), PAY = { personal: '개인', card: '법인카드' };
  const okR = await confirmSubmit({ title: '출장보고서·정산, 이대로 보낼까요?', html: `
    <div class="cf-title">${escH($('#r_title').textContent)}</div>
    <dl class="cf-grid"><dt>출장일시</dt><dd>${escH(d.period)}</dd><dt>출장지</dt><dd>${escH(d.destination)}${d.visit_org ? ' · ' + escH(d.visit_org) : ''}</dd>
      <dt>출장구분</dt><dd>${escH(d.category)}${d.project ? ' · ' + escH(d.project) : ''}</dd><dt>자금과목</dt><dd>${escH(d.fund)}</dd>
      <dt>보고사항</dt><dd>${escH(d.report)}</dd><dt>일정</dt><dd>${d.schedule.map(x => `${escH(x.date)} ${escH(x.place)} — ${escH(x.detail)}`).join('<br>')}</dd></dl>
    <div class="cf-sec">정산 경비 (채주)</div>
    ${d.expenses.length ? `<table class="cf-tbl"><thead><tr><th>예산과목</th><th>거래처비고</th><th>결제</th><th>증빙</th><th style="text-align:right">금액</th></tr></thead>
      <tbody>${d.expenses.map(e => `<tr><td>${escH(itemName(e.item))}</td><td>${escH(e.memo)}</td><td>${PAY[e.pay] || '개인'}${e.pay === 'card' ? (e.noVat ? ' · 면세' : ` · 부가세 ${won(Math.floor(e.amount / 11))}`) : ''}</td><td>${(e.proofs || []).length ? '<span class="cf-ok">✓</span>' : '<span class="cf-no">없음</span>'}</td><td class="n">${won(e.amount)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4">합계</td><td class="n">${won(sumR)}</td></tr></tfoot></table>` : '<p class="sub">정산할 경비가 없어요 — 신청 금액 전액을 환원해요.</p>'}`,
    note: '보내면 결의서전송(채주·첨부·환원) → <b>[전송]까지 앱이 해요</b> → 결재상신 → 본문까지 채우고 작성 창을 띄워요. <b>상신은 직접</b>. 품의 한도를 넘는 금액은 한도까지만 청구돼요.' });
  if(!okR) return;
  runJob('출장보고서 입력', '/api/job/report', {data: d}, () => { loadTrips(); gwMap = null; });
};

/* ---------- 설정 ---------- */
/** 예산 부서 선택: 그룹웨어 사업코드 목록 (없으면 지금 값만) */
function fillDepts(c){   // 고를 게 두 개 이상이면 선택 상자, 아니면 글자 칸
  const list = [...new Set([c.budgetDept, ...(c.budgetDepts || [])].filter(Boolean))];
  const many = list.length > 1;
  $('#s_dept').classList.toggle('hidden', !many); $('#s_dept_text').classList.toggle('hidden', many);
  $('#s_dept').innerHTML = '';
  list.forEach(n => { const o = document.createElement('option'); o.value = o.textContent = n; $('#s_dept').appendChild(o); });
  $('#s_dept').value = c.budgetDept || list[0] || '';
  $('#s_dept_text').value = c.budgetDept || '';
}
const deptValue = () => ($('#s_dept').classList.contains('hidden') ? $('#s_dept_text') : $('#s_dept')).value.trim();
async function loadProfile(force){   // 그룹웨어에서 이름·품의부서·사업코드 목록
  runJob('내 정보 불러오기', '/api/job/gw-profile', {force}, async () => { META = await rpc('/api/meta'); const c = META.config; $('#s_name').value = c.name; fillDepts(c); $('#s_msg').textContent = '그룹웨어에서 불러왔어요'; }, {quiet: true});
}
$('#btnProfile').onclick = () => loadProfile(true);
$('#btnSave').onclick = async () => {
  await rpc('/api/config', {name: $('#s_name').value.trim(), budgetDept: deptValue(), defaultOrigin: $('#s_origin').value.trim()});
  $('#s_msg').textContent = '저장됨'; META = await rpc('/api/meta'); syncApplyDefaults();
};
$('#btnLogin').onclick = () => runJob('로그인 확인', '/api/job/login', {}, () => checkGw(false));
/** 설정 화면을 저장된 값으로 다시 그린다 (탭 들어올 때마다) */
function renderSettings(){
  const c = META.config;
  $('#s_name').value = c.name; fillDepts(c); $('#s_origin').value = c.defaultOrigin;
  loadAiSettings(); showGwSaved();
}
/** 설정에서 온 값만 신청서에 맞춘다: 출발지가 비어 있거나 예전 기본 출발지 그대로면 새 기본 출발지로 (직접 고친 값은 그대로) */
let lastOrigin = '';
function syncApplyDefaults(){
  const now = META.config.defaultOrigin || '', cur = $('#a_from').value.trim();
  if(!cur || cur === lastOrigin) $('#a_from').value = now;
  lastOrigin = now;
}
function loadAiSettings(){
  const c = META.config, sel = $('#s_ai');
  sel.innerHTML = '<option value="none">사용 안 함 (템플릿)</option>' + Object.entries(META.providers).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('');
  sel.value = c.aiProvider || (c.aiBuiltin ? 'gemini' : 'none'); $('#s_model').value = c.aiModel || '';
  $('#s_model').placeholder = META.providers[sel.value] ? `기본: ${META.providers[sel.value].model}` : '비우면 기본 모델';
  const keyHint = () => { const k = $('#s_ai').value; $('#s_key').placeholder = c.aiKeySet && !c.aiBuiltin ? '저장됨 (바꾸려면 새 키 입력)' : k === 'gemini' && c.aiBuiltin ? '팀 공용 Gemini 키 사용 중 (개인 키를 넣으면 그게 우선)' : k === 'none' ? '' : 'API 키 붙여넣기 (필수)'; };
  $('#s_key').value = ''; keyHint(); $('#s_ai').addEventListener('change', keyHint);

  const r = c.rates; $('#s_lodging').value = r.lodgingPerNight; $('#s_breakfast').value = r.breakfast; $('#s_lunch').value = r.lunch; $('#s_dinner').value = r.dinner; $('#s_fare_margin').value = r.fareMargin ?? 20000;
  $('#s_rank').value = c.rank || 'staff'; $('#s_car_fuel').value = c.carFuel || 'gasoline'; $('#s_car_type').value = c.carType || '1';
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
  const rates = {...META.config.rates, lodgingPerNight: num($('#s_lodging').value), breakfast: num($('#s_breakfast').value), lunch: num($('#s_lunch').value), dinner: num($('#s_dinner').value), fareMargin: num($('#s_fare_margin').value)};
  await rpc('/api/config', {rates, rank: $('#s_rank').value, carFuel: $('#s_car_fuel').value, carType: $('#s_car_type').value}); META = await rpc('/api/meta'); $('#s_rate_msg').textContent = '저장됨';
};

/* ---------- 작업 패널 ---------- */
let jobTimer = null, jobSince = 0;
async function runJob(title, path, body, onDone, opt = {}){
  try { await rpc(path, {...body, title}); } catch(e){ alertErr(e.message); return; }
  watchJob(title, onDone, opt);
}
/** 진행 중인 작업 화면에 붙기 (새 작업 시작, 또는 새로고침 후 이어보기) */
function watchJob(title, onDone, {quiet = false} = {}){
  $('#jobTitle').textContent = title; $('#jobLog').textContent = ''; jobSince = 0; $('#jobShow').classList.add('hidden');
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
    $('#jobShow').textContent = '작업 중인 창 열기';
    $('#jobShow').classList.toggle('hidden', !(q || s.state === 'error'));   // 사람이 손봐야 할 때(질문·실패)만 작업 창을 보여 준다
    const what = {apply: '와니가 작성 중', report: '와니가 작성 중', fare: '와니가 교통비 조회 중', 'trip-delete': '와니가 삭제 중', 'gw-delete': '와니가 삭제 중', 'gw-list': '그룹웨어 로그인·품의 상태를 확인 중이에요', 'gw-profile': '그룹웨어에서 내 정보를 불러오는 중이에요', 'report-load': '그룹웨어에서 보고서를 불러오는 중이에요', 'refund-check': '정산 환원을 확인하는 중이에요', receipts: '와니가 영수증 읽는 중', login: '그룹웨어 로그인 상태를 확인 중이에요'}[s.kind] || '와니가 처리 중';
    $('#dimWhat').textContent = what; $('.wani .pen').textContent = /삭제/.test(what) ? '🧹' : /조회|확인/.test(what) ? '🔍' : '✍️';
    const textQ = q && (q.type === 'text' || q.type === 'choice');
    $('#jobAsk').style.display = q && !textQ ? 'block' : 'none';
    if(textQ && !$('#askModal').classList.contains('on')) openAsk(q);
    if(!textQ) $('#askModal').classList.remove('on');
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
      clearInterval(jobTimer); jobTimer = null; $$('main .btn.primary').forEach(b => b.disabled = false); $('#btnGwList').disabled = false; $('#gwRefreshIcon').classList.remove('on'); $('#jobCancel').classList.add('hidden'); $('#jobSpin').classList.remove('on'); $('#dim').classList.remove('on'); $('#jobAsk').style.display='none';
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
function openAsk(q){
  const choice = q.type === 'choice';
  $('#askTitle').textContent = choice ? '📍 어디로 가나요?' : '📍 출장지를 다시 알려 주세요';
  $('#askQ').textContent = q.text; $('#askInput').classList.toggle('hidden', choice); $('#askChoices').classList.toggle('hidden', !choice); $('#askGo').classList.toggle('hidden', choice);
  $('#askSkip').textContent = choice ? '다른 이름으로 다시 찾기' : '금액 직접 입력';
  if(choice){ $('#askChoices').innerHTML = ''; (q.def || []).forEach((label, i) => { const b = document.createElement('button'); b.type = 'button'; const [name, addr] = String(label).split(' — '); b.textContent = name; if(addr){ const sm = document.createElement('small'); sm.textContent = addr; b.appendChild(sm); } b.onclick = () => askDone(i); $('#askChoices').appendChild(b); }); }
  else { $('#askInput').value = q.def || ''; }
  $('#askModal').classList.add('on'); if(!choice){ $('#askInput').focus(); $('#askInput').select(); }
}
const askDone = v => { $('#askModal').classList.remove('on'); answer(v); };
$('#askGo').onclick = () => { const v = $('#askInput').value.trim(); if(v) askDone(v); else $('#askInput').focus(); };
$('#askSkip').onclick = () => askDone('');
attachAc($('#askInput'), $('#askAc'), { onPick: pl => { $('#askInput').value = pl.name; askDone(pl.name); } });
$('#askInput').addEventListener('keydown', e => { if(e.key === 'Enter' && !e.isComposing && !e.defaultPrevented) $('#askGo').click(); });
$('#jobClose').onclick = () => { rpc('/api/job/cancel'); $('#jobPanel').style.display = 'none'; $('#dim').classList.remove('on'); };   // 닫기 = 진행 중이던 작업 취소(그룹웨어 품의도 삭제)
$('#jobCancel').onclick = () => rpc('/api/job/cancel');
$('#jobShow').onclick = () => rpc('/api/gw/show');
function alertErr(m){ $('#jobPanel').style.display='block'; $('#jobTitle').textContent='오류'; $('#jobLog').textContent = m; $('#jobAsk').style.display='none'; }

/* ---------- 그룹웨어 로그인 ---------- */
let gwChecked = 0;
// 로그인되면 한 번: 이름·예산 부서가 비었으면 그룹웨어에서 불러오고, 자차를 아직 안 물어봤으면 물어본다
let firstLoginDone = false;
async function whenJobIdle(){ for(;;){ const s = await rpc('/api/job', {since: 1e9}).catch(() => ({state: 'none'})); if(!jobTimer && !['running', 'waiting'].includes(s.state)) return; await new Promise(r => setTimeout(r, 800)); } }
async function afterLogin(){
  if(firstLoginDone) return; firstLoginDone = true;
  await whenJobIdle();
  const c = META.config;
  if(!c.name || !c.budgetDept){ await new Promise(done => runJob('내 정보 불러오기', '/api/job/gw-profile', {force: false}, async () => { META = await rpc('/api/meta'); renderSettings(); done(); }, {quiet: true})); }
  if(META.config.hasCar == null) askCar();
}
function askCar(){
  $('#carPick').classList.add('hidden'); $('#carYes').textContent = '있어요'; $('#carNo').textContent = '없어요';
  $('#car_fuel').value = META.config.carFuel || 'gasoline'; $('#car_type').value = META.config.carType || '1';
  $('#carModal').classList.add('on');
}
const saveCar = async patch => { $('#carModal').classList.remove('on'); await rpc('/api/config', patch); META = await rpc('/api/meta'); renderSettings(); };
$('#carNo').onclick = () => saveCar({hasCar: false});
$('#carYes').onclick = () => {
  if($('#carPick').classList.contains('hidden')){ $('#carPick').classList.remove('hidden'); $('#carYes').textContent = '저장'; $('#carNo').textContent = '자차 없어요'; return; }   // 있어요 → 연료·차종 고르기
  saveCar({hasCar: true, carFuel: $('#car_fuel').value, carType: $('#car_type').value});
};
function setGwPill(st){
  const p = $('#gwPill'); p.classList.toggle('ok', st === 'ok'); p.classList.toggle('bad', st === 'bad');
  // 설정 › 그룹웨어 계정 버튼: 로그인돼 있으면 [로그아웃]만, 아니면 로그인 버튼들 (확인 중엔 그대로)
  if(st === 'ok' || st === 'bad'){ const on = st === 'ok';
    ['#btnGwLogin', '#btnLogin'].forEach(id => $(id).classList.toggle('hidden', on)); $('#btnGwLogout').classList.toggle('hidden', !on); }
  if(st === 'ok') afterLogin();
  p.querySelector('span').textContent = st === 'ok' ? '그룹웨어 로그인됨' : st === 'bad' ? '그룹웨어 로그인 필요' : '그룹웨어 확인 중';
}
function showGwSaved(){ $('#s_gw').textContent = META.config.gwSaved ? `저장된 계정: ${META.config.gwId} (자동 로그인)` : '저장된 계정 없음'; $('#btnGwForget').classList.toggle('hidden', !META.config.gwSaved); }
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
  if(st.loggedIn && (!META.config.name || !META.config.budgetDept || !(META.config.budgetDepts || []).length)) setTimeout(() => loadProfile(false), 300);   // 처음 깐 PC: 그룹웨어에서 채우기
  if(!st.loggedIn && openIfNeeded) openLogin(st.failed ? '저장된 계정으로 로그인하지 못했어요. 비밀번호가 바뀌었다면 다시 입력해 주세요.' : '');
  return st;
}
$('#gwPill').onclick = () => $('#gwPill').classList.contains('ok') ? checkGw() : openLogin();
$('#btnGwOpen').onclick = () => rpc('/api/gw/open');   // 어느 화면에서든 그룹웨어 창 띄우기
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
$('#btnGwLogout').onclick = async () => {
  if(!confirm('그룹웨어에서 로그아웃할까요?\n\n로그인 정보와 저장된 비밀번호, 내 정보(이름·예산 부서)가 지워져요. 다시 로그인하면 그룹웨어에서 새로 받아와요.')) return;
  try { await rpc('/api/gw/logout'); } catch(e){ alertErr(e.message); return; }
  try { localStorage.removeItem('gw_rows'); } catch(e){ /* */ }
  gwMap = null; gwAll = []; META = await rpc('/api/meta'); renderSettings(); setGwPill('bad'); showGwSaved();
  $('#s_msg').textContent = '로그아웃했어요';
  openLogin('로그아웃했어요. 다시 로그인해 주세요.');
};
$('#btnGwForget').onclick = async () => { await rpc('/api/gw/forget'); META = await rpc('/api/meta'); showGwSaved(); };
window.addEventListener('focus', () => { if(Date.now() - gwChecked > 20 * 60 * 1000 && !$('#loginModal').classList.contains('on')) checkGw(); });

/* ---------- 시작 ---------- */
(async () => {
  META = await rpc('/api/meta');
  const c = META.config; $('#ver').textContent = 'v' + META.version;
  renderSettings();
  lastOrigin = ''; syncApplyDefaults();
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
  if(!META.configured || !c.name){ $$('nav button')[2].click(); $('#s_msg').textContent = '처음이면 그룹웨어에 로그인해 주세요. 이름·예산 부서는 자동으로 채워져요. 기본 출발지가 다르면 고쳐서 저장하세요.'; }
})();
