'use strict';
// 아마란스10 조작: 품의서입력(복수) 그리드 → 결재상신 모달 → 전자결재 팝업 본문 → 보관.
// 그리드는 RealGrid2 DOM: 행 tr.rg-data-row / 셀 td.rg-data-cell(헤더 .rg-header-cell 순서) /
// 행 체크 td.rg-checkbar-cell / 드롭다운 .rg-list-editor
// 자동 조작이 막히면 ui.assist() 로 사람에게 넘기고(앱 화면에 안내 + [계속]) 이어서 진행한다.

const { Page, sleep } = require('./driver');
const { FILL_JS, FIND_JS } = require('./editorFill');

const BUDGET_PATH = '/#/HP/NPC1023/NCA0018';
const APPROVE_PATH = '/#/HP/NPC1025/NCA0019';
const COMPOSE_PATH = '/#/UB/UB/UBA0000?specialLnb=Y&moduleCode=UB&menuCode=UBA&pageCode=UBA6000';   // 전자결재 › 결재작성 (전체 양식)
const RESOLUTION_PATH = '/#/HP/NPC1030/NCA0020';   // 결의서입력: 전송된 결의 → [결재상신]   // 품의서승인(복수): 승인된 품의 → [결의서전송/취소]
const { capToBudget, planPayees, PAY_MODES } = require('./rules');
// 확인창(OBTConfirm·'…?' 창) 안의 [확인]/[예] 위치. 없으면 null. 화면 전체에서 '마지막 확인'을 고르면 결의서전송 창 맨 아래 [확인]이 눌려 창이 닫힌다
// (실제 덤프로 확인: 확인창 버튼이 DOM 에서 창 버튼보다 앞에 있음 — 2026-10-22)
const CONFIRM_OK = `() => { const m = x => vis(x) && /하시겠습니까|습니까\\s*\\?|\\?\\s*(취소|확인|예|아니오)/.test(x.innerText || '') && !/OBTDialog_bottomButton/.test(x.className);
  const d = all('[class*=Confirm_root]').filter(m).pop() || all('[class*=Dialog], .dialog_data, [role=dialog]').filter(x => m(x) && (x.innerText || '').length < 300).pop();   // 큰 창(결의서전송) 말고 확인창
  const b = d && all('button, [role=button]', d).filter(b => vis(b) && /^(확인|예)$/.test(norm(b.textContent))).pop(); return b ? center(b) : null; }`;
