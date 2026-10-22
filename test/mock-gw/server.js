'use strict';
// 아마란스10 흉내 서버 (자동 입력 엔진 E2E 테스트용).
// 실제 화면에서 확인한 구조를 재현: RealGrid2 DOM 클래스, 코드도움 모달, 결재상신 모달, window.open 팝업,
// dzEditor iframe(본문은 실제 '출장신청 및 출장경비 사전품의' 양식 HTML).

const http = require('http');
const fs = require('fs');
const path = require('path');

const FIX = path.join(__dirname, '..', 'fixtures');
const saved = [];
let settle = null;   // 정산 화면 상태 (settle.js). 테스트가 setSettle 로 넣고 getSettle 로 읽음

const INDEX = `<!doctype html><html><head><meta charset="utf-8"><title>Amaranth 10 (mock)</title><style>
body{font-family:sans-serif;margin:0} .rg-root{border:1px solid #ccc;margin:10px;width:1200px} table{border-collapse:collapse}
td{border:1px solid #ddd;height:28px;min-width:90px;padding:0 4px;position:relative} .rg-checkbar-cell{min-width:24px}
.rg-list-editor{position:absolute;background:#fff;border:1px solid #888;z-index:5} .rg-list-editor div{padding:4px 10px;cursor:pointer}
.dlg{position:fixed;left:200px;top:120px;width:600px;background:#fff;border:2px solid #333;z-index:10;padding:10px}
.dlg .r{padding:4px;border-bottom:1px solid #eee;cursor:pointer} .bar{position:fixed;bottom:0;left:0;right:0;background:#556;padding:8px}
input.rg-editor{position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box}
</style></head><body><div id="app"></div><script src="/settle.js"></script><script src="/compose.js"></script><script>
const $=s=>document.querySelector(s);
// 가짜 API: 실제 아마란스처럼 로그인하면 oAuthToken·signKey 쿠키와 사용자 정보가 생기고, 품의 목록은 fetch 로 받는다 (앱은 목록을 API 로만 읽음)
const ST={'작성':'2','상신대기':'2','진행중':'0','결재진행':'0','결재완료':'1','반려':'3'};
const toApi=r=>({getDtYymm:(r.품의연월||'').replace('-',''),getDtDd:r.품의일,getSq:r.순번,getFg:r.품의구분==='지출'?'1':'2',rmkDc:r.적요||'',unitSumam:Number(String(r.총금액||'0').replace(/,/g,'')),approState:ST[r.결재상태]||'2',approStateNm:r.결재상태||'',noDoc:'',sendUnitAm:0,refundUnitAm:0,remainUnitAm:0});
const realFetch=window.fetch.bind(window);
window.fetch=async(url,opt)=>{ const u=String(url);
  if(u.endsWith('/nonprofit/NCA0018/0BN00001')){ const b=JSON.parse((opt&&opt.body)||'{}'); const ym=String(b.getDtYearMonth||'').slice(0,6);
    const st=await realFetch('/settle/state').then(r=>r.json()).catch(()=>null);   // 정산 mock 의 신청 품의도 목록에 (출장 보고 화면 테스트)
    const extra=st&&st.approve?st.approve.map(a=>({품의연월:a.품의연월,품의일:a.품의일,순번:a.순번,품의구분:'지출',적요:a.적요+'로 인한 출장',총금액:a.총금액,결재상태:a.결재상태})):[];
    const top=JSON.parse(localStorage.top||'[]').concat(extra).filter(r=>r.순번&&(r.품의연월||'').replace('-','')===ym&&(!b.getDt||String(+r.품의일)===String(+b.getDtDate)));
    return new Response(JSON.stringify({resultCode:0,resultData:top.map(toApi)}),{status:200,headers:{'Content-Type':'application/json'}}); }
  if(u.endsWith('/eap/eap107A04')) return new Response(JSON.stringify({resultCode:200,resultData:{list:{list:[],totalCount:0}}}),{status:200,headers:{'Content-Type':'application/json'}});
  return realFetch(url,opt); };
function route(){
  if(localStorage.auth){ document.cookie='oAuthToken=mock-token; path=/'; document.cookie='signKey=mock-key; path=/'; sessionStorage.userInfo=JSON.stringify({coCd:'1000',deptCd:'MBU1000',empCd:'250303'}); }
  if(!localStorage.auth){ if(location.hash!=='#/login') location.hash='#/login'; return loginPage(); }
  if(location.hash.startsWith('#/HP/NPC1023/NCA0018')) return budget();
  if(window.settleRoute && window.settleRoute(location.hash)) return;
  if(window.composeRoute && window.composeRoute(location.hash)) return;
  $('#app').innerHTML='<h1>일정 HOME</h1>';
}
// 로그인: 아이디 → [다음] → 비밀번호 (두 단계). 테스트 계정 tester / pw1234
function loginPage(){
  $('#app').innerHTML='<h1>로그인</h1><div id="lg"><input type="text" id="uid" placeholder="아이디"> <button id="next">다음</button></div><p id="lgerr"></p>';
  // 실제 아마란스처럼: 2단계는 아이디가 고정(disabled 입력칸)되고, 틀리면 그 화면에 그대로 남는다. [다른계정으로 로그인]으로 1단계로
  $('#next').onclick=()=>{ const id=$('#uid').value; if(!id) return;
    $('#lg').innerHTML='<input type="text" id="uid_fixed" disabled value="'+id+'"> <input type="password" id="upw" placeholder="비밀번호"> <button id="lgbtn">로그인</button><br><a href="#" id="other">다른계정으로 로그인</a>';
    const go=()=>{ if(id==='tester'&&$('#upw').value==='pw1234'){ localStorage.auth=1; location.hash='#/main'; } else $('#lgerr').textContent='! 아이디/비밀번호가 일치하지 않습니다.'; };
    $('#upw').addEventListener('keydown',e=>{ if(e.key==='Enter') go(); }); $('#lgbtn').onclick=go;
    $('#other').onclick=e=>{ e.preventDefault(); loginPage(); $('#uid').value=id; }; };
  $('#uid').addEventListener('keydown',e=>{ if(e.key==='Enter') $('#next').click(); });
}
window.addEventListener('hashchange', route);
const TOP=['품의연월','품의일','순번','품의구분','적요','총금액','결재상태','문서번호'], BOT=['부서','예산과목','품의금액','적요','첨부파일'];
// 실제 사업코드도움: 부서코드 | 부서명, 행이 많고 보이는 행만 그림(가상 스크롤). 매니퓰레이터 사업부는 아래쪽.
const DEPTS=[];for(let i=0;i<30;i++)DEPTS.push(['D'+(1000+i),'테스트부서'+i]);DEPTS.splice(24,0,['MBU1000','매니퓰레이터 사업부']);
const SEARCH='__SEARCH__';   // enter: Enter로 검색 / button: 돋보기 버튼만 / none: 검색 안 됨(스크롤로 찾기)
const CODES=[['8120002','여비교통비(판)_국내교통비'],['8120003','여비교통비(판)_국내숙박비'],['8120004','여비교통비(판)_식대']];
let S;
function budget(){
  // 위쪽 품의 목록은 새로고침해도 남도록 localStorage 에 보관 (삭제 테스트용). 순번 44 는 결재 진행 중인 기존 품의
  const def=[1,2,3,4].map(n=>({품의연월:'2026-10',품의일:'14',순번:String(39+n),품의구분:'지출',적요:'예전 품의',총금액:'1,000',결재상태:'결재완료'}))
    .concat([{품의연월:'2026-10',품의일:'14',순번:'44',품의구분:'지출',적요:'기존 품의',총금액:'10,000',결재상태:'진행중'},{품의연월:'2026-10',품의일:'14'}]);
  S={top:JSON.parse(localStorage.top||'null')||def,bot:[],focus:null,enter:0,checked:-1,marks:new Set(),off:null,stick:true};
  render();
}
// 실제 RealGrid 처럼 보이는 행만 DOM 에 그림: 위쪽 목록은 마지막 5행만 (화면상 행 번호 ≠ 데이터 행 번호)
function gridHtml(id,cols,all){
  const maxOff=Math.max(0,all.length-5); if(id==='top'&&(S.off==null||S.off>maxOff||S.stick)) S.off=maxOff;
  const off=id==='top'?S.off:0, rows=id==='top'?all.slice(off,off+5):all;
  return '<div class="rg-root" id="'+id+'"><table class="rg-header"><tr><td class="rg-head-cell rg-checkbar-head"></td>'+cols.map(c=>'<td class="rg-header-cell"><span class="rg-header-renderer">'+c+'</span></td>').join('')+'</tr></table>'+
   '<table class="rg-body">'+rows.map((r,j)=>{const i=j+off; return '<tr class="rg-data-row"><td class="rg-checkbar-cell" data-i="'+i+'">'+(id==='top'&&S.marks&&S.marks.has(i)?'☑':'☐')+'</td>'+cols.map(c=>'<td class="rg-data-cell'+((c==='부서'||c==='예산과목')&&id==='bot'?' rg2-button-codepicker':'')+'" data-g="'+id+'" data-r="'+i+'" data-c="'+c+'"><div class="rg-renderer">'+(r[c]||'')+'</div>'+((c==='부서'||c==='예산과목')&&id==='bot'?'<div class="rg-cell-buttons" style="position:absolute;right:2px;top:5px"><div class="rg-button-action" style="width:18px;height:18px;background:#ccc"></div></div>':'')+'</td>').join('')+'</tr>';}).join('')+'</table></div>';
}
function render(){
  localStorage.top=JSON.stringify(S.top);
  // 실제 화면처럼 위쪽 그리드 React fiber 에 RealGrid2 데이터 공급자(getRowCount/getJsonRow)를 달아 둔다
  const ST={'진행중':'0','결재완료':'1','작성':'2','상신대기':'2'};
  const dp={ getRowCount:()=>S.top.length, getJsonRow:i=>{const r=S.top[i]; if(!r) return null; return r.순번?{getDtYymm:(r.품의연월||'').replace('-',''),getDtDd:r.품의일,getSq:r.순번,getFg:r.품의구분==='지출'?'1':'2',rmkDc:r.적요||'',unitSumam:Number(String(r.총금액||'0').replace(/,/g,''))+'.0000',approState:ST[r.결재상태]||'2',noDoc:''}:{getDtYymm:'',getSq:''};} };
  $('#app').innerHTML='<div class="tools"><button id="btnPrint" title="인쇄"><img src="/ic_print.png" alt=""></button><button id="btnDel" title="삭제"><img src="/ic_delete.png" alt=""></button></div>'+gridHtml('top',TOP,S.top)+gridHtml('bot',BOT,S.bot)+(S.checked>=0?'<div class="bar"><button id="btnAppr">결재상신</button></div>':'');
  $('#top').__reactFiber$mock={memoizedProps:{dataProvider:dp},stateNode:null,return:null};
  if($('#btnAppr')) $('#btnAppr').onclick=approvalDialog;
  $('#btnDel').onclick=()=>{ if(!S.marks.size) return; dialog('알림','<p>선택한 품의를 삭제하시겠습니까?</p>',()=>{ S.top=S.top.filter((r,i)=>!S.marks.has(i)||/진행|완료/.test(r.결재상태||'')); S.marks.clear(); S.checked=-1; render(); }); };
}
// 실제처럼 첨부파일 칸에서 Enter 로 확정된 행만 합계에 반영
const total=()=>S.bot.filter(r=>r.done).reduce((s,r)=>s+Number(String(r.품의금액||'0').replace(/,/g,'')),0);
function dialog(title, bodyHtml, onOk){
  const d=document.createElement('div'); d.className='dlg'; d.innerHTML='<h3>'+title+'</h3>'+bodyHtml+'<div><button class="cancel">취소</button><button class="ok">확인</button></div>';
  document.body.appendChild(d); d.querySelector('.cancel').onclick=()=>d.remove(); d.querySelector('.ok').onclick=()=>{ if(onOk(d)!==false) d.remove(); }; return d;
}
// 실제 코드도움 목록은 캔버스(RealGridJS). 글자가 DOM 에 없고, React fiber 의 props 에 GridView/DataProvider 가 있다.
function codeHelp(title, items, onPick){
  let shown=items, cur=-1, top=0;
  const d=dialog(title,'<label>검색어 <span id="name"><input type="text"></span></label> <button class="OBTConditionPanel_searchButton__x" style="width:28px;height:24px"><img src="/icon-btn-search.png" alt=""></button> <input class="OBTDatePickerRebuild_inputYMD__x" value="2026-10-15"><div data-orbit-component="OBTDataGrid" class="g" style="position:relative"><canvas width="560" height="243"></canvas></div>',()=>{ if(cur<0) return false; onPick(shown[cur]); });
  const cv=d.querySelector('canvas'), ctx=cv.getContext('2d'), H=27;
  const paint=()=>{ ctx.fillStyle='#fff'; ctx.fillRect(0,0,560,243); ctx.fillStyle='#000'; ctx.font='13px sans-serif'; ctx.fillText('코드',8,18); ctx.fillText('이름',200,18);
    for(let i=top;i<Math.min(shown.length,top+8);i++){ const y=H*(i-top+1); if(i===cur){ ctx.fillStyle='#cde'; ctx.fillRect(0,y,560,H); ctx.fillStyle='#000'; } ctx.fillText(shown[i][0],8,y+18); ctx.fillText(shown[i][1],200,y+18); } };
  const draw=q=>{ shown=items.filter(it=>!q||it.join(' ').includes(q)); cur=shown.length?0:-1; top=0; paint(); };
  const dp={ getRowCount:()=>shown.length, getJsonRow:i=>({CODE:shown[i][0], NAME:shown[i][1]}) };
  const gv={ setCurrent:c=>{ cur=c.dataRow!=null?c.dataRow:c.itemIndex; top=Math.max(0,cur-3); paint(); }, getItemIndex:i=>i, getDataSource:()=>dp, setFocus(){} };
  d.querySelector('.g').__reactFiber$mock={ memoizedProps:{ id:'g' }, return:{ memoizedProps:{ gridView:gv, provider:dp }, return:null } };
  cv.addEventListener('click',e=>{ const r=cv.getBoundingClientRect(); const i=top+Math.floor((e.clientY-r.top)/H)-1; if(i>=0&&i<shown.length){ cur=i; paint(); } });
  draw('');
  const q=d.querySelector('#name input');
  q.addEventListener('keydown',e=>{ if(e.key==='Enter'&&SEARCH==='enter') draw(q.value); });
  d.querySelector('.OBTConditionPanel_searchButton__x').onclick=()=>{ if(SEARCH!=='none') draw(q.value); };
}
function editCell(td, onCommit){
  const inp=document.createElement('input'); inp.className='rg-editor'; inp.value=td.querySelector('.rg-renderer').textContent; td.appendChild(inp); inp.focus();
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.stopPropagation(); const v=inp.value; inp.remove(); onCommit(v); } });
}
document.addEventListener('wheel',e=>{ if(!S||!e.target.closest('#top')) return; const maxOff=Math.max(0,S.top.length-5);
  S.off=Math.max(0,Math.min(maxOff,S.off+(e.deltaY>0?1:-1))); S.stick=S.off===maxOff; render(); },{passive:true});
document.addEventListener('dblclick',e=>{
  const td=e.target.closest('td.rg-data-cell'); if(!td) return; const g=td.dataset.g, r=+td.dataset.r, c=td.dataset.c;
  if(g==='top'&&c==='품의구분'){ const l=document.createElement('div'); l.className='rg-dropdownlist'; l.innerHTML='<div class="rg-dropdown-item"><span class="rg-dropdown-label">1.지출</span></div><div class="rg-dropdown-item"><span class="rg-dropdown-label">2.수입</span></div>';
    td.appendChild(l); l.querySelectorAll('.rg-dropdown-item').forEach(o=>o.onclick=ev=>{ ev.stopPropagation(); S.top[r].품의구분=o.textContent.replace(/^[0-9]+[.]/,''); render(); }); }
  if(g==='top'&&c==='적요') editCell(td,v=>{ S.top[r].적요=v; S.focus={g,r,c}; render(); });
  if(g==='bot'&&(c==='품의금액'||c==='적요')) editCell(td,v=>{ S.bot[r][c]=c==='품의금액'?Number(v.replace(/,/g,'')).toLocaleString('en-US'):v; S.focus={g,r,c:c==='적요'?'첨부파일':c}; render(); });
});
document.addEventListener('click',e=>{
  const cb=e.target.closest('td.rg-checkbar-cell');
  if(cb&&cb.closest('#top')){ const k=+cb.dataset.i; if(S.marks.has(k)) S.marks.delete(k); else S.marks.add(k); S.checked=k; S.top[S.checked].총금액=total().toLocaleString('en-US'); render(); return; }
  const td=e.target.closest('td.rg-data-cell'); if(!td) return; const g=td.dataset.g, r=+td.dataset.r, c=td.dataset.c;
  S.focus={g,r,c};
  // 실제처럼 셀 오른쪽 아이콘(.rg-button-action)을 눌러야 코드도움이 열림
  if(e.target.closest('.rg-button-action')){
    if(g==='bot'&&c==='부서') codeHelp('사업코드도움',DEPTS,it=>{ S.bot[r].부서=it[1]; render(); });
    if(g==='bot'&&c==='예산과목') codeHelp('예산과목코드도움',CODES,it=>{ S.bot[r].예산과목=it[1]; render(); });
  }
});
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter'||!S||!S.focus) return;
  const f=S.focus;
  if(f.g==='top'&&f.c==='품의구분'&&S.top[f.r].품의구분){ if(++S.enter===3){ S.top[f.r].순번=String(Math.max(...S.top.map(r=>+r.순번||0))+1); S.top[f.r].적요='출장'; S.top[f.r].결재상태='작성'; S.top.push({품의연월:'2026-10',품의일:'14'}); S.bot.push({}); S.focus={g:'bot',r:0,c:'부서'}; render(); } }
  else if(f.g==='bot'&&f.c==='첨부파일'){ S.bot[f.r].done=true; S.bot.push({}); S.focus={g:'bot',r:f.r+1,c:'부서'}; render(); }
});
function approvalDialog(){
  let form='품의서입력(복수)지출';
  const d=dialog('전자결재상신','<div>결재양식 <span class="dd">'+form+'</span><div class="opts" style="display:none"></div></div><div>제목 <input type="text" class="t"></div>',d=>{
    const t=d.querySelector('.t').value; if(!t) return false;
    window.__approval={form,title:t};
    window.open('/popup.html?form='+encodeURIComponent(form)+'&title='+encodeURIComponent(t),'popup_page_1','width=1000,height=900');
  });
  const opts=['품의서입력(복수)지출','품의서입력(복수)지출_정부과제 회의비 신청','출장신청 및 출장경비 사전품의','출장보고서 및 정산 품의서'];
  d.querySelector('.dd').onclick=()=>{ const o=d.querySelector('.opts'); o.style.display='block'; o.innerHTML=opts.map(x=>'<div class="r">'+x+'</div>').join('');
    o.querySelectorAll('.r').forEach(r=>r.onclick=()=>{ form=r.textContent; d.querySelector('.dd').textContent=form; o.style.display='none'; }); };
}
route();
</script></body></html>`;

