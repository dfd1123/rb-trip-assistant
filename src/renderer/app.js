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
  amt.oninput = () => { amt.value = amt.value ? num(amt.value).toLocaleString('ko-KR') : ''; onchange(); };
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
    dates: {start: $('#a_start').value, end: $('#a_end').value},
    category: radio('a_category'), project: $('#a_project').value.trim(),
    transport: t, companions: list($('#a_companions').value),
    companion_purpose: $('#a_companion_purpose').value.trim(),
    purpose: $('#a_purpose').value.trim(), expenses: readExp($('#a_exp tbody')),
  };
}
function fillApply(d){
  $('#a_reason').value = d.reason||''; $('#a_destination').value = d.destination||'';
  $('#a_start').value = (d.dates||{}).start||''; $('#a_end').value = (d.dates||{}).end||'';
  setRadio('a_category', d.category||'일반'); $('#a_project').value = d.project||'';
  const t = d.transport||{}; setRadio('a_mode', t.mode||'car');
  $('#a_to').value = t.to||''; if(t.from) $('#a_from').value = t.from;
  $('#a_fare').value = t.total ? Number(t.total).toLocaleString('ko-KR') : ''; fareShot = '';
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
  const r = await rpc('/api/prompt'); await rpc('/api/copy', {text: r.text});
  $('#copied').textContent = '복사됨. AI 채팅에 붙여 넣으세요.';
};
$('#btnFill').onclick = async () => {
  $('#aiErr').textContent = '';
  try { fillApply((await rpc('/api/parse', {text: $('#aiPaste').value})).data); }
  catch(e){ $('#aiErr').textContent = e.message; }
};
$('#btnFare').onclick = () => {
  const d = applyData();
  runJob('교통비 조회', '/api/job/fare', {mode: d.transport.mode, to: d.transport.to, from: d.transport.from}, r => {
    if(r && r.total){ $('#a_fare').value = r.total.toLocaleString('ko-KR'); fareShot = r.screenshot||''; $('#a_fare_desc').innerHTML = '<b></b> <a href="#">캡처 보기</a>'; $('#a_fare_desc b').textContent = r.describe; $('#a_fare_desc a').onclick = e => { e.preventDefault(); rpc('/api/open', {path: fareShot}); }; refreshApply(); }
  });
};
$('#btnApply').onclick = async () => {
  $('#a_err').textContent = '';
  const data = applyData();
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
      <div class="sub" style="margin:2px 0 0">${t.start} ~ ${t.end}</div></div><button class="btn">보고서 작성</button>`;
    el.querySelector('b').textContent = t.reason;
    el.querySelector('button').onclick = () => openReport(t.id);
    $('#trips').appendChild(el);
  });
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
$('#btnAddDay').onclick = () => schedRow();
$('#btnAddRExp').onclick = () => expRow($('#r_exp tbody'), {}, refreshReport);
$('#btnBack').onclick = () => { $('#reportView').classList.add('hidden'); $('#tripList').classList.remove('hidden'); };
$('#btnRPrompt').onclick = async () => { await rpc('/api/copy', {text: reportPrompt}); $('#rcopied').textContent = '복사됨'; };
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

/* ---------- 작업 패널 ---------- */
let jobTimer = null, jobSince = 0;
async function runJob(title, path, body, onDone){
  try { await rpc(path, body); } catch(e){ alertErr(e.message); return; }
  $('#jobTitle').textContent = title; $('#jobLog').textContent = ''; jobSince = 0;
  $('#jobPanel').style.display = 'block'; $$('.btn.primary').forEach(b => b.disabled = true);
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
    if(s.state==='done' || s.state==='error'){
      clearInterval(jobTimer); $$('.btn.primary').forEach(b => b.disabled = false);
      if(s.state==='error') $('#jobLog').textContent += '\n✖ ' + s.error + '\n';
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
function alertErr(m){ $('#jobPanel').style.display='block'; $('#jobTitle').textContent='오류'; $('#jobLog').textContent = m; $('#jobAsk').style.display='none'; }

/* ---------- 시작 ---------- */
(async () => {
  META = await rpc('/api/meta');
  const c = META.config; $('#ver').textContent = 'v' + META.version;
  $('#s_name').value = c.name; $('#s_dept').value = c.budgetDept; $('#s_origin').value = c.defaultOrigin;
  $('#a_from').value = c.defaultOrigin;
  expRow($('#a_exp tbody'), {item:'domestic_lodging'}, refreshApply);
  expRow($('#a_exp tbody'), {item:'meal'}, refreshApply);
  if(!META.configured || !c.name){ $$('nav button')[2].click(); $('#s_msg').textContent = '처음이면 이름부터 저장해 주세요'; }
})();
