'use strict';
// 아마란스10 조작: 품의서입력(복수) 그리드 → 결재상신 모달 → 전자결재 팝업 본문 → 보관.
// 그리드는 RealGrid2 DOM: 행 tr.rg-data-row / 셀 td.rg-data-cell(헤더 .rg-header-cell 순서) /
// 행 체크 td.rg-checkbar-cell / 드롭다운 .rg-list-editor
// 자동 조작이 막히면 ui.assist() 로 사람에게 넘기고(앱 화면에 안내 + [계속]) 이어서 진행한다.

const { Page, sleep } = require('./driver');
const { FILL_JS, FIND_JS } = require('./editorFill');

const BUDGET_PATH = '/#/HP/NPC1023/NCA0018';
const popupsOf = new WeakMap();   // 그룹웨어 창 → 그 창에서 열린 작성 팝업들
const norm = s => String(s || '').replace(/\s/g, '');
const amountOf = s => Number(String(s || '').replace(/[^\d]/g, '')) || 0;

class Amaranth {
  constructor({ win, baseUrl, ui, log, debugDir, creds }) {
    this.page = new Page(win);
    this.win = win;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.ui = ui;
    this.log = log;
    this.debugDir = debugDir;
    this.creds = creds || (() => null);   // () => {id, pw} | null
    if (!popupsOf.has(win.webContents)) {
      const set = new Set();
      popupsOf.set(win.webContents, set);
      win.webContents.on('did-create-window', w => { set.add(w); w.on('closed', () => set.delete(w)); });
    }
  }

