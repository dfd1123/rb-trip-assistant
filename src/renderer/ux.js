'use strict';
// 신청·보고 화면을 보기 좋게: 예시가 타이핑되는 입력칸, 자동 작성 칸 반짝, 출장 티켓·정산 영수증 미리보기, 제출 준비 체크리스트.
// 입력·전송 로직(app.js)은 건드리지 않는다 — 화면 값만 읽고, 자동 작성 함수는 감싸서 반짝 효과만 더한다.

/* ---------- 예시 문장이 타이핑되는 placeholder ---------- */
function typePlaceholder(ta){
  const ex = (ta.dataset.examples || '').split('|').filter(Boolean);
  if(!ex.length) return;
  const base = ta.placeholder.startsWith('②') ? '② 예: ' : '예: ';
  let i = 0, j = 0, back = false, wait = 0;
  setInterval(() => {
    if(ta.value || document.activeElement === ta) return;   // 쓰는 중이면 멈춤
    if(wait > 0){ wait--; return; }
    const s = ex[i];
    if(!back){ j++; if(j >= s.length){ back = true; wait = 28; } }
    else { j -= 2; if(j <= 0){ j = 0; back = false; i = (i + 1) % ex.length; wait = 4; } }
    ta.placeholder = base + s.slice(0, j) + (back || wait ? '' : '▍');
  }, 55);
}
$$('textarea[data-examples]').forEach(typePlaceholder);