const G_PAYEE = '거래처코드';   // 채주내역 그리드 (첫 열)
const p_wait = async (p, cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(500); } return false; };
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
        // 비밀번호 값은 진단 파일에 남기지 않는다: 복제본의 비밀번호 칸 값을 지운 뒤 HTML 로 (글자 치환은 속성 순서·'>' 에 뚫림)
        const safe = el => { const c = el.cloneNode(true); (c.matches && c.matches('input[type=password]') ? [c] : []).concat([...c.querySelectorAll('input[type=password]')]).forEach(i => i.setAttribute('value', '***')); return c.outerHTML; };
        const ae = document.activeElement;   // 창 포커스·표시 상태 (윈도우에서 숨긴 창이 포커스를 못 받아 편집기·드롭다운이 안 열리는지 가리려고)
        const env = { hasFocus: document.hasFocus(), visibility: document.visibilityState, active: ae ? `${ae.tagName}#${ae.id}.${String(ae.className).slice(0, 60)}` : '',
          screen: [screenX, screenY, innerWidth, innerHeight, devicePixelRatio], dropdownItems: all('.rg-dropdown-item').length,
          listEditor: (all('input.rg-list-editor').map(e => `${e.getAttribute('aria-expanded')} ${e.parentElement.style.cssText}`)[0] || '') };
        return { dialog: dlg ? safe(dlg) : '(창 제목을 못 찾음)', page: safe(document.documentElement), url: location.href, probe: { env, ...(probe || {}) } };
      }, titleRe || '.^');
      fs.writeFileSync(base + '-dialog.html', `<!-- ${d.url} -->\n` + d.dialog);
      fs.writeFileSync(base + '-page.html', d.page);
      const w = this.win; d.probe.env.win = { focused: w.isFocused(), visible: w.isVisible(), minimized: w.isMinimized(), bounds: w.getBounds(), platform: process.platform };
      fs.writeFileSync(base + '-probe.json', JSON.stringify(d.probe, null, 1));
      this.log(`(창 상태: 포커스 ${d.probe.env.hasFocus ? 'O' : 'X'}/${w.isFocused() ? 'O' : 'X'}, ${d.probe.env.visibility}, 드롭다운 항목 ${d.probe.env.dropdownItems}개)`);
      try { fs.writeFileSync(base + '.png', (await this.win.webContents.capturePage()).toPNG()); } catch (e) { this.log(`(진단 캡처 실패: ${e.message})`); }
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
    // 그룹웨어 주소(같은 origin)일 때만 비밀번호를 넣는다 — 앞부분만 같은 다른 주소·리다이렉트된 남의 사이트에 넣지 않게
    const sameOrigin = () => { try { return new URL(p.url()).origin === new URL(this.baseUrl).origin; } catch (e) { return false; } };
    if (!sameOrigin()) { this.log(`(그룹웨어 주소가 아니라 자동 로그인을 안 해요: ${p.url().slice(0, 60)})`); return false; }
    this.log('저장된 계정으로 그룹웨어에 로그인합니다.');
    const has = what => p.eval(w => !!(w === 'pw' ? loginPw() : loginId()), what);
    // 칸 비우고 넣기 → 정확히 그 값인지 확인 (남아 있던 글자에 붙어 'fdfd1123' 처럼 되는 것 방지). 안 맞으면 Backspace 로 지우고 다시
    const fill = async (which, v) => {
      const pick = which === 'pw' ? () => loginPw() : () => loginId();
      for (let t = 0; t < 3; t++) {
        await p.clickWhere(pick);
        await p.eval(w => { const el = w === 'pw' ? loginPw() : loginId(); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); }, which);
        if (t) await p.press('Backspace', 40);
        if (which === 'pw' && !sameOrigin()) throw new Error('그룹웨어 주소가 아니에요');   // 넣기 직전에도
        await p.type(v);
        if (await p.eval((w, x) => (w === 'pw' ? loginPw() : loginId()).value === x, which, v)) return;
        this.log(`(${which === 'pw' ? '비밀번호' : '아이디'} 칸 값이 달라 다시 넣어요${which === 'pw' ? '' : `: '${await p.eval(() => loginId().value)}'`})`);
      }
    };
    try {
      // 2단계(비밀번호) 화면에 다른 아이디가 고정돼 보이면(예: 처음에 잘못 친 아이디) [다른계정으로 로그인]으로 1단계로 돌아간다
      const fixedId = () => p.eval(() => { const i = all('input[type=text]').find(e => vis(e) && (e.disabled || e.readOnly) && e.value && !/회사|comp/i.test(e.id + e.placeholder)); return i ? i.value : ''; });   // 2단계 화면에 고정된 아이디
      const state = async () => `아이디칸 ${(await has('id')) ? '편집 가능' : '없음'}, 고정 아이디 '${await fixedId()}', 비밀번호칸 ${(await has('pw')) ? '있음' : '없음'}`;
      this.log(`로그인 화면: ${await state()}`);
      if (await has('pw') && !(await has('id')) && (await fixedId()) !== id) {   // 2단계에 다른 아이디가 고정돼 있음 (예: 처음에 잘못 친 아이디)
        this.log(`고정된 아이디('${await fixedId()}')가 달라 [다른계정으로 로그인]으로 처음부터 다시 해요.`);
        const unlocked = () => p.eval(v => !!loginId() || (() => { const i = all('input[type=text]').find(e => vis(e) && (e.disabled || e.readOnly) && e.value); return !i || i.value === v; })(), id);
        const other = await p.eval(() => { const b = all('a, button, span, div').filter(e => vis(e) && ownText(e) && /다른\s*계정으로\s*로그인/.test(e.textContent)).pop(); return b ? center(b) : null; });
        if (other) { await p.click(other); await p.waitFor(unlocked, [], { timeout: 4000 }); }
        if (!(await unlocked())) {   // 링크가 안 먹으면 로그인 페이지를 새로 연다
          this.log('[다른계정으로 로그인]이 안 먹어 로그인 페이지를 새로 열어요.');
          await p.goto(this.baseUrl); await sleep(2500);
          await p.waitFor(unlocked, [], { timeout: 8000 });
        }
        await sleep(500);
        this.log(`→ ${await state()}`);
        if (!(await unlocked())) { await this.debugDump('login-locked', '로그인'); this.log('아이디를 바꿀 수 없는 화면이에요.'); return false; }
      }
      if (!(await has('pw')) && (await has('id'))) {             // 1단계: 아이디만 있는 화면 → 다음
        await fill('id', id);
        const next = await p.eval(() => { const b = all('button, [role=button], input[type=submit], a, span, div').filter(e => vis(e) && /^(다음|NEXT|Next|확인|로그인|LOGIN|Login)$/.test(norm(e.textContent || e.value))).pop(); return b ? center(b) : null; });
        if (next) await p.click(next); else await p.key('Enter');
        await p.waitFor(() => !!loginPw(), [], { timeout: 8000 });
        this.log(`아이디 입력 후: ${await state()}`);
      }
      if (await has('pw')) {
        if (await has('id') && !(await p.eval(v => loginId().value === v, id))) await fill('id', id);
        await fill('pw', pw);
        await p.key('Enter');
        this.log('비밀번호 입력 → 로그인 시도');
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
    this.win.setSkipTaskbar(false); this.win.center(); this.win.show(); this.win.focus();   // 윈도우·리눅스는 화면 밖에 둔 창이라 가운데로
    // 사람이 로그인하도록 '질문'으로 넘긴다 → 앱 화면의 딤이 풀리고 [작업 중인 창 열기]·[취소]가 보인다 (조용히 기다리면 화면이 잠긴 것처럼 보임)
    const msg = '그룹웨어에 로그인되어 있지 않아요. [작업 중인 창 열기]로 아마란스 창을 띄워 직접 로그인해 주세요. 로그인되면 자동으로 이어서 진행해요. (설정 → 그룹웨어 계정에 저장해 두면 다음부터 자동 로그인)';
    const end = Date.now() + timeoutMs;
    const cancelled = () => !!(this.ui && this.ui.cancelled);
    const waitLogin = async () => { while (await this.isLoginPage()) { if (cancelled()) throw new Error('취소됨'); if (Date.now() > end) throw new Error('로그인 대기 시간(10분)이 지났습니다. 다시 눌러 주세요.'); await sleep(1000); } };
    if (this.ui && typeof this.ui.assist === 'function' && typeof this.ui.answer === 'function') {   // 작업(Job) 화면이 있을 때
      let done = false; const w = waitLogin().then(() => { done = true; }); w.catch(() => {});
      while (!done) {
        await Promise.race([this.ui.assist(msg), w]);   // [계속]을 누르거나 로그인이 감지되면. [취소]면 여기서 바로 끝남 (삼키지 않음)
        if (done) this.ui.answer(true);                 // 로그인 감지 → 열려 있던 질문 닫기
        else await Promise.race([w, sleep(2000)]);      // [계속]만 눌렀으면 잠깐 보고 다시 물어봄
      }
      await w;
    } else { this.log(msg); await waitLogin(); }
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
  /** 내 정보: 품의서입력 화면 위 칸에서 {coCd, deptCd, deptName, empCd, empName} ("MBU1000. 매니퓰레이터 사업부" 형식) */
  async readProfile() {
    await this.openBudgetList();
    return this.page.eval(() => {
      const val = label => { const el = all('*').find(e => ownText(e) && vis(e) && norm(e.textContent) === label); if (!el) return '';
        for (let box = el.parentElement, i = 0; box && i < 4; box = box.parentElement, i++) {
          const inp = all('input', box).find(x => vis(x) && /^[A-Za-z0-9]+\.\s*\S/.test(x.value) && (el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING));
          if (inp) return inp.value; }
        return ''; };
      const split = v => { const m = /^([A-Za-z0-9]+)\.\s*(.+)$/.exec(v || ''); return m ? [m[1], m[2].trim()] : ['', '']; };
      const [coCd] = split(val('회계단위')), [deptCd, deptName] = split(val('품의부서')), [empCd, empName] = split(val('작성자'));
      return { coCd, deptCd, deptName, empCd, empName };
    });
  }

  /** 예산 줄 '부서' 사업코드도움의 전체 목록 이름들 (아무것도 고르지 않고 닫는다). 못 읽으면 [] */
  async budgetDeptList() {
    const p = this.page, title = '^사업코드도움$';
    const findDlg = `(re) => { const r = new RegExp(re); const h = all('*').filter(e => ownText(e) && vis(e) && r.test(e.textContent.trim())).pop(); return h ? dialog(h.textContent.trim()) : null; }`;
    let stop = null;
    try { if (this.debugDir) stop = await p.netLogStart(); } catch (e) { stop = null; }
    try {
      await this.openCodeHelp('예산과목', 0, '부서', title);
      const btn = await p.eval(`(re) => { const d = (${findDlg})(re); const b = d && (d.querySelector('#tutorial-conditionPanel-search, [class*=searchButton]') || all('button', d).find(x => vis(x) && !norm(x.textContent) && x.querySelector('img[src*=search]'))); return b && vis(b) ? center(b) : null; }`, title);
      if (btn) await p.click(btn);
      const rows = await p.waitFor(`(re) => { const d = (${findDlg})(re); const g = d && rgFind(d); const rs = g ? rgRows(g).filter(Boolean) : []; return rs.length ? rs : null; }`, [title], { timeout: 6000 });
      // 행마다 이름 칸: 키가 nm/name 이고 한글인 값 → 없으면 한글 값 아무거나
      const names = (rows || []).map(r => { const es = Object.entries(r).filter(([, v]) => typeof v === 'string' && /[가-힣]/.test(v));
        const hit = es.find(([k]) => /(nm|name)$/i.test(k)) || es[0]; return hit ? hit[1].trim() : ''; }).filter(Boolean);
      return [...new Set(names)];
    } finally {
      try { await p.clickWhere(`(re) => { const d = (${findDlg})(re); return d && all('button', d).filter(b => vis(b) && /^(취소|닫기)$/.test(norm(b.textContent))).pop(); }`, title); }
      catch (e) { await p.key('Escape'); }
      if (stop) { try { const net = await stop(); require('fs').writeFileSync(require('path').join(this.debugDir, 'net-dept-codehelp.json'), JSON.stringify(net.filter(r => !/static|langPack|event0/.test(r.url)), null, 1)); } catch (e) { /* 진단 */ } }
    }
  }

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
  /** match: 글자(칸 값과 정확히 같음) 또는 { re: 정규식 글자, label: 안내용 } — re 에 맞는 줄이 여럿이면 사람에게 고르게 한다 */
  async pickInCodeHelp(titleRe, query, match) {
    const p = this.page;
    if (match && typeof match === 'object') return this.pickInCodeHelpBy(titleRe, query, match);
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

  /** 코드도움에서 고르기: 검색 → (re 가 있으면 그에 맞는) 줄 → 하나면 선택, 여럿이면 사람에게 모달로 고르게.
   *  remember 를 주면 고른 걸 이 작업(결재건) 동안 기억해 다음 채주 줄부터는 안 묻고 같은 걸로 */
  async pickInCodeHelpBy(titleRe, query, { re = '', label = '', remember = '' }) {
    const p = this.page, ui = this.ui;
    this.picks = this.picks || {};
    const kept = remember && this.picks[remember];
    const findDlg = `(re) => { const r = new RegExp(re); const h = all('*').filter(e => ownText(e) && vis(e) && r.test(e.textContent.trim())).pop(); return h ? dialog(h.textContent.trim()) : null; }`;
    await p.clickWhere(`(re) => { const d = (${findDlg})(re); return d && (d.querySelector('#name input, input#name') || all('input', d).find(e => vis(e) && !e.readOnly && !/date|YMD/i.test(e.className) && (e.type || 'text') === 'text')); }`, titleRe);
    await p.selectAll(); await p.type(query); await sleep(300); await p.key('Enter'); await sleep(300);
    const btn = await p.eval(`(re) => { const d = (${findDlg})(re); if (!d) return null;
      const b = d.querySelector('#tutorial-conditionPanel-search, [class*=searchButton]') || all('button', d).find(x => vis(x) && !norm(x.textContent) && x.querySelector('img[src*=search]'));
      return b && vis(b) ? center(b) : null; }`, titleRe);
    if (btn) await p.click(btn);
    await sleep(600);
    const got = await p.waitFor(`(t, re) => { const d = (${findDlg})(t); const g = d && rgFind(d); if (!g) return null; const rows = rgRows(g); if (!rows.some(r => r)) return null;
      const rx = re ? new RegExp(re) : null;
      const hits = rows.map((r, i) => { if (!r) return null; const vals = Object.values(r).map(v => String(v ?? '')).filter(Boolean);
        const text = rx ? vals.find(v => rx.test(norm(v))) : vals.find(v => /[가-힣A-Za-z]/.test(v) && !/^\d+$/.test(v));   // re 없으면 이름 칸(글자 있는 첫 값)
        return text ? { i, text, row: vals.join(' · ') } : null; }).filter(Boolean);
      return { n: rows.length, hits }; }`, [titleRe, re], { timeout: 4000 });
    if (!got) throw new Error('검색 결과를 읽지 못했어요');
    if (!got.hits.length) throw new Error(`검색 결과 ${got.n}건 중 ${label || re}에 맞는 줄이 없어요`);
    let pick = got.hits[0];
    if (kept) {
      pick = got.hits.find(h => h.text === kept);
      if (!pick) throw new Error(`전에 고른 '${kept}' 줄이 이번 검색 결과에 없어요`);
    } else if (got.hits.length > 1) {
      const k = typeof ui.askChoice === 'function' ? await ui.askChoice(`'${query}' 이름의 거래처가 ${got.hits.length}건 검색됐어요. 이 결재건에서 쓸 거래처를 골라 주세요 (이번 작업의 다음 채주 줄도 같은 걸로 넣어요).`, got.hits.map(h => h.row)) : '';
      if (k === '' || k == null) throw new Error(`'${query}' 거래처가 ${got.hits.length}건이라 고르지 못했어요`);
      pick = got.hits[Number(k)];
    }
    if (remember) this.picks[remember] = pick.text;
    this.log(`  코드도움 선택: ${pick.text}${kept ? ' (전에 고른 것)' : ''}`);
    await p.eval(`(t, i) => { const d = (${findDlg})(t); rgSelect(rgFind(d), i); }`, titleRe, pick.i);
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
    // 목록은 화면이 뜬 뒤 따로 불러오고, 다 불러와야 맨 아래 빈 행(새 입력 줄)이 생긴다. 느린 PC·품의가 많은 사람은 몇 초 걸림
    const blankReady = async () => { const n = await this.rowCount('품의구분'); return n > 0 && !(await this.rowVals('품의구분', n - 1))['순번']; };
    const waitBlank = async ms => { const end = Date.now() + ms; while (Date.now() < end) { if (await blankReady()) return true; await sleep(500); } return false; };
    if (!(await waitBlank(15000))) {
      this.log('(품의 목록이 늦게 떠서 [조회]를 다시 눌러요)');
      try { await p.clickWhere(() => all('button').filter(b => vis(b) && norm(b.textContent) === '조회')[0]); } catch (e) { /* 조회 버튼 없음 */ }
      if (!(await waitBlank(15000))) await this.debugDump('budget-noblank', '품의서입력');
    }

    let row = (await this.rowCount('품의구분')) - 1;
    if (row < 0 || (await this.rowVals('품의구분', row))['순번']) {
      // 사람에게 맡겨도 [계속]만 누르고 넘어올 수 있다 → 빈 행이 생길 때까지 다시 묻는다 (행 번호 -1 로 진행하면 엉뚱한 실패가 이어짐)
      for (let i = 0; i < 5 && !(await blankReady()); i++) {
        await ui.assist('품의 목록이 아직 안 떴거나 맨 아래 빈 행이 없어요. [작업 중인 창 열기]에서 [조회]를 눌러 목록과 맨 아래 빈 행이 보이면 [계속]을 눌러 주세요.');
        await waitBlank(5000);
      }
      row = (await this.rowCount('품의구분')) - 1;
      if (!(await blankReady())) throw new Error('품의 목록에 새 입력 줄(빈 행)이 없어 품의를 만들 수 없어요. 그룹웨어에서 품의서입력(복수) 화면이 정상인지 확인해 주세요.');
    }

    // 이미 있는 순번: 화면 줄(보이는 것만 그려짐)에 목록 API(그날 전체)를 더한다. 화면만 보면 스크롤 밖의 옛 품의를 '새 품의'로 착각해 엉뚱한 품의에 연결될 수 있음
    const seqDom = await p.eval(() => { const g = grid('품의구분'); return rows(g).map((_, i) => (rowVals(g, i) || {})['순번']).filter(Boolean); });
    let seqApi = [];
    try { const u = await this.apiUser(); const t = new Date(); const ym = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`;
      if (u) seqApi = (await this.apiBudgetRows(u, { days: [`${ym}|${t.getDate()}`] })).map(r => r.seq); } catch (e) { /* API 실패 → 화면 줄만 */ }
    const seqBefore = [...new Set([...seqDom, ...seqApi])];
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
      await this.debugDump('kind-fail', '품의서입력');
      await ui.assist(`품의구분이 '${kind}'로 저장되지 않은 것 같아요. 위 [작업 중인 창 열기]로 뜬 창에서(따로 연 브라우저 말고) 맨 아래 빈 행의 품의구분을 '${kind}'로 고르고 Enter 3번 누른 뒤 [계속]을 눌러주세요.`);
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
        const diagFile = this.debugDir && require('path').join(this.debugDir, 'net-dept-codehelp.json');
        const stopNet = diagFile && i === 0 && !require('fs').existsSync(diagFile) ? await p.netLogStart().catch(() => null) : null;
        await this.openCodeHelp('예산과목', i, '부서', '^사업코드도움$');
        await this.pickInCodeHelp('^사업코드도움$', dept, dept);
        if (stopNet) { try { const net = await stopNet(); require('fs').mkdirSync(this.debugDir, { recursive: true }); require('fs').writeFileSync(diagFile, JSON.stringify(net.filter(r => !/static|langPack|event0/.test(r.url)), null, 1)); } catch (e) { /* 진단 */ } }
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
          memo: x.rmkDc || '', total: Math.round(Number(x.unitSumam) || 0).toLocaleString('ko-KR'), status, docNo: x.noDoc || '', locked: Amaranth.locked(status), sent: Math.round(Number(x.sendUnitAm) || 0), refund: Math.round(Number(x.refundUnitAm) || 0), remain: Math.round(Number(x.remainUnitAm) || 0) });   // sent·refund·remain: 이 API(0BN00001)엔 없어 늘 0 (품의서승인 화면 그리드에만 있음)
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

  /** 한 번만(진단 파일이 없을 때): 보고서 결의서전송 흐름 자동화를 만들기 위해 실제 화면 구조를 기록한다. 읽기 전용.
   *  품의서승인(복수) 목록 → 승인된 출장 신청 품의 하나 체크 → [결의서전송/취소] 창을 열어 구조만 기록 → 창 닫기.
   *  결의구분 선택·집행용도 Enter(결의 순번이 생김)·[전송]은 하지 않는다. */
  async diagReportFlow() {
    const fs = require('fs'), path = require('path');
    if (!this.debugDir) return;
    const file = path.join(this.debugDir, 'report-flow.json');
    if (fs.existsSync(file)) return;
    const p = this.page, out = { at: new Date().toISOString(), steps: [] };
    const step = (name, v) => { out.steps.push({ name, ...v }); this.log(`(진단: ${name})`); };
    const buttons = () => p.eval(() => all('button, [role=button]').filter(vis).map(b => b.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean));
    try {
      await p.goto(this.baseUrl + APPROVE_PATH);
      await sleep(2000);
      if (await this.isLoginPage()) { await this.ensureLogin(); await p.goto(this.baseUrl + APPROVE_PATH); }
      await p.waitFor(() => all('.rg-root, [data-orbit-component=OBTDataGrid]').some(vis), [], { timeout: 30000, message: '품의서승인 화면이 열리지 않았어요' });
      await sleep(2500);
      // 화면 기본 조회 조건이 오늘 하루면 목록이 빌 수 있다 → 그대로 기록 (조건 칸 구조도 page.html 에 남음)
      const list = await p.eval(() => {
        const gs = all('.rg-root').filter(vis).map(g => ({ headers: headers(g), rows: rows(g).map((_, i) => rowVals(g, i)).slice(0, 30) }));
        const r = rgFind(document); const data = r ? rgRows(r).slice(0, 30) : null;
        return { url: location.href, grids: gs, data };
      });
      step('목록', { list, buttons: await buttons() });
      await this.debugDump('rf1-approval-list', '품의서승인');
      // 승인완료 품의 찾기 (사용자가 고른 테스트 건: 2026-09 27일 순번 3). 기본 조회가 오늘만이면 기간을 9/1~10/31 로 넓혀 다시 조회
      const findIdx = () => p.eval(() => { const g = all('.rg-root').filter(vis)[0]; if (!g) return -1;
        const vs = rows(g).map((_, i) => rowVals(g, i) || {});
        const k = vs.findIndex(v => v['품의연월'] === '2026-09' && v['품의일'] === '27' && v['순번'] === '3');
        return k >= 0 ? k : vs.findIndex(v => JSON.stringify(v).includes('승인완료')); });
      let idx = await findIdx();
      if (idx < 0) {
        const box = await p.eval(() => { const lb = all('*').find(e => ownText(e) && vis(e) && norm(e.textContent) === '품의일자'); if (!lb) return null;
          let c = lb; for (let i = 0; c && i < 6 && !all('input', c).filter(vis).length; i++) c = c.parentElement;
          const ins = c ? all('input', c).filter(vis) : []; return ins.length ? { pts: ins.map(center), vals: ins.map(x => x.value) } : null; });
        step('품의일자 칸', { box });
        if (box) {
          // 날짜 칸은 숫자만 받는다(품의서입력 화면과 같음): 20260901 → Enter
          const want = box.pts.length >= 2 ? ['20260901', '20261031'] : ['20260901'];
          for (let i = 0; i < want.length; i++) { await p.click(box.pts[i]); await p.selectAll(); await p.type(want[i]); await p.key('Enter'); await sleep(400); }
          step('날짜 입력 후', { vals: await p.eval(() => { const lb = all('*').find(e => ownText(e) && vis(e) && norm(e.textContent) === '품의일자');
            let c = lb; for (let i = 0; c && i < 6 && !all('input', c).filter(vis).length; i++) c = c.parentElement; return c ? all('input', c).filter(vis).map(x => x.value) : null; }) });
          try { await p.clickWhere(() => all('#tutorial-conditionPanel-search, [class*=OBTConditionPanel_searchButton]').filter(vis).pop()); } catch (e) { await p.key('Enter'); }
          await sleep(3000);
          idx = await findIdx();
          step('기간 넓힌 뒤', { idx, rows: await p.eval(() => { const g = all('.rg-root').filter(vis)[0]; return g ? rows(g).map((_, i) => rowVals(g, i)) : []; }) });
        }
      }
      step('승인완료 품의 행', { idx });
      if (idx < 0) throw new Error('목록에 승인완료 품의가 없어요 (조회 기간 확인 필요)');
      await p.clickWhere(k => { const g = all('.rg-root').filter(vis)[0]; const c = all('td.rg-checkbar-cell', g)[k]; return c && (all('span, label, input', c).find(vis) || c); }, idx);
      await sleep(800);
      step('체크 후', { buttons: await buttons() });
      await p.clickWhere(() => all('button, [role=button]').filter(b => vis(b) && norm(b.textContent) === '결의서전송/취소').pop());
      await sleep(4000);
      const dlg = await p.eval(() => ({
        texts: all('*').filter(e => vis(e) && ownText(e)).map(e => e.textContent.trim()).filter(t => t.length < 40).slice(-200),
        grids: all('.rg-root').filter(vis).map(g => ({ headers: headers(g), rows: rows(g).map((_, i) => rowVals(g, i)).slice(0, 10) })),
        inputs: all('input, textarea, select').filter(vis).map(e => ({ tag: e.tagName, type: e.type, ph: e.placeholder, val: e.value, ro: e.readOnly })).slice(0, 80),
      }));
      step('결의서전송 창', { dlg, buttons: await buttons() });
      await this.debugDump('rf2-transfer-dialog', '결의서전송');
    } catch (e) { out.error = e.message; await this.debugDump('rf-error', '품의서승인|결의서전송').catch(() => {}); }
    finally {
      // 창 닫기: Esc → 그래도 있으면 [닫기]/[취소](정확히 그 글자)만. [전송]은 절대 누르지 않는다
      try { await p.key('Escape'); await sleep(800);
        const close = await p.eval(() => { const b = all('button, [role=button]').filter(b => vis(b) && /^(닫기|취소)$/.test(norm(b.textContent))).pop(); return b ? center(b) : null; });
        if (close) { await p.click(close); await sleep(800); }
      } catch (e) { /* */ }
      try { fs.mkdirSync(this.debugDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(out, null, 1)); } catch (e) { /* */ }
    }
  }

  /** 한 번만(진단 파일이 없을 때): 보고서 3단계(결의서입력 → 결재상신) 자동화를 만들기 위해 결의서입력 화면 구조를 기록한다. 읽기 전용 — 아무 버튼도 누르지 않는다 */
  async diagResolutionInput() {
    const fs = require('fs'), path = require('path');
    if (!this.debugDir) return;
    const file = path.join(this.debugDir, 'resolution-input.json');
    if (fs.existsSync(file)) return;
    const p = this.page, out = { at: new Date().toISOString() };
    try {
      await p.goto(this.baseUrl + APPROVE_PATH); await sleep(2500);
      await p.clickWhere(() => all('.nav-text, span, a').filter(e => vis(e) && norm(e.textContent) === '결의서입력').pop());
      await sleep(5000);
      out.url = p.url();
      out.grids = await p.eval(() => all('.rg-root').filter(vis).map(g => ({ headers: headers(g), rows: rows(g).map((_, i) => rowVals(g, i)).slice(0, 15) })));
      out.data = await p.eval(() => { const r = rgFind(document); return r ? rgRows(r).slice(0, 15) : null; });
      out.buttons = await p.eval(() => all('button, [role=button]').filter(vis).map(b => b.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean));
      out.labels = await p.eval(() => all('*').filter(e => vis(e) && ownText(e)).map(e => e.textContent.trim()).filter(t => t.length < 20).slice(0, 120));
      await this.debugDump('rf3-resolution-input', '결의서입력');
    } catch (e) { out.error = e.message; await this.debugDump('rf3-error', '결의서입력').catch(() => {}); }
    try { fs.writeFileSync(file, JSON.stringify(out, null, 1)); } catch (e) { /* */ }
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
        transport: tr.some(c => c.startsWith('자차')) ? 'car' : tr.some(c => /기차|버스/.test(c)) ? 'transit' : tr.some(c => c.startsWith('법인')) ? 'corporate' : '',   // 아무것도 체크 안 됐으면 모름
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
  /** 체크바 상태 (실제 표시는 span.rg-checkbar-(un)checked — 숨긴 input.checked 는 안 따라옴). 그리드가 없으면 [] */
  checkStates(gridHdr) {
    return this.page.eval(h => { const g = grid(h); if (!g) return []; return all('td.rg-checkbar-cell', g).map(c => {
      const sp = c.querySelector('[class*=checkbar-checked], [class*=checkbar-unchecked]'), inp = c.querySelector('input[type=checkbox]');
      return sp ? /checkbar-checked/.test(sp.className) : inp ? inp.checked : /☑/.test(c.textContent); }); }, gridHdr);
  }
  /** i번째 줄 체크/해제. 누른 뒤 표시가 바뀌었는지 보고 최대 3번 */
  async setRowChecked(i, on, seq = '', gridHdr = '품의구분') {
    const p = this.page;
    for (let t = 0; t < 3; t++) {
      if ((await this.checkStates(gridHdr))[i] === on) return;
      // 실제 체크바: 숨긴 input(display:none) → 보이는 span.rg-checkbar-(un)checked → 숨긴 label 순. 보이는 것만 클릭
      await p.clickWhere((h, k) => { const g = grid(h); const c = g && all('td.rg-checkbar-cell', g)[k]; return c && (all('span, label, input', c).find(vis) || c); }, gridHdr, i);
      await sleep(400);
    }
    if ((await this.checkStates(gridHdr))[i] !== on) throw new Error(`${seq ? `순번 ${seq}` : `${i + 1}번째`} 행을 ${on ? '체크' : '해제'}하지 못했습니다.`);
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
    try { await p.clickWhere(() => all('#tutorial-conditionPanel-search, [class*=OBTConditionPanel_searchButton]').filter(vis).pop()); } catch (e) { await p.key('Enter'); }
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
    else await ui.assist(`삭제할 품의 ${del.length}건을 체크해 두었어요. [작업 중인 창 열기]로 창을 띄워 삭제 버튼을 눌러 주세요.`);
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

  // ---------- 보고서: 승인된 신청 품의로 지출결의(결의서전송) ----------
  /** 품의서승인(복수)에서 신청 품의(ym·day·seq) 행을 체크한다. 화면 기본 조회가 이번 달이라 품의일자 시작을 그 달 1일로 넓힌다 */
  async openApprovedBudget({ ym, day, seq }, { noAssist = false } = {}) {
    const p = this.page;
    if (p.url() === this.baseUrl + APPROVE_PATH) { p.wc.reload(); await new Promise(r => p.wc.once('did-finish-load', r)); }   // 같은 주소면 해시만 바뀌어 새로 안 열림
    else await p.goto(this.baseUrl + APPROVE_PATH);
    await sleep(2000);
    if (await this.isLoginPage()) { await this.ensureLogin(); await p.goto(this.baseUrl + APPROVE_PATH); }
    await p.waitFor(() => !!grid('품의구분'), [], { timeout: 30000, message: '품의서승인(복수) 화면이 열리지 않았어요.' });
    await sleep(1500);
    const find = () => p.eval((y, d, q) => { const g = grid('품의구분'); return rows(g).findIndex((_, i) => { const v = rowVals(g, i) || {}; return v['품의연월'] === y && String(Number(v['품의일'])) === String(Number(d)) && v['순번'] === String(q); }); }, ym, day, seq);
    let ri = await find();
    if (ri < 0) {   // 품의일자 시작 칸을 품의한 달 1일로 → 조회
      const box = await p.eval(() => { const lb = all('*').find(e => ownText(e) && vis(e) && norm(e.textContent) === '품의일자'); if (!lb) return null;
        let c = lb; for (let i = 0; c && i < 6 && !all('input', c).filter(vis).length; i++) c = c.parentElement;
        const ins = c ? all('input', c).filter(vis) : []; return ins.length ? center(ins[0]) : null; });
      if (box) {
        await p.click(box); await p.selectAll(); await p.type(ym.replace('-', '') + '01'); await p.key('Enter'); await sleep(400);
        try { await p.clickWhere(() => all('#tutorial-conditionPanel-search, [class*=OBTConditionPanel_searchButton]').filter(vis).pop()); } catch (e) { await p.key('Enter'); }
        await sleep(2500);
        ri = await find();
      }
    }
    if (ri < 0) {
      await this.debugDump('approve-find', '품의서승인');
      const rowsNow = await p.eval(() => { const g = grid('품의구분'); return g ? rows(g).map((_, i) => { const v = rowVals(g, i) || {}; return `${v['품의연월']}-${v['품의일']}#${v['순번']}`; }).join(', ') : '(그리드 없음)'; });
      this.log(`품의서승인 목록에 없음: 찾는 건 ${ym}-${day}#${seq}, 보이는 건 ${rowsNow}`);
      if (noAssist) throw new Error(`품의서승인 목록에서 신청 품의(${ym}-${day} 순번 ${seq})를 못 찾았어요`);
      await this.ui.assist(`품의서승인 목록에서 신청 품의(${ym}-${day} 순번 ${seq})를 못 찾았어요. 품의일자를 맞춰 조회하고 그 행만 체크한 뒤 [계속]을 눌러 주세요.`); return;
    }
    const v = await this.rowVals('품의구분', ri);
    if (!/승인완료/.test(v['진행상태'] || '')) throw new Error(`신청 품의(순번 ${seq})가 아직 '${v['진행상태'] || v['결재상태'] || '?'}' 상태예요. 신청이 승인완료돼야 보고(정산)를 할 수 있어요.`);
    await this.checkOnly('품의구분', ri, { noAssist });
    await sleep(300);
    this.approvedTotal = amountOf(v['총금액']);   // 품의 총금액 — 전송된 결의가 다 썼는지(환원할 게 있는지) 판단
    this.log(`신청 품의 선택: ${ym}-${day} 순번 ${seq} (${v['총금액']}원)`);
  }

  /** 예산내역 i번째 줄을 선택(아래 채주내역이 그 줄 것으로 바뀜). 선택됐는지(rg-focused-row) 확인하고 안 됐으면 다른 칸으로 다시. 끝내 안 되면 멈춘다 */
  async selectBudgetRow(i, label) {
    const p = this.page;
    const focused = () => p.eval(k => { const g = grid('결제수단'); const tr = g && rows(g)[k]; return !!tr && /rg-focused-row/.test(tr.className); }, i);
    for (const col of ['예산과목', '부서', '품의금액', '미지출액']) {
      await p.click(await this.cellPoint('결제수단', i, col)); await sleep(900);
      if (await focused()) return;
    }
    await this.debugDump('settle-select', '결의서전송');
    throw new Error(`예산 줄(${label})이 선택되지 않아요. 채주를 엉뚱한 줄에 넣지 않으려고 멈췄어요.`);
  }

  /** 그리드 칸 드롭다운에서 고르기 (항목 글자 "3.외상" 의 번호는 무시하고 비교) */
  async pickDropdown(gridHdr, row, col, want) {
    const p = this.page;
    if (norm(((await this.rowVals(gridHdr, row)) || {})[col] || '').includes(norm(want))) return;   // 이미 그 값이면 건드리지 않음
    await p.dblclick(await this.cellPoint(gridHdr, row, col));
    await sleep(500);
    // 목록 항목: "3.외상" 처럼 번호가 붙은 글자. 클래스(.rg-dropdown-item 등)에 기대지 않고 글자로 찾는다 — 가장 안쪽 요소
    const findOpt = k => { const cand = all('.rg-dropdown-item, li, [role=option], div, span').filter(e => vis(e) && /^\d+\./.test(norm(e.textContent)) && norm(e.textContent).replace(/^\d+\./, '') === k);
      const el = cand.find(e => !cand.some(o => o !== e && e.contains(o))); return el ? center(el) : null; };
    let opt = await p.waitFor(findOpt, [want], { timeout: 1500 });
    if (!opt) {   // 더블클릭으로 편집칸(예금 ▼)만 열리고 목록은 안 펼쳐질 때가 있다 → 칸 오른쪽 ▼ 를 누른다
      const arrow = await p.eval((h, r, c) => { const g = grid(h); const el = g && cell(g, r, c); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.right - 12), y: Math.round(b.top + b.height / 2) }; }, gridHdr, row, col);
      if (arrow) { await p.click(arrow); opt = await p.waitFor(findOpt, [want], { timeout: 3000 }); }
    }
    if (!opt) { await this.debugDump(`dropdown-${norm(col)}`, '결의서전송'); throw new Error(`'${want}' 항목이 안 보임`); }
    await p.click(opt); await sleep(400);
    const got = String(((await this.rowVals(gridHdr, row)) || {})[col] || '');
    if (!norm(got).includes(norm(want))) throw new Error(`${col} 칸이 '${got || '빈칸'}'`);
  }

  /** 전송된 결의면 { ok, resNo } (환원이 빠졌으면 [환원]만 다시). 아니면 null — 아무것도 안 함 */
  /** 그리드(gridHdr)에서 k번째 줄만 체크: 다른 줄에 남아 있던 체크(사람이 전에 해 둔 것 등)는 풀어 준다.
   *  체크 칸은 데이터 줄(tr) 안이 아니라 옆의 tr.rg-row-bar 에 있어 그리드 안 td.rg-checkbar-cell 순서 = 줄 순서 */
  /** k번째 줄만 체크 (다른 줄은 해제). fresh: 이미 체크돼 있어도 풀었다가 다시 (그대로 두면 [결재상신]이 안 먹는 화면이 있음).
   *  끝내 안 되면 사람에게 — 두 줄이 체크된 채로 넘어가면 그룹웨어가 "한 건의 품의서만 전송할 수 있습니다"로 막음 (2026-10-28) */
  async checkOnly(gridHdr, k, { fresh = false, noAssist = false } = {}) {
    try {
      const st = await this.checkStates(gridHdr);
      for (let i = 0; i < st.length; i++) if (i !== k && st[i]) { await this.setRowChecked(i, false, '', gridHdr); this.log(`  (다른 줄 ${i + 1} 체크 풀음)`); }
      if (fresh && st[k]) await this.setRowChecked(k, false, '', gridHdr);
      await this.setRowChecked(k, true, '', gridHdr);
      const now = await this.checkStates(gridHdr);
      if (now.some((on, i) => on !== (i === k))) throw new Error(`${now.map((on, i) => on ? i + 1 : '').filter(Boolean).join(',') || '없음'} 체크됨`);
    } catch (e) {
      if (/창이 닫혔/.test(e.message) || noAssist) throw e;   // 뒤에서 하는 점검은 사람에게 묻지 않고 다음에 다시
      await this.debugDump('check-only', '');
      await this.ui.assist(`목록에서 ${k + 1}번째 줄만 체크하지 못했어요(${e.message}). [작업 중인 창 열기]에서 그 줄만 체크(다른 줄은 해제)하고 [계속]을 눌러 주세요.`);
    }
  }
  /** 결의내역 ri 줄 체크 → 버튼(label) → 확인 창(최대 2개) */
  async pressResButton(ri, label) {
    const p = this.page;
    await this.checkOnly('결의구분', ri);
    await sleep(300);
    // 결의내역 그리드가 든 창 안의 버튼만 (창이 닫혔는데 아래 품의서승인 화면의 [삭제]를 누르면 안 됨)
    await p.clickWhere(l => { const g = grid('결의구분'); const hit = c => all('button', c).filter(b => vis(b) && norm(b.textContent) === l);
      let c = g; while (c && !hit(c).length) c = c.parentElement; return c ? hit(c).pop() : null; }, label);
    await sleep(1200);
    // "삭제하시겠습니까?" 같은 확인 창: 그 창 안의 [확인]만 (결의서전송 창 맨 아래 [확인]을 누르면 안 됨 — 2026-10-22 삭제가 안 된 원인)
    for (let i = 0; i < 2; i++) {
      // 진짜 확인창(Confirm·Alert)부터. 없을 때만 작은 창 — 적요·거래처비고에 '?'가 든 결의서전송 창 자체를 확인창으로 보면 맨 아래 [확인]이 눌려 창이 닫힘
      const ok = await p.eval(() => { const m = x => vis(x) && /하시겠습니까|습니까\?|\?/.test(x.innerText || '');
        const d = all('[class*=Confirm_root], [class*=Alert_root]').filter(m).pop() || all('[class*=Dialog], .dialog_data, [role=dialog]').filter(x => m(x) && (x.innerText || '').length < 300).pop();
        const b = d && all('button, [role=button]', d).filter(b => vis(b) && /^(확인|예)$/.test(norm(b.textContent))).pop(); return b ? center(b) : null; });
      if (!ok) break; await p.click(ok); await sleep(1500);
    }
  }
  /** 이미 전송된 지출결의서가 있을 때: 사람이 "다시 넣기"를 고르면 [전송취소] → 그 결의 줄 [삭제] (채주 줄도 같이 사라짐) → null 을 돌려줘 새로 넣는다 (사용자 요청 2026-10-22).
   *  안 고르면(이미 결재 올린 결의 등) 전처럼 그대로 두고 환원만 챙긴다.
   *  offerRedo: 사람이 [보고서 작성]으로 정산을 다시 돌릴 때만 true. 백그라운드 환원 점검(repairRefund)은 절대 묻지 않는다 — 결재 중인 결의를 지우게 하면 안 됨 */
  async keepRefundIfSent(res, readRes, pressRefund, isRefund, { offerRedo = false } = {}) {
    const sent = res.find(v => v['결의번호'] && /지출결의서/.test(v['결의구분'] || ''));
    if (!sent) return null;
    this.lastSent = { no: sent['결의번호'], amount: Number(String(sent['결의금액'] || '').replace(/[^\d]/g, '')) || 0, purpose: String(sent['집행용도'] || '') };   // 결의서입력에서 이 결의를 금액으로 찾게 (같은 날 다른 출장 결의와 헷갈리지 않게)
    const ui = this.ui;
    if (offerRedo && typeof ui.confirm === 'function' && await ui.confirm(`이미 전송된 정산 결의(${sent['결의번호']}, ${sent['결의금액'] || ''}원)가 있어요.\n채주를 다시 넣을까요? [예]를 누르면 전송취소 → 결의 줄 삭제 → 새로 입력해요.\n(이 결의로 이미 결재를 올렸다면 [아니오])`)) {
      try {
        const ri = () => readRes().then(r => r.findIndex(v => v['결의번호'] === sent['결의번호'] && /지출결의서/.test(v['결의구분'] || '')));
        let k = await ri();
        this.log(`[전송취소] 결의 ${sent['결의번호']}`);
        await this.pressResButton(k, '전송취소');
        const cancelled = await p_wait(this.page, async () => { const r = await readRes(); return r.some(v => /지출결의서/.test(v['결의구분'] || '') && !v['결의번호']) && !r.some(v => v['결의번호'] === sent['결의번호']); }, 8000);
        if (!cancelled) throw new Error('전송취소가 안 됐어요 (결의번호가 그대로)');
        k = (await readRes()).findIndex(v => /지출결의서/.test(v['결의구분'] || '') && !v['결의번호']);
        const before = (await readRes()).filter(v => v['결의구분']).length;
        this.log('전송취소된 지출결의서 줄 [삭제] (채주 줄도 같이)');
        await this.pressResButton(k, '삭제');
        const gone = await p_wait(this.page, async () => (await readRes()).filter(v => v['결의구분']).length < before, 8000);
        if (!gone) throw new Error('결의 줄이 안 지워졌어요');
        this.log('✔ 전송취소·삭제 — 채주를 새로 넣어요.');
        return null;
      } catch (e) {
        await this.debugDump('settle-retransfer', '결의서전송');
        await ui.assist(`전송취소·삭제를 못 했어요(${e.message}). [작업 중인 창 열기]에서 결의내역의 지출결의서 줄을 골라 [전송취소] → [삭제]한 뒤 [계속]을 눌러 주세요.`);
        if (!(await readRes()).some(v => v['결의번호'] && /지출결의서/.test(v['결의구분'] || ''))) return null;
      }
    }
    this.log(`이미 전송된 결의(${sent['결의번호']})가 있어 결의서전송은 건너뛰어요.`);
    // 품의를 다 쓴 결의는 환원할 게 없다 (정산 때도 [환원]을 안 누름) → 품의 총금액 − 결의금액 이 남을 때만
    const total = this.approvedTotal || 0;   // 품의서승인 목록의 총금액 (예산내역 그리드 합계는 화면에 그려진 줄만이라 안 믿음). 모르면 전처럼 [환원]
    if (total && amountOf(sent['결의금액']) >= total) { this.log('품의 금액을 다 써서 환원할 게 없어요.'); return { ok: true, resNo: sent['결의번호'] }; }
    if (!res.some(isRefund)) {
      this.log('환원이 빠져 있어 [환원]을 다시 눌러요 (남은 품의 금액 돌려주기).');
      try { await pressRefund(); if (!(await readRes()).some(isRefund)) throw new Error('환원 줄이 안 생겼어요'); this.log('✔ [환원] 다시 했어요.'); }
      catch (e) { await this.debugDump('settle-rerefund', '결의서전송'); await this.ui.assist(`[환원]을 다시 못 했어요(${e.message}). [작업 중인 창 열기]에서 결의서전송 창의 [환원]을 눌러 남은 금액을 돌려준 뒤 [계속]을 눌러 주세요.`); }
    }
    return { ok: true, resNo: sent['결의번호'] };
  }

  /** 전송은 됐는데 환원이 빠진 품의(목록 API: 결의금액>0, 환원 0, 잔액>0) → 결의서전송 창을 열어 [환원]만 다시. 전송 안 된 품의면 아무것도 안 함 */
  async repairRefund(row) {
    const p = this.page;
    await this.openApprovedBudget({ ym: row.ym, day: row.day, seq: row.seq }, { noAssist: true });   // 조용한 점검: 사람에게 묻지 않고 실패하면 다음에 다시
    await p.clickWhere(() => all('button, [role=button]').filter(b => vis(b) && norm(b.textContent) === '결의서전송/취소').pop());
    await p.waitFor(() => !!grid('결의구분'), [], { timeout: 10000, message: '결의서전송/취소 창이 열리지 않았어요.' });
    await sleep(1200);
    const readRes = () => p.eval(() => { const g = grid('결의구분'); return rows(g).map((_, i) => rowVals(g, i) || {}); });
    const isRefund = v => /환원/.test(v['결의구분'] || '');
    const pressRefund = async () => {
      await p.clickWhere(() => all('button').filter(b => vis(b) && norm(b.textContent) === '환원').pop()); await sleep(1500);
      const ok = await p.eval(CONFIRM_OK);
      if (ok) { await p.click(ok); await sleep(1000); }
    };
    const r = await this.keepRefundIfSent(await readRes(), readRes, pressRefund, isRefund);
    if (!r) this.log(`(${row.ym}-${row.day} 순번 ${row.seq}: 전송된 결의가 없어 손대지 않았어요)`);
    return r;
  }

  /** 결의서전송/취소 창: 지출결의서 → 집행용도 → 예산 줄 선택(예산내역은 신청 품의 그대로) → 채주내역(영수증마다 한 줄) → [환원]. [전송]은 사람이 누른다.
   *  lines: [{label(예산과목명), pay('personal'|'card'), supply, memo(거래처비고), planDate}] */
  async settleTransfer({ purpose, payee, fund, lines }) {
    const p = this.page, ui = this.ui;
    await p.clickWhere(() => all('button, [role=button]').filter(b => vis(b) && norm(b.textContent) === '결의서전송/취소').pop());
    await p.waitFor(() => !!grid('결의구분'), [], { timeout: 10000, message: '결의서전송/취소 창이 열리지 않았어요.' });
    await sleep(1200);

    const readRes = () => p.eval(() => { const g = grid('결의구분'); return rows(g).map((_, i) => rowVals(g, i) || {}); });
    const isRefund = v => /환원/.test(v['결의구분'] || '');
    const pressRefund = async () => {
      await p.clickWhere(() => all('button').filter(b => vis(b) && norm(b.textContent) === '환원').pop()); await sleep(1500);
      const ok = await p.eval(CONFIRM_OK);
      if (ok) { await p.click(ok); await sleep(1000); }
    };
    // 0) 이미 [전송]한 결의가 있으면 결의서전송은 끝난 것 — 아무것도 바꾸지 않는다 ([환원취소] 금지). 환원이 빠져 있으면 다시 [환원]만
    // 결의내역이 늦게 그려질 수 있다: 두 번 연달아 같게 읽힐 때까지 (느린 PC에서 빈 목록으로 보고 넘어가면 전송된 결의에 [환원취소]를 누를 뻔 — 자가 테스트 2026-10-28)
    let first = await readRes(); await sleep(500);
    await p_wait(p, async () => { const r = await readRes(); const same = JSON.stringify(r) === JSON.stringify(first); first = r; return same; }, 4000);
    const isSent = r => r.some(v => v['결의번호'] && /지출결의서/.test(v['결의구분'] || ''));   // 환원 줄엔 전송 뒤에도 결의번호가 안 붙는다 → 지출결의서로만 판단
    const done = await this.keepRefundIfSent(first, readRes, pressRefund, isRefund, { offerRedo: true });
    if (done) return done;
    // 0-1) 전송 전에 눌러 둔 [환원]이 있으면 먼저 [환원취소]. 채주를 다 넣은 뒤 마지막에 다시 환원한다
    // 다시 넣기(전송취소·삭제)를 했으면 줄 위치가 바뀌었으니 새로 읽는다 (예전 목록의 줄 번호로 누르면 엉뚱한 줄)
    let hi = (await readRes()).findIndex(v => isRefund(v) && !v['결의번호']);
    if (hi >= 0 && isSent(await readRes())) {   // 누르기 직전 한 번 더: 전송된 결의면 [환원취소] 절대 안 함
      const d = await this.keepRefundIfSent(await readRes(), readRes, pressRefund, isRefund, { offerRedo: true }); if (d) return d;
      hi = (await readRes()).findIndex(v => isRefund(v) && !v['결의번호']);   // 다시 넣기로 전송취소·삭제했으면 줄이 바뀜
    }
    if (hi >= 0) {
      this.log('전에 해 둔 환원이 있어 [환원취소]부터 해요.');
      try {
        await p.click(await this.cellPoint('결의구분', hi, '결의일자')); await sleep(400);
        await p.clickWhere(() => all('button').filter(b => vis(b) && norm(b.textContent) === '환원취소').pop()); await sleep(1200);
        const ok = await p.eval(CONFIRM_OK);
        if (ok) { await p.click(ok); await sleep(1200); }
        if ((await readRes()).some(v => /환원/.test(v['결의구분'] || '') && !v['결의번호'])) throw new Error('환원 줄이 그대로 있어요');
        this.log('[환원취소] 했어요.');
      } catch (e) { await this.debugDump('settle-unrefund', '결의서전송'); await ui.assist(`[환원취소]를 못 했어요(${e.message}). 결의내역의 환원 줄을 고르고 [환원취소]를 누른 뒤 [계속]을 눌러 주세요.`); }
    }

    // 1) 결의내역: 아직 전송 안 한 지출결의서 줄이 있으면 그 줄, 없으면 빈 줄에 새로
    let res = await readRes();
    let ri = res.findIndex(v => v['순번'] && /지출결의서/.test(v['결의구분'] || '') && !v['결의번호']);   // 전송된 결의는 지우지 않는다
    if (ri >= 0) {   // 전송 안 한 지출결의서 줄이 남아 있으면(전에 하다 만 것) 이어 쓰지 않고 지우고 새로 — 옛 채주 줄이 섞이지 않게 (사용자 요청 2026-10-22)
      this.log(`전에 만든 지출결의서 줄(순번 ${res[ri]['순번']})은 [삭제]하고 새로 넣어요.`);
      try {
        const before = res.filter(v => v['결의구분']).length;
        await this.pressResButton(ri, '삭제');
        const err = await this.closeErrorDialog(); if (err) throw new Error(err);
        if (!(await p_wait(p, async () => (await readRes()).filter(v => v['결의구분']).length < before, 8000))) throw new Error('결의 줄이 안 지워졌어요');
        this.log('✔ 지웠어요');
      } catch (e) {
        if (/창이 닫혔/.test(e.message)) throw e;
        await this.debugDump('settle-delete-res', '결의서전송');
        await ui.assist(`전에 만든 지출결의서 줄을 못 지웠어요(${e.message}). [작업 중인 창 열기]에서 결의내역의 그 줄을 체크하고 [삭제]한 뒤 [계속]을 눌러 주세요.`);
      }
      res = await readRes(); ri = res.findIndex(v => v['순번'] && /지출결의서/.test(v['결의구분'] || '') && !v['결의번호']);
    }
    if (ri < 0) {
      ri = res.findIndex(v => !v['순번']);
      if (ri < 0) ri = res.length - 1;
      this.log('결의구분: 지출결의서');
      try { await this.pickDropdown('결의구분', ri, '결의구분', '지출결의서'); }
      catch (e) { await ui.assist(`결의구분 선택 실패(${e.message}). 결의내역 빈 줄의 결의구분을 '지출결의서'로 골라 주세요.`); }
    } else this.log(`이미 만든 지출결의서 줄(순번 ${res[ri]['순번']})을 이어서 써요.`);
    this.log(`집행용도: ${purpose}`);
    try {
      await p.dblclick(await this.cellPoint('결의구분', ri, '집행용도'));
      await p.selectAll(); await p.type(purpose); await p.key('Enter'); await sleep(500);
      // 새 줄은 Enter 로 칸을 넘겨 순번이 붙어야 확정된다 (이미 있던 줄은 바로 확정). 순번이 생길 때까지 Enter, 최대 4번
      const seqOf = () => p.eval(r => { const g = grid('결의구분'); return ((g && rowVals(g, r)) || {})['순번'] || ''; }, ri);
      for (let i = 0; i < 4 && !(await seqOf()); i++) { await p.key('Enter'); await sleep(700); }
      this.log(`결의 줄 순번: ${(await seqOf()) || '(안 붙음)'}`);
      await sleep(400);
      // Enter 두 번이면 커서가 아래 빈 줄로 내려가 예산내역이 비어 보인다 → 이 결의 줄을 다시 눌러 선택해야 그 줄의 예산내역이 나온다
      const k = await p.eval(() => { const g = grid('결의구분'); return rows(g).findIndex((_, i) => /지출결의서/.test((rowVals(g, i) || {})['결의구분'] || '')); });
      await p.click(await this.cellPoint('결의구분', k >= 0 ? k : ri, '결의일자'));
      await p.waitFor(() => { const g = grid('결제수단'); return g && rows(g).some((_, i) => (rowVals(g, i) || {})['예산과목']); }, [], { timeout: 8000, message: '예산내역이 안 내려왔어요' });
    } catch (e) { await this.debugDump('settle-purpose', '결의서전송'); await ui.assist(`집행용도 입력 실패(${e.message}). 집행용도에 '${purpose}'를 넣고 Enter 두 번 눌러 예산내역이 내려오게 한 뒤 [계속]을 눌러 주세요.`); }
    await sleep(800);

    // 2) 예산내역 줄마다: 이 예산과목에 정산할 영수증이 있으면 결제수단·과세구분 → 채주내역
    const budgets = await p.eval(() => { const g = grid('결제수단'); return rows(g).map((_, i) => rowVals(g, i) || {}).filter(v => v['예산과목']); });
    const failed = [];   // 저장 확인이 안 된 채주 줄
    const { plan, left } = planPayees(budgets, lines);   // 같은 예산과목 영수증 여러 장 = 그 예산 줄 아래 채주 여러 줄 (식대 4일치 등)
    lines.filter(l => Number(l.amount) === 0).forEach(l => this.log(`${l.memo || l.label}: 0원이라 채주로는 안 넣어요`));
    for (const pb of plan) {
      if (!pb.lines.length) { this.log(`${pb.label}: 쓴 돈 없음 → 환원으로 전액 돌려줌`); continue; }
      const pays = [...new Set(pb.lines.map(l => l.pay || 'personal'))];
      if (pays.length > 1) {   // 사람이 직접 넣었으니 이 줄은 앱이 또 넣지 않는다 (전엔 [계속] 뒤에 같은 채주를 또 넣어 두 번 들어갔음)
        await ui.assist(`${pb.label} 에 개인경비와 법인카드가 섞여 있어요. 예산 줄 하나엔 결제수단 하나만 돼요. 그룹웨어에서 이 예산 줄의 채주를 직접 넣고 [계속]을 눌러 주세요. (앱은 이 줄은 건너뛰어요)`);
        pb.manual = true; continue;
      }
      const mode = PAY_MODES[pays[0]] || PAY_MODES.personal;
      this.log(`${pb.label}: ${mode.method}·${mode.tax}, 영수증 ${pb.lines.length}건`);
      try { await this.pickDropdown('결제수단', pb.index, '결제수단', mode.method); } catch (e) { await ui.assist(`결제수단 선택 실패(${e.message}). ${pb.label} 예산 줄 결제수단을 '${mode.method}'로 골라 주세요.`); }
      try { await this.pickDropdown('결제수단', pb.index, '과세구분', mode.tax); } catch (e) { await ui.assist(`과세구분 선택 실패(${e.message}). ${pb.label} 예산 줄 과세구분을 '${mode.tax}'로 골라 주세요.`); }
      pb.lines.filter(l => l.cut).forEach(l => this.log(`  ${l.memo || pb.label}: 품의 한도 ${pb.limit.toLocaleString('ko-KR')}원이라 ${l.cut.toLocaleString('ko-KR')}원 깎아 ${l.amount.toLocaleString('ko-KR')}원만 청구`));
      if (pb.dropped) this.log(`  한도를 다 써서 영수증 ${pb.dropped}건은 청구에서 뺐어요 (청구 안 한 영수증은 첨부도 안 해요)`);
      await this.selectBudgetRow(pb.index, pb.label);   // 이 예산 줄 선택 → 아래 채주내역이 이 줄 것 (선택 확인까지)
      await this.deleteStalePayees(payee, pb.lines);   // 전에 넣어 둔 다른 채주 줄은 지움 (남겨 두면 한도 넘어 그룹웨어가 "채주내역 등록/수정중 오류")
      for (const [k, l] of pb.lines.entries()) {
        if (k > 0) {   // 같은 예산 줄의 다음 채주: 첨부 뒤엔 채주 그리드가 오른쪽 끝에 멈춰 있어 키·스크롤이 안 먹는다 → 다른 예산 줄을 갔다 오면 왼쪽부터 다시 그려진다
          const other = budgets.findIndex((_, i) => i !== pb.index);
          if (other >= 0) { await this.selectBudgetRow(other, '다른 줄').catch(() => {}); await this.selectBudgetRow(pb.index, pb.label); }
        }
        if (!(await this.enterPayee(k + 1, { payee, fund, ...l }))) failed.push(`${pb.label} ${k + 1}번째`);
      }
    }
    // 저장 확인: 예산 줄을 다시 골라 채주가 남아 있는지 (화면에만 있던 값은 다른 줄을 고르면 사라진다)
    for (const pb of plan.filter(x => x.lines.length && !x.manual)) {
      // 같은 줄을 다시 눌러선 채주가 새로 안 그려진다 → 다른 예산 줄을 갔다 와야 저장 안 된 값이 사라져 보임 (채주 넣은 줄이 하나뿐일 때 확인이 헛돌았음)
      const other = budgets.findIndex((_, i) => i !== pb.index);
      if (other >= 0) await this.selectBudgetRow(other, '다른 줄').catch(() => {});
      await this.selectBudgetRow(pb.index, pb.label);
      let got = 0; for (const l of pb.lines) if ((await this.payeeRow({ payee, memo: l.memo, supply: l.supply })) >= 0) got++;   // 줄마다 내용으로 찾기 (보이는 줄만 그려져서 개수 세기는 안 믿음)
      this.log(`저장 확인 ${pb.label}: 채주 ${got}/${pb.lines.length}줄`);
      if (got < pb.lines.length) failed.push(`${pb.label} (저장 ${got}/${pb.lines.length})`);
    }
    // 사람에게 직접 넣게 한 줄(개인경비·법인카드 섞임): 채주가 한 줄이라도 들어갔는지는 본다 — [계속]만 누르면 빈 채로 환원·전송될 뻔
    for (const pb of plan.filter(x => x.manual)) {
      const other = budgets.findIndex((_, i) => i !== pb.index);
      if (other >= 0) await this.selectBudgetRow(other, '다른 줄').catch(() => {});
      await this.selectBudgetRow(pb.index, pb.label);
      const n = await p.eval(() => { const g = grid('거래처코드'); return g ? rows(g).map((_, i) => rowVals(g, i) || {}).filter(v => String(v['거래처명'] || '').trim()).length : 0; });
      this.log(`저장 확인 ${pb.label}: 직접 넣은 채주 ${n}줄`);
      if (!n) failed.push(`${pb.label} (직접 넣을 채주가 없음)`);
    }
    if (left.length) await ui.assist(`신청 품의에 없는 예산과목이라 못 넣은 경비가 있어요: ${left.map(l => `${l.label} ${l.supply.toLocaleString('ko-KR')}원`).join(', ')}. 그룹웨어에서 직접 처리해 주세요.`);

    // 3) [환원]: 신청액과 실제 사용액 차이를 - 로. 채주가 다 안 들어갔으면 누르지 않는다 (빈 채로 누르면 품의 전액이 환원됨)
    if (failed.length) {
      await this.debugDump('settle-payee-missing', '결의서전송');
      await ui.assist(`채주 줄이 저장 안 된 것 같아요: ${failed.join(', ')}. 그래서 [환원]은 누르지 않았어요. 직접 채주를 확인·입력하고 [환원]을 누른 뒤 [계속]을 눌러 주세요.`);
    } else if (plan.every(pb => pb.lines.reduce((a, l) => a + l.amount, 0) >= pb.limit)) this.log('품의 금액을 다 써서 환원할 금액이 없어요 ([환원] 안 누름)');
    else try { await pressRefund();
      // 누른 것만으로 끝내지 않고 환원 줄이 생겼는지 본다 (그룹웨어가 오류 창을 띄우면 환원 없이 전송될 뻔함)
      const err = await this.closeErrorDialog(); if (err) throw new Error(err);
      if (!(await p_wait(p, async () => (await readRes()).some(v => isRefund(v) && !v['결의번호']), 5000))) throw new Error('환원 줄이 안 생겼어요');
      this.log('[환원] 눌렀어요');
    } catch (e) { if (/창이 닫혔/.test(e.message)) throw e; await this.debugDump('settle-refund', '결의서전송'); await ui.assist(`[환원]을 못 했어요(${e.message}). [작업 중인 창 열기]에서 결의내역의 [환원]을 누르고 환원 줄이 생기면 [계속]을 눌러 주세요.`); }
    await this.debugDump('settle-done', '결의서전송');
    // 환원이 필요했는데 끝내 환원 줄이 없으면(도움 요청 뒤 [계속]만 누름) 자동 [전송]하지 않는다 — 남은 품의 금액이 안 돌아감
    const needRefund = !plan.every(pb => pb.lines.reduce((a, l) => a + l.amount, 0) >= pb.limit);
    if (!failed.length && needRefund && !(await readRes()).some(v => isRefund(v) && !v['결의번호'])) { this.log('환원 줄이 없어 [전송]은 하지 않았어요.'); return { ok: false }; }
    return { ok: !failed.length };
  }

  /** 가로로 가려진 칸(채주내역의 거래처비고·자금과목·자금계획일 등)을 그리드 안에 보이게 한 뒤 좌표.
   *  '보인다' = 그 좌표에서 실제로 맨 위에 있는 요소가 그 칸 (반쯤 가려진 칸을 누르면 창 밖 어두운 곳이 눌려 결의서전송 창이 닫힌다).
   *  안 보이면 그리드의 가로 스크롤 버튼(.rg-scroll-right/left)을 눌러 옮긴다 */
  async revealCell(gridHdr, row, col) {
    const p = this.page;
    // 보이는 칸 = 그 좌표에서 실제로 맨 위에 있는 요소가 그 칸. 방향은 '지금 보이는 칸들'과 비교해서 정한다
    // (.rg-body 는 전체 열 폭이라 화면에 보이는 범위가 아니다 → 그걸로 방향을 정하면 거꾸로 스크롤함)
    const look = () => p.eval((h, r, c) => { const g = grid(h); if (!g) return { closed: true }; const tr = rows(g)[r]; if (!tr) return { dir: 1 };
      const hit = td => { const b = td.getBoundingClientRect(); if (b.width < 4) return false; const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!t && (t === td || td.contains(t)); };
      const shown = all('td.rg-data-cell', tr).filter(hit);
      const el = cell(g, r, c);
      if (el && hit(el)) { const b = el.getBoundingClientRect(); return { pt: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } }; }
      const h0 = all('.rg-header-cell', g).find(x => norm(x.textContent) === norm(c));
      const ref = el || h0; if (!ref || !shown.length) return { dir: 1 };
      const x = ref.getBoundingClientRect().left, first = shown[0].getBoundingClientRect().left;
      return { dir: x < first ? -1 : 1 }; }, gridHdr, row, col);
    const tried = [];
    const check = async () => { const v = await look(); if (v.closed) throw new Error('결의서전송 창이 닫혔어요'); return v; };
    let v = await check(); if (v.pt) return v.pt;
    // 1) 방향키: 이 줄에서 실제로 보이는 맨 오른쪽(왼쪽) 칸을 누르고 →(←). 그리드는 현재 칸을 따라 스크롤한다
    const edge = await p.eval((h, r, d) => { const g = grid(h); const tr = g && rows(g)[r]; if (!tr) return null;
      const ok = all('td.rg-data-cell', tr).filter(td => { const b = td.getBoundingClientRect(); const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return b.width > 4 && t && (t === td || td.contains(t)); });
      const td = d > 0 ? ok[ok.length - 1] : ok[0]; if (!td) return null; const b = td.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; }, gridHdr, row, v.dir);
    if (edge) {
      await p.click(edge); await sleep(200);
      if (v.dir < 0) { await p.key('Home'); await sleep(300); v = await check(); }   // 왼쪽 끝 칸으로 한 번에
      for (let i = 0; i < 25 && !v.pt; i++) { await p.key(v.dir > 0 ? 'Right' : 'Left'); await sleep(150); v = await check(); }
      tried.push('방향키');
      if (v.pt) { this.log(`  (${col}: 방향키로 이동)`); return v.pt; }
    }
    // 2) 가로 휠
    const body = await p.eval(h => { const g = grid(h); const b = g && (g.querySelector('.rg-body') || g).getBoundingClientRect(); return b ? { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(b.height / 2, 30)) } : null; }, gridHdr);
    if (body) {
      for (let i = 0; i < 15 && !v.pt; i++) { await p.wheel(body, 0, v.dir * 200); await sleep(150); v = await check(); }
      tried.push('가로 휠');
      if (v.pt) { this.log(`  (${col}: 가로 휠로 이동)`); return v.pt; }
    }
    // 3) 가로 스크롤바 손잡이 끌기
    const thumb = await p.eval(h => { const g = grid(h); const t = g && g.querySelector('.rg-hscrollbar .rg-scrollthumb'); const tr = g && g.querySelector('.rg-hscrollbar .rg-scrolltrack'); if (!t || !tr) return null;
      const a = t.getBoundingClientRect(), b = tr.getBoundingClientRect(); return { x: Math.round(a.left + a.width / 2), y: Math.round(a.top + a.height / 2), room: Math.round(b.right - a.right), back: Math.round(a.left - b.left) }; }, gridHdr);
    if (thumb) {
      const step = Math.ceil((v.dir > 0 ? thumb.room : thumb.back) / 3) + 2;   // 세 번에 나눠 끝까지
      for (let i = 0; i < 3 && !v.pt; i++) {
        const cur = await p.eval(h => { const t = grid(h).querySelector('.rg-hscrollbar .rg-scrollthumb').getBoundingClientRect(); return { x: Math.round(t.left + t.width / 2), y: Math.round(t.top + t.height / 2) }; }, gridHdr);
        await p.drag(cur, { x: cur.x + v.dir * step, y: cur.y }); await sleep(300); v = await check();
      }
      tried.push('스크롤바 끌기');
      if (v.pt) { this.log(`  (${col}: 스크롤바를 끌어 이동)`); return v.pt; }
    }
    this.log(`  (${col}: ${tried.join('·') || '방법 없음'} 모두 실패)`);
    await this.debugDump(`reveal-${norm(col)}`, '결의서전송');
    throw new Error(`${col} 칸을 화면에 못 띄움`);
  }

  /** 채주 k번째 줄 첨부파일 칸에 영수증 올리기. 칸을 누르면 (a) 파일 선택 창이 뜨거나 (b) 첨부 창이 뜬다 → 둘 다 처리 */
  /** 채주 한 줄에 증빙 여러 장(하루 식대 묶음) — 첨부 창을 파일마다 열어 하나씩. 이미 올라간 개수만큼은 건너뜀(다시 돌릴 때) */
  async attachPayeeProof(k, files) {
    // 첨부파일 칸 숫자는 개수가 아니라 첨부 묶음 번호(26395 등)라 그걸로 판단하지 않는다. 파일마다 창을 열어 이미 있는 이름이면 건너뜀 (실제 덤프 확인 2026-10-22)
    for (const file of [].concat(files).filter(Boolean)) await this.attachOneProof(k, file);
  }
  async attachOneProof(k, file) {
    const p = this.page, ui = this.ui, G = '거래처코드', name = require('path').basename(file);
    const dlgCount = () => p.eval(() => all('[class*=Dialog], .dialog_data, [role=dialog]').filter(vis).length);
    try {
      const before = await dlgCount();
      const pt = await this.revealCell(G, k, '첨부파일');
      await p.click(pt);   // 첨부파일 칸 → 파일업로드 창 (실제 화면 확인)
      {
        await sleep(800);
        if ((await dlgCount()) <= before) throw new Error('첨부 창이 안 열림');
        // 이미 올라간 파일이면(다시 돌릴 때) 창을 닫고 건너뜀. 창에는 전에 올린 파일 목록이 나온다
        if (await p.eval(n => { const d = dialog('파일업로드'); return !!d && norm(d.innerText).includes(norm(n)); }, name)) {
          await p.clickWhere(() => { const d = dialog('파일업로드'); return d && all('button', d).filter(b => vis(b) && norm(b.textContent) === '취소').pop(); }).catch(() => p.key('Escape'));
          await sleep(600); this.log(`  첨부: ${name} 은 이미 있어요`); return;
        }
        // 파일업로드 창: 📎 버튼은 누르지 않는다 — 숨은 창에서 OS 파일 선택 창이 안 보이게 떠서 그 뒤 모든 입력이 막혔다.
        // 대신 📎 의 숨은 파일칸(input[type=file].btn_fileAdd)에 파일을 직접 넣는다 (이 방법으로 실제 업로드됨)
        {
          const marked = await p.eval(() => { const d = dialog('파일업로드') || document; const el = all('input[type=file].btn_fileAdd', d)[0] || all('input[type=file]', d)[0]; if (!el) return false;
            all('[data-ta-file]').forEach(x => x.removeAttribute('data-ta-file')); el.setAttribute('data-ta-file', '1'); return true; });
          if (!marked) throw new Error('파일업로드 창에서 파일 넣는 곳을 못 찾음');
          await p.setFiles('[data-ta-file="1"]', [file]);
        }
        // 이 파일 이름이 목록에 떠야 성공 ("첨부파일 N개" 만 보면 두 번째 파일부터는 올리기 전에도 참이라 실패를 못 잡았음)
        const ok = await p.waitFor(n => { const d = dialog('파일업로드'); return !!d && norm(d.innerText).includes(norm(n)); }, [name], { timeout: 8000 });
        if (!ok) throw new Error('파일업로드 창에 파일이 안 올라감');
        const save = await p.eval(() => { const d = dialog('파일업로드'); const b = d && all('button', d).filter(b => vis(b) && norm(b.textContent) === '확인').pop(); return b ? center(b) : null; });
        if (!save) throw new Error('파일업로드 창의 [확인]을 못 찾음');
        await p.click(save); await sleep(1200);
        this.log(`  첨부: ${name} (첨부 창)`);
      }
      const n = String(((await this.rowVals(G, k)) || {})['첨부파일'] || '').trim();
      this.log(`  첨부 확인: 첨부파일 칸 '${n || '(글자 없음 — 아이콘만)'}'`);   // 칸에 개수가 안 나오는 화면일 수 있어 실패로 보지 않음
    } catch (e) {
      if (/창이 닫혔/.test(e.message)) throw e;
      await this.debugDump('attach-fail', '첨부|결의서전송');
      await ui.assist(`채주 ${k + 1}번째 줄에 영수증(${name})을 못 올렸어요(${e.message}). [작업 중인 창 열기]에서 그 줄 첨부파일에 직접 올리고 [계속]을 눌러 주세요.`);
    }
  }

  /** [전송]: 지출결의서 줄을 체크하고 전송 → 확인. 결의번호가 붙으면 성공 */
  async transferResolution() {
    const p = this.page, ui = this.ui;
    const readRes = () => p.eval(() => { const g = grid('결의구분'); return rows(g).map((_, i) => rowVals(g, i) || {}); });
    const res0 = await readRes();
    // 아직 전송 안 한 지출결의서 줄 (이미 전송된 다른 결의가 같이 보일 수 있음 — 그걸 고르거나 그 번호를 '새 결의번호'로 착각하지 않게)
    const ri = res0.findIndex(v => /지출결의서/.test(v['결의구분'] || '') && !v['결의번호']);
    if (ri < 0) throw new Error('전송할 지출결의서 줄이 없어요');
    const oldNos = new Set(res0.map(v => v['결의번호']).filter(Boolean));
    await this.checkOnly('결의구분', ri);
    await sleep(300);
    await p.clickWhere(() => all('button').filter(b => vis(b) && norm(b.textContent) === '전송').pop());
    await sleep(1200);
    for (let i = 0; i < 2; i++) {   // "전송하시겠습니까?" 등 확인 창
      const ok = await p.eval(CONFIRM_OK);
      if (!ok) break; await p.click(ok); await sleep(1500);
    }
    const no = await p.waitFor(old => { const g = grid('결의구분'); const v = g && rows(g).map((_, i) => rowVals(g, i) || {}).find(x => /지출결의서/.test(x['결의구분'] || '') && x['결의번호'] && !old.includes(x['결의번호'])); return v ? v['결의번호'] : null; }, [[...oldNos]], { timeout: 8000 });
    await this.debugDump('settle-sent', '결의서전송');
    if (!no) { await ui.assist('[전송] 후 결의번호가 안 보여요. 그룹웨어 화면을 확인하고 [계속]을 눌러 주세요.'); return ''; }
    { const v = (await readRes()).find(x => x['결의번호'] === no) || {}; this.lastSent = { no, amount: amountOf(v['결의금액']), purpose: String(v['집행용도'] || '') }; }   // 결의서입력 목록에서 이 결의를 찾을 때
    this.log(`✔ [전송] 완료: 결의번호 ${no}`);
    return no;
  }

  /** 채주내역 k번째 줄: 거래처코드(이름 → Enter 로 코드·거래처명 자동) · 공급가액 · 거래처비고 · 자금과목 · 자금계획일(Enter 로 줄 저장) */
  /** 채주내역에서 조건에 맞는 줄의 '화면상 행 번호'. 그리드는 보이는 줄만 그리므로(식대 여러 장이면 아래로 밀림) 못 찾으면 세로로 스크롤하며 찾는다
   *  want: { blank: true } = 거래처명 빈 줄 / { payee, memo, supply } = 이미 저장된 그 줄 */
  /** 그룹웨어 오류 창("… 오류가 발생하였습니다" 등, [확인] 하나)이 떠 있으면 닫고 그 글을 돌려줌. 없으면 '' */
  async closeErrorDialog() {
    const p = this.page;
    const d = await p.eval(() => { const d = all('[class*=Dialog], .dialog_data, [role=dialog], [class*=Confirm_root], [class*=Alert_root]').filter(x => vis(x) && !x.querySelector('.rg-root') && (/Alert_root/.test(x.className) || /오류|실패|에러|없습니다|할 수 없|초과/.test(x.innerText || ''))).pop();   // 그리드가 든 창(결의서전송 창 자체: '데이터가 존재하지 않습니다' 글이 있음)은 알림이 아님   // OBTAlert 는 글과 상관없이 알림 ("선택해 주세요" 등도 막힌 것)
      const b = d && all('button, [role=button]', d).filter(b => vis(b) && /^(확인|닫기)$/.test(norm(b.textContent))).pop(); return b ? { pt: center(b), text: norm(d.innerText).slice(0, 80) } : null; }).catch(() => null);
    if (!d) return '';
    await p.click(d.pt); await sleep(800);
    this.log(`  (그룹웨어 오류 창 닫음: ${d.text})`);
    return d.text;
  }
  /** 지금 고른 예산 줄의 채주 중 계획(lines)에 없는 줄 삭제: 체크 → [채주내역 삭제] → 확인. 다시 돌릴 때 전에 넣은 값이 남아 한도를 넘지 않게 */
  async deleteStalePayees(payee, lines) {
    const p = this.page, G = '거래처코드';
    const same = (v, l) => norm(v['거래처명'] || '').includes(norm(payee)) && amountOf(v['공급가액']) === l.supply && norm(v['거래처비고'] || '') === norm(l.memo || '');
    const stale = (await p.eval(() => { const g = grid('거래처코드'); return g ? rows(g).map((_, i) => rowVals(g, i) || {}) : []; }))
      .map((v, i) => ({ v, i })).filter(({ v }) => String(v['거래처명'] || '').trim() && !lines.some(l => same(v, l)));
    if (!stale.length) return;
    this.log(`  계획에 없는 채주 ${stale.length}줄 삭제: ${stale.map(({ v }) => `${v['거래처비고'] || ''} ${v['공급가액'] || ''}`).join(', ')}`);
    try {
      for (const { i } of stale) { await p.clickWhere(k => { const g = grid('거래처코드'); const c = all('td.rg-checkbar-cell', g)[k]; return c && (all('span, label, input', c).find(vis) || c); }, i); await sleep(300); }
      await p.clickWhere(() => all('button').filter(b => vis(b) && norm(b.textContent) === '채주내역삭제').pop()); await sleep(1000);
      const ok = await p.eval(() => { const d = all('[class*=Dialog], .dialog_data, [role=dialog], [class*=Confirm_root], [class*=Alert_root]').filter(x => vis(x) && /하시겠습니까|\?/.test(x.innerText || '')).pop();
        const b = d && all('button, [role=button]', d).filter(b => vis(b) && /^(확인|예)$/.test(norm(b.textContent))).pop(); return b ? center(b) : null; });
      if (ok) { await p.click(ok); await sleep(1500); }
      const err = await this.closeErrorDialog(); if (err) throw new Error(err);
      const left = (await p.eval(() => { const g = grid('거래처코드'); return rows(g).map((_, i) => rowVals(g, i) || {}); })).filter(v => String(v['거래처명'] || '').trim() && !lines.some(l => same(v, l))).length;
      if (left) throw new Error(`${left}줄이 그대로 있어요`);
      this.log('  ✔ 지웠어요');
    } catch (e) {
      if (/창이 닫혔/.test(e.message)) throw e;
      await this.debugDump('payee-stale', '결의서전송');
      await this.ui.assist(`전에 넣은 채주 줄을 못 지웠어요(${e.message}). [작업 중인 창 열기]에서 채주내역의 그 줄을 체크하고 [채주내역 삭제]한 뒤 [계속]을 눌러 주세요.`);
    }
  }
  async payeeRow(want) {
    const p = this.page, G = '거래처코드';
    const find = () => p.eval(w => { const g = grid('거래처코드'); if (!g) return { closed: true };
      // 줄이 화면에 보이는지 = 그 줄의 칸 중 하나라도 실제로 보이면 (가로로 오른쪽 끝까지 밀려 있으면 첫 칸은 안 보임)
      const hit = tr => all('td.rg-data-cell', tr).some(td => { const b = td.getBoundingClientRect(); if (b.width < 4) return false; const t = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!t && (t === td || td.contains(t)); });
      const rs = rows(g); for (let i = 0; i < rs.length; i++) { const v = rowVals(g, i) || {}; if (!hit(rs[i])) continue;
        const ok = w.blank ? !String(v['거래처명'] || '').trim() : norm(v['거래처명'] || '').includes(norm(w.payee)) && Number(String(v['공급가액'] || '').replace(/[^\d]/g, '')) === w.supply && norm(v['거래처비고'] || '') === norm(w.memo || '');
        if (ok) return { i }; }
      return { i: -1 }; }, want);
    const body = await p.eval(() => { const g = grid('거래처코드'); const b = g && (g.querySelector('.rg-body') || g).getBoundingClientRect(); return b ? { x: Math.round(b.left + Math.min(b.width / 2, 200)), y: Math.round(b.top + 40) } : null; });
    // 세로 스크롤바가 없으면(줄이 다 보이면) 스크롤할 필요 없음
    const canScroll = await p.eval(() => { const g = grid('거래처코드'); const t = g && g.querySelector('.rg-vscrollbar .rg-scrollthumb'), tr = g && g.querySelector('.rg-vscrollbar .rg-scrolltrack');
      return !!(t && tr && vis(t) && t.getBoundingClientRect().height < tr.getBoundingClientRect().height - 2); });
    for (const dir of canScroll ? [0, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1] : [0]) {   // 그대로 → 아래로 → 위로
      if (dir && body) { await p.wheel(body, dir * 100); await sleep(250); }
      const r = await find(); if (r.closed) throw new Error('결의서전송 창이 닫혔어요'); if (r.i >= 0) return r.i;
    }
    return -1;
  }

  /** 채주 한 줄: 빈 줄에 거래처코드(이름 → Enter 로 코드·거래처명 자동) · 공급가액 · 거래처비고 · 자금과목 · 자금계획일 → Enter 로 저장 → 첨부. 이미 저장된 줄이면 첨부만 */
  async enterPayee(n, { payee, fund, supply, vat = 0, pay = 'personal', memo, planDate, proofs = [] }) {
    const p = this.page, ui = this.ui, G = '거래처코드';
    this.log(`  채주 ${n}: ${memo || ''} ${supply.toLocaleString('ko-KR')}원`);
    const saved = await this.payeeRow({ payee, memo, supply });
    if (saved >= 0) {
      this.log(`  채주 ${n}: 이미 저장돼 있어 그대로 둬요`);   // 다시 돌릴 때 같은 줄을 또 넣지 않음
      if (proofs.length) await this.attachPayeeProof(saved, proofs);
      return true;
    }
    let k = await this.payeeRow({ blank: true });
    if (k < 0) { await ui.assist(`채주내역에서 빈 줄을 못 찾았어요. 빈 줄이 보이게 스크롤한 뒤 [계속]을 눌러 주세요.`); k = await this.payeeRow({ blank: true }); if (k < 0) return false; }
    const before = await this.rowCount(G);
    try {
      await p.dblclick(await this.revealCell(G, k, '거래처코드'));
      await p.selectAll(); await p.type(payee); await p.key('Enter');
      await sleep(600);
      // 같은 글자가 둘 이상(대표자명이 같은 거래처 등)이면 거래처코드도움 창이 뜬다 → '이름(임직원)' 줄을 고른다
      if (await p.eval(() => !!dialog('거래처코드도움'))) {
        // 같은 이름이 여럿(CFO·임직원_개발2팀·카드[5302] 등) → 사람에게 모달로 고르게 하고, 이 작업(결재건) 동안은 그걸로 (사용자 요청 2026-10-22)
        this.log(`  거래처 '${payee}' 검색 결과가 여러 건 → 코드도움에서 선택`);
        await this.pickInCodeHelp('^거래처코드도움$', payee, { label: `'${payee}'`, remember: `거래처:${payee}` });
      }
      const ok = await p.waitFor((r, nm) => { const g = grid('거래처코드'); const v = g && rowVals(g, r); return v && norm(v['거래처명'] || '').includes(norm(nm)); }, [k, payee], { timeout: 5000 });
      if (!ok) throw new Error(`거래처명이 안 채워짐`);
    } catch (e) {
      if (/창이 닫혔/.test(e.message)) throw e;
      await this.debugDump('settle-payee', '거래처|결의서전송');
      await ui.assist(`거래처코드에서 '${payee}'를 못 찾았어요(${e.message}). 신입이면 거래처 등록이 안 됐을 수 있어요. [작업 중인 창 열기]에서 채주 ${n}번째 줄 거래처를 직접 고른 뒤 [계속]을 눌러 주세요.`);
    }
    const put = async (col, text, enter = true, keys = false) => {
      if (!(await p.eval(() => !!grid('거래처코드')).catch(() => false))) throw new Error(`${col} 넣기 전에 결의서전송 창이 닫혔어요. 그룹웨어에서 확인한 뒤 다시 해 주세요.`);   // 창 없이 계속 누르면 뒤 화면을 건드림
      try { await p.dblclick(await this.revealCell(G, k, col)); await p.selectAll();
        if (keys) { await p.press('Backspace', 10); await p.typeKeys(text); } else await p.type(text);   // 날짜 칸은 키를 하나씩 눌러야 받는다
        if (enter) await p.key('Enter'); await sleep(400); }
      catch (e) { if (/창이 닫혔/.test(e.message)) throw e; await ui.assist(`채주 ${n}번째 줄 ${col} 입력 실패(${e.message}). '${text}'를 넣어 주세요.`); }
    };
    await put('공급가액', String(supply));
    if (pay === 'card') await put('부가세액', String(vat));   // 법인카드: 과세면 부가세, 면세·불공제(항공권·주유비)면 0 을 직접 넣음. 개인카드는 공급가액만
    if (memo) await put('거래처비고', memo);
    await put('자금과목', fund);
    await put('자금계획일', planDate.replace(/-/g, ''), true, true);   // 숫자만 키로 하나씩(20261020)
    // 줄 저장: 품의 예산 줄처럼 마지막 칸까지 Enter 로 넘어가 새 빈 줄이 생겨야 저장된다 (값만 넣으면 화면에만 있고 [환원] 때 사라짐)
    const nextBlank = () => p.eval(r => { const g = grid('거래처코드'); const v = g && rowVals(g, r + 1); return !!v && !String(v['거래처명'] || '').trim(); }, k);
    for (let i = 0; i < 3 && !(await nextBlank()) && (await this.rowCount(G)) <= before; i++) {
      const pop = await p.eval(() => all('[class*=Dialog], .dialog_data').filter(vis).length);
      await p.key('Enter'); await sleep(700);
      if ((await p.eval(() => all('[class*=Dialog], .dialog_data').filter(vis).length)) > pop) { this.log(`  (Enter 에 새 창이 떠서 멈춤)`); await this.debugDump('settle-enter-popup', '증빙|첨부|결의서전송'); break; }
    }
    this.log(`  채주 ${n} 줄 저장: 아래 새 빈 줄 ${(await nextBlank()) ? '생김' : '안 보임'}`);
    { const err = await this.closeErrorDialog(); if (err) { await this.debugDump('payee-error', '결의서전송'); await ui.assist(`채주 ${n}번째 줄 저장에서 그룹웨어가 "${err}" 라고 해요 (예산 한도 초과 등). [작업 중인 창 열기]에서 확인하고 [계속]을 눌러 주세요.`); } }
    await sleep(400);
    const r2 = await this.payeeRow({ payee, memo, supply });   // 저장되며 줄 위치가 바뀌었을 수 있어 내용으로 다시 찾는다
    if (r2 >= 0) k = r2;
    if (proofs.length) await this.attachPayeeProof(k, proofs);
    const v = (await this.rowVals(G, k)) || {};
    const ok = amountOf(v['공급가액']) === supply && norm(v['거래처명'] || '').includes(norm(payee));
    this.log(`  채주 ${n} 확인: 거래처명 '${v['거래처명'] || ''}', 공급가액 '${v['공급가액'] || ''}', 거래처비고 '${v['거래처비고'] || ''}', 자금과목 '${v['자금과목'] || ''}', 자금계획일 '${v['자금계획일'] || '(안 보임)'}'`);
    if (v['자금계획일'] && v['자금계획일'] !== planDate) await ui.assist(`채주 ${n}번째 줄 자금계획일이 ${v['자금계획일']}이에요. ${planDate}로 고쳐 주세요.`);
    return ok;
  }

  // ---------- 결재상신 ----------
  /** 하단 [결재상신] → 결재양식/제목 → 확인 → 전자결재 팝업(BrowserWindow) */
  /** 결의서입력에서 전송된 결의(결의번호 YYYYMMDD-NNNNN) 행을 체크한다 → 이어서 openApproval */
  async openResolution(resNo) {
    const p = this.page;
    const m = /^(\d{4})(\d{2})(\d{2})-0*(\d+)$/.exec(String(resNo || ''));
    if (!m) throw new Error(`결의번호 형식을 모르겠어요: ${resNo}`);
    const ym = `${m[1]}-${m[2]}`, day = String(Number(m[3])), seq = m[4];
    await p.goto(this.baseUrl + RESOLUTION_PATH); await sleep(2000);
    if (await this.isLoginPage()) { await this.ensureLogin(); await p.goto(this.baseUrl + RESOLUTION_PATH); }
    await p.waitFor(() => !!grid('결의구분'), [], { timeout: 30000, message: '결의서입력 화면이 열리지 않았어요.' });
    await sleep(1500);
    // 결의서입력 목록의 순번은 결의번호 끝자리와 다를 수 있다 (순번 23 ↔ 20261022-00024 — 2026-10-22). 날짜·지출결의서·집행용도·금액·상신대기로 찾고, 여럿이면 순번이 맞는 것, 없으면 마지막 것
    const sent = this.lastSent && this.lastSent.no === resNo ? this.lastSent : null;
    const find = () => p.eval((y, d, q, amt, purpose) => { const g = grid('결의구분'); const num = s => Number(String(s || '').replace(/[^\d]/g, '')) || 0;
      const vs = rows(g).map((_, i) => ({ i, v: rowVals(g, i) || {} }));
      const cand = vs.filter(({ v }) => v['결의연월'] === y && String(Number(v['결의일'])) === d && /지출결의서/.test(v['결의구분'] || '')
        && (!purpose || norm(v['집행용도'] || '').startsWith(norm(purpose).slice(0, 10))) && (!amt || num(v['총금액']) === amt));
      const wait = cand.filter(({ v }) => /상신대기/.test(v['결재상태'] || ''));   // 상신대기 우선. 없으면 아래에서 '이미 결재 중' 이라고 알려 줌
      const pool = wait.length ? wait : cand;
      const hit = pool.find(({ v }) => v['순번'] === q) || pool[pool.length - 1];
      return hit ? hit.i : -1; }, ym, day, seq, sent ? sent.amount : 0, sent ? sent.purpose : '');
    let ri = await find();
    // 화면을 막 열면 목록이 안 불려 와 빈 줄만 있을 때가 있다 (2026-10-28 최병관) → 돋보기(조회)를 눌러 다시 불러와 찾는다
    for (let i = 0; ri < 0 && i < 3; i++) {
      this.log('목록에 결의가 안 보여 [조회]를 다시 눌러요.');
      try { await p.clickWhere(() => all('#tutorial-conditionPanel-search, [class*=OBTConditionPanel_searchButton]').filter(vis).pop()); } catch (e) { await p.key('Enter'); }
      ri = (await p_wait(p, async () => (await find()) >= 0, 6000)) ? await find() : -1;
    }
    if (ri < 0) {
      await this.debugDump('resolution-find', '결의서입력');
      await this.ui.assist(`결의서입력 목록에서 결의(${resNo}${sent ? `, ${sent.amount.toLocaleString('ko-KR')}원` : ''})를 못 찾았어요. [작업 중인 창 열기]에서 그 행만 체크하고 [계속]을 눌러 주세요.`);
      ri = await find();   // 사람이 [조회]해서 목록이 나왔으면 아래에서 앱이 직접 체크 (사람이 누른 체크만으론 [결재상신]이 안 먹었음 — 2026-10-28)
    }
    if (ri < 0) {
      const checked = await p.eval(() => { const g = grid('결의구분'); return rows(g).some(tr => all('td.rg-checkbar-cell input', tr).some(x => x.checked) || /rg-checked|checked/.test(tr.className)); }).catch(() => false);
      if (!checked) throw new Error(`결의서입력 목록에서 결의(${resNo}) 행이 체크되지 않았어요. 다시 [그룹웨어 보내기]를 눌러 주세요.`);
      return;
    }
    const v = await this.rowVals('결의구분', ri);
    if (!/상신대기/.test(v['결재상태'] || '')) throw new Error(`결의(${resNo})가 이미 '${v['결재상태']}' 상태예요. 결재상신은 상신대기일 때만 해요.`);
    await this.checkOnly('결의구분', ri, { fresh: true });   // 체크된 채로 두면 [결재상신]이 안 먹는다 → 풀었다가 다시 체크 (사용자 확인 2026-10-28)
    await sleep(300);
    this.log(`결의 선택: ${ym}-${day} 순번 ${seq} (${v['총금액']}원)`);
  }

  async openApproval(formName, title, { category = '품의서입력' } = {}) {
    const p = this.page, ui = this.ui;
    this.log(`결재상신: ${formName}`);
    // 이전에 열어 둔 작성 창(이미 보관됨)이 있으면 닫는다. 같은 이름의 창이 재사용되는 것을 막기 위함.
    for (const w of popupsOf.get(this.win.webContents) || []) if (!w.isDestroyed()) w.destroy();
    const popupPromise = new Promise(resolve => this.win.webContents.once('did-create-window', w => resolve(w)));
    await p.clickWhere(() => all('button').filter(b => norm(b.textContent) === '결재상신' && vis(b) && !b.disabled).pop());
    await sleep(1000);
    {   // "…결재상신을 진행하시겠습니까?" 확인창이 먼저 뜨면 그 창의 [확인] (결의서입력 — 2026-10-22)
      const ok = await p.eval(() => { const d = all('[class*=Confirm_root], [class*=Dialog], [role=dialog]').filter(x => vis(x) && /결재상신.*하시겠습니까/.test(x.innerText || '')).pop();
        const b = d && all('button, [role=button]', d).filter(b => vis(b) && /^(확인|예)$/.test(norm(b.textContent))).pop(); return b ? center(b) : null; }).catch(() => null);
      if (ok) { this.log('  (결재상신 확인창 → [확인])'); await p.click(ok); await sleep(1500); }
    }
    try { await p.waitFor(() => !!dialog('전자결재상신'), [], { timeout: 8000, message: '전자결재상신 창이 열리지 않았습니다.' }); }
    catch (e) {   // 그룹웨어가 알림으로 막았으면(금액 없음 등) 그 문구를 그대로 보여 준다
      const why = await p.eval(() => all('[role=alertdialog], [role=dialog], .alert, .modal, .OBTAlert, .OBTDialog').filter(vis).map(d => d.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).pop() || '').catch(() => '');
      await this.debugDump('approval', '결재상신');
      // 멈추지 않고 사람에게 넘긴다: 창에서 알림을 닫고 [결재상신]을 직접 눌러 상신 창을 띄우면 이어서 채운다
      await ui.assist(`전자결재상신 창이 안 열렸어요${why ? ` (그룹웨어 알림: ${why.slice(0, 150)})` : ''}. [작업 중인 창 열기]에서 알림을 닫고 하단 [결재상신]을 눌러 상신 창을 띄운 뒤 [계속]을 눌러 주세요.`);
      await p.waitFor(() => !!dialog('전자결재상신'), [], { timeout: 8000, message: e.message });
    }
    // 결의서입력의 상신 창은 결재양식이 이미 골라진 드롭다운으로 뜬다 → 이미 그 양식이면 건드리지 않는다
    // 결의서입력의 상신 창은 결재양식이 드롭다운(값이 입력칸에 보임)으로 미리 골라져 뜬다 → 이미 그 양식이면 건드리지 않는다
    const formShown = () => p.eval(f => { const d = dialog('전자결재상신'); if (!d) return false;
      return all('input', d).some(i => vis(i) && norm(i.value) === norm(f)) || all('*', d).some(e => vis(e) && ownText(e) && norm(e.textContent) === norm(f)); }, formName);
    if (await formShown()) this.log(`결재양식: ${formName} (이미 선택됨)`);
    else try {
      // 결재양식 칸(라벨 옆)을 눌러 목록을 열고 양식 이름을 고른다. 예전 품의서 상신 창(분류 목록 → 양식)도 같이 처리
      const box = await p.eval(() => { const d = dialog('전자결재상신'); const lb = d && all('*', d).find(e => vis(e) && ownText(e) && norm(e.textContent) === '결재양식');
        let c = lb; for (let i = 0; c && i < 5; i++) { c = c.parentElement; const x = c && all('input, [class*=DropDown], [class*=dropdown], [class*=Select]', c).filter(e => vis(e) && !e.contains(lb))[0]; if (x) return center(x); } return null; });
      if (box) { await p.click(box); await sleep(700); }
      else { await p.clickWhere(c => { const d = dialog('전자결재상신'); return byText(c, d, false)[0] || byText('출장', d, false)[0]; }, category); await sleep(500); }
      await p.clickWhere(f => byText(f).pop(), formName);
      await sleep(500);
      if (!(await formShown())) throw new Error('양식이 선택되지 않음');
    } catch (e) { await this.debugDump('approval-form', '전자결재상신'); await ui.assist(`결재양식 선택 실패(${e.message}). 결재양식을 '${formName}'으로 골라주세요.`); }
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
  /** 결재작성(전체 양식)에서 양식 이름을 찾아 눌러 작성 창을 연다 (품의 입력이 없는 양식: 구매의뢰서 등). 돌려주는 건 작성 팝업 창 */
  async openForm(formName) {
    const p = this.page, ui = this.ui;
    this.log(`결재작성: ${formName}`);
    for (const w of popupsOf.get(this.win.webContents) || []) if (!w.isDestroyed()) w.destroy();
    await p.goto(this.baseUrl + COMPOSE_PATH); await sleep(2500);
    if (await this.isLoginPage()) { await this.ensureLogin(); await p.goto(this.baseUrl + COMPOSE_PATH); await sleep(2500); }
    // 양식 목록 줄: <dt><p class="ellipsis">전산기기 <em>구매의뢰서</em></p></dt> — 검색어가 <em> 으로 쪼개지고 비슷한 이름(전산기기 구매의뢰서)이 같이 뜬다
    // → 줄(p·dt) 전체 글자가 양식 이름과 '정확히' 같은 것만
    const FIND = f => { const hit = all('dt p, dt, li p, li').filter(e => vis(e) && norm(e.textContent) === norm(f)); return hit[0] || null; };
    const popupPromise = new Promise(resolve => this.win.webContents.once('did-create-window', w => resolve(w)));
    try {
      if (!(await p.waitFor(FIND, [formName], { timeout: 6000 }))) {
        // 목록에 안 보이면 검색칸에 이름을 넣고 찾는다
        await p.clickWhere(() => all('input[type=text], input:not([type])').filter(i => vis(i) && /검색|양식/.test((i.placeholder || '') + (i.title || '')) ).pop() || all('input[type=text], input:not([type])').filter(vis)[0]);
        await p.selectAll(); await p.type(formName); await p.key('Enter'); await sleep(1500);
        await p.waitFor(FIND, [formName], { timeout: 8000, message: `결재작성 목록에서 '${formName}' 양식을 못 찾았어요` });
      }
      await p.clickWhere(FIND, formName);
    } catch (e) {
      await this.debugDump('compose-form', '결재작성');
      await ui.assist(`'${formName}' 양식을 자동으로 못 열었어요 (${e.message}). [작업 중인 창 열기]에서 결재작성 › 전체 양식의 '${formName}'을 직접 눌러 작성 창을 띄운 뒤 [계속]을 눌러 주세요.`);
    }
    const popup = await Promise.race([popupPromise, sleep(30000).then(() => null)]);
    if (!popup) throw new Error('전자결재 작성 창이 열리지 않았습니다.');
    await new Promise(r => popup.webContents.isLoading() ? popup.webContents.once('did-finish-load', r) : r());
    this.log('전자결재 작성 창이 열렸습니다.');
    return popup;
  }

  /** 작성 창 머리의 '수신및참조' 칸에 부서를 넣는다 (이미 든 건 건너뜀). 입력칸에 이름을 치면 조직도 자동완성(👥 경영지원부(전자결재용))이 뜨고,
   *  그 위에 경로 말풍선((주)레인보우로보틱스>본사>…)이 같이 뜬다 → 글자가 이름과 '정확히' 같은 줄만 누른다. 없으면 Enter(첫 후보) */
  async addRecipients(popup, names, { withDept = false } = {}) {
    const pp = new Page(popup), ui = this.ui;
    if (withDept) {   // 머리 표 '작성부서' 칸에 골라져 있는 부서 (예: 개발 2팀)
      const dept = await pp.eval(() => { const lb = all('td,th').find(e => vis(e) && norm(e.textContent) === '작성부서'); const tr = lb && lb.closest('tr'); if (!tr) return '';
        const sel = all('select', tr).find(vis); if (sel && sel.selectedIndex >= 0) return sel.options[sel.selectedIndex].text.trim();
        const inp = all('input', tr).find(i => vis(i) && i.value); if (inp) return inp.value.trim();
        const cell = lb.nextElementSibling; return cell ? cell.innerText.trim().split('\n')[0] : ''; }).catch(() => '');
      if (dept) names = [...names, dept]; else this.log('(작성부서를 못 읽어서 수신및참조에 안 넣었어요)');
    }
    const row = () => pp.eval(() => { const lb = all('td,th').find(e => vis(e) && norm(e.textContent) === '수신및참조'); const tr = lb && lb.closest('tr'); return tr ? tr.innerText : null; });
    const input = () => pp.clickWhere(() => { const lb = all('td,th').find(e => vis(e) && norm(e.textContent) === '수신및참조'); const tr = lb && lb.closest('tr');
      return tr && all('input', tr).filter(i => vis(i) && !i.readOnly && i.type !== 'checkbox' && i.type !== 'hidden').pop(); });
    const missing = [];
    for (const name of names) {
      await this.dismissTempDraft(pp, 0);   // 늦게 뜬 임시 저장 창이 입력칸을 덮지 않게
      if (norm((await row()) || '').includes(norm(name))) continue;
      let ok = false;
      for (let attempt = 0; attempt < 2 && !ok; attempt++) try {   // 도중에 임시 저장 창이 덮었으면 닫고 한 번 더
        if (attempt) { await pp.key('Escape').catch(() => {}); await this.dismissTempDraft(pp, 0); }
        await input(); await pp.selectAll(); await pp.type(name); await sleep(1600);
        const pt = await pp.eval(n => {
          const lb = all('td,th').find(e => vis(e) && norm(e.textContent) === '수신및참조'); const tr = lb && lb.closest('tr');
          const c = all('li, [role=option], a, span, div, p').filter(e => vis(e) && norm(e.textContent) === norm(n) && !(tr && tr.contains(e)) && !/>/.test(e.textContent));
          c.sort((x, y) => x.getBoundingClientRect().width * x.getBoundingClientRect().height - y.getBoundingClientRect().width * y.getBoundingClientRect().height);
          const el = c[0] && (c[0].closest('li, [role=option]') || c[0]); return el ? center(el) : null; }, name);
        if (pt) await pp.click(pt); else await pp.key('Enter');
        await sleep(1000);
        ok = norm((await row()) || '').includes(norm(name));
      } catch (e) { /* 다음 시도 */ }
      if (!ok) missing.push(name);
    }
    if (missing.length) {
      if (this.debugDir) { try { require('fs').writeFileSync(require('path').join(this.debugDir, 'recipients-popup.html'), await pp.eval(() => document.body.outerHTML)); } catch (e) { /* */ } }
      await ui.assist(`수신및참조에 ${missing.join(', ')}을(를) 자동으로 못 넣었어요. 작성 창에서 직접 추가한 뒤 [계속]을 눌러 주세요.`);
    } else this.log(`수신및참조: ${names.join(', ')}`);
  }

  /** "작성 중이던 임시 저장 본문이 있습니다. 불러오시겠습니까?" → [취소] (새로 작성). waitMs 동안 기다려 봄. 이미 [취소] 했으면 아무것도 안 함 */
  async dismissTempDraft(pp, waitMs) {
    const on = () => all('div, p, span').some(e => vis(e) && /임시\s*저장\s*본문이\s*있습니다/.test(e.textContent || '') && e.children.length <= 3);
    const tmp = waitMs ? await pp.waitFor(on, [], { timeout: waitMs }).catch(() => null) : await pp.eval(on).catch(() => false);
    if (!tmp) return;
    try { await pp.clickWhere(() => { const msg = all('div, p, span').filter(e => vis(e) && /임시\s*저장\s*본문이\s*있습니다/.test(e.textContent || '')).pop();
      for (let box = msg; box; box = box.parentElement) { const b = all('button', box).find(x => vis(x) && norm(x.textContent) === '취소'); if (b) return b; } return null; });
      this.log('임시 저장 본문은 불러오지 않고 새로 작성해요'); await sleep(800);
    } catch (e) { await this.ui.assist('작성 창의 "임시 저장 본문을 불러올까요?"에서 [취소]를 눌러 주세요. 그 뒤 [계속]을 누르면 이어서 채워요.'); }
  }

  async fillAndKeep(popup, { title, probe, payload, attachments = [], save = true, beforeShow = null }) {   // beforeShow: 창을 사람에게 띄우기 전에 더 할 일 (수신및참조 등)
    const pp = new Page(popup), ui = this.ui;
    // "작성 중이던 임시 저장 본문이 있습니다. 불러오시겠습니까?" → [취소] (새로 작성). 늦게 뜰 수 있어 몇 초 기다려 봄
    // 이 창은 늦게(3초 넘어) 뜰 수도 있어서 처음에 기다려 보고, 제목·본문·수신및참조 전에도 다시 본다 (늦게 뜬 창이 덮으면 입력이 다 막혔음 — 2026-10-22 mock 으로 확인)
    await this.dismissTempDraft(pp, 3000);
    let frame = await pp.findFrame(FIND_JS, probe, 30000);
    await this.dismissTempDraft(pp, 0);
    if (!frame) { await ui.assist('본문 편집기를 찾지 못했습니다. 작성 창이 다 열렸는지 확인해 주세요.'); frame = await pp.findFrame(FIND_JS, probe, 5000); }

    // 제목 칸: 대부분 양식은 .docTitleBox, 구매의뢰서 같은 양식은 머리 표의 '제 목' 줄 입력칸
    const TITLE_INPUT = () => document.querySelector('.docTitleBox input') || (() => { const lb = all('td,th').find(e => vis(e) && norm(e.textContent) === '제목'); const tr = lb && lb.closest('tr');
      return tr && all('input[type=text], input:not([type]), textarea', tr).filter(i => vis(i) && !i.readOnly)[0]; })();
    const titleVal = () => pp.eval(`() => { const i = (${TITLE_INPUT})(); return i ? i.value : null; }`).catch(() => null);
    const cur = await titleVal();
    if (cur !== null && cur !== title) {
      await pp.clickWhere(TITLE_INPUT);
      await pp.selectAll(); await pp.type(title); await sleep(300);
      if ((await titleVal()) !== title) await ui.assist(`제목을 못 넣었어요. 작성 창 제목 칸에 "${title}"를 넣고 [계속]을 눌러 주세요.`);
    } else if (cur === null) await ui.assist(`제목 칸을 못 찾았어요. 작성 창 제목 칸에 "${title}"를 넣고 [계속]을 눌러 주세요.`);

    if (frame) {
      const res = await frame.executeJavaScript(`(${FILL_JS})(${JSON.stringify(payload)})`);
      this.log(`본문 입력: ${res.filled.join(', ')}`);
      if (res.missing.length) await ui.assist(`본문에서 찾지 못한 칸: ${res.missing.join(', ')}. 직접 채워 주세요.`);
    }

    // 결의서에서 올린 결재 문서는 채주 첨부(영수증)가 이미 딸려 온다 → 이미 목록에 있는 이름은 다시 안 올림 ("같은파일이 이미 첨부되었습니다" 방지)
    const shown = await pp.eval(() => document.body.innerText + ' ' + all('[title]').map(e => e.getAttribute('title')).join(' ')).catch(() => '');
    const has = f => { const b = require('path').basename(f); return shown.includes(b) || shown.includes(b.slice(0, 14)); };   // 긴 이름은 화면에서 말줄임(…)될 수 있어 앞부분으로도
    const files = attachments.filter(Boolean).filter(f => !has(f));
    const skipped = attachments.filter(Boolean).length - files.length;
    if (skipped) this.log(`첨부: ${skipped}개는 이미 붙어 있어 건너뜀`);
    if (files.length) {
      try { await pp.setFiles('input[type=file]', files); await sleep(1500); this.log(`첨부: ${files.length}개`); }
      catch (e) { await ui.assist(`첨부 실패(${e.message}). 다음 파일을 직접 끌어다 놓아 주세요: ${files.join(', ')}`); }
    }

    await this.dismissTempDraft(pp, 0);
    if (beforeShow) await beforeShow();
    await this.dismissTempDraft(pp, 0);
    if (!save) { popup.setSkipTaskbar(false); popup.center(); popup.show(); popup.focus(); this.log('본문까지 채웠어요. 열린 작성 창에서 확인하고 [보관]·[상신]은 직접 눌러 주세요.'); return; }
    await pp.eval(() => { window.__confirm = window.confirm; window.confirm = () => true; window.alert = () => {}; return true; });   // 보관 확인창 자동 승인
    await pp.clickWhere(() => all('.topBtn').find(b => norm(b.textContent) === '보관'));
    await sleep(800);
    try { await pp.clickWhere(() => all('button').filter(b => norm(b.textContent) === '확인' && vis(b)).pop()); } catch (e) { /* 확인창 없음 */ }
    await sleep(1500);
    this.log('보관(임시저장) 완료. 열린 작성 창에서 결재선을 확인하고 [상신]은 직접 눌러 주세요.');
    // [상신]은 절대 자동으로 누르지 않는다 — 결재선이 기본값이면 그 자리에서 제출돼 버린다 (회수 필요)
    await pp.eval(() => { window.confirm = window.__confirm; return true; });   // 확인창 다시 사람에게
    popup.setSkipTaskbar(false); popup.center(); popup.show(); popup.focus();
  }
}

module.exports = { Amaranth, BUDGET_PATH };