  /** 자동 선택 실패 시 화면 구조를 파일로 남긴다 (코드도움 창 HTML + 전체 화면 HTML + 캡처). 개선용. */
  async debugDump(name, titleRe) {
    if (!this.debugDir) return '';
    try {
      const fs = require('fs'), path = require('path');
      fs.mkdirSync(this.debugDir, { recursive: true });
      const base = path.join(this.debugDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`);
      const d = await this.page.eval(re => {
        const r = new RegExp(re);
        const h = all('*').filter(e => ownText(e) && vis(e) && r.test(e.textContent.trim())).pop();
        let box = h; if (h) { let p = h; while (p && p !== document.body) { const q = p.getBoundingClientRect(); if (q.width > 500 && q.height > 300) { box = p; break; } p = p.parentElement; } }
        const dlg = h ? (dialog(h.textContent.trim()) || box) : null;
        let probe = null;
        try {
          const g = rgFind(dlg || document);
          if (g) probe = { rows: rgRows(g).slice(0, 5), gv: g.gv && rgMethods(g.gv), dp: g.dp && rgMethods(g.dp), iface: g.iface && rgMethods(g.iface), dpCount: g.dp && g.dp.getRowCount() };
          else {
            const el = (dlg || document).querySelector('[data-orbit-component=OBTDataGrid]');
            const k = el && Object.keys(el).find(k => k.startsWith('__react'));
            const fibers = []; let f = k && el[k];
            for (let i = 0; f && i < 15; i++, f = f.return) fibers.push({ type: typeof f.type === 'string' ? f.type : (f.type && (f.type.displayName || f.type.name)) || '', props: f.memoizedProps && typeof f.memoizedProps === 'object' ? Object.keys(f.memoizedProps).slice(0, 30) : [], state: f.stateNode && !f.stateNode.nodeType ? Object.keys(f.stateNode).slice(0, 40) : [] });
            probe = { found: false, elKeys: el ? Object.keys(el) : [], fibers };
          }
        } catch (e) { probe = { error: e.message }; }
        return { dialog: dlg ? dlg.outerHTML : '(창 제목을 못 찾음)', page: document.documentElement.outerHTML, url: location.href, probe };
      }, titleRe || '.^');
      fs.writeFileSync(base + '-dialog.html', `<!-- ${d.url} -->\n` + d.dialog);
      fs.writeFileSync(base + '-page.html', d.page);
      fs.writeFileSync(base + '-probe.json', JSON.stringify(d.probe, null, 1));
      fs.writeFileSync(base + '.png', (await this.win.webContents.capturePage()).toPNG());
      this.log(`(진단 파일 저장: ${base}-dialog.html)`);
      return base;
    } catch (e) { return ''; }
  }

  // ---------- 로그인 ----------
  /** 로그인 화면인지: URL 에 login 이 있거나, 보이는 비밀번호 칸이 있으면 */
  isLoginPage() {
    return this.page.eval(() => /login/i.test(location.href) || Array.from(document.querySelectorAll('input[type=password]')).some(vis)).catch(() => true);
  }

  /** 그룹웨어를 열어 로그인 화면인지 확인 (창은 보이지 않아도 됨) */
  async loginNeeded() {
    const p = this.page;
    if (!p.url().startsWith(this.baseUrl)) await p.goto(this.baseUrl);
    await sleep(2500);
    return this.isLoginPage();
  }

  /** 아이디·비밀번호 자동 입력. 아이디 → (다음) → 비밀번호 두 단계 화면도 처리. 성공하면 true */
  async autoLogin(id, pw) {
    const p = this.page;
    if (!id || !pw) return false;
    this.log('저장된 계정으로 그룹웨어에 로그인합니다.');
    const has = what => p.eval(w => !!(w === 'pw' ? loginPw() : loginId()), what);
    try {
      if (!(await has('pw')) && (await has('id'))) {             // 1단계: 아이디만 있는 화면 → 다음
        await p.clickWhere(() => loginId()); await p.selectAll(); await p.type(id);
        const next = await p.eval(() => { const b = all('button, [role=button], input[type=submit], a, span, div').filter(e => vis(e) && /^(다음|NEXT|Next|확인|로그인|LOGIN|Login)$/.test(norm(e.textContent || e.value))).pop(); return b ? center(b) : null; });
        if (next) await p.click(next); else await p.key('Enter');
        await p.waitFor(() => !!loginPw(), [], { timeout: 8000 });
      }
      if (await has('pw')) {
        if (await has('id') && !(await p.eval(v => loginId().value === v, id))) { await p.clickWhere(() => loginId()); await p.selectAll(); await p.type(id); }
        await p.clickWhere(() => loginPw()); await p.selectAll(); await p.type(pw);
        await p.key('Enter');
      }
      const end = Date.now() + 15000;
      while (Date.now() < end) { await sleep(1000); if (!(await this.isLoginPage())) { await sleep(2500); this.log('로그인 성공'); return true; } }
    } catch (e) { /* 아래에서 실패 처리 */ }
    await this.debugDump('login', '로그인');
    this.log('자동 로그인에 실패했어요 (아이디·비밀번호 확인, 추가 인증 등).');
    return false;
  }

  async ensureLogin(timeoutMs = 10 * 60 * 1000) {
    if (!(await this.loginNeeded())) return;
    const c = this.creds();
    if (c && await this.autoLogin(c.id, c.pw)) return;
    this.win.show(); this.win.focus();
    this.log('그룹웨어에 로그인되어 있지 않아요. 열린 아마란스 창에서 로그인해 주세요. 로그인하면 자동으로 이어서 진행합니다. (설정 → 그룹웨어 계정에 저장해 두면 다음부터 자동 로그인)');
    const end = Date.now() + timeoutMs;
    while (await this.isLoginPage()) {
      if (Date.now() > end) throw new Error('로그인 대기 시간(10분)이 지났습니다. 다시 [그룹웨어에 입력하기]를 눌러 주세요.');
      await sleep(1000);
    }
    await sleep(3000);
    this.log('로그인 확인됨 — 이어서 진행합니다.');
  }

  // ---------- 그리드 헬퍼 ----------
  rowCount(gridHdr) { return this.page.eval(h => { const g = grid(h); return g ? rows(g).length : -1; }, gridHdr); }
  rowVals(gridHdr, row) { return this.page.eval((h, r) => { const g = grid(h); return g ? rowVals(g, r) : null; }, gridHdr, row); }
  cellPoint(gridHdr, row, col) {
    return this.page.eval((h, r, c) => { const g = grid(h); const el = g && cell(g, r, c); return el ? center(el) : null; }, gridHdr, row, col);
  }

  async editCell(gridHdr, row, col, text) {
    const p = this.page;
    await p.dblclick(await this.cellPoint(gridHdr, row, col));
    await p.selectAll();
    await p.type(text);
    await p.key('Enter');
    await sleep(400);
  }

  // ---------- 코드도움 모달 ----------
  async openCodeHelp(gridHdr, row, col, titleRe) {
    const p = this.page;
    const opened = () => p.waitFor(re => { const r = new RegExp(re); return all('*').some(e => ownText(e) && vis(e) && r.test(e.textContent.trim()) && !!dialog(e.textContent.trim())); },
      [titleRe], { timeout: 3000 });
    await p.click(await this.cellPoint(gridHdr, row, col));            // 셀 선택
    // 코드도움 칸은 오른쪽에 아이콘 버튼(.rg-button-action)이 있고 그걸 눌러야 창이 열린다
    const btn = await p.eval((h, r, c) => {
      const g = grid(h), td = g && cell(g, r, c); if (!td) return null;
      const tr = td.getBoundingClientRect();
      const b = all('.rg-button-action', g).find(e => { const q = e.getBoundingClientRect(); return vis(e) && q.left >= tr.left - 2 && q.right <= tr.right + 2 && q.top >= tr.top - 2 && q.bottom <= tr.bottom + 2; });
      if (b) return center(b);
      return { x: Math.round(tr.right - 12), y: Math.round(tr.top + tr.height / 2), edge: true };
    }, gridHdr, row, col);
    if (btn) { await p.click(btn); if (await opened()) return; }
    await p.dblclick(await this.cellPoint(gridHdr, row, col));
    if (await opened()) return;
    throw new Error('코드도움 창이 열리지 않았습니다.');
  }

  /**
   * 코드도움 창에서 고르기. 실제 아마란스 코드도움 목록은 캔버스(RealGridJS)라 화면 글자를 읽을 수 없어서
   * ① 검색어 입력 → 조회 버튼 ② React 내부의 그리드 데이터에서 일치하는 행을 찾아 선택 ③ 확인.
   * 데이터를 못 읽으면 검색 결과 첫 행을 클릭해서 고르고, 호출한 쪽이 결과 칸을 확인한다.
   */
  async pickInCodeHelp(titleRe, query, match) {
    const p = this.page;
    const findDlg = `(re) => { const r = new RegExp(re); const h = all('*').filter(e => ownText(e) && vis(e) && r.test(e.textContent.trim())).pop(); return h ? dialog(h.textContent.trim()) : null; }`;

    // 1) 검색어 → Enter → 조회(돋보기) 버튼
    await p.clickWhere(`(re) => { const d = (${findDlg})(re); return d && (d.querySelector('#name input, input#name') || all('input', d).find(e => vis(e) && !e.readOnly && !/date|YMD/i.test(e.className) && (e.type || 'text') === 'text')); }`, titleRe);
    await p.selectAll();
    await p.type(query);
    await sleep(300);
    await p.key('Enter');
    await sleep(500);
    const btn = await p.eval(`(re) => { const d = (${findDlg})(re); if (!d) return null;
      const b = d.querySelector('#tutorial-conditionPanel-search, [class*=searchButton]') || all('button', d).find(x => vis(x) && !norm(x.textContent) && x.querySelector('img[src*=search]'));
      return b && vis(b) ? center(b) : null; }`, titleRe);
    if (btn) await p.click(btn);
    await sleep(1200);

    // 2) 그리드 데이터에서 일치 행 찾기
    const pick = await p.waitFor(`(re, m) => { const d = (${findDlg})(re); if (!d) return null;
      const g = rgFind(d);
      if (g) { const rows = rgRows(g); const t = norm(m);
        const i = rows.findIndex(r => r && Object.values(r).some(v => norm(String(v)) === t));
        if (i >= 0) { rgSelect(g, i); return { how: 'data', i, n: rows.length }; }
        if (rows.some(r => r)) return { how: 'nomatch', n: rows.length }; }
      const hit = byText(m, d)[0];                                   // DOM 그리드(테스트·다른 화면)
      if (hit) return { how: 'dom', pt: center(hit) };
      return null; }`, [titleRe, match], { timeout: 4000 });

    if (pick && pick.how === 'dom') await p.click(pick.pt);
    else if (pick && pick.how === 'nomatch') throw new Error(`검색 결과 ${pick.n}건 중 '${match}'가 없습니다.`);
    else if (!pick) {
      // 데이터를 못 읽음 → 검색 결과 첫 행 클릭 (검색어가 정확하면 보통 1건)
      const pt = await p.eval(`(re) => { const d = (${findDlg})(re); const c = d && d.querySelector('canvas'); if (!c) return null;
        const r = c.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(200, r.width / 3)), y: Math.round(r.top + 27 + 13) }; }`, titleRe);
      if (!pt) throw new Error(`검색 결과에서 '${match}'를 찾지 못했습니다.`);
      this.log(`(목록을 직접 읽지 못해 검색 결과 첫 줄을 골랐어요 — 결과를 확인합니다)`);
      await p.click(pt);
    }
    await sleep(300);
    await p.clickWhere(`(re) => { const d = (${findDlg})(re); return okButtons(d).pop(); }`, titleRe);
    await p.waitFor(`(re) => !(${findDlg})(re)`, [titleRe], { timeout: 6000 });
  }

  // ---------- 품의서입력(복수) ----------
  /** 품의 1건 + 예산 라인 입력. 그 품의의 top grid 행 번호를 돌려준다. */
  async enterBudget(dept, expenses, kind = '지출') {
    const p = this.page, ui = this.ui;
    this.log('품의서입력(복수) 화면을 엽니다.');
    await p.goto(this.baseUrl + BUDGET_PATH);
    await sleep(1500);
    if (await this.isLoginPage()) { await this.ensureLogin(); await p.goto(this.baseUrl + BUDGET_PATH); }   // 세션 만료
    await p.waitFor(() => !!grid('품의구분'), [], { timeout: 30000, message: '품의서입력 화면이 열리지 않았습니다.' });
    await sleep(1500);

    let row = (await this.rowCount('품의구분')) - 1;
    if (row < 0 || (await this.rowVals('품의구분', row))['순번']) {
      await ui.assist('품의 목록 맨 아래에 빈 행이 없습니다. 빈 행을 만든 뒤 [계속]을 눌러주세요.');
      row = (await this.rowCount('품의구분')) - 1;
    }

    this.log(`품의구분 '${kind}' 선택`);
    try {
      await p.dblclick(await this.cellPoint('품의구분', row, '품의구분'));
      await sleep(600);
      // 실제 화면: .rg-dropdownlist > .rg-dropdown-item > .rg-dropdown-label "1.지출" / "2.수입"
      const opt = await p.waitFor(k => { const el = all('.rg-dropdown-item').find(e => vis(e) && norm(e.textContent).replace(/^\d+\./, '') === k); return el ? center(el) : null; }, [kind], { timeout: 3000 });
      if (opt) await p.click(opt);
      else { await p.key('Down'); if (kind !== '지출') await p.key('Down'); await p.key('Enter'); }
      await sleep(400);
      await p.click(await this.cellPoint('품의구분', row, '품의구분'));
      await p.press('Enter', 3);
    } catch (e) {
      await ui.assist(`품의구분 선택에 실패했습니다(${e.message}). 품의구분을 '${kind}'로 고르고 Enter 3번을 눌러주세요.`);
    }
    if (!String((await this.rowVals('품의구분', row))['품의구분'] || '').includes(kind))
      await ui.assist(`품의구분이 '${kind}'로 보이지 않습니다. 직접 선택하고 Enter 3번 눌러주세요.`);

    for (const [i, ex] of expenses.entries()) {
      this.log(`예산 라인 ${i + 1}/${expenses.length}: ${ex.label} ${ex.amount.toLocaleString('ko-KR')}원`);
      if ((await this.rowCount('예산과목')) <= i) await ui.assist(`예산 목록에 ${i + 1}번째 행이 없습니다. 빈 행을 만들어 주세요.`);
      try {
        await this.openCodeHelp('예산과목', i, '부서', '^사업코드도움$');
        await this.pickInCodeHelp('^사업코드도움$', dept, dept);
        await sleep(400);
        const got = String(((await this.rowVals('예산과목', i)) || {})['부서'] || '');
        if (!norm(got).includes(norm(dept))) throw new Error(`부서 칸이 '${got || '빈칸'}'입니다`);
      } catch (e) { await this.debugDump('dept', '사업코드도움'); await ui.assist(`부서 선택 실패(${e.message}). ${i + 1}번째 줄 부서를 '${dept}'로 지정해 주세요.`); }
      try {
        await this.openCodeHelp('예산과목', i, '예산과목', '(예산과목|예산|과목).*(코드)?도움$');
        await this.pickInCodeHelp('(예산과목|예산|과목).*(코드)?도움$', ex.code, ex.code);
        await sleep(400);
        const got = String(((await this.rowVals('예산과목', i)) || {})['예산과목'] || '');
        if (!norm(got).includes(norm(ex.code)) && !norm(got).includes(norm(ex.label.split('_').pop()))) throw new Error(`예산과목 칸이 '${got || '빈칸'}'입니다`);
      } catch (e) { await this.debugDump('budget-item', '(예산과목|예산|과목).*(코드)?도움$'); await ui.assist(`예산과목 선택 실패(${e.message}). ${i + 1}번째 줄 예산과목을 ${ex.code} ${ex.label}로 지정해 주세요.`); }
      try {
        await this.editCell('예산과목', i, '품의금액', String(ex.amount));
        await p.dblclick(await this.cellPoint('예산과목', i, '적요'));
        await p.selectAll();
        await p.type(ex.memo);
        await p.key('Enter');                       // → 첨부파일
        await sleep(300);
        await p.key('Enter');                       // 첨부파일에서 Enter 해야 행이 확정되고 금액이 반영됨 (다음 빈 행 생김)
        await sleep(900);
      } catch (e) { await ui.assist(`금액/적요 입력 실패(${e.message}). ${i + 1}번째 줄에 ${ex.amount.toLocaleString('ko-KR')}원 / '${ex.memo}' 를 입력해 주세요.`); }
      const got = amountOf(((await this.rowVals('예산과목', i)) || {})['품의금액']);
      if (got !== ex.amount) await ui.assist(`${i + 1}번째 줄 금액이 ${got.toLocaleString('ko-KR')}원으로 보입니다. ${ex.amount.toLocaleString('ko-KR')}원으로 고쳐 주세요.`);
    }

    // 품의 행 체크 → 총금액 확인
    await sleep(800);
    await p.clickWhere(r => all('td.rg-checkbar-cell', grid('품의구분'))[r], row);
    await sleep(1500);
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    const vals = await this.rowVals('품의구분', row);
    if (amountOf(vals['총금액']) !== total)
      await ui.assist(`품의 총금액이 ${amountOf(vals['총금액']).toLocaleString('ko-KR')}원입니다(예상 ${total.toLocaleString('ko-KR')}원). 확인 후 품의 행만 체크된 상태로 두세요.`);
    this.log(`품의 입력 완료: 총 ${total.toLocaleString('ko-KR')}원 (순번 ${vals['순번'] || '?'})`);
    this.lastBudget = vals['순번'] ? { key: [vals['품의연월'], vals['품의일'], vals['순번']].join('|'), ym: vals['품의연월'], day: vals['품의일'], seq: vals['순번'] } : null;
    return row;
  }

  // ---------- 올린 품의 목록·삭제 ----------
  /** 결재가 진행 중이거나 끝난 품의는 삭제하지 않는다 */
  static locked(status) {
    const t = String(status || '').replace(/\s/g, '');
    if (!t || /(상신대기|미상신|작성|보관|임시|반려|회수|취소)/.test(t)) return false;   // 아직 상신 전이거나 돌아온 건
    return /(진행|완료|승인|결재중|종결|상신|합의|결재대기)/.test(t);
  }

  async openBudgetList() {
    const p = this.page;
    // 같은 주소면 해시만 바뀌고 새로고침이 안 돼 이전 체크가 남을 수 있음 → 확실히 새로 연다
    if (p.url() === this.baseUrl + BUDGET_PATH) { p.wc.reload(); await new Promise(r => p.wc.once('did-finish-load', r)); }
    else await p.goto(this.baseUrl + BUDGET_PATH);
    await sleep(1500);
    if (await this.isLoginPage()) { await this.ensureLogin(); await p.goto(this.baseUrl + BUDGET_PATH); }
    await p.waitFor(() => !!grid('품의구분'), [], { timeout: 30000, message: '품의서입력 화면이 열리지 않았습니다.' });
    await sleep(1500);
  }

  /** 품의서입력(복수) 위쪽 목록 (순번이 있는 = 저장된 품의만) */
  async listBudgetRows() {
    await this.openBudgetList();
    const rows = await this.page.eval(() => { const g = grid('품의구분'); return rows(g).map((_, i) => rowVals(g, i)); });
    return rows.map((r, i) => ({ ...r, index: i })).filter(r => r && r['순번'])
      .map(r => ({ index: r.index, key:[r['품의연월'], r['품의일'], r['순번']].join('|'), ym: r['품의연월'] || '', day: r['품의일'] || '', seq: r['순번'],
        kind: r['품의구분'] || '', memo: r['적요'] || '', total: r['총금액'] || '', status: r['결재상태'] || '', docNo: r['문서번호'] || '',
        locked: Amaranth.locked(r['결재상태']) }));
  }

  /** keys(품의연월|품의일|순번) 품의 삭제. 결재 진행 중인 건은 건너뜀. 삭제된 개수를 돌려준다 */
  async deleteBudgetRows(keys) {
    const p = this.page, ui = this.ui;
    const want = new Set(keys);
    const before = await this.listBudgetRows();          // 새로 열어 체크가 하나도 없는 상태에서 시작
    const targets = before.filter(r => want.has(r.key));
    const skip = targets.filter(r => r.locked);
    for (const r of skip) this.log(`건너뜀: ${r.day}일 순번 ${r.seq} (결재상태 '${r.status}')`);
    const del = targets.filter(r => !r.locked);
    if (!del.length) { this.log('삭제할 품의가 없습니다.'); return { deleted: 0, skipped: skip.length }; }
    for (const r of del) {
      this.log(`선택: ${r.ym} ${r.day}일 순번 ${r.seq} ${r.memo} ${r.total}`);
      await p.clickWhere(i => { const g = grid('품의구분'); return g && all('td.rg-checkbar-cell', g)[i]; }, r.index).catch(async e => { throw new Error(`품의 행(순번 ${r.seq})을 체크하지 못했습니다: ${JSON.stringify(await p.eval(() => { const g = grid('품의구분'); return g ? [all('td.rg-checkbar-cell', g).length, location.href] : ['no grid', location.href]; }))}`); });
      await sleep(250);
    }
    // 상단 도구 모음의 삭제(휴지통) 버튼
    const btn = await p.eval(() => {
      const g = grid('품의구분'); const gt = g ? g.getBoundingClientRect().top : 9999;
      const exact = all('button, [role=button]').filter(b => vis(b) && !b.disabled && norm(b.textContent) === '삭제');   // 하단 바 [삭제]
      if (exact.length) return center(exact.pop());
      const c = all('button, [role=button]').filter(b => vis(b) && b.getBoundingClientRect().bottom <= gt + 5).filter(b => {
        const t = norm(b.textContent) + (b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '') + (b.id || '') + (b.className || '');
        const img = b.querySelector('img'); const src = img ? img.getAttribute('src') || '' : '';
        return /삭제|delete|trash|remove/i.test(t) || /del|trash|remove/i.test(src);
      });
      const b = c.pop(); return b ? center(b) : null; });
    if (btn) await p.click(btn);
    else await ui.assist(`삭제할 품의 ${del.length}건을 체크해 두었어요. 위쪽 휴지통(삭제) 버튼을 눌러 주세요.`);
    // "삭제하시겠습니까?" 확인
    const ok = await p.waitFor(() => { const h = all('*').filter(e => ownText(e) && vis(e) && /삭제/.test(e.textContent) && /(\?|하시겠|할까요)/.test(e.textContent)).pop();
      const d = h && dialog(h.textContent.trim()); const b = d && okButtons(d).pop(); return b ? center(b) : null; }, [], { timeout: 5000 });
    if (ok) await p.click(ok);
    await sleep(2000);
    const after = await this.listBudgetRows();
    const left = after.filter(r => del.some(d => d.key === r.key));
    if (left.length) throw new Error(`${left.length}건이 아직 남아 있어요. 그룹웨어에서 확인해 주세요.`);
    this.log(`✔ ${del.length}건 삭제됨${skip.length ? `, ${skip.length}건은 결재 진행 중이라 건너뜀` : ''}`);
    return { deleted: del.length, skipped: skip.length, rows: after };
  }

  // ---------- 결재상신 ----------
  /** 하단 [결재상신] → 결재양식/제목 → 확인 → 전자결재 팝업(BrowserWindow) */
  async openApproval(formName, title) {
    const p = this.page, ui = this.ui;
    this.log(`결재상신: ${formName}`);
    // 이전에 열어 둔 작성 창(이미 보관됨)이 있으면 닫는다. 같은 이름의 창이 재사용되는 것을 막기 위함.
    for (const w of popupsOf.get(this.win.webContents) || []) if (!w.isDestroyed()) w.destroy();
    const popupPromise = new Promise(resolve => this.win.webContents.once('did-create-window', w => resolve(w)));
    await p.clickWhere(() => all('button').filter(b => norm(b.textContent) === '결재상신' && vis(b) && !b.disabled).pop());
    await p.waitFor(() => !!dialog('전자결재상신'), [], { timeout: 8000, message: '전자결재상신 창이 열리지 않았습니다.' });
    try {
      await p.clickWhere(() => { const d = dialog('전자결재상신'); return byText('품의서입력', d, false)[0] || byText('출장', d, false)[0]; });
      await sleep(500);
      await p.clickWhere(f => byText(f).pop(), formName);
      await sleep(400);
    } catch (e) { await ui.assist(`결재양식 선택 실패(${e.message}). 결재양식을 '${formName}'으로 골라주세요.`); }
    await p.clickWhere(() => all('input[type=text]', dialog('전자결재상신')).filter(vis).pop());
    await p.selectAll();
    await p.type(title);
    await p.clickWhere(() => all('button', dialog('전자결재상신')).filter(b => norm(b.textContent) === '확인' && vis(b)).pop());
    const popup = await Promise.race([popupPromise, sleep(30000).then(() => null)]);
    if (!popup) throw new Error('전자결재 작성 창이 열리지 않았습니다.');
    await new Promise(r => popup.webContents.isLoading() ? popup.webContents.once('did-finish-load', r) : r());
    this.log('전자결재 작성 창이 열렸습니다.');
    return popup;
  }

  /** 팝업 본문 채우기 → 첨부 → [보관] */
  async fillAndKeep(popup, { title, probe, payload, attachments = [], save = true }) {
    const pp = new Page(popup), ui = this.ui;
    let frame = await pp.findFrame(FIND_JS, probe, 30000);
    if (!frame) { await ui.assist('본문 편집기를 찾지 못했습니다. 작성 창이 다 열렸는지 확인해 주세요.'); frame = await pp.findFrame(FIND_JS, probe, 5000); }

    const cur = await pp.eval(() => { const i = document.querySelector('.docTitleBox input'); return i ? i.value : null; });
    if (cur !== null && cur !== title) {
      await pp.clickWhere(() => document.querySelector('.docTitleBox input'));
      await pp.selectAll(); await pp.type(title);
    }

    if (frame) {
      const res = await frame.executeJavaScript(`(${FILL_JS})(${JSON.stringify(payload)})`);
      this.log(`본문 입력: ${res.filled.join(', ')}`);
      if (res.missing.length) await ui.assist(`본문에서 찾지 못한 칸: ${res.missing.join(', ')}. 직접 채워 주세요.`);
    }

    const files = attachments.filter(Boolean);
    if (files.length) {
      try { await pp.setFiles('input[type=file]', files); await sleep(1500); this.log(`첨부: ${files.length}개`); }
      catch (e) { await ui.assist(`첨부 실패(${e.message}). 다음 파일을 직접 끌어다 놓아 주세요: ${files.join(', ')}`); }
    }

    if (!save) { this.log('보관하지 않고 멈춥니다.'); return; }
    await pp.eval(() => { window.confirm = () => true; window.alert = () => {}; return true; });   // 보관 확인창 자동 승인
    await pp.clickWhere(() => all('.topBtn').find(b => norm(b.textContent) === '보관'));
    await sleep(800);
    try { await pp.clickWhere(() => all('button').filter(b => norm(b.textContent) === '확인' && vis(b)).pop()); } catch (e) { /* 확인창 없음 */ }
    await sleep(1500);
    this.log('보관(임시저장) 완료. 상신은 내용을 확인한 뒤 직접 눌러 주세요.');
  }
}

module.exports = { Amaranth, BUDGET_PATH };
