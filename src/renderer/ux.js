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
  if(from === target){ el.textContent = won(target); return; }
  const t0 = performance.now(), dur = 520;
  const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
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
wrapFill('fillReport', '#reportView');
wrapFill('applyReceipts', '#reportView');

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
  const btn = !$('#tab-apply').classList.contains('hidden') ? $('#btnApply') : !$('#reportView').classList.contains('hidden') ? $('#btnReport') : null;
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
  if(!ovs && mode !== 'corporate' && fareTxt) by['교통비'] = (by['교통비'] || 0) + num(fareTxt);
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
  const max = Math.max(1, ...Object.values(by).map(o => o.sum));
  const rows = $('#rcRows'); rows.innerHTML = '';
  if(!exps.length) rows.innerHTML = '<div class="rc-empty">아직 정산할 경비가 없어요<br>영수증을 넣으면 여기에 쌓여요</div>';
  Object.entries(by).forEach(([k, o]) => {
    const d = document.createElement('div'); d.className = 'rc-row';
    d.innerHTML = '<div class="t"><b></b><span></span></div><div class="bar"><i></i></div><div class="cap"></div>';
    d.querySelector('b').textContent = k; d.querySelector('.t span').textContent = won(o.sum);
    d.querySelector('.cap').textContent = `${o.n}건 · 증빙 ${o.proof}/${o.n}`;
    rows.appendChild(d); requestAnimationFrame(() => { d.querySelector('.bar i').style.width = Math.round(o.sum / max * 100) + '%'; });
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
setInterval(() => { try { updateApply(); updateReport(); foldBadge('#aFold'); foldBadge('#rFold'); updateFab(); } catch(e){ /* 화면 준비 전 */ } }, 350);
// 다른 출장 보고서를 열거나 새로 작성하면 다시 접음
const _showReport = window.showReport; if(typeof _showReport === 'function') window.showReport = async function(...a){ setFold('#rFold', false); return _showReport.apply(this, a); };
const _resetApply = window.resetApply; if(typeof _resetApply === 'function') window.resetApply = function(...a){ setFold('#aFold', false); return _resetApply.apply(this, a); };

/* ---------- 화면을 새로 그려도(개발 중 코드 반영 등) 보던 탭 유지 ---------- */
$$('nav button').forEach(b => b.addEventListener('click', () => { try { sessionStorage.ta_tab = b.dataset.tab; } catch(e){ /* */ } }));
try { const t = sessionStorage.ta_tab; const b = t && t !== 'apply' && $(`nav button[data-tab="${t}"]`); if(b) setTimeout(() => b.click(), 0); } catch(e){ /* */ }
