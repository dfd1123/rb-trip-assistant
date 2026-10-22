// 가짜 아마란스: 품의서승인(복수) → [결의서전송/취소] 창 → 결의서입력 → [결재상신]
// 실제 화면 덤프(debug/*settle*, *attach-popup*, *payee-stale*, *approval*)에서 확인한 구조를 흉내 낸다:
//  - 그리드는 .rg-root / .rg-header-cell / tr.rg-data-row / td.rg-data-cell / td.rg-checkbar-cell(input[type=checkbox])
//  - 선택한 줄은 tr.rg-focused-row, 드롭다운 항목은 "3.외상" 처럼 번호가 붙은 글자
//  - 확인창은 OBTConfirm_root(결의서전송 창보다 DOM 에서 앞), 오류는 OBTAlert_root, 창 맨 아래 [확인]은 OBTDialog_bottomButton (누르면 창이 닫힘)
//  - 첨부파일 칸 값은 첨부 묶음 번호(개수 아님), 파일업로드 창은 전에 올린 파일을 쌓아 보여 줌
// 상태는 서버(/settle/state)에 두어 테스트가 미리 넣고 끝나고 읽는다.
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const won = n => Math.round(Number(n) || 0).toLocaleString('en-US');
  const num = s => Number(String(s || '').replace(/[^\d-]/g, '')) || 0;
  let T = null;   // 상태
  const save = () => fetch('/settle/state', { method: 'POST', body: JSON.stringify(T) });
  const load = async () => { T = await (await fetch('/settle/state')).json(); };
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const css = `<style>
    .s-root{font:13px sans-serif} .rg-root{border:1px solid #bbb;margin:6px 0;display:block}
    .rg-root table{border-collapse:collapse;table-layout:fixed;width:max-content} .rg-root td{border:1px solid #ddd;height:26px;width:66px;min-width:66px;max-width:66px;box-sizing:border-box;overflow:hidden;white-space:nowrap;padding:0 2px;position:relative;font-size:11px}
    .rg-root td.rg-checkbar-cell,.rg-root td.rg-checkbar-head{width:22px;min-width:22px;max-width:22px} tr.rg-focused-row td{background:#e7f0ff}
    .OBTDialog_root{position:fixed;left:8px;top:8px;width:1340px;background:#fff;border:2px solid #333;z-index:10;padding:6px}
    .tbar{display:flex;gap:4px;margin:4px 0} .tbar button{font-size:12px}
    .OBTConfirm_root,.OBTAlert_root{position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:30;display:flex;align-items:center;justify-content:center}
    .OBTConfirm_root .box,.OBTAlert_root .box{background:#fff;padding:16px;border:1px solid #333;min-width:300px}
    .up{position:fixed;left:400px;top:120px;width:460px;background:#fff;border:2px solid #555;z-index:20;padding:10px}
    .rg-dropdownlist{position:absolute;background:#fff;border:1px solid #888;z-index:25;left:0;top:26px;min-width:110px} .rg-dropdown-item{padding:3px 6px;cursor:pointer}
    input.rg-editor{position:absolute;left:0;top:0;width:100%;height:100%;box-sizing:border-box;font-size:11px}
    .sbar{position:fixed;bottom:0;left:0;right:0;background:#556;padding:6px;z-index:5}
  </style>`;

  // ---------- 공용: 그리드 ----------
  // rows: [{...칸 값}], opts: { check: Set(행번호), focus: 행번호, gid }
  function grid(gid, cols, rows, opts = {}) {
    const ck = opts.check || new Set();
    if (opts.vw) {   // 실제 채주내역처럼 가로로 잘림: 보이는 폭 vw, 왼쪽으로 opts.sx 만큼 밀림 + 가로 스크롤바
      const full = 22 + cols.length * 66, sx = Math.max(0, Math.min(opts.sx || 0, full - opts.vw)), tw = Math.max(30, Math.round(opts.vw * opts.vw / full)), tl = Math.round((opts.vw - tw) * (sx / Math.max(1, full - opts.vw)));
      return `<div class="rg-root" id="${gid}" style="width:${opts.vw}px"><div class="rg-viewport" style="width:${opts.vw}px;overflow:hidden"><div class="rg-scroller" style="width:${full}px;margin-left:${-sx}px">` + grid(gid + '__inner', cols, rows, { ...opts, vw: 0 }).replace(/^<div class="rg-root" id="[^"]*">/, '').replace(/<\/div>$/, '').replace(new RegExp(gid + '__inner', 'g'), gid)
        + `</div></div>${opts.vr && rows.length > opts.vr ? `<div class="rg-vscrollbar" style="position:relative;width:14px;height:60px;background:#eee"><div class="rg-scrolltrack" style="position:absolute;inset:0"></div><div class="rg-scrollthumb" style="position:absolute;left:0;width:14px;height:20px;top:${Math.round(40 * (opts.vy || 0) / Math.max(1, rows.length - opts.vr))}px;background:#999"></div></div>` : ''}<div class="rg-hscrollbar" style="height:14px;position:relative;background:#eee;width:${opts.vw}px"><div class="rg-scrolltrack" style="position:absolute;inset:0"></div><div class="rg-scrollthumb" style="position:absolute;top:0;height:14px;width:${tw}px;left:${tl}px;background:#999"></div></div></div>`;
    }
    return `<div class="rg-root" id="${gid}"><table class="rg-header"><tr><td class="rg-head-cell rg-checkbar-head"></td>${cols.map(c => `<td class="rg-header-cell"><span class="rg-header-renderer">${c}</span></td>`).join('')}</tr></table>
      <table class="rg-body">${(opts.vr ? rows.map((r, i) => [r, i]).slice(opts.vy || 0, (opts.vy || 0) + opts.vr) : rows.map((r, i) => [r, i])).map(([r, i]) => `<tr class="rg-data-row${opts.focus === i ? ' rg-focused-row' : ''}" data-g="${gid}" data-r="${i}"><td class="rg-checkbar-cell" data-g="${gid}" data-i="${i}"><input type="checkbox" class="rg-checkbox"${ck.has(i) ? ' checked' : ''}></td>${cols.map(c => `<td class="rg-data-cell" data-g="${gid}" data-r="${i}" data-c="${c}"><div class="rg-renderer">${esc(r[c] ?? '')}</div></td>`).join('')}</tr>`).join('')}</table></div>`;
  }
  function confirmBox(msg, onOk) {
    const d = document.createElement('div'); d.className = 'OBTConfirm_root'; d.setAttribute('data-orbit-component', 'OBTConfirm');
    d.innerHTML = `<div class="box"><p>${msg}</p><div><button class="c">취소</button><button class="o">확인</button></div></div>`;
    document.body.insertBefore(d, document.body.firstChild);   // 실제처럼 결의서전송 창보다 DOM 에서 앞
    d.querySelector('.c').onclick = () => d.remove(); d.querySelector('.o').onclick = () => { d.remove(); onOk(); };
  }
  function alertBox(msg) {
    const d = document.createElement('div'); d.className = 'OBTAlert_root';
    d.innerHTML = `<div class="box"><p>${msg}</p><button class="o">확인</button></div>`;
    document.body.insertBefore(d, document.body.firstChild); d.querySelector('.o').onclick = () => d.remove();
    T.alerts = (T.alerts || 0) + 1; (T.alertTexts = T.alertTexts || []).push(msg); save();
  }
  function dropdown(td, items, onPick) {
    const l = document.createElement('div'); l.className = 'rg-dropdownlist';
    l.innerHTML = items.map(x => `<div class="rg-dropdown-item"><span class="rg-dropdown-label">${x}</span></div>`).join('');
    td.appendChild(l);
    l.querySelectorAll('.rg-dropdown-item').forEach(o => o.onclick = ev => { ev.stopPropagation(); onPick(o.textContent.replace(/^\d+\./, '')); });
  }
  function editor(td, onCommit) {
    const inp = document.createElement('input'); inp.className = 'rg-editor'; inp.value = td.querySelector('.rg-renderer').textContent; td.appendChild(inp); inp.focus();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const v = inp.value; inp.remove(); onCommit(v); } });
  }

  // ---------- 품의서승인(복수) ----------
  const TOPC = ['품의연월', '품의일', '순번', '품의구분', '적요', '총금액', '결재상태', '진행상태'];
  let A = { check: new Set() };
  // 실제처럼 품의일자 기본값은 이번 달 1일부터: 지난달에 신청한 품의는 날짜를 바꿔 [조회]해야 보임
  const monthStart = () => today().slice(0, 8).replace(/-/g, '') + '01';
  function approvePage() {
    const from = A.from || monthStart(), shown = T.approve.filter(r => `${r.품의연월.replace('-', '')}${String(r.품의일).padStart(2, '0')}` >= from);
    A.rows = shown;
    $('#app').innerHTML = css + `<div class="s-root"><h3>품의서승인(복수)</h3><div><span>품의일자</span> <span><input type="text" id="sFrom" value="${from}"> ~ <input type="text" value="${today().replace(/-/g, '')}"></span> <button class="OBTConditionPanel_searchButton__x" id="sFind">조회</button> <button id="sOpen">결의서전송/취소</button></div>${grid('appr', TOPC, shown, { check: A.check })}</div>`;
    $('#sFind').onclick = () => { A.from = $('#sFrom').value.replace(/\D/g, '').slice(0, 8) || monthStart(); A.check.clear(); approvePage(); };
    $('#sOpen').onclick = () => { const k = [...A.check][0]; if (k == null) return alertBox('품의를 선택해 주세요.'); openTransfer(A.rows[k]); };
  }

  // ---------- 결의서전송/취소 창 ----------
  const RESC = ['순번', '결의일자', '결의구분', '집행용도', '결의금액', '결의번호'];
  const BUDC = ['부서', '예산과목', '결제수단', '과세구분', '채주유형', '입출금계좌', '예산과목비고', '품의금액', '기지출액', '미지출액'];
  const PAYC = ['거래처코드', '거래처명', '총금액', '공급가액', '부가세액', '계좌번호', '금융기관', '예금주명', '실제예금주명', '거래처비고', '신고기준일', '자금과목', '자금계획일', '증빙', '첨부파일'];
  let D = null;   // { ap, resFocus, budFocus, resCheck:Set, payCheck:Set, draft: 집행용도 입력 중인 빈 줄 }
  const resRows = ap => [...ap.resolutions.map(r => ({ 순번: r.순번, 결의일자: r.결의일자, 결의구분: r.결의구분, 집행용도: r.집행용도, 결의금액: r.결의구분 === '환원' ? won(r.금액) : won(sumRes(r)), 결의번호: r.결의번호 || '' })),
    { 순번: '', 결의일자: today(), 결의구분: D.draft.결의구분 || '', 집행용도: D.draft.집행용도 || ap.적요, 결의금액: '', 결의번호: '' }];
  const sumRes = r => (r.budgets || []).reduce((a, b) => a + b.payees.reduce((x, p) => x + num(p.총금액), 0), 0);
  const curRes = () => D.ap.resolutions[D.resFocus];
  const payOf = (r, bi) => r.budgets[bi].payees;
  function openTransfer(ap) {
    D = { ap, resFocus: ap.resolutions.findIndex(r => r.결의구분 === '지출결의서'), budFocus: 0, resCheck: new Set(), payCheck: new Set(), draft: {} };
    if (D.resFocus < 0) D.resFocus = -1;
    drawTransfer();
  }
  function drawTransfer() {
    let d = $('#sDlg'); if (!d) { d = document.createElement('div'); d.id = 'sDlg'; d.className = 'OBTDialog_root'; d.setAttribute('role', 'dialog'); document.body.appendChild(d); }
    const r = D.resFocus >= 0 ? curRes() : null, isExp = r && r.결의구분 === '지출결의서';
    const buds = isExp ? D.ap.budgets.map((b, i) => { const used = r.budgets[i].payees.reduce((a, p) => a + num(p.총금액), 0); return { ...b, 결제수단: r.budgets[i].결제수단, 과세구분: r.budgets[i].과세구분, 채주유형: '거래처', 품의금액: won(num(b.품의금액)), 기지출액: '', 미지출액: won(num(b.품의금액)) }; }) : [];
    // 실제처럼: 맨 아래 빈 줄은 입력 중인 줄이 저장돼야 새로 생긴다
    const plist = isExp && buds.length ? payOf(r, D.budFocus) : [];
    const pays = isExp && buds.length ? [...plist.map(p => ({ ...p, 첨부파일: p.files && p.files.length ? String(p.group) : '' })), ...(!plist.length || plist[plist.length - 1].saved ? [{}] : [])] : [];
    d.innerHTML = css + `<div class="s-root"><h2>결의서전송/취소</h2>
      <div class="tbar"><b>결의내역</b><button data-b="삭제">삭제</button><button data-b="전송">전송</button><button data-b="전송취소">전송취소</button><button data-b="환원">환원</button><button data-b="환원취소">환원취소</button><button>예금주 조회</button></div>
      ${grid('res', RESC, resRows(D.ap), { check: D.resCheck, focus: D.resFocus })}
      <div class="tbar"><b>예산내역</b></div>${grid('bud', BUDC, buds, { focus: isExp ? D.budFocus : -1 })}
      <div class="tbar"><b>채주내역</b><button>전자(세금)계산서발행내역</button><button data-b="채주내역 삭제">채주내역 삭제</button></div>${grid('pay', PAYC, pays, { check: D.payCheck, vw: T.payViewport || 0, sx: D.paySx || 0, vr: T.payRows || 0, vy: D.payVy || 0 })}
      <div class="OBTDialog_bottomButton___NF_C"><button id="sClose">확인</button></div></div>`;
    $('#sClose').onclick = () => { d.remove(); D = null; T.closed = (T.closed || 0) + 1; save(); };   // 맨 아래 [확인] = 창 닫기 (앱이 누르면 안 됨)
    d.querySelectorAll('[data-b]').forEach(b => b.onclick = () => button(b.dataset.b));
  }
  function button(name) {
    const ap = D.ap; (T.buttons = T.buttons || []).push(name);
    const checked = [...D.resCheck].map(i => ap.resolutions[i]).filter(Boolean);
    if (name === '삭제') {
      if (!checked.length) return alertBox('삭제할 결의를 선택해 주세요.');
      return confirmBox(`현재 체크된 데이터 ${checked.length}건 존재합니다.<br>체크된 데이터 모두 삭제하시겠습니까?`, () => {
        if (checked.some(r => r.결의번호)) return alertBox('전송된 결의서는 삭제할 수 없습니다.');
        ap.resolutions = ap.resolutions.filter(r => !checked.includes(r));
        if (checked.some(r => r.결의구분 === '지출결의서')) ap.resolutions = ap.resolutions.filter(r => r.결의구분 !== '환원' || r.결의번호);   // 지출결의서를 지우면 같이 만든 환원도 사라짐
        D.resCheck.clear(); D.resFocus = ap.resolutions.findIndex(r => r.결의구분 === '지출결의서'); save(); drawTransfer(); });
    }
    if (name === '전송') {
      const r = checked.find(x => x.결의구분 === '지출결의서');
      if (!r || r.결의번호) return alertBox('전송할 결의서를 선택해 주세요.');
      return confirmBox('선택한 결의서를 전송하시겠습니까?', () => {
        const ymd = r.결의일자.replace(/-/g, ''); r.결의번호 = `${ymd}-${String(T.nextResNo++).padStart(5, '0')}`;
        T.resList.push({ 결의연월: r.결의일자.slice(0, 7), 결의일: String(Number(r.결의일자.slice(8))), 순번: String(T.nextGisuSq++), 결의구분: '지출결의서', 집행용도: r.집행용도, 총금액: won(sumRes(r)), 결재상태: '상신대기', 결재문서번호: '', 진행상태: '결의대기', 결의번호: r.결의번호, apKey: ap.key });
        D.resCheck.clear(); save(); drawTransfer(); });
    }
    if (name === '전송취소') {
      const r = checked.find(x => x.결의번호);
      if (!r) return alertBox('전송취소할 결의서를 선택해 주세요.');
      return confirmBox('선택한 결의서를 전송취소하시겠습니까?', () => {
        const row = T.resList.find(x => x.결의번호 === r.결의번호); if (row && row.결재상태 !== '상신대기') return alertBox('결재가 진행된 결의서는 전송취소할 수 없습니다.');
        T.resList = T.resList.filter(x => x.결의번호 !== r.결의번호); r.결의번호 = ''; D.resCheck.clear(); save(); drawTransfer(); });
    }
    if (name === '환원') {
      const r = ap.resolutions.find(x => x.결의구분 === '지출결의서'); if (!r) return alertBox('지출결의서가 없습니다.');
      if (ap.resolutions.some(x => x.결의구분 === '환원' && !x.결의번호)) return alertBox('이미 환원되었습니다.');
      const left = ap.budgets.reduce((a, b, i) => a + num(b.품의금액) - r.budgets[i].payees.reduce((x, p) => x + num(p.총금액), 0), 0);
      ap.resolutions.push({ 순번: String(ap.resolutions.length + 1), 결의일자: today(), 결의구분: '환원', 집행용도: '', 금액: left, 결의번호: '' });
      save(); return drawTransfer();
    }
    if (name === '환원취소') {
      const r = ap.resolutions[D.resFocus]; if (!r || r.결의구분 !== '환원') return alertBox('환원 줄을 선택해 주세요.');
      ap.resolutions.splice(D.resFocus, 1); D.resFocus = ap.resolutions.findIndex(x => x.결의구분 === '지출결의서'); save(); return drawTransfer();
    }
    if (name === '채주내역 삭제') {
      const r = curRes(); const list = payOf(r, D.budFocus); const del = [...D.payCheck].filter(i => list[i]);
      if (!del.length) return alertBox('삭제할 채주를 선택해 주세요.');
      return confirmBox(`현재 체크된 데이터 ${del.length}건 존재합니다.<br>체크된 데이터 모두 삭제하시겠습니까?`, () => {
        r.budgets[D.budFocus].payees = list.filter((_, i) => !del.includes(i)); D.payCheck.clear(); save(); drawTransfer(); });
    }
  }
  // 채주 줄 저장 (실제: 마지막 칸 Enter). 예산 줄 품의금액을 넘으면 오류
  function savePayee(bi, i) {
    const r = curRes(), list = payOf(r, bi), p = list[i]; if (!p || p.saved) return;
    p.총금액 = won(num(p.공급가액) + num(p.부가세액));
    const sum = list.reduce((a, x) => a + (x.saved || x === p ? num(x.총금액) : 0), 0);
    if (sum > num(D.ap.budgets[bi].품의금액)) { alertBox('채주내역 등록/수정중 오류가 발생하였습니다.'); return; }
    p.saved = true; if (T.payRows) D.payVy = Math.max(0, list.length + 1 - T.payRows); save();
  }
  function payeeVendor(td, bi, i, q) {
    const list = payOf(curRes(), bi);
    if (!list[i]) list[i] = {};
    const hits = T.vendors.filter(v => v[1].replace(/\s/g, '').includes(q.replace(/\s/g, '')) || (v[2] || '').includes(q));
    const set = v => { Object.assign(list[i], { 거래처코드: v[0], 거래처명: v[1] }); save(); drawTransfer(); };
    if (hits.length === 1) return set(hits[0]);
    if (!hits.length) return alertBox('거래처가 없습니다.');
    codeHelp('거래처코드도움', hits.map(v => [v[0], v[1], v[2] || '']), it => set(hits.find(v => v[0] === it[0])), q);   // 실제처럼 대표자명도 검색됨
  }
  // 코드도움 (실제: 캔버스 그리드, React fiber 에 GridView·DataProvider)
  function codeHelp(title, items, onPick, q0) {
    let shown = items, cur = 0;
    const d = document.createElement('div'); d.className = 'up'; d.setAttribute('role', 'dialog');
    d.innerHTML = `<h3>${title}</h3><label>검색어 <span id="name"><input type="text" value="${esc(q0 || '')}"></span></label> <button class="OBTConditionPanel_searchButton__x" style="width:28px;height:24px"></button>
      <div class="g" data-orbit-component="OBTDataGrid"><canvas width="420" height="160"></canvas></div><div><button class="c">취소</button><button class="o">확인</button></div>`;
    document.body.appendChild(d);
    const dp = { getRowCount: () => shown.length, getJsonRow: i => ({ CODE: shown[i][0], NAME: shown[i][1], REP: shown[i][2] || '' }) };
    const gv = { setCurrent: c => { cur = c.dataRow != null ? c.dataRow : c.itemIndex; }, getItemIndex: i => i, getDataSource: () => dp, setFocus() {} };
    d.querySelector('.g').__reactFiber$mock = { memoizedProps: { id: 'g' }, return: { memoizedProps: { gridView: gv, provider: dp }, return: null } };
    const q = d.querySelector('#name input');
    d.querySelector('.OBTConditionPanel_searchButton__x').onclick = () => { shown = items.filter(it => !q.value || it.join(' ').includes(q.value)); cur = 0; };
    d.querySelector('.c').onclick = () => d.remove();
    d.querySelector('.o').onclick = () => { const it = shown[cur]; d.remove(); if (it) onPick(it); };
  }
  // 파일업로드 창
  function upload(bi, i) {
    const r = curRes(), list = payOf(r, bi); if (!list[i] || !list[i].saved) return alertBox('채주를 먼저 저장해 주세요.');
    const p = list[i], pending = [...(p.files || [])];
    const d = document.createElement('div'); d.className = 'up OBTDialog_root'; d.setAttribute('role', 'dialog');
    const draw = () => { d.innerHTML = `<h3>파일업로드</h3><div>첨부파일 ${pending.length}개</div><div>마우스로 파일을 끌어오세요</div>${pending.map(n => `<div class="f"><p>${esc(n.replace(/\.[^.]+$/, ''))}</p><span>${esc(n.slice(n.lastIndexOf('.')))}</span></div>`).join('')}
      <input type="file" class="btn btn_fileAdd ml3" multiple style="width:20px;height:20px"><div><button class="c">취소</button><button class="o">확인</button></div>`;
      d.querySelector('input[type=file]').addEventListener('change', e => { for (const f of e.target.files) pending.push(f.name); draw(); });
      d.querySelector('.c').onclick = () => d.remove();
      d.querySelector('.o').onclick = () => { p.files = pending; p.group = p.group ? p.group + 1 : 26000 + Math.floor(Math.random() * 900); d.remove(); if (T.payViewport) { D.paySx = 9999; D.payStuck = true; } save(); drawTransfer(); }; };
    draw(); document.body.appendChild(d);
  }

  // ---------- 결의서입력 ----------
  const RLC = ['결의연월', '결의일', '순번', '결의구분', '집행용도', '총금액', '결재상태', '결재문서번호', '진행상태'];
  let RL = { check: new Set() };
  function resolutionPage() {
    $('#app').innerHTML = css + `<div class="s-root"><h3>결의서입력</h3>${grid('rl', RLC, [...T.resList, { 결의연월: today().slice(0, 7), 결의일: String(Number(today().slice(8))) }], { check: RL.check })}</div>
      <div class="sbar"><button id="sAppr">결재상신</button></div>`;
    $('#sAppr').onclick = () => {
      const rows = [...RL.check].map(i => T.resList[i]).filter(Boolean);
      if (!rows.length) return alertBox('결의서를 선택해 주세요.');
      confirmBox('선택한 결의서 중 결재진행/결재완료/임시보관상태인 결의서와 반제결의서는 제외하고 결재상신을 진행하시겠습니까?', () => {
        const ok = rows.filter(r => r.결재상태 === '상신대기');
        if (!ok.length) return alertBox('상신할 결의서가 없습니다.');
        T.approvalFor = ok.map(r => r.결의번호); save();
        const d = document.createElement('div'); d.className = 'up OBTDialog_root'; d.setAttribute('role', 'dialog');
        d.innerHTML = `<h3>전자결재상신</h3><div><span>결재양식</span> <input type="text" readonly value="출장보고서 및 경비정산 지출결의서"></div><div>제목 <input type="text" class="t"></div><div><button class="c">취소</button><button class="o">확인</button></div>`;
        document.body.appendChild(d);
        d.querySelector('.c').onclick = () => d.remove();
        d.querySelector('.o').onclick = () => { const t = d.querySelector('.t').value; if (!t) return; d.remove(); T.approvalTitle = t; save();
          window.open('/popup.html?form=' + encodeURIComponent('출장보고서 및 경비정산 지출결의서') + '&title=' + encodeURIComponent(t), 'popup_page_1', 'width=1000,height=900'); };
      });
    };
  }

  // ---------- 이벤트 ----------
  document.addEventListener('click', e => {
    if (!T) return;
    const cb = e.target.closest('td.rg-checkbar-cell');
    if (cb) {
      const g = cb.dataset.g, i = +cb.dataset.i, set = g === 'appr' ? A.check : g === 'rl' ? RL.check : g === 'res' ? D.resCheck : g === 'pay' ? D.payCheck : null;
      if (set) { set.has(i) ? set.delete(i) : set.add(i); if (g === 'appr') approvePage(); else if (g === 'rl') resolutionPage(); else drawTransfer(); }
      return;
    }
    const td = e.target.closest('td.rg-data-cell'); if (!td || !D) return;
    const g = td.dataset.g, i = +td.dataset.r, c = td.dataset.c;
    if (g === 'res' && i < D.ap.resolutions.length && D.resFocus !== i) { D.resFocus = i; D.budFocus = 0; D.payCheck.clear(); drawTransfer(); }
    if (g === 'bud' && D.budFocus !== i) { D.budFocus = i; D.payCheck.clear(); D.paySx = 0; D.payStuck = false; D.payVy = 0; drawTransfer(); }
    if (g === 'pay' && c === '첨부파일') upload(D.budFocus, i);
    if (g === 'pay') { D.payFocus = { i, c }; D.payCur = { i, c: PAYC.indexOf(c) }; }
    if (g === 'res') D.resCell = { i, c };
  });
  document.addEventListener('dblclick', e => {
    if (!D) return;
    const td = e.target.closest('td.rg-data-cell'); if (!td) return;
    const g = td.dataset.g, i = +td.dataset.r, c = td.dataset.c;
    const blank = g === 'res' && i === D.ap.resolutions.length;
    if (blank && c === '결의구분') return dropdown(td, ['1.지출결의서', '2.반제결의서'], v => { D.draft.결의구분 = v; drawTransfer(); });
    if (blank && c === '집행용도') return editor(td, v => { D.draft.집행용도 = v; D.draftReady = true; drawTransfer(); });
    if (g === 'bud' && (c === '결제수단' || c === '과세구분')) {
      const r = curRes(); if (!r) return;
      return dropdown(td, c === '결제수단' ? ['1.예금', '2.현금', '3.외상', '4.신용카드'] : ['1.과세', '2.면세', '3.기타'], v => { r.budgets[i][c] = v; save(); drawTransfer(); });
    }
    if (g === 'pay') {
      const r = curRes(); if (!r) return; const list = payOf(r, D.budFocus);
      if (c === '거래처코드') return editor(td, v => payeeVendor(td, D.budFocus, i, v));
      if (['공급가액', '부가세액', '거래처비고', '자금과목', '자금계획일'].includes(c)) return editor(td, v => {
        if (!list[i]) list[i] = {};
        list[i][c] = c === '공급가액' || c === '부가세액' ? won(num(v)) : c === '자금계획일' ? String(v).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : v;
        if (c === '공급가액') list[i].총금액 = won(num(list[i].공급가액) + num(list[i].부가세액));
        save(); drawTransfer();
        if (c === '자금계획일') D.payFocus = { i, c: '자금계획일', last: true };
      });
    }
  });
  const scrollTo = sx => { D.paySx = Math.max(0, sx); drawTransfer(); };
  document.addEventListener('keydown', e => {
    if (!D || !T.payViewport || !D.payCur || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
    if (D.payStuck) return;   // 첨부 뒤엔 키가 안 먹음 (실제)
    const n = PAYC.length; let c = D.payCur.c;
    c = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, c + (e.key === 'ArrowRight' ? 1 : -1)));
    D.payCur.c = c; const x = 22 + c * 66, vw = T.payViewport, sx = D.paySx || 0;
    scrollTo(x < sx ? x : x + 66 > sx + vw ? x + 66 - vw : sx);
  });
  document.addEventListener('wheel', e => { if (!D || !e.target.closest('#pay')) return;
    if (T.payRows && e.deltaY && !e.shiftKey) { const n = payOf(curRes(), D.budFocus).length + 1; D.payVy = Math.max(0, Math.min(n - T.payRows, (D.payVy || 0) + Math.sign(e.deltaY))); drawTransfer(); return; }
    if (!T.payViewport || D.payStuck) return; const dx = e.deltaX || (e.shiftKey ? e.deltaY : 0); if (dx) scrollTo((D.paySx || 0) + dx); }, { passive: true });
  let drag = null;
  document.addEventListener('mousedown', e => { const t = e.target.closest('#pay .rg-scrollthumb'); if (t && D) drag = { x: e.clientX, sx: D.paySx || 0 }; });
  document.addEventListener('mousemove', e => { if (!drag || !D) return; const full = 22 + PAYC.length * 66, vw = T.payViewport; D.paySx = Math.max(0, Math.min(full - vw, drag.sx + (e.clientX - drag.x) * full / vw)); D.payStuck = false; drawTransfer(); });
  document.addEventListener('mouseup', () => { drag = null; });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !D) return;
    if (D.draftReady) {   // 집행용도 입력 뒤 Enter: 새 지출결의서 줄 확정 (순번·예산내역)
      D.draftReady = false;
      const ap = D.ap; if (D.draft.결의구분 !== '지출결의서') return;
      ap.resolutions.push({ 순번: String(ap.resolutions.length + 1), 결의일자: today(), 결의구분: '지출결의서', 집행용도: D.draft.집행용도, 결의번호: '', budgets: ap.budgets.map(() => ({ 결제수단: '', 과세구분: '', payees: [] })) });
      D.draft = {}; D.resFocus = ap.resolutions.length - 1; save(); drawTransfer(); return;
    }
    if (D.payFocus && D.payFocus.last) { const f = D.payFocus; D.payFocus = null; savePayee(D.budFocus, f.i); drawTransfer(); }
  });

  window.settleRoute = hash => {
    { const d = $('#sDlg'); if (d) d.remove(); D = null; document.querySelectorAll('.OBTConfirm_root,.OBTAlert_root,.up').forEach(x => x.remove()); }   // 화면을 옮기면 떠 있던 창은 사라짐 (실제처럼)
    if (hash.startsWith('#/HP/NPC1025/NCA0019')) { load().then(() => { A = { check: new Set() }; approvePage(); }); return true; }
    if (hash.startsWith('#/HP/NPC1030/NCA0020')) { load().then(() => { RL = { check: new Set() }; resolutionPage(); }); return true; }
    return false;
  };
  window.__settle = () => T;
})();