/* ---------- 숫자 올라가는 효과 ---------- */
function countTo(el, target){
  const from = Number(el.dataset.v || 0); el.dataset.v = target;
  const tok = el._anim = (el._anim || 0) + 1;   // 앞 애니메이션이 끝나기 전에 값이 또 바뀌면 앞의 것은 멈춤 (안 그러면 옛 목표값이 마지막에 덮어써 합계가 틀려 보임)
  if(from === target){ el.textContent = won(target); return; }
  const t0 = performance.now(), dur = 520;
  const step = t => { if(el._anim !== tok) return; const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.textContent = won(Math.round(from + (target - from) * e)); if(k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

/* ---------- 자동 작성으로 바뀐 칸 반짝 ---------- */
function snapshot(root){ return new Map($$(`${root} input, ${root} textarea, ${root} select`).map(el => [el, el.type === 'radio' || el.type === 'checkbox' ? el.checked : el.value])); }
function sparkleChanged(root, before){
  let n = 0;
  $$(`${root} input, ${root} textarea, ${root} select`).forEach(el => {
    const now = el.type === 'radio' || el.type === 'checkbox' ? el.checked : el.value;
    if(before.has(el) && before.get(el) === now) return;
    if(el.type === 'radio' && !now) return;
    if(el.type === 'hidden' || (!now && now !== 0)) return;
    const target = el.type === 'radio' ? el.closest('label') : el.type === 'hidden' ? null : el;
    if(!target) return;
    setTimeout(() => { target.classList.remove('sparkle'); void target.offsetWidth; target.classList.add('sparkle'); }, 45 * n++);
  });
  setTimeout(() => $$(`${root} .sparkle`).forEach(x => x.classList.remove('sparkle')), 45 * n + 1600);
}
function wrapFill(name, root){
  const orig = window[name]; if(typeof orig !== 'function') return;
  window[name] = function(...a){ const b = snapshot(root); const r = orig.apply(this, a); requestAnimationFrame(() => sparkleChanged(root, b)); return r; };
}
wrapFill('fillApply', '#tab-apply');
// 출장 신청 펼치기: 내용이 채워지면(자동 작성·다시 신청·전에 쓰던 신청서) 아래 칸을 보여 줌
function revealApply(){ const t = $('#tab-apply'); if(!t.classList.contains('pre')) return; t.classList.remove('pre'); t.classList.add('reveal'); setTimeout(() => t.classList.remove('reveal'), 600); setTimeout(() => { if(typeof maybeGuide === 'function') maybeGuide(); }, 300); }
{ const f = window.fillApply; window.fillApply = function(d = {}, ...a){ const r = f.call(this, d, ...a); const dt = d.dates || {}; if(d.reason || d.destination || dt.start || d.start) revealApply(); return r; }; }
$('#aManual').onclick = e => { e.preventDefault(); revealApply(); };
if($('#a_reason').value.trim() || $('#a_destination').value.trim() || $('#a_start').value) revealApply();
wrapFill('fillReport', '#reportView');
wrapFill('applyReceipts', '#reportView');
wrapFill('fillPurchase', '#tab-purchase');

/* ---------- 세부 내용 접기: 기본은 접힘. 고칠 칸(주황)이 생기거나 체크리스트에서 고르면 펼침 ---------- */
function setFold(id, open){ const f = $(id); if(f) f.classList.toggle('open', open); }
$$('.fold .fold-head').forEach(h => h.onclick = () => h.parentElement.classList.toggle('open'));
function revealIn(el){ const f = el && el.closest('.fold'); if(f && !f.classList.contains('open')) f.classList.add('open'); }
function foldBadge(id){   // 접혀 있을 때 고칠 칸 개수 표시
  const f = $(id); if(!f) return; const n = $$(`${id} .need`).length; let b = f.querySelector('.fh-badge');
  if(n && !b){ b = document.createElement('span'); b.className = 'fh-badge'; f.querySelector('.fh-i').before(b); }
  if(b){ if(n) b.textContent = `확인 필요 ${n}`; else b.remove(); }
  if(n && !f.dataset.autoOpened){ f.dataset.autoOpened = '1'; f.classList.add('open'); }   // 처음 생기면 한 번 펼침
  if(!n) delete f.dataset.autoOpened;
}

/* ---------- 떠 있는 제출 버튼: 원래 버튼이 화면 밖이면 오른쪽 아래에 ---------- */
const fab = $('#fabSubmit');
function updateFab(){
  const btn = !$('#tab-apply').classList.contains('hidden') ? $('#btnApply') : !$('#reportView').classList.contains('hidden') ? $('#btnReport') : !$('#tab-purchase').classList.contains('hidden') ? $('#btnPurchase') : null;
  if(!btn){ fab.classList.add('hidden'); return; }
  const r = btn.getBoundingClientRect(), off = r.bottom < 0 || r.top > innerHeight;
  const jp = $('#jobPanel'), busy = jp && getComputedStyle(jp).display !== 'none';   // 작업 창(토스트)과 겹치지 않게
  fab.classList.toggle('hidden', !off || busy); fab.textContent = btn.textContent; fab.disabled = btn.disabled; fab.dataset.for = btn.id;
}
fab.onclick = () => { const b = $('#' + fab.dataset.for); if(b && !b.disabled) b.click(); };
addEventListener('scroll', updateFab, {passive: true});

/* ---------- 제출 준비 체크리스트 ---------- */
function renderReady(listSel, barSel, pctSel, items, btnSel, baseLabel){
  const need = items.filter(x => !x.optional), done = need.filter(x => x.ok).length;
  const pct = need.length ? Math.round(done / need.length * 100) : 100;
  const ul = $(listSel), key = JSON.stringify(items.map(x => [x.label, x.ok]));
  if(ul.dataset.key !== key){
    ul.dataset.key = key; ul.innerHTML = '';
    items.forEach(x => { const li = document.createElement('li'); if(x.ok) li.className = 'ok';
      li.innerHTML = `<i>${x.ok ? '✓' : x.optional ? '·' : ''}</i><span></span>`; li.querySelector('span').textContent = x.label + (x.optional ? ' (선택)' : '');
      if(x.focus) li.onclick = () => { const el = $(x.focus); if(el){ revealIn(el); setTimeout(() => { el.scrollIntoView({block: 'center', behavior: 'smooth'}); setTimeout(() => el.focus(), 300); }, 30); } };
      ul.appendChild(li); });
  }
  $(barSel).style.width = pct + '%'; $(pctSel).textContent = pct + '%';
  ul.closest('.ready').classList.toggle('all', pct === 100);
  const btn = $(btnSel); if(btn && !btn.dataset.busyLabel){ const left = need.length - done; btn.textContent = left ? `${baseLabel} · ${left}개 남음` : `${baseLabel} ✦`; }
}

/* ---------- 신청: 출장 티켓 + 체크리스트 ---------- */
$$('#tkGrades button').forEach(b => b.onclick = () => { const r = $(`input[name=a_grade][value="${b.dataset.g}"]`); if(!r || r.checked) return; r.checked = true; r.dispatchEvent(new Event('change', {bubbles: true})); });
$('#tkFxBtn').onclick = () => { if(typeof lookupRate === 'function') lookupRate(); };
$$('input[name=a_mode]').forEach(r => r.addEventListener('change', () => { const sg = $('#a_mode_seg'); if(sg) sg.classList.remove('need'); }));
// 티켓의 교통편 버튼 = 아래 진짜 라디오를 누름 → 기존 처리(교통비 지우고 네이버 지도 조회)가 그대로 돈다. 법인차량이면 차량 고르게 세부 내용을 펼침
$$('#tkModes button').forEach(b => b.onclick = () => { const r = $(`input[name=a_mode][value=${b.dataset.m}]`); if(!r || r.checked) return; r.checked = true; r.dispatchEvent(new Event('change', {bubbles: true}));
  $('#a_mode_seg') && $('#a_mode_seg').classList.remove('need'); if(b.dataset.m === 'corporate'){ setFold('#aFold', true); setTimeout(() => $('#a_corporate_car').scrollIntoView({block: 'center', behavior: 'smooth'}), 60); } });
const WD = '일월화수목금토';
const fmtDay = (d, t) => { if(!d) return '-'; const x = new Date(`${d}T00:00:00`); return `${x.getMonth() + 1}/${x.getDate()}(${WD[x.getDay()]})${t ? ' ' + t : ''}`; };
let applyKey = '';
function updateApply(){
  if($('#tab-apply').classList.contains('hidden')) return;
  const mode = radio('a_mode'), start = $('#a_start').value, end = $('#a_end').value || start;
  const fareTxt = $('#a_fare').value, totalNum = num((/[\d,]+/.exec($('#a_total').textContent) || ['0'])[0]);   // '374,814원 (교통비 여유 20,000원 포함)' → 첫 금액만
  const exps = readExp($('#a_exp tbody'));
  const key = JSON.stringify([radio('a_scope'), radio('a_grade'), $('#a_rate').value, typeof rateInfo !== 'undefined' && rateInfo.screenshot, $('#a_air').value, $('#a_hotel').value, mode, start, end, $('#a_start_time').value, $('#a_end_time').value, $('#a_from').value, $('#a_destination').value, fareTxt, totalNum, exps, $('#a_reason').value, $('#a_purpose').value, radio('a_category'), $('#a_project').value, $('#a_companions').value, $('#a_companion_purpose').value]);
  if(key === applyKey) return; applyKey = key;
  const ovs = radio('a_scope') === '해외', grade = radio('a_grade'), rateTxt = $('#a_rate').value;
  $('#tkMode').textContent = ovs ? '✈️' : mode === 'transit' ? '🚆' : mode === 'corporate' ? '🚐' : mode === 'car' ? '🚗' : '🧳';
  $('#tkModes').classList.toggle('hidden', ovs); $('#tkOv').classList.toggle('hidden', !ovs);
  $$('#tkModes button').forEach(b => b.classList.toggle('on', b.dataset.m === mode)); $('#aTicket').classList.toggle('pick', !ovs && !mode);
  $$('#tkGrades button').forEach(b => b.classList.toggle('on', b.dataset.g === grade)); $('#aTicket').classList.toggle('pickg', ovs && !grade);
  $('#tkFx').textContent = rateTxt ? `USD ${rateTxt}원${typeof rateInfo !== 'undefined' && rateInfo.date ? ` · ${rateInfo.date} 고시` : ''}` : '환율을 불러와 주세요';
  $('#tkFrom').textContent = !mode ? ($('#a_from').value || (META.config && META.config.defaultOrigin) || '출발지') : mode === 'corporate' ? ($('#a_corporate_car').value || '법인차량') : ($('#a_from').value || (META.config && META.config.defaultOrigin) || '출발지');
  $('#tkTo').textContent = $('#a_destination').value || '출장지';
  $('#tkStart').textContent = fmtDay(start, $('#a_start_time').value);
  $('#tkEnd').textContent = fmtDay(end, $('#a_end_time').value);
  const days = start ? Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 864e5) + 1 : 0;
  $('#tkDays').textContent = days > 0 ? (days === 1 ? '당일' : `${days - 1}박 ${days}일`) : '';
  countTo($('#tkTotal'), totalNum);
  const by = {}; exps.forEach(e => { const k = (META.items[e.item] || e.item).replace('여비교통비(판)_', ''); by[k] = (by[k] || 0) + e.amount; });
  { const f = fareParts(); if(f.fare + f.margin) by['교통비'] = (by['교통비'] || 0) + f.fare + f.margin; }   // 합계와 같은 계산 (여유분 포함)
  $('#tkBreak').innerHTML = ''; Object.entries(by).filter(([, v]) => v).forEach(([k, v]) => { const sp = document.createElement('span'); sp.textContent = `${k} ${won(v)}`; $('#tkBreak').appendChild(sp); });
  if(!ovs && !mode){ const sp = document.createElement('span'); sp.className = 'need'; sp.textContent = '교통비 · 교통편 선택 필요'; $('#tkBreak').appendChild(sp); }   // 안 골랐으면 합계에 교통비가 빠져 있다는 표시
  const companions = list($('#a_companions').value);
  const items = ovs ? [
    { label: '국가 등급', ok: !!grade, focus: '#tkGrades button' },
    { label: '환율', ok: !!(rateTxt && typeof rateInfo !== 'undefined' && rateInfo.screenshot), focus: '#tkFxBtn' },
    { label: '항공권', ok: exps.some(e => e.item === 'airfare'), focus: '#a_air' },
  ] : [
    { label: '교통편', ok: !!mode, focus: '#tkModes button' },
  ];
  items.push(
    { label: '출장 사유', ok: !!$('#a_reason').value.trim(), focus: '#a_reason' },
    { label: '출장지', ok: !!$('#a_destination').value.trim(), focus: '#a_destination' },
    { label: '날짜', ok: !!start, focus: '#a_start' },
    { label: '출발·복귀 시각', ok: !!($('#a_start_time').value && $('#a_end_time').value), focus: '#a_start_time + .tsel select' },
    { label: '출장목적', ok: !!$('#a_purpose').value.trim(), focus: '#a_purpose' },
  );
  if(ovs) items.push({ label: '항공권 견적', ok: !!$('#a_air').value.trim(), optional: true, focus: '#a_air' }, { label: '숙박 견적', ok: !!$('#a_hotel').value.trim(), optional: true, focus: '#a_hotel' });
  if(!ovs && mode && mode !== 'corporate') items.push({ label: '교통비', ok: fareTxt !== '', focus: '#a_fare' });
  if(radio('a_category') === '연구과제') items.push({ label: '과제명', ok: !!$('#a_project').value.trim(), focus: '#a_project' });
  if(companions.length) items.push({ label: '동행목적', ok: !!$('#a_companion_purpose').value.trim(), focus: '#a_companion_purpose' });
  renderReady('#aReadyList', '#aReadyBar', '#aReadyPct', items, '#btnApply', '그룹웨어에 입력하기');
}

/* ---------- 보고: 단계 + 정산 영수증 + 체크리스트 ---------- */
let reportKey = '';
function updateReport(){
  if($('#reportView').classList.contains('hidden')) return;
  const files = (typeof rqFiles !== 'undefined' ? rqFiles : []).length, memo = !!$('#rq_memo').value.trim();
  const written = !!$('#r_report').value.trim();
  const exps = readExp($('#r_exp tbody'));
  const sched = $$('#r_sched textarea'), schedOk = sched.length > 0 && sched.every(x => x.value.trim());
  const key = JSON.stringify([files, memo, written, exps, schedOk, radio('r_fund'), $('#r_period').value, $('#r_destination').value]);
  if(key === reportKey) return; reportKey = key;
  // 단계
  const st = [files > 0, memo, written];
  const now = st.findIndex(x => !x);
  $$('#rSteps .st').forEach((el, i) => { el.classList.toggle('done', st[i] || (i === 0 && (memo || written))); el.classList.toggle('now', i === now && !(i === 0 && (memo || written))); });
  $$('#rSteps .st-line').forEach((el, i) => el.classList.toggle('done', st[i] || (i === 0 && (memo || written))));
  // 정산 영수증
  const by = {}; exps.forEach(e => { const k = (META.items[e.item] || e.item).replace('여비교통비(판)_', ''); const o = by[k] || (by[k] = { sum: 0, n: 0, proof: 0 }); o.sum += e.amount; o.n++; if((e.proofs || []).length) o.proof++; });
  const rows = $('#rcRows'); rows.innerHTML = '';
  if(!exps.length) rows.innerHTML = '<div class="rc-empty">아직 정산할 경비가 없어요<br>영수증을 넣으면 여기에 쌓여요</div>';
  Object.entries(by).forEach(([k, o]) => {
    const d = document.createElement('div'); d.className = 'rc-row';
    d.innerHTML = '<div class="t"><b></b><span></span></div><div class="cap"></div>';
    d.querySelector('b').textContent = k; d.querySelector('.t span').textContent = won(o.sum);
    d.querySelector('.cap').textContent = `${o.n}건 · 증빙 ${o.proof}/${o.n}`;
    rows.appendChild(d);
  });
  const proofs = exps.reduce((s, e) => s + ((e.proofs || []).length ? 1 : 0), 0);
  $('#rcCount').textContent = `영수증 ${proofs}장`;
  countTo($('#rcTotal'), exps.reduce((s, e) => s + e.amount, 0));
  const items = [
    { label: '보고사항', ok: written, focus: '#r_report' },
    { label: '일정 세부 내용', ok: schedOk, focus: '#r_sched textarea' },
    { label: '자금과목', ok: !!radio('r_fund'), focus: '#r_fund input' },
    { label: '출장일시', ok: !!$('#r_period').value.trim(), focus: '#r_period' },
    { label: '출장지', ok: !!$('#r_destination').value.trim(), focus: '#r_destination' },
    { label: '증빙 첨부', ok: exps.length > 0 && proofs === exps.length, optional: true, focus: '#r_exp' },
  ];
  renderReady('#rReadyList', '#rReadyBar', '#rReadyPct', items, '#btnReport', '그룹웨어에 정산 입력하기');
}

// 값은 코드로도 바뀌어서(자동 작성) 이벤트만으론 놓친다 → 짧게 훑어서 바뀐 것만 다시 그림
// 지난번 [입력하기] 때 뜬 오류 문구는 무엇이든 고치면 바로 지운다 (다 채웠는데 '…넣어 주세요'가 남아 있지 않게)
['#tab-apply', '#reportView'].forEach(id => ['input', 'change', 'click'].forEach(ev => $(id).addEventListener(ev, e => {
  if(ev === 'click' && !e.target.closest('#tkModes, .seg, .tsel, .rd-list')) return;
  const err = id === '#tab-apply' ? $('#a_err') : $('#r_err'); if(err) err.textContent = '';
}, true)));
setInterval(() => { try { updateApply(); updateReport(); foldBadge('#aFold'); foldBadge('#rFold'); foldBadge('#puFold'); updateFab(); } catch(e){ /* 화면 준비 전 */ } }, 350);
// 다른 출장 보고서를 열거나 새로 작성하면 다시 접음
const _showReport = window.showReport; if(typeof _showReport === 'function') window.showReport = async function(...a){ setFold('#rFold', false); return _showReport.apply(this, a); };
const _resetApply = window.resetApply; if(typeof _resetApply === 'function') window.resetApply = function(...a){ setFold('#aFold', false); const r = _resetApply.apply(this, a); $('#tab-apply').classList.add('pre'); return r; };   // 새로 작성 = 다시 한 줄 칸만

/* ---------- 화면을 새로 그려도(개발 중 코드 반영 등) 보던 탭 유지 ---------- */
$$('nav button').forEach(b => b.addEventListener('click', () => { try { sessionStorage.ta_tab = b.dataset.tab; } catch(e){ /* */ } }));
try { const t = sessionStorage.ta_tab; const b = t && t !== 'apply' && $(`nav button[data-tab="${t}"]`); if(b) setTimeout(() => b.click(), 0); } catch(e){ /* */ }

/* ---------- 처음 들어온 사람용 가이드: 화면을 하나씩 짚어 준다. 본 화면은 기억 (❓ 가이드로 다시) ---------- */
const GUIDES = {
  apply: [
    ['#a_scope_seg', '국내 / 해외', '먼저 국내 출장인지 해외 출장인지 고르세요. 해외면 환율·항공권 칸이 따로 나와요.'],
    ['#q_memo', '한 줄로 쓰기', '언제 · 어디 · 무슨 일인지만 쓰세요. 예) "다음주 화~목 판교 RBY1 연동 검증, 자차"'],
    ['#btnQuick', '✦ 자동 작성', '누르면 날짜·출장지·사유·목적·경비를 회사 규정대로 채우고, 아래에 출장 티켓과 제출 준비가 펼쳐져요.'],
    ['#aManual', '직접 입력', 'AI 없이 칸을 하나씩 채우고 싶으면 이걸 누르세요.'],
  ],
  applyResult: [
    ['#aTicket', '출장 티켓', '교통편(자차·대중교통·법인차량)을 여기서 고르면 교통비를 바로 계산해요. 합계도 여기서 보여요.'],
    ['#tab-apply .card.ready', '제출 준비', '빠진 게 있으면 여기에 남아요. 항목을 누르면 그 칸으로 데려가요.'],
    ['#aFold .fold-head', '세부 내용', 'AI 가 채운 내용을 고치고 싶을 때만 펼치세요.'],
    ['#btnApply', '그룹웨어에 입력하기', '품의 입력과 결재 문서 본문까지 채워 작성 창을 띄워요. 결재선 확인과 [상신]은 직접 눌러 주세요.'],
  ],
  trips: [
    ['#gwRange', '조회 기간', '그룹웨어에 올린 출장 품의를 이 기간으로 읽어요 (기본 3개월).'],
    ['#trips', '출장 목록', '출장마다 신청·보고 결재 상태가 보여요. 신청이 승인되면 [보고서 작성]을 누르세요.'],
    ['#btnGwList', '새로고침', '그룹웨어에서 상태를 다시 읽어요. 결재가 끝난 출장은 아래로 숨겨져요.'],
  ],
  report: [
    ['#r_drop', '① 영수증 넣기', '영수증·증빙(사진·PDF)을 끌어다 놓으면 AI 가 과목·금액·날짜를 읽어 채워요. 정산할 게 없으면 건너뛰세요.'],
    ['#rq_memo', '② 한 일 한 줄', '출장에서 한 일을 한 줄로 쓰세요. 보고서 본문을 써 드려요.'],
    ['#btnRQuick', '✦ 자동 작성', '영수증과 한 줄로 보고서와 정산 경비를 채우고, 자차였으면 유류대(네이버 지도 캡처)까지 조회해요. 그러면 아래가 펼쳐져요.'],
    ['#rManual', '직접 입력', 'AI 없이 칸을 하나씩 채우고 싶으면 이걸 누르세요.'],
  ],
  reportResult: [
    ['#rReceipt', '정산 영수증', '과목별 정산 금액과 증빙이 몇 개 붙었는지 보여요.'],
    ['#rFold .fold-head', '세부 내용', '자금과목(일반경비·제조경비)과 경비 줄을 여기서 확인하세요.'],
    ['#btnReport', '그룹웨어에 정산 입력하기', '결의서 전송과 출장보고서 결재 창까지 띄워요. [상신]은 직접.'],
  ],
  purchase: [
    ['#pu_src_seg', '발주서 / 제품 주소', '발주서·견적서 파일이 있으면 [발주서 파일], 온라인에서 살 거면 [제품 페이지 주소]. 둘 중 하나만 써요.'],
    ['#po_drop:not(.hidden), #pu_urlbox:not(.hidden)', '① 올리기', '발주서·견적서 파일을 끌어다 놓거나, 제품 페이지 주소를 넣으세요.'],
    ['#pu_memo', '② 한 줄 메모', '무엇에 쓰려고 사는지 한 줄. 예) "협동로봇 주변기기 개발용 카메라"'],
    ['#btnPuDraft', '✦ 자동 작성', '발주서·페이지를 읽어 거래처·품목·금액을 채우고, 메모로 제목과 구매 상세 사유(밑에 구매 제품 내용)를 써요. 그러면 아래가 펼쳐져요.'],
    ['#puManual', '직접 입력', 'AI 없이 칸을 하나씩 채우고 싶으면 이걸 누르세요.'],
  ],
  purchaseResult: [
    ['#puInfo', '구매 정보', '구매목적·프로젝트명·긴급도·대체 가능 여부·납기는 직접 고르세요. 정부과제·기타는 세부 프로젝트명이 꼭 필요해요.'],
    ['#puReady', '제출 준비', '빠진 게 있으면 여기에 남아요. 다 되면 [그룹웨어에 입력하기].'],
    ['#btnPurchase', '그룹웨어에 입력하기', '본문·첨부·수신및참조까지 채워 작성 창을 띄워요. 시행자·결재라인은 꼭 직접 선택하고 [상신]을 눌러 주세요.'],
  ],
};
GUIDES.applyAll = [...GUIDES.apply.filter(x => x[0] !== '#aManual'), ...GUIDES.applyResult];   // [❓ 가이드]를 펼친 뒤에 누르면 전부
let gd = null;
const seenGuide = k => { try { return localStorage['guide_' + k] === '1'; } catch(e){ return true; } };
const markGuide = k => { try { localStorage['guide_' + k] = '1'; } catch(e){ /* */ } };
function gdShow(){
  const visible = sel => [...document.querySelectorAll(sel)].find(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  while(gd && gd.i < gd.steps.length && !visible(gd.steps[gd.i][0])) gd.i += gd.dir;   // 지금 안 보이는 칸은 건너뜀
  if(!gd || gd.i < 0 || gd.i >= gd.steps.length) return gdEnd();
  const [sel, title, text] = gd.steps[gd.i], el = visible(sel);
  const tall = el.getBoundingClientRect().height > innerHeight * 0.55;   // 화면보다 큰 칸은 윗부분만 짚음
  el.scrollIntoView({ block: tall ? 'start' : 'center' }); if(tall) scrollBy(0, -90);
  requestAnimationFrame(() => {
    const b = el.getBoundingClientRect(), r = tall ? { top: b.top, left: b.left, width: b.width, height: Math.min(b.height, 220), bottom: b.top + Math.min(b.height, 220) } : b, pad = 6, hole = $('#gdHole'), card = $('#gdCard');
    Object.assign(hole.style, { top: r.top - pad + 'px', left: r.left - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    $('#gdStep').textContent = `${gd.i + 1} / ${gd.steps.length}`; $('#gdTitle').textContent = title; $('#gdText').textContent = text;
    $('#gdPrev').disabled = gd.i === 0; $('#gdNext').textContent = gd.i === gd.steps.length - 1 ? '시작하기 ✦' : '다음';
    const ch = card.offsetHeight || 160, below = r.bottom + 14 + ch < innerHeight;
    card.style.top = Math.max(12, below ? r.bottom + 14 : r.top - ch - 14) + 'px';
    card.style.left = Math.min(innerWidth - card.offsetWidth - 16, Math.max(16, r.left)) + 'px';
  });
}
function gdStart(key, force = false){
  if(!GUIDES[key] || (!force && seenGuide(key)) || gd) return;
  gd = { key, steps: GUIDES[key], i: 0, dir: 1 }; $('#guide').classList.remove('hidden'); gdShow();
}
function gdEnd(){ if(gd) markGuide(gd.key); gd = null; $('#guide').classList.add('hidden'); }
$('#gdNext').onclick = () => { if(!gd) return; gd.dir = 1; gd.i++; gdShow(); };
$('#gdPrev').onclick = () => { if(!gd) return; gd.dir = -1; gd.i--; gdShow(); };
$('#gdSkip').onclick = gdEnd;
addEventListener('keydown', e => { if(!gd) return; if(e.key === 'Escape') gdEnd(); else if(e.key === 'ArrowRight' || e.key === 'Enter') $('#gdNext').click(); else if(e.key === 'ArrowLeft') $('#gdPrev').click(); });
addEventListener('resize', () => { if(gd) gdShow(); });
GUIDES.reportAll = [...GUIDES.report.filter(x => x[0] !== '#rManual'), ...GUIDES.reportResult];
GUIDES.purchaseAll = [...GUIDES.purchase.filter(x => x[0] !== '#puManual'), ...GUIDES.purchaseResult];
const ALL = { apply: ['#tab-apply', 'applyAll'], report: ['#reportView', 'reportAll'], purchase: ['#puNew', 'purchaseAll'] };   // 펼친 뒤 [❓ 가이드] = 전부
$$('[data-guide]').forEach(b => b.addEventListener('click', () => { const a = ALL[b.dataset.guide]; gdStart(a && !$(a[0]).classList.contains('pre') ? a[1] : b.dataset.guide, true); }));
// 보고서가 펼쳐지면(자동 작성 뒤) 펼친 부분 가이드
for (const id of ['#reportView', '#puNew']) { const v = $(id); new MutationObserver(() => { if(!v.classList.contains('pre') && !v.classList.contains('hidden')) maybeGuide(); }).observe(v, { attributes: true, attributeFilter: ['class'] }); }
// 화면에 처음 들어올 때: 지금 보이는 화면의 가이드 (작업 중 딤·모달이 떠 있으면 다음 기회에)
function currentGuide(){
  if(!$('#tab-apply').classList.contains('hidden')) return $('#tab-apply').classList.contains('pre') ? 'apply' : (seenGuide('apply') ? 'applyResult' : 'apply');
  if(!$('#tab-trips').classList.contains('hidden')) return $('#reportView').classList.contains('hidden') ? 'trips' : $('#reportView').classList.contains('pre') ? 'report' : (seenGuide('report') ? 'reportResult' : 'report');
  if(!$('#tab-purchase').classList.contains('hidden') && !$('#puNew').classList.contains('hidden')) return $('#puNew').classList.contains('pre') ? 'purchase' : (seenGuide('purchase') ? 'purchaseResult' : 'purchase');
  return '';
}
function maybeGuide(){ setTimeout(() => { const busy = $('#dim').classList.contains('on') || $$('#cfmModal.on, #askModal.on, #carModal.on, #loginModal.on').length; const k = currentGuide(); if(k && !busy) gdStart(k); }, 600); }
$$('nav button, .trip-view label, input[name=pu_view]').forEach(b => b.addEventListener(b.tagName === 'INPUT' ? 'change' : 'click', maybeGuide));
if(typeof window.showReport === 'function'){ const _sr = window.showReport; window.showReport = async function(...a){ const r = await _sr.apply(this, a); maybeGuide(); return r; }; }
maybeGuide();