// 구매의뢰서 작성 창 (실제 덤프 구조를 줄여서). MOCK_TEMPDRAFT=1 이면 "임시 저장 본문" 창을 늦게 띄움
const COMPOSE = `<!doctype html><html><head><meta charset="utf-8"><title>전자결재</title><style>
.OBTAutoCompleteChips_item__5KBpq{display:inline-block;margin:2px;padding:1px 4px;border:1px solid #aac} .ac{position:fixed;left:300px;top:220px;background:#fff;border:1px solid #888;z-index:9}
.ac li{padding:3px 8px;cursor:pointer;list-style:none} .tip{position:fixed;left:300px;top:200px;background:#333;color:#fff;font-size:11px;padding:2px 6px;z-index:10}
.tmp{position:fixed;inset:0;background:rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;z-index:20} .tmp .b{background:#fff;padding:16px}
</style></head><body>
<div><span class="title">전자결재</span><div class="topBtn">미리보기</div><div class="topBtn" id="keep">보관</div><div class="topBtn">상신</div></div>
<table border="1"><tbody>
<tr><td><p><span>기&nbsp;&nbsp;안&nbsp;&nbsp;자</span></p></td><td>이정우</td></tr>
<tr><td><p><span>작&nbsp;성&nbsp;부&nbsp;서</span></p></td><td class="bd_color textL pl5">개발 2팀</td></tr>
<tr><td><p><span>수신및참조</span><br></p></td><td><div class="referBox migFormEdit"><div class="flex-1 h-box"><p class="eapAutoChips flex-1"></p><div class="OBTAutoCompleteChips_Wrapper"><div data-orbit-component="OBTAutoCompleteChips" class="OBTAutoCompleteChips_wrapper__5KBpq" id="chips"><div class="OBTAutoCompleteChips_inputWrapper__5KBpq"><input type="text" value="" id="refin"></div></div></div><button class="btnImg ml4"><img alt=""></button></div></div></td></tr>
<tr><td><p><span>시&nbsp; 행&nbsp; 자</span></p></td><td><input type="text" placeholder="시행자를 입력해주세요."></td></tr>
<tr><td><p><span>제&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;목</span></p></td><td><div class="docTitleBox"><input type="text" maxlength="200" id="title"></div></td></tr>
</tbody></table>
<iframe id="editorView_UBAP001" src="/compose-editor.html" style="width:900px;height:600px"></iframe>
<input type="file" multiple id="files">
<script>
const ORG=['구매팀','경영지원부','경영지원부(전자결재용)','연구지원팀','개발 2팀','개발 1팀'];
const chips=document.getElementById('chips'), inp=document.getElementById('refin');
const add=n=>{ const d=document.createElement('div'); d.className='OBTAutoCompleteChips_item__5KBpq OBTAutoCompleteChips_correct__5KBpq'; d.innerHTML='<div>'+n+' <button>x</button></div>'; chips.insertBefore(d, chips.lastElementChild); window.__chips=(window.__chips||[]).concat(n); };
const close=()=>document.querySelectorAll('.ac,.tip').forEach(x=>x.remove());
inp.addEventListener('input',()=>{ close(); const q=inp.value.trim(); if(!q) return; const hits=ORG.filter(o=>o.includes(q)); if(!hits.length) return;
  const t=document.createElement('div'); t.className='tip'; t.textContent='(주)레인보우로보틱스>본사>'+hits[0]; document.body.appendChild(t);   // 경로 말풍선 (누르면 안 됨)
  const u=document.createElement('ul'); u.className='ac'; u.innerHTML=hits.map(h=>'<li role="option"><span>👥</span> <span>'+h+'</span></li>').join(''); document.body.appendChild(u);
  u.querySelectorAll('li').forEach((li,i)=>li.onclick=()=>{ add(hits[i]); inp.value=''; close(); }); });
inp.addEventListener('keydown',e=>{ if(e.key==='Enter'){ const q=inp.value.trim(); const h=ORG.filter(o=>o.includes(q))[0]; if(h){ add(h); inp.value=''; close(); } } });
document.getElementById('files').addEventListener('change',e=>{ window.__files=[...e.target.files].map(f=>f.name); });
if (__TEMPDRAFT__) setTimeout(()=>{ const d=document.createElement('div'); d.className='tmp'; d.innerHTML='<div class="b"><p>작성 중이던 임시 저장 본문이 있습니다. 불러오시겠습니까?</p><button id="tc">취소</button><button id="to">확인</button></div>'; document.body.appendChild(d);
  document.getElementById('tc').onclick=()=>{ d.remove(); window.__tempdraft='cancel'; }; document.getElementById('to').onclick=()=>{ d.remove(); window.__tempdraft='load'; document.getElementById('title').value='옛 임시 제목'; }; }, __TEMPDELAY__);
</script></body></html>`;

