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
    await sleep(300);
    const btn = await p.eval(`(re) => { const d = (${findDlg})(re); if (!d) return null;
      const b = d.querySelector('#tutorial-conditionPanel-search, [class*=searchButton]') || all('button', d).find(x => vis(x) && !norm(x.textContent) && x.querySelector('img[src*=search]'));
      return b && vis(b) ? center(b) : null; }`, titleRe);
    if (btn) await p.click(btn);
    await sleep(600);

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
  async enterBudget(dept, expenses, { memo = '', kind = '지출' } = {}) {
    const p = this.page, ui = this.ui;
    this.log('품의서입력(복수) 화면을 엽니다.');
    await p.goto(this.baseUrl + BUDGET_PATH);
    await sleep(800);
    if (await this.isLoginPage()) { await this.ensureLogin(); await p.goto(this.baseUrl + BUDGET_PATH); }   // 세션 만료
    await p.waitFor(() => !!grid('품의구분'), [], { timeout: 30000, message: '품의서입력 화면이 열리지 않았습니다.' });
    await sleep(700);

    let row = (await this.rowCount('품의구분')) - 1;
    if (row < 0 || (await this.rowVals('품의구분', row))['순번']) {
      await ui.assist('품의 목록 맨 아래에 빈 행이 없습니다. 빈 행을 만든 뒤 [계속]을 눌러주세요.');
      row = (await this.rowCount('품의구분')) - 1;
    }

    const seqBefore = await p.eval(() => { const g = grid('품의구분'); return rows(g).map((_, i) => (rowVals(g, i) || {})['순번']).filter(Boolean); });
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
    // 저장되면 새 순번이 붙고 그리드가 스크롤돼 화면상 행 위치가 바뀐다 → 행 번호가 아니라 '새 순번'으로 찾는다
    let seq = await p.waitFor((k, before) => { const g = grid('품의구분'); if (!g) return null;
      const vs = rows(g).map((_, i) => rowVals(g, i)).filter(v => v && v['순번'] && !before.includes(v['순번']) && String(v['품의구분'] || '').includes(k));
      return vs.length ? vs[vs.length - 1]['순번'] : null; }, [kind, seqBefore], { timeout: 6000 });
    if (!seq) {
      await ui.assist(`품의구분이 '${kind}'로 저장되지 않은 것 같아요. 그룹웨어 창을 열어 맨 아래 빈 행의 품의구분을 '${kind}'로 고르고 Enter 3번 누른 뒤 [계속]을 눌러주세요.`);
      seq = await p.eval((k, before) => { const g = grid('품의구분'); const vs = rows(g).map((_, i) => rowVals(g, i)).filter(v => v && v['순번'] && !before.includes(v['순번']));
        return vs.length ? vs[vs.length - 1]['순번'] : null; }, kind, seqBefore);
    }
    this.log(`새 품의 순번 ${seq || '?'}`);
    if (seq) { const v = await p.eval(q => { const g = grid('품의구분'); return rows(g).map((_, i) => rowVals(g, i)).find(x => x && x['순번'] === q) || null; }, seq); this.rememberBudget(v); }   // 확정되면 바로 기억 → 중단 시 삭제

    // 품의 행 적요 (예: "RBY1 정비로 인한 출장")
    if (memo) {
      const rowOfSeq = () => p.eval(q => { const g = grid('품의구분'); return rows(g).findIndex((_, i) => (rowVals(g, i) || {})['순번'] === q); }, seq);
      try {
        const ri = seq ? await rowOfSeq() : row;
        if (ri < 0) throw new Error('행을 찾지 못함');
        await this.editCell('품의구분', ri, '적요', memo);
        const got = String(((await this.rowVals('품의구분', seq ? await rowOfSeq() : row)) || {})['적요'] || '');
        if (!norm(got).includes(norm(memo))) throw new Error(`적요 칸이 '${got || '빈칸'}'`);
      } catch (e) { await ui.assist(`품의 적요 입력 실패(${e.message}). 품의 행 적요에 '${memo}'를 넣어 주세요.`); }
    }

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
        await p.waitFor((n, a) => { const g = grid('예산과목'); return rows(g).length > n + 1 && Number(String((rowVals(g, n) || {})['품의금액'] || '').replace(/[^\d]/g, '')) === a; }, [i, ex.amount], { timeout: 2500, interval: 150 });
      } catch (e) { await ui.assist(`금액/적요 입력 실패(${e.message}). ${i + 1}번째 줄에 ${ex.amount.toLocaleString('ko-KR')}원 / '${ex.memo}' 를 입력해 주세요.`); }
      const got = amountOf(((await this.rowVals('예산과목', i)) || {})['품의금액']);
      if (got !== ex.amount) await ui.assist(`${i + 1}번째 줄 금액이 ${got.toLocaleString('ko-KR')}원으로 보입니다. ${ex.amount.toLocaleString('ko-KR')}원으로 고쳐 주세요.`);
    }

    // 품의 행 체크 → 총금액 확인
    await sleep(300);
    const rowOf = () => p.eval(q => { const g = grid('품의구분'); return rows(g).findIndex((_, i) => (rowVals(g, i) || {})['순번'] === q); }, seq);
    let ri = seq ? await rowOf() : -1;
    if (ri < 0) ri = row;
    await this.setRowChecked(ri, true, seq);
    await sleep(800);
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    if (seq) { const r2 = await rowOf(); if (r2 >= 0) ri = r2; }
    const vals = await this.rowVals('품의구분', ri);
    if (amountOf(vals['총금액']) !== total)
      await ui.assist(`품의 총금액이 ${amountOf(vals['총금액']).toLocaleString('ko-KR')}원입니다(예상 ${total.toLocaleString('ko-KR')}원). 확인 후 품의 행만 체크된 상태로 두세요.`);
    this.log(`품의 입력 완료: 총 ${total.toLocaleString('ko-KR')}원 (순번 ${vals['순번'] || '?'})`);
    this.rememberBudget(vals);
    return ri;
  }
  rememberBudget(vals) {
    if (vals && vals['순번']) this.lastBudget = { key: [vals['품의연월'], vals['품의일'], vals['순번']].join('|'), ym: vals['품의연월'], day: vals['품의일'], seq: vals['순번'] };
  }
  /** 취소·오류로 중단할 때: 작성 팝업 닫고, 만들어 둔 품의 행 삭제 (ui 가 이미 취소 상태라 log/assist 없이 돈다) */
  async rollback() {
    for (const w of popupsOf.get(this.win.webContents)) if (!w.isDestroyed()) w.destroy();
    if (!this.lastBudget) return '';
    const g = new Amaranth({ win: this.win, baseUrl: this.baseUrl, ui: { assist: async m => { throw new Error(m); } }, log: () => {}, debugDir: this.debugDir, creds: this.creds });
    try { await g.deleteBudgetRows([this.lastBudget.key]); return `— 그룹웨어에 올리던 품의(순번 ${this.lastBudget.seq})는 삭제했어요.`; }
    catch (e) { return `— 그룹웨어 품의(순번 ${this.lastBudget.seq}) 삭제 실패: ${e.message}. 품의서입력(복수) 화면에서 직접 지워 주세요.`; }
  }

  // ---------- 올린 품의 목록·삭제 ----------
  /** 결재가 진행 중이거나 끝난 품의는 삭제하지 않는다 */
  static locked(status) {
    const t = String(status || '').replace(/\s/g, '');
    if (!t || /(상신대기|미상신|작성|보관|임시|반려|회수|취소)/.test(t)) return false;   // 아직 상신 전이거나 돌아온 건
    return /(진행|완료|승인|결재중|종결|상신|합의|결재대기|보류)/.test(t);
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
  /** 위쪽 품의 그리드 가운데 좌표 (휠 스크롤용) */
  topGridPoint() { return this.page.eval(() => { const g = grid('품의구분'); const b = g && g.querySelector('.rg-body, table:last-of-type') || g; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 120)) }; }); }
  visibleBudgetRows() { return this.page.eval(() => { const g = grid('품의구분'); return g ? rows(g).map((_, i) => rowVals(g, i)) : []; }); }

  /** 위쪽 그리드 한 칸 스크롤 (dir -1 위 / +1 아래). 휠이 안 먹으면 셀을 잡고 방향키. 움직였으면 true */
  async scrollTop(dir, big = false) {
    const p = this.page;
    const sig = async () => JSON.stringify((await this.visibleBudgetRows()).map(r => r && r['순번']));
    const before = await sig();
    await p.wheel(await this.topGridPoint(), dir * (big ? 600 : 120));
    if ((await sig()) !== before) return true;
    // 방향키: 위쪽 그리드의 맨 위/아래 보이는 행 '품의연월' 칸을 잡고 이동
    const n = (await this.visibleBudgetRows()).length;
    if (!n) return false;
    if (!this._kbFocus) { await p.click(await this.cellPoint('품의구분', dir < 0 ? 0 : n - 1, '품의연월')); this._kbFocus = true; await sleep(200); }
    for (let k = 0; k < (big ? 10 : 2); k++) await p.key(dir < 0 ? 'Up' : 'Down');
    await sleep(200);
    return (await sig()) !== before;
  }

  // ---------- 그룹웨어 API 직접 호출 (화면 없이, DB 조회처럼 빠르게) ----------
  // 아마란스10 요청 규칙(번들에서 확인): Authorization: Bearer <세션 토큰>, transaction-id(32자 hex 난수), timestamp(초),
  // wehago-sign = Base64(HmacSHA256(token + tid + timestamp + pathname, <세션 서명키>)). 인증값은 1회용.
  // 토큰·서명키는 이 앱의 그룹웨어 창 세션(persist:gw)이 로그인하며 받은 값이다.
  // 호출은 그룹웨어 페이지 안에서(같은 출처) 한다 — 브라우저가 붙이는 쿠키·언어 헤더가 실제 화면 요청과 똑같아야 서버가 같은 SQL 을 만든다.
  async apiCall(path, body, menuCode = 'NPC1023') {
    const p = this.page;
    if (!p.url().startsWith(this.baseUrl)) { await p.goto(this.baseUrl); await sleep(1500); }   // 처음 한 번만
    const r = await p.eval(async (base, path, body) => {
      const ck = n => (document.cookie.split('; ').find(c => c.startsWith(n + '=')) || '').slice(n.length + 1);
      const token = decodeURIComponent(ck('oAuthToken')), key = decodeURIComponent(ck('signKey'));
      if (!token || !key) return { error: '로그인 세션 없음' };
      const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
      const tid = hex(), ts = String(Math.floor(Date.now() / 1000));
      const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(token + tid + ts + path));
      const sign = btoa(String.fromCharCode(...new Uint8Array(sig)));
      const res = await fetch(base + path, { method: 'POST', credentials: 'include', body: JSON.stringify(body), headers: {
        'Content-type': 'application/json', Authorization: 'Bearer ' + token, 'transaction-id': tid, timestamp: ts, 'wehago-sign': sign,
        'Access-Domain': location.origin, 'menu-code': 'NPC1023', 'use-multilang': 'false' } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || (j.resultCode !== 0 && j.resultCode !== 200)) return { error: `API ${res.status}: ${(j.resultMsg || j.message || JSON.stringify(j)).slice(0, 300)}` };   // /gw/ 쪽은 200 을 성공으로 쓴다
      return { data: j.resultData };
    }, this.baseUrl, path, body);
    if (!r || r.error) throw new Error((r && r.error) || 'API 호출 실패');
    return r.data;
  }

  /** 전자결재 > 상신문서 목록 (기안일 from~to, YYYYMMDD). 문서번호·결재양식·결재상태가 있어 "진짜 출장 신청/보고 문서"를 가려낼 수 있다.
   *  번들에서 확인: 상신문서 화면(UBA1010, 메뉴 1000400, 상위 1000300)이 /eap/eap107A04 를 이 본문으로 호출한다 */
  async apiApprovalDocs(from, to) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const data = await this.apiCall('/eap/eap107A04', {
        page: String(page), pageSize: '100', eaBoxId: '1000300', nMenuID: '1000400', sfrDt: from, stoDt: to,
        sDocTp: '', searchCompSeq: '', searchBizSeq: '', sTitle: '', sContents: '', sUserNm: '', sDocSts: '', sDocNo: '', sDeptNm: '', sReceipt: '', sLineNm: '', sAll: '',
        sFormId: ['0'], periodPicker: 'REP_DT', sortField: 'REP_DT', sortType: 'DESC', docContentsData: {}, item: {}, fDocSts: [], sReadYN: '', sExecYN: '',
        useElasticSearch: false, useElasticSearch_new: false, pageCode: 'UBA1010', upperMenuNo: '1000300', menuNo: '1000400' }, 'UBA1010');
      const list = (data && data.list && (data.list.list || data.list)) || (Array.isArray(data) ? data : []);
      for (const d of list) out.push({ docId: String(d.DOC_ID || ''), formId: String(d.FORM_ID || ''), docNo: String(d.DOC_NO || ''), title: String(d.DOC_TITLE || ''), form: String(d.FORM_NM || ''),
        status: String(d.DOC_STSNM || d.DOC_STS || ''), date: String(d.REP_DT || d.CREATED_DT || '') });
      const total = Number((data && data.list && data.list.totalCount) || 0);
      if (list.length < 100 || out.length >= total) break;
    }
    return out;
  }

  /** 회계단위·부서·사번 {coCd, deptCd, empCd}: 품의서입력 화면 상단 "1000. (주)…" / "MBU1000. …" / "250303. …" 칸에서, 없으면 sessionStorage.userInfo 에서. 못 읽으면 null */
  async apiUser() {
    return this.page.eval(() => { try {
      const code = label => {
        const el = all('*').find(e => ownText(e) && vis(e) && norm(e.textContent) === label); if (!el) return '';
        for (let box = el.parentElement, i = 0; box && i < 4; box = box.parentElement, i++) {
          const inp = all('input', box).find(x => vis(x) && /^[A-Za-z0-9]+\.\s*\S/.test(x.value) && (el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING));
          if (inp) return inp.value.split('.')[0].trim();
        }
        return '';
      };
      const s = { coCd: code('회계단위'), deptCd: code('품의부서'), empCd: code('작성자') };
      if (s.coCd && s.deptCd && s.empCd) return s;
      const u = JSON.parse(sessionStorage.getItem('userInfo') || 'null'); const out = {};
      const walk = (o, d) => { if (!o || typeof o !== 'object' || d > 4) return; for (const [k, v] of Object.entries(o)) { if (/^(coCd|deptCd|empCd)$/.test(k) && v && !out[k]) out[k] = String(v); else if (v && typeof v === 'object') walk(v, d + 1); } };
      walk(u, 0); return out.coCd && out.deptCd && out.empCd ? out : null;
    } catch (e) { return null; } }).catch(() => null);
  }

  /** 품의 목록을 API 로. user: {coCd, deptCd, empCd}. months: ['2026-10', …] 는 월 단위로, days: ['2026-10|15', …] 는 날짜별로 조회해 합친다.
   *  월 단위 요청(getDt·getDtDate 비움)은 서버가 거부할 수 있어서 실패하면 그 달의 날짜별 조회로 후퇴한다 */
  async apiBudgetRows(user, { months = [], days = [] } = {}) {
    const out = new Map();
    const query = async (ym, day) => {
      const y = ym.slice(0, 4), m = ym.slice(5, 7); const last = String(new Date(Number(y), Number(m), 0).getDate());
      const rows = await this.apiCall('/nonprofit/NCA0018/0BN00001', { targetDivCd: [user.coCd], targetDeptCd: user.deptCd, targetEmpCd: user.empCd,
        getDt: day ? y + m + day.padStart(2, '0') : '', getDtYearMonth: y + m + '01', getDtLastDate: y + m + last, getDtDate: day ? String(Number(day)) : '',
        getFg: [], mgtCds: [], mgtBottoms: [], bgtCds: [], startUnitAm: '0', endUnitAm: '0', rmkDc: '', optionBN01: '1', optionBN14: '0', vPCoCd: user.coCd, coCd: user.coCd });
      for (const x of rows || []) {
        if (!x.getSq) continue;
        const rym = String(x.getDtYymm || '').replace(/^(\d{4})(\d{2})$/, '$1-$2'), rday = String(Number(x.getDtDd || day)), seq = String(x.getSq);
        const status = x.approStateNm || Amaranth.APPRO_STATE[String(x.approState)] || '';
        out.set([rym, rday, seq].join('|'), { key: [rym, rday, seq].join('|'), ym: rym, day: rday, seq, kind: String(x.getFg) === '1' ? '지출' : String(x.getFg) === '2' ? '수입' : '',
          memo: x.rmkDc || '', total: Math.round(Number(x.unitSumam) || 0).toLocaleString('ko-KR'), status, docNo: x.noDoc || '', locked: Amaranth.locked(status) });
      }
    };
    const covered = new Set();
    for (const ym of months) {
      try { await query(ym, ''); covered.add(ym); }
      catch (e) { this.log(`(${ym} 월 단위 조회 안 됨: ${String(e.message).slice(0, 80)} — 날짜별로)`); this.monthQueryFailed = true; }
    }
    for (const d of days) { const [ym, day] = d.split('|'); if (!covered.has(ym)) await query(ym, day); }
    return [...out.values()];
  }

  /** 품의서입력(복수) 위쪽 목록 전체 (보이는 행만 그리는 그리드라 스크롤하며 모은다). 순번이 있는 = 저장된 품의만 */
  /** 목록 조회 진단: 그룹웨어가 쓰는 API(요청·응답)와 RealGrid2 데이터 접근 가능 여부를 파일로 남긴다 → 스크롤 없이 바로 읽는 방식으로 바꾸기 위함 */
  /** 한 번만: 품의 행을 눌렀을 때 아래 예산 그리드를 채우는 요청(품의 상세 API)을 기록 → 적요 대신 예산과목(여비교통비)으로 출장 품의를 가려내기 위함 */
  async diagBudgetDetail() {
    const fs = require('fs'), path = require('path');
    const file = path.join(this.debugDir, 'net-budget-detail.json');
    if (fs.existsSync(file)) return;
    let stop = null;
    try {
      await this.openBudgetList();
      const ri = await this.page.eval(() => { const g = grid('품의구분'); return rows(g).findIndex((_, i) => (rowVals(g, i) || {})['순번']); });
      if (ri < 0) return;
      stop = await this.page.netLogStart();
      await this.page.click(await this.cellPoint('품의구분', ri, '순번'));
      await sleep(2500);
      const net = (await stop()).filter(r => !/static|langPack|event0|schres/.test(r.url));
      const bottom = await this.page.eval(() => { const g = grid('예산과목'); const r = g && rgFind(document, g); return r ? rgRows(r).slice(0, 3) : null; });
      fs.mkdirSync(this.debugDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), row: ri, bottom, net }, null, 1));
    } catch (e) { try { if (stop) await stop(); } catch (e2) { /* */ } }
  }

  /** 한 번만: 전자결재 > 상신문서 화면을 숨긴 채 열어 목록 요청(문서별 결재양식·상태가 있는 API)을 기록 → 적요 대신 결재양식으로 출장 문서를 가려내기 위함 */
  async diagApprovalList() {
    const fs = require('fs'), path = require('path');
    const file = path.join(this.debugDir, 'net-approval-list.json');
    if (fs.existsSync(file)) return;
    const out = { at: new Date().toISOString(), steps: [] };
    let stop = null;
    try {
      // 1) 전자결재 메뉴 트리에서 '상신문서' 위치 찾기 (메뉴 API)
      const tree = await this.apiCall('/gw/gw999A04', { menuGubun: 'UB', menuCode: 'UB', urlPath: 'UBA0000', searchAllLowerMenu: true });
      const flat = []; const walk = (n, d) => { for (const x of n || []) { flat.push({ d, menuNo: x.menuNo, name: x.name, urlPath: x.urlPath, menuCode: x.menuCode, menuGubun: x.menuGubun }); walk(x.children, d + 1); } };
      walk(tree, 0); out.tree = flat;
      const hit = flat.find(x => /^상신문서/.test(String(x.name || '').replace(/\s/g, ''))) || flat.find(x => /^상신\/?보관함/.test(String(x.name || '').replace(/\s/g, '')));
      out.hit = hit || null;
      if (!hit) throw new Error('상신/보관함 메뉴 없음');
      // 2) 그 화면을 열면서 요청 기록. 상신/보관함이면 왼쪽의 '상신문서'를 눌러 본다
      stop = await this.page.netLogStart();
      await this.page.goto(`${this.baseUrl}/#/${hit.menuGubun}/${hit.menuCode}/${hit.urlPath}`);
      await sleep(5000);
      const sub = await this.page.eval(() => { const el = all('a, button, span, li, div').filter(e => vis(e) && ownText(e) && /^상신문서/.test(norm(e.textContent))).pop(); return el ? center(el) : null; });
      out.clickedSub = !!sub;
      if (sub) { await this.page.click(sub); await sleep(5000); }
      const net = await stop(); stop = null;
      out.url = this.page.url(); out.frames = this.page.frames().map(f => f.url);
      out.text = (await this.page.allText()).slice(0, 1500);
      out.net = net.filter(r => !/static|langPack|event0|schres/.test(r.url));
    } catch (e) { out.error = e.message; try { if (stop) await stop(); } catch (e2) { /* */ } }
    try { fs.mkdirSync(this.debugDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(out, null, 1)); } catch (e) { /* */ }
  }

  async diagBudgetList() {
    if (!this.debugDir) return this.openBudgetList();
    let stop = null;
    try { stop = await this.page.netLogStart(); } catch (e) { /* 디버거 사용 불가 */ }
    await this.openBudgetList();
    try {
      const net = stop ? await stop() : [];
      const probe = await this.page.eval(() => { try {
        const g = grid('품의구분'); const r = g && rgFind(document, g);
        return r ? { found: true, gv: !!r.gv, dp: !!r.dp, iface: !!r.iface, count: r.dp && r.dp.getRowCount && r.dp.getRowCount(), rows: rgRows(r).slice(0, 3), methods: r.dp && rgMethods(r.dp) } : { found: false, gridClass: g && g.className };
      } catch (e) { return { error: e.message }; } });
      const fs = require('fs'), path = require('path');
      fs.mkdirSync(this.debugDir, { recursive: true });
      fs.writeFileSync(path.join(this.debugDir, 'net-budget-list.json'), JSON.stringify({ at: new Date().toISOString(), url: this.page.url(), probe, net }, null, 1));
    } catch (e) { /* 진단은 실패해도 목록 조회는 계속 */ }
  }

  /** 결재 문서 본문(HTML)에서 출장신청서 칸을 읽는다: {destination, period, start, end, start_time, end_time, category, project, transport, companions, companion_purpose, purpose}
   *  본문 API(번들에서 확인): /eap/eap111A19 {docId, formId} → resultData.docContents {basicHtml, content} */
  async apiApplyDocFields(docId, formId) {
    const data = await this.apiCall('/eap/eap111A19', { docId, formId }, 'UBA1010');
    const html = String(((data || {}).docContents || {}).basicHtml || '') + String(((data || {}).docContents || {}).content || '');
    if (!html.trim()) throw new Error('문서 본문 없음');
    return this.page.eval((html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const norm = s => (s || '').replace(/[\s\u200b\u00a0]/g, '');
      const cells = Array.from(doc.querySelectorAll('td,th'));
      const label = (...ls) => cells.find(td => ls.some(l => norm(td.textContent) === norm(l)));
      const next = td => { let s = td && td.nextElementSibling; while (s && !/^(TD|TH)$/.test(s.tagName)) s = s.nextElementSibling; if (s) return s; const tr = td && td.parentElement, n = tr && tr.nextElementSibling; return n ? n.querySelector('td,th') : null; };
      const text = (...ls) => { const v = next(label(...ls)); return v ? v.innerText.replace(/\u00a0/g, ' ').trim() : ''; };
      const checked = (...ls) => { const v = next(label(...ls)); if (!v) return []; const out = []; const walker = doc.createTreeWalker(v, NodeFilter.SHOW_ALL); let cur = null, buf = '';
        const flush = () => { if (cur && (cur.checked || cur.hasAttribute('checked'))) out.push(norm(buf)); buf = ''; };
        let n; while ((n = walker.nextNode())) { if (n.nodeType === 1 && n.tagName === 'INPUT' && n.type === 'checkbox') { flush(); cur = n; } else if (n.nodeType === 3 && cur) buf += n.textContent; } flush(); return out; };
      const period = text('출장일');
      const ds = [...period.matchAll(/(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})(?:\s*(\d{1,2}:\d{2}))?/g)].map(m => ({ d: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, t: m[4] || '' }));
      const cat = checked('구분'); const tr = checked('교통편');
      const project = (() => { const v = next(label('구분')); const m = v && /연구과제\s*\(\s*([^)]*?)\s*\)/.exec(v.innerText || ''); return m && !/^과제명$/.test(m[1].trim()) ? m[1].trim() : ''; })();
      return { destination: text('국내'), period, start: ds[0] ? ds[0].d : '', end: ds[1] ? ds[1].d : (ds[0] ? ds[0].d : ''), start_time: ds[0] ? ds[0].t : '', end_time: ds[1] ? ds[1].t : '',
        category: cat.some(c => c.startsWith('연구과제')) ? '연구과제' : '일반', project,
        transport: tr.some(c => c.startsWith('자차')) ? 'car' : tr.some(c => /기차|버스/.test(c)) ? 'transit' : tr.some(c => c.startsWith('법인')) ? 'corporate' : 'car',
        companions: text('동행자').split(/[,،、]\s*|\s{2,}/).map(s => s.trim()).filter(Boolean), companion_purpose: text('동행목적'), purpose: text('출장목적(상세기입)', '출장목적') };
    }, html);
  }

  /** 결재상태 코드 → 이름 (그룹웨어 flagsEx S0/01 코드표, 2026-10 기준) */
  static APPRO_STATE = { '-1': '반려취소', '-2': '미상신', '-3': '문서삭제', 0: '결재진행', 1: '결재완료', 2: '상신대기', 3: '보류', 4: '결재반려', 5: '임시보관' };

  /** 위쪽 그리드의 RealGrid2 데이터 공급자에서 전체 행을 바로 읽는다 (화면에 안 보이는 행 포함, 스크롤 불필요). 못 읽으면 null */
  async budgetRowsFromData() {
    const raw = await this.page.eval(() => { try { const g = grid('품의구분'); const r = g && rgFind(document, g); return r ? rgRows(r) : null; } catch (e) { return null; } }).catch(() => null);
    if (!raw || !raw.some(x => x && x.getSq)) return null;
    return raw.filter(x => x && x.getSq).map(x => {
      const ym = String(x.getDtYymm || '').replace(/^(\d{4})(\d{2})$/, '$1-$2'), day = String(x.getDtDd || ''), seq = String(x.getSq);
      const status = Amaranth.APPRO_STATE[String(x.approState)] || String(x.approState ?? '');
      return { key: [ym, day, seq].join('|'), ym, day, seq, kind: String(x.getFg) === '1' ? '지출' : String(x.getFg) === '2' ? '수입' : String(x.getFg || ''),
        memo: x.rmkDc || '', total: Math.round(Number(x.unitSumam) || 0).toLocaleString('ko-KR'), status, docNo: x.noDoc || '', locked: Amaranth.locked(status) };
    });
  }

  async listBudgetRows({ reopen = true, date = null } = {}) {
    if (reopen) await this.openBudgetList();
    if (date) await this.setBudgetDate(date[0], date[1]);   // [ym, day]
    const fast = await this.budgetRowsFromData();
    if (fast) return fast;
    this.log('(그리드 데이터를 못 읽어 화면을 스크롤하며 읽어요)');
    if (reopen) await this.diagBudgetList();
    this._kbFocus = false;
    const keyOf = r => [r['품의연월'], r['품의일'], r['순번']].join('|');
    for (let i = 0; i < 40; i++) if (!(await this.scrollTop(-1, true))) break;   // 맨 위로
    const seen = new Map();
    for (let i = 0; i < 300; i++) {
      for (const r of await this.visibleBudgetRows()) if (r && r['순번']) seen.set(keyOf(r), r);
      if (!(await this.scrollTop(1))) break;
    }
    for (const r of await this.visibleBudgetRows()) if (r && r['순번']) seen.set(keyOf(r), r);
    return [...seen.values()].map(r => ({ key: keyOf(r), ym: r['품의연월'] || '', day: r['품의일'] || '', seq: r['순번'],
      kind: r['품의구분'] || '', memo: r['적요'] || '', total: r['총금액'] || '', status: r['결재상태'] || '', docNo: r['문서번호'] || '',
      locked: Amaranth.locked(r['결재상태']) }));
  }

  /** 위쪽 그리드 화면상 i번째 행 체크 (RealGrid2 체크바는 별도 표: tr.rg-row-bar / span.rg-checkbar-checked) */
  async setRowChecked(i, on, seq = '') {
    const p = this.page;
    const state = () => p.eval(k => { const g = grid('품의구분'); const c = all('td.rg-checkbar-cell', g)[k]; if (!c) return null;
      const inp = c.querySelector('input[type=checkbox]'); const sp = c.querySelector('[class*=checkbar-checked], [class*=checkbar-unchecked]');
      return sp ? /checkbar-checked/.test(sp.className) : inp ? inp.checked : /☑/.test(c.textContent); }, i);
    for (let t = 0; t < 3; t++) {
      if ((await state()) === on) return;
      // 실제 체크바: 숨긴 input(display:none) → 보이는 span.rg-checkbar-(un)checked → 숨긴 label 순. 보이는 것만 클릭
      await p.clickWhere(k => { const g = grid('품의구분'); const c = all('td.rg-checkbar-cell', g)[k]; return c && (all('span, label, input', c).find(vis) || c); }, i);
      await sleep(300);
    }
    if ((await state()) !== on) throw new Error(`순번 ${seq} 행을 ${on ? '체크' : '해제'}하지 못했습니다.`);
  }

  /** key 품의 행이 화면에 보이게 스크롤하고 화면상 행 번호를 돌려준다 */
  /** 품의(key)의 예산 줄(아래 그리드)을 읽는다 → [{label, amount, memo}]. 상신 전 보고 품의에서 경비를 되살릴 때 쓴다 */
  /** 품의서입력 화면 위 조건의 품의일을 ym(YYYY-MM)·day 로 바꾸고 조회 (화면은 기본으로 오늘 날짜 품의만 보여 준다) */
  async setBudgetDate(ym, day) {
    const p = this.page;
    const box = () => p.eval(() => { const lb = all('*').find(e => ownText(e) && vis(e) && norm(e.textContent) === '품의일'); if (!lb) return null;
      let c = lb; for (let i = 0; c && i < 6 && all('input', c).filter(vis).length < 2; i++) c = c.parentElement;
      const ins = c ? all('input', c).filter(vis) : []; return ins.length >= 2 ? [center(ins[0]), center(ins[1]), ins[0].value, ins[1].value] : null; });
    const b = await box(); if (!b) return false;
    if (b[2] !== ym) { await p.click(b[0]); await p.selectAll(); await p.type(ym.replace('-', '')); await p.key('Enter'); await sleep(400); }
    if (String(Number(b[3])) !== String(Number(day))) { await p.click(b[1]); await p.selectAll(); await p.type(String(Number(day))); await p.key('Enter'); await sleep(300); }
    try { await p.clickWhere(() => document.querySelector('#tutorial-conditionPanel-search, [class*=OBTConditionPanel_searchButton]')); } catch (e) { await p.key('Enter'); }
    await sleep(1500);
    return true;
  }

  async budgetLines(key) {
    const p = this.page;
    await this.openBudgetList();
    const [ym, day] = key.split('|');
    await this.setBudgetDate(ym, day);
    const idx = await this.revealBudgetRow(key);
    if (idx < 0) throw new Error('품의를 목록에서 찾지 못했어요');
    await p.click(await this.cellPoint('품의구분', idx, '순번'));
    await p.waitFor(() => { const g = grid('예산과목'); return g && rows(g).some((_, i) => (rowVals(g, i) || {})['예산과목']); }, [], { timeout: 6000 });
    await sleep(300);
    const lines = await p.eval(() => { const g = grid('예산과목'); return g ? rows(g).map((_, i) => rowVals(g, i)).filter(v => v && v['예산과목']) : []; });
    return lines.map(v => ({ label: String(v['예산과목'] || ''), amount: Number(String(v['품의금액'] || '').replace(/[^\d]/g, '')) || 0, memo: String(v['적요'] || '') })).filter(l => l.amount > 0);
  }

  async revealBudgetRow(key) {
    const p = this.page;
    const find = () => p.eval(k => { const g = grid('품의구분'); return rows(g).findIndex((_, i) => { const v = rowVals(g, i) || {}; return [v['품의연월'], v['품의일'], v['순번']].join('|') === k; }); }, key);
    for (const dir of [-1, 1]) {
      for (let i = 0; i < 200; i++) {
        const idx = await find(); if (idx >= 0) return idx;
        if (!(await this.scrollTop(dir))) break;
      }
    }
    return -1;
  }


  /** keys(품의연월|품의일|순번) 품의 삭제. 화면은 품의일 하루치만 보여 주므로 날짜별로 나눠 지운다 */
  async deleteBudgetRows(keys) {
    const byDate = new Map();
    for (const k of keys) { const [ym, day] = k.split('|'); const d = `${ym}|${day}`; byDate.set(d, [...(byDate.get(d) || []), k]); }
    let deleted = 0, skipped = 0, rows = [];
    for (const [d, ks] of byDate) { const r = await this.deleteBudgetRowsOn(ks, d.split('|')); deleted += r.deleted; skipped += r.skipped; rows = r.rows || rows; }
    return { deleted, skipped, rows };
  }

  async deleteBudgetRowsOn(keys, date) {
    const p = this.page, ui = this.ui;
    const want = new Set(keys);
    const before = await this.listBudgetRows({ date });   // 새로 열어(그 품의일로) 체크가 하나도 없는 상태에서 시작
    const targets = before.filter(r => want.has(r.key));
    const skip = targets.filter(r => r.locked);
    for (const r of skip) this.log(`건너뜀: ${r.day}일 순번 ${r.seq} (결재상태 '${r.status}')`);
    const del = targets.filter(r => !r.locked);
    if (!del.length) { this.log('삭제할 품의가 없습니다.'); return { deleted: 0, skipped: skip.length }; }
    for (const r of del) {
      this.log(`선택: ${r.ym} ${r.day}일 순번 ${r.seq} ${r.memo} ${r.total}`);
      const idx = await this.revealBudgetRow(r.key);
      if (idx < 0) throw new Error(`순번 ${r.seq} 품의를 목록에서 찾지 못했습니다.`);
      await this.setRowChecked(idx, true, r.seq);
      await sleep(250);
    }
    const okBefore = await p.eval(() => all('button, [role=button]').filter(b => vis(b) && /^(확인|예)$/.test(norm(b.textContent))).length);
    // 삭제 버튼: 체크하면 나타나는 하단 바 [삭제] → 없으면 상단 휴지통 아이콘
    const btn = await p.eval(() => {
      const g = grid('품의구분'); const gt = g ? g.getBoundingClientRect().top : 9999;
      const exact = all('button, [role=button]').filter(b => vis(b) && !b.disabled && norm(b.textContent) === '삭제' && b.getBoundingClientRect().top > gt);
      if (exact.length) return { ...center(exact.pop()), how: '하단 [삭제]' };
      const c = all('button, [role=button]').filter(b => vis(b) && b.getBoundingClientRect().bottom <= gt + 5).filter(b => {
        const t = norm(b.textContent) + (b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '') + (b.id || '') + (b.className || '');
        const img = b.querySelector('img'); const src = img ? img.getAttribute('src') || '' : '';
        return /삭제|delete|trash|remove/i.test(t) || /del|trash|remove/i.test(src);
      });
      const b = c.pop(); return b ? { ...center(b), how: '상단 휴지통' } : null; });
    if (btn) { this.log(`삭제 버튼 클릭 (${btn.how})`); await p.click(btn); }
    else await ui.assist(`삭제할 품의 ${del.length}건을 체크해 두었어요. [그룹웨어 창 열기]로 창을 띄워 삭제 버튼을 눌러 주세요.`);
    // 확인 창: "삭제하시겠습니까?" 등 — 새로 뜬 창의 [확인]/[예]
    const ok = await p.waitFor(n => {
      const h = all('*').filter(e => ownText(e) && vis(e) && /삭제/.test(e.textContent) && /(\?|하시겠|할까요)/.test(e.textContent)).pop();
      const d = h && dialog(h.textContent.trim()); const b1 = d && okButtons(d).pop(); if (b1) return center(b1);
      const bs = all('button, [role=button]').filter(b => vis(b) && /^(확인|예)$/.test(norm(b.textContent)));
      return bs.length > n ? center(bs[bs.length - 1]) : null; }, [okBefore], { timeout: 6000 });
    if (ok) { this.log('삭제 확인 클릭'); await p.click(ok); } else this.log('(삭제 확인 창이 보이지 않았어요)');
    await sleep(1500);
    // 완료 알림(삭제되었습니다 등)이 뜨면 닫기
    const done = await p.eval(n => { const bs = all('button, [role=button]').filter(b => vis(b) && /^(확인|예)$/.test(norm(b.textContent))); return bs.length > n ? center(bs[bs.length - 1]) : null; }, okBefore);
    if (done) await p.click(done);
    await sleep(2000);
    const after = await this.listBudgetRows({ date });
    const left = after.filter(r => del.some(d => d.key === r.key));
    if (left.length) await this.debugDump('delete', '삭제');
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

    if (!save) { popup.show(); popup.focus(); this.log('본문까지 채웠어요. 열린 작성 창에서 확인하고 [보관]·[상신]은 직접 눌러 주세요.'); return; }
    await pp.eval(() => { window.__confirm = window.confirm; window.confirm = () => true; window.alert = () => {}; return true; });   // 보관 확인창 자동 승인
    await pp.clickWhere(() => all('.topBtn').find(b => norm(b.textContent) === '보관'));
    await sleep(800);
    try { await pp.clickWhere(() => all('button').filter(b => norm(b.textContent) === '확인' && vis(b)).pop()); } catch (e) { /* 확인창 없음 */ }
    await sleep(1500);
    this.log('보관(임시저장) 완료. 열린 작성 창에서 결재선을 확인하고 [상신]은 직접 눌러 주세요.');
    // [상신]은 절대 자동으로 누르지 않는다 — 결재선이 기본값이면 그 자리에서 제출돼 버린다 (회수 필요)
    await pp.eval(() => { window.confirm = window.__confirm; return true; });   // 확인창 다시 사람에게
    popup.show(); popup.focus();
  }
}

module.exports = { Amaranth, BUDGET_PATH };
