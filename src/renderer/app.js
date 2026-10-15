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
  if(b.dataset.tab==='trips') loadTrips();
});

/* ---------- 경비 표 ---------- */
function expRow(tbody, e={}, onchange){
  const tr = document.createElement('tr');
  const opts = Object.entries(META.items).filter(([k]) => tbody.id!=='a_exp' || k!=='domestic_transport')
    .map(([k,v]) => `<option value="${k}">${v.replace('여비교통비(판)_','')}</option>`).join('');
  tr.innerHTML = `<td><select>${opts}</select></td><td><input inputmode="numeric"></td><td><input placeholder="비우면 자동"></td><td><button class="btn small">✕</button></td>`;
  const [sel, amt, memo] = tr.querySelectorAll('select,input');
  sel.value = e.item || (tbody.id==='a_exp' ? 'domestic_lodging' : 'domestic_transport');
  amt.value = e.amount ? Number(e.amount).toLocaleString('ko-KR') : '';
  memo.value = e.memo || '';
  amt.oninput = () => { amt.value = amt.value ? num(amt.value).toLocaleString('ko-KR') : ''; if(tbody.id==='a_exp') autoExp = false; onchange(); };
  sel.onchange = memo.oninput = onchange;
  tr.querySelector('button').onclick = () => { tr.remove(); onchange(); };
  tbody.appendChild(tr); onchange();
}
const readExp = tbody => [...tbody.querySelectorAll('tr')].map(tr => {
  const [sel, amt, memo] = tr.querySelectorAll('select,input');
  return {item: sel.value, amount: num(amt.value), memo: memo.value.trim()};
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
  const map = {'날짜': ['#a_start','#a_end'], '출발 시각': ['#a_start_time'], '복귀 시각': ['#a_end_time'], '출장지': ['#a_destination'], '사유': ['#a_reason']};
  $$('.need').forEach(el => el.classList.remove('need'));
  missing.forEach(m => (map[m]||[]).forEach(id => $(id).classList.add('need')));
}
$$('#a_start,#a_end,#a_start_time,#a_end_time,#a_destination,#a_reason').forEach(el => ['input','change'].forEach(ev => el.addEventListener(ev, () => el.classList.remove('need'))));
$('#btnQuick').onclick = async () => {
  const memo = $('#q_memo').value.trim();
  if(!memo){ $('#q_memo').focus(); return; }
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
function renderPlaces(){
  $('#q_places').innerHTML = '';
  (META.places||[]).forEach(p => {
    const c = document.createElement('button'); c.className = 'chip'; c.textContent = (p.aliases && p.aliases[0]) || p.name; c.title = p.name;
    c.onclick = () => { const m = $('#q_memo'); m.value = (m.value.trim() + ' ' + c.textContent).trim() + ' '; m.focus(); };
    $('#q_places').appendChild(c);
  });
}
$('#btnApply').onclick = async () => {
  $('#a_err').textContent = '';
  const data = applyData();
  const need = [];
  if(!data.dates.start || !$('#a_end').value) need.push('날짜');
  if(!data.dates.start_time) need.push('출발 시각');
  if(!data.dates.end_time) need.push('복귀 시각');
  if(need.length){ markNeed(need); $('#a_err').textContent = `${need.join(', ')}을(를) 넣어 주세요.`; return; }
  try { await rpc('/api/plan', data); } catch(e){ $('#a_err').textContent = e.message; return; }
  runJob('출장신청서 입력', '/api/job/apply', {data, save: $('#a_save').checked}, () => loadTrips());
};

/* ---------- 내 출장 / 보고서 ---------- */
async function loadTrips(){
  const {trips} = await rpc('/api/trips');
  $('#trips').innerHTML = trips.length ? '' : '<p class="sub">아직 신청 기록이 없어요.</p>';
  trips.forEach(t => {
    const el = document.createElement('div'); el.className = 'item';
    el.innerHTML = `<div><b></b><span class="pill ${t.status==='보관됨'?'ok':''}">신청 ${t.status||'-'}</span><span class="pill ${t.report==='보관됨'?'ok':''}">보고 ${t.report||'-'}</span>
      <div class="sub" style="margin:2px 0 0">${t.start} ~ ${t.end}</div></div><div class="inline"><button class="btn again">다시 신청</button><button class="btn primary rep">보고서 작성</button></div>`;
    el.querySelector('b').textContent = t.reason;
    el.querySelector('.rep').onclick = () => openReport(t.id);
    el.querySelector('.again').onclick = () => repeatTrip(t.id);
    $('#trips').appendChild(el);
  });
}
async function repeatTrip(id){
  const {data} = await rpc('/api/repeat', {id});
  $$('nav button')[0].click();
  fillApply(data); autoExp = true; markNeed(['날짜']); showMealPlan(null);
  $('#q_status').textContent = '지난 출장 내용을 불러왔어요. 날짜만 고르면 경비는 규정대로 다시 계산돼요.';
  $('#a_start').focus();
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
  const r = await rpc('/api/draft', {id});
  currentTrip = r.draft; reportPrompt = r.prompt;
  $('#r_heading').textContent = r.draft.reason; $('#r_trip').textContent = `신청 ID ${id}`;
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
  $('#btnRQuick').disabled = true; $('#rq_status').textContent = '작성 중…';
  try {
    const r = await rpc('/api/report-quick', {id: currentTrip.trip_id, memo: $('#rq_memo').value});
    fillReport({...reportData(), ...r.data});
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
$('#btnReport').onclick = () => {
  $('#r_err').textContent = '';
  const d = reportData();
  if(!d.report){ $('#r_err').textContent = '담당업무 및 보고사항을 입력해 주세요.'; return; }
  runJob('출장보고서 입력', '/api/job/report', {data: d, save: $('#r_save').checked}, () => loadTrips());
};

/* ---------- 설정 ---------- */
$('#btnSave').onclick = async () => {
  await rpc('/api/config', {name: $('#s_name').value.trim(), budgetDept: $('#s_dept').value.trim(), defaultOrigin: $('#s_origin').value.trim()});
  $('#s_msg').textContent = '저장됨'; META = await rpc('/api/meta'); $('#a_from').value ||= META.config.defaultOrigin;
};
$('#btnLogin').onclick = () => runJob('로그인 확인', '/api/job/login', {});
function loadAiSettings(){
  const c = META.config, sel = $('#s_ai');
  sel.innerHTML = '<option value="">사용 안 함 (템플릿)</option>' + Object.entries(META.providers).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('');
  sel.value = c.aiProvider || ''; $('#s_model').value = c.aiModel || '';
  $('#s_model').placeholder = c.aiProvider ? `기본: ${META.providers[c.aiProvider].model}` : '비우면 기본 모델';
  $('#s_key').value = ''; $('#s_key').placeholder = c.aiKeySet ? '저장됨 (바꾸려면 새 키 입력)' : 'API 키 붙여넣기';
  const r = c.rates; $('#s_lodging').value = r.lodgingPerNight; $('#s_breakfast').value = r.breakfast; $('#s_lunch').value = r.lunch; $('#s_dinner').value = r.dinner;
  const mt = c.mealTimes; [['bf','breakfast'],['lu','lunch'],['di','dinner']].forEach(([a,k]) => { $(`#s_${a}_from`).value = mt[k][0]; $(`#s_${a}_to`).value = mt[k][1]; });
}
$('#s_ai').onchange = () => { const k = $('#s_ai').value; $('#s_model').placeholder = k ? `기본: ${META.providers[k].model}` : '비우면 기본 모델'; };
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
async function runJob(title, path, body, onDone){
  try { await rpc(path, {...body, title}); } catch(e){ alertErr(e.message); return; }
  watchJob(title, onDone);
}
/** 진행 중인 작업 화면에 붙기 (새 작업 시작, 또는 새로고침 후 이어보기) */
function watchJob(title, onDone){
  $('#jobTitle').textContent = title; $('#jobLog').textContent = ''; jobSince = 0;
  $('#jobPanel').style.display = 'block'; $('#jobCancel').classList.remove('hidden'); $$('main .btn.primary').forEach(b => b.disabled = true);
  clearInterval(jobTimer);
  jobTimer = setInterval(async () => {
    const s = await rpc('/api/job', {since: jobSince});
    if(s.logs && s.logs.length){ $('#jobLog').textContent += s.logs.join('\n') + '\n'; $('#jobLog').scrollTop = 1e9; jobSince = s.next; }
    const q = s.question;
    $('#jobAsk').style.display = q ? 'block' : 'none';
    if(q){
      $('#jobQ').textContent = q.text;
      $('#jobInput').classList.toggle('hidden', q.type!=='int');
      $('#jobNo').classList.toggle('hidden', q.type!=='confirm');
      $('#jobYes').textContent = q.type==='confirm' ? '예' : q.type==='int' ? '입력' : '계속';
    }
    if(s.state==='done' || s.state==='error' || s.state==='cancelled' || s.state==='none'){
      clearInterval(jobTimer); $$('main .btn.primary').forEach(b => b.disabled = false); $('#jobCancel').classList.add('hidden'); $('#jobAsk').style.display='none';
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
$('#jobClose').onclick = () => $('#jobPanel').style.display = 'none';
$('#jobCancel').onclick = () => rpc('/api/job/cancel');
function alertErr(m){ $('#jobPanel').style.display='block'; $('#jobTitle').textContent='오류'; $('#jobLog').textContent = m; $('#jobAsk').style.display='none'; }

/* ---------- 시작 ---------- */
(async () => {
  META = await rpc('/api/meta');
  const c = META.config; $('#ver').textContent = 'v' + META.version;
  $('#s_name').value = c.name; $('#s_dept').value = c.budgetDept; $('#s_origin').value = c.defaultOrigin;
  $('#a_from').value = c.defaultOrigin;
  renderPlaces(); loadAiSettings();
  const checkUpdate = async () => {
    const u = await rpc('/api/update').catch(() => null);
    if(!u || !['available','downloaded','downloading'].includes(u.status)) return;
    $('#updBar').classList.remove('hidden');
    $('#updText').textContent = u.status === 'downloaded' ? `새 버전 v${u.version} 준비 완료. 재시작하면 적용돼요.`
      : u.status === 'downloading' ? `새 버전 v${u.version} 받는 중…` : `새 버전 v${u.version}이 나왔어요 (지금 v${u.current}).`;
    $('#updBtn').classList.toggle('hidden', u.status === 'downloading');
    $('#updBtn').textContent = u.status === 'downloaded' ? '지금 재시작' : '다운로드';
  };
  $('#updBtn').onclick = () => rpc('/api/update/install');
  setTimeout(checkUpdate, 8000); setInterval(checkUpdate, 60000);
  const cur = await rpc('/api/job').catch(() => null);          // 새로고침 전 작업이 남아 있으면 이어서 보여주기
  if(cur && (cur.state === 'running' || cur.state === 'waiting')) watchJob(cur.title || '진행 중인 작업', cur.kind === 'fare' ? r => setFare(r) : (cur.kind === 'apply' || cur.kind === 'report') ? () => loadTrips() : null);
  $('#q_memo').focus();
  if(!META.configured || !c.name){ $$('nav button')[2].click(); $('#s_msg').textContent = '처음이면 이름부터 저장해 주세요'; }
})();