const POPUP = `<!doctype html><html><head><meta charset="utf-8"><title>전자결재</title></head><body>
<div><span class="title">전자결재</span><div class="topBtn">미리보기</div><div class="topBtn" id="keep">보관</div><div class="topBtn">상신</div></div>
<div class="docTitleBox"><input type="text" maxlength="200" id="title"></div>
<iframe id="editorView_UBAP001" src="/editor.html" style="width:900px;height:700px"></iframe>
<input type="file" multiple id="files">
<script>
const q=new URLSearchParams(location.search); document.getElementById('title').value=q.get('title')||'';
document.getElementById('keep').onclick=async()=>{
  if(!confirm('보관하시겠습니까?')) return;
  const ed=document.getElementById('editorView_UBAP001').contentDocument.body.innerHTML;
  await fetch('/saved',{method:'POST',body:JSON.stringify({form:q.get('form'),title:document.getElementById('title').value,body:ed,files:document.getElementById('files').files.length})});
  document.title='보관됨';
};
</script></body></html>`;

function start(port = 0) {
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/saved') {
      let b = ''; req.on('data', c => b += c); req.on('end', () => { saved.push(JSON.parse(b)); res.end('ok'); }); return;
    }
    const send = (body, type = 'text/html; charset=utf-8') => { res.writeHead(200, { 'Content-Type': type }); res.end(body); };
    if (req.url === '/settle.js') return send(fs.readFileSync(path.join(__dirname, 'settle.js'), 'utf8'), 'text/javascript; charset=utf-8');
    if (req.url === '/settle/state' && req.method === 'POST') { let b = ''; req.on('data', c => b += c); req.on('end', () => { settle = JSON.parse(b); res.end('ok'); }); return; }
    if (req.url === '/settle/state') return send(JSON.stringify(settle), 'application/json');
    if (req.url === '/' || req.url.startsWith('/?')) return send(INDEX.replace('__SEARCH__', process.env.MOCK_SEARCH || 'button'));
    if (req.url.startsWith('/popup.html')) return send(POPUP);
    if (req.url === '/compose.js') return send(fs.readFileSync(path.join(__dirname, 'compose.js'), 'utf8'), 'text/javascript; charset=utf-8');
    if (req.url.startsWith('/compose.html')) return send(COMPOSE.replace('__TEMPDRAFT__', process.env.MOCK_TEMPDRAFT ? 'true' : 'false').replace('__TEMPDELAY__', String(Number(process.env.MOCK_TEMPDRAFT) > 1 ? Number(process.env.MOCK_TEMPDRAFT) : 700)));
    if (req.url.startsWith('/compose-editor.html')) return send(`<!doctype html><html><head><meta charset="utf-8"></head><body contenteditable="true">${fs.readFileSync(path.join(FIX, 'purchase_body.html'), 'utf8')}</body></html>`);
    if (req.url.startsWith('/editor.html'))
      return send(`<!doctype html><html><head><meta charset="utf-8"></head><body contenteditable="true">${fs.readFileSync(path.join(FIX, process.env.MOCK_FORM || 'apply_form_body.html'), 'utf8')}</body></html>`);
    res.writeHead(404); res.end();
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}`, saved })));
}

module.exports = { start, setSettle: s => { settle = s; }, getSettle: () => settle };
