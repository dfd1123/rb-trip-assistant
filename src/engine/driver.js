'use strict';
// Electron 내장 Chromium 창을 사람이 쓰듯 조작하는 얇은 드라이버.
// 클릭/키 입력은 실제 입력 이벤트(sendInputEvent), 텍스트는 insertText(한글 IME 문제 없음).

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 페이지 안에서 쓰는 헬퍼 (매 호출마다 함께 주입)
const PRELUDE = String.raw`
const norm = s => (s || '').replace(/[\s​ ]/g, '');
const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
const all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const ownText = e => Array.from(e.childNodes).some(n => n.nodeType === 3 && n.textContent.trim());
const byText = (text, root = document, exact = true) => { const t = norm(text);
  const hits = all('*', root).filter(e => vis(e) && (exact ? norm(e.textContent) === t : norm(e.textContent).includes(t)));
  return hits.filter(e => !hits.some(o => o !== e && e.contains(o))); };   // 가장 안쪽 요소만
const center = el => { el.scrollIntoView({ block: 'center', inline: 'center' }); const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
const okButtons = root => all('button, [role=button], [class*=Button], [class*=btn]', root).filter(b => norm(b.textContent) === '확인' && vis(b));
const dialog = title => { const heads = byText(title).reverse();
  for (const h of heads) { let p = h; while (p && p !== document.body) {
    if (okButtons(p).length) return p; p = p.parentElement; } }
  return null; };
const loginId = () => all('input').find(e => vis(e) && !e.disabled && !e.readOnly && /^(text|email|tel|)$/i.test(e.getAttribute('type') || '') && !/date|search|검색|captcha/i.test((e.name || '') + (e.id || '') + (e.placeholder || '') + (e.className || '')));
const loginPw = () => all('input[type=password]').find(e => vis(e) && !e.disabled);
// 캔버스 그리드(RealGridJS 1.x, OBTDataGrid): 화면에 글자가 없으므로 React 내부에서 GridView·DataProvider 를 찾아 쓴다
const rgFind = (root, startEl) => {
  const el = startEl || (root || document).querySelector('[data-orbit-component=OBTDataGrid]') || (root || document).querySelector('canvas');
  if (!el) return null;
  const isDp = o => o && typeof o === 'object' && typeof o.getRowCount === 'function' && (typeof o.getJsonRow === 'function' || typeof o.getValue === 'function');
  const isGv = o => o && typeof o === 'object' && typeof o.setCurrent === 'function';
  const out = { gv: null, dp: null, iface: null };
  const scan = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 2) return;
    if (!out.dp && isDp(o) && typeof o.setCurrent !== 'function') out.dp = o;
    if (!out.gv && isGv(o)) out.gv = o;
    if (!out.iface && typeof o.getRowCount === 'function' && typeof o.getValue === 'function' && typeof o.setSelection === 'function') out.iface = o;
    if (out.gv && out.dp) return;
    let keys = []; try { keys = Object.keys(o); } catch (e) {}
    for (const k of keys) { if (/^(__|_owner|return|child|sibling|alternate)/.test(k)) continue; let v; try { v = o[k]; } catch (e) { continue; } if (v && typeof v === 'object' && !(v instanceof Node)) scan(v, depth + 1); }
    if (!out.dp && out.gv && typeof out.gv.getDataSource === 'function') { try { const d = out.gv.getDataSource(); if (isDp(d)) out.dp = d; } catch (e) {} }
  };
  for (let n = el; n && !(out.gv && out.dp); n = n.parentElement) {
    const k = Object.keys(n).find(k => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    let f = k && n[k];
    for (let i = 0; f && i < 25 && !(out.gv && out.dp); i++, f = f.return) {
      scan(f.memoizedProps, 0); scan(f.stateNode && f.stateNode.nodeType ? null : f.stateNode, 0);
    }
    if (n.matches && n.matches('[class*=Dialog], .dialog_data')) break;
  }
  return (out.gv || out.dp || out.iface) ? out : null;
};
const rgRows = r => {   // [{...값}] 최대 2000행. RealGridJS 버전마다 API 가 달라 여러 방법을 차례로 시도
  const ok = o => o && typeof o === 'object' && Object.values(o).some(v => v != null && v !== '');
  const fieldNames = () => { try {
    if (r.dp && r.dp.getFieldNames) return r.dp.getFieldNames();
    if (r.dp && r.dp.getOrgFieldNames) return r.dp.getOrgFieldNames();
    if (r.dp && r.dp.getFields) return r.dp.getFields().map(f => f.fieldName || f.orgFieldName || f.name);
    if (r.gv && r.gv.getColumns) return r.gv.getColumns().map(c => c.fieldName || c.name);
  } catch (e) {} return []; };
  const tries = [
    i => r.dp && r.dp.getJsonRow && r.dp.getJsonRow(i),
    i => r.dp && r.dp.getJsonRows && r.dp.getJsonRows(i, i)[0],
    i => r.dp && r.dp.getRow && r.dp.getRow(i),
    i => r.gv && r.gv.getValues && r.gv.getValues(i),
    i => { const f = fieldNames(); return f.length && r.dp && r.dp.getValue ? Object.fromEntries(f.map(n => [n, r.dp.getValue(i, n)])) : null; },
    i => { if (!r.iface) return null; const cols = (r.iface.getColumns ? r.iface.getColumns() : []).map(c => c.name || c.fieldName || c); return Object.fromEntries(cols.map(c => [c, r.iface.getValue(i, c)])); },
  ];
  const count = (() => { try { return (r.dp && r.dp.getRowCount()) || (r.iface && r.iface.getRowCount()) || (r.gv && r.gv.getItemCount && r.gv.getItemCount()) || 0; } catch (e) { return 0; } })();
  const fn = tries.find(t => { try { return ok(t(0)); } catch (e) { return false; } });
  const res = [];
  for (let i = 0; i < Math.min(count, 2000); i++) { let v = null; try { v = fn ? fn(i) : null; } catch (e) {} res.push(v); }
  return res;
};
const rgMethods = o => { const m = new Set(); for (let x = o; x && x !== Object.prototype; x = Object.getPrototypeOf(x)) Object.getOwnPropertyNames(x).forEach(k => { try { if (typeof o[k] === 'function') m.add(k); } catch (e) {} }); return [...m].filter(k => /row|value|field|column|current|select|item|count|json|focus/i.test(k)).slice(0, 80); };
const rgSelect = (r, i) => {
  if (r.gv) { let item = i; try { if (r.gv.getItemIndex) { const x = r.gv.getItemIndex(i); if (x >= 0) item = x; } } catch (e) {} r.gv.setCurrent({ itemIndex: item, dataRow: i }); try { r.gv.setFocus && r.gv.setFocus(); } catch (e) {} return true; }
  if (r.iface) { r.iface.setSelection({ rowIndex: i }); return true; }
  return false;
};
const grid = hdr => all('.rg-root').find(r => vis(r) && all('.rg-header-cell', r).some(h => norm(h.textContent) === norm(hdr)));
const headers = g => all('.rg-header-cell', g).map(h => norm(h.textContent));
const rows = g => all('tr.rg-data-row', g);
// 칸 찾기: 헤더 순서가 아니라 '헤더 바로 아래 위치'로 (채주내역 '계좌번호'처럼 헤더 하나가 칸 두 개를 덮으면 순서가 어긋난다)
const cellUnder = (h, r) => { const a = h.getBoundingClientRect(), x = a.left + a.width / 2;
  return all('td.rg-data-cell', r).find(td => { const b = td.getBoundingClientRect(); return b.width > 0 && b.left <= x && b.right >= x; }) || null; };
// 헤더 수와 칸 수가 같으면 순서로, 다르면(덮는 헤더가 있으면) 위치로
const cellFor = (g, r, h, i) => { const c = all('td.rg-data-cell', r); return c.length === all('.rg-header-cell', g).length ? c[i] : cellUnder(h, r); };
const cell = (g, row, hdr) => { const r = rows(g)[row]; const hs = all('.rg-header-cell', g); const i = hs.findIndex(h => norm(h.textContent) === norm(hdr));
  return r && i >= 0 ? cellFor(g, r, hs[i], i) || null : null; };
const rowVals = (g, row) => { const r = rows(g)[row]; if (!r) return null; const hs = all('.rg-header-cell', g);
  return Object.fromEntries(hs.map((h, i) => { const td = cellFor(g, r, h, i); return [norm(h.textContent), td ? td.textContent.trim() : undefined]; })); };
`;

class Page {
  constructor(win) { this.win = win; this.wc = win.webContents; }

  /** fn: 페이지에서 실행할 함수 소스(문자열). PRELUDE 헬퍼 사용 가능. */
  async eval(fn, ...args) {
    const code = `(() => { ${PRELUDE}\n return (${fn})(...${JSON.stringify(args)}); })()`;
    return this.wc.executeJavaScript(code, true);
  }

  async waitFor(fn, args = [], { timeout = 10000, interval = 300, message } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
      try { last = await this.eval(fn, ...args); if (last) return last; } catch (e) { /* 페이지 전환 중 */ }
      await sleep(interval);
    }
    if (message) throw new Error(message);
    return null;
  }

  url() { return this.wc.getURL(); }
  async goto(url) { await this.wc.loadURL(url); }

  /** 끌기 (스크롤바 손잡이 등): 누른 채 여러 번 나눠 움직이고 놓는다 */
  async drag(from, to, steps = 8) {
    this.wc.focus();
    this.wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y });
    this.wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = Math.round(from.x + (to.x - from.x) * i / steps), y = Math.round(from.y + (to.y - from.y) * i / steps);
      this.wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers: ['leftButtonDown'] }); await sleep(30);
    }
    this.wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 });
    await sleep(100);
  }

  async click(pt, { count = 1 } = {}) {
    if (!pt) throw new Error('클릭할 위치를 찾지 못했습니다.');
    const { x, y } = pt;
    this.wc.focus();   // 숨긴 창은 포커스 이벤트가 안 와 RealGrid 편집기·코드도움이 안 열린다 (document.hasFocus() false)
    this.wc.sendInputEvent({ type: 'mouseMove', x, y });
    for (let i = 1; i <= count; i++) {
      this.wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: i });
      this.wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: i });
      await sleep(50);
    }
    await sleep(150);
  }
  dblclick(pt) { return this.click(pt, { count: 2 }); }

  /** 페이지 함수로 요소를 찾아 가운데 좌표를 받은 뒤 클릭 */
  async clickWhere(findFn, ...args) {
    const pt = await this.eval(`(...a) => { const el = (${findFn})(...a); return el ? center(el) : null; }`, ...args);
    if (!pt) throw new Error('요소를 찾지 못했습니다.');
    await this.click(pt);
    return pt;
  }

  /** 마우스 휠 (deltaY > 0 = 아래로) */
  async wheel(pt, deltaY, deltaX = 0) {
    // 숨긴 창에서는 실제 휠 입력이 전달되지 않아, 그 위치의 요소에 휠 이벤트를 직접 보낸다 (그리드는 JS 로 휠을 처리)
    if (this.win.isVisible()) {
      this.wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
      this.wc.sendInputEvent({ type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: -deltaX, deltaY: -deltaY, canScroll: true });
    } else {
      await this.eval((x, y, d, dx) => { const el = document.elementFromPoint(x, y); if (el) el.dispatchEvent(new WheelEvent('wheel', { deltaY: d, deltaX: dx, shiftKey: !d && !!dx, deltaMode: 0, clientX: x, clientY: y, bubbles: true, cancelable: true })); }, pt.x, pt.y, deltaY, deltaX);
    }
    await sleep(250);
  }

  async key(keyCode, modifiers = []) {
    this.wc.focus();
    this.wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Enter') this.wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    this.wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(80);
  }
  async press(keyCode, times = 1) { for (let i = 0; i < times; i++) { await this.key(keyCode); await sleep(150); } }
  async selectAll() { this.wc.focus(); this.wc.selectAll(); await sleep(120); }   // 단축키(Cmd+A)는 메뉴 없는 창에서 안 먹음
  async type(text) { await this.wc.insertText(String(text)); await sleep(100); }
  /** 키를 하나씩 눌러 입력 (붙여넣기를 안 받는 날짜 칸 등). 숫자·영문용 */
  async typeKeys(text) { this.wc.focus(); for (const ch of String(text)) { for (const type of ['keyDown', 'char', 'keyUp']) this.wc.sendInputEvent({ type, keyCode: ch }); await sleep(40); } await sleep(100); }

  /** 모든 프레임(iframe 포함) */
  frames() { return this.wc.mainFrame.framesInSubtree; }

  async findFrame(fnSrc, arg, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      for (const fr of this.frames()) {
        try { if (await fr.executeJavaScript(`(${fnSrc})(${JSON.stringify(arg)})`)) return fr; } catch (e) { /* 로딩 중 */ }
      }
      await sleep(500);
    }
    return null;
  }

  async allText() {
    const out = [];
    for (const fr of this.frames()) {
      try { out.push(await fr.executeJavaScript('document.body ? document.body.innerText : ""')); } catch (e) { /* skip */ }
    }
    return out.join('\n');
  }

  async screenshot(file) {
    const img = await this.wc.capturePage();
    require('fs').writeFileSync(file, img.toPNG());
    return file;
  }

  /** XHR/fetch 요청·응답 기록 시작. 돌려주는 함수를 부르면 기록을 끝내고 목록을 준다 (그룹웨어 API 파악용 진단) */
  async netLogStart() {
    const dbg = this.wc.debugger;
    const attached = dbg.isAttached();
    if (!attached) dbg.attach('1.3');
    await dbg.sendCommand('Network.enable');
    const reqs = new Map(); const pending = [];
    const onMsg = (e, method, params) => {
      if (method === 'Network.requestWillBeSent' && /xhr|fetch/i.test(params.type || '')) {
        const r = params.request; reqs.set(params.requestId, { url: r.url, method: r.method, headers: r.headers, postData: r.postData || '' });
      }
      if (method === 'Network.responseReceived' && reqs.has(params.requestId)) Object.assign(reqs.get(params.requestId), { status: params.response.status, mime: params.response.mimeType });
      if (method === 'Network.loadingFinished' && reqs.has(params.requestId))
        pending.push(dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId }).then(b => { reqs.get(params.requestId).body = String(b.body || '').slice(0, 300000); }).catch(() => {}));
    };
    dbg.on('message', onMsg);
    return async () => {
      await sleep(1000); await Promise.all(pending);
      dbg.off('message', onMsg);
      try { await dbg.sendCommand('Network.disable'); } catch (e) { /* */ }
      if (!attached) dbg.detach();
      return [...reqs.values()];
    };
  }

  /** <input type=file> 에 파일 넣기 (CDP) */
  async setFiles(selector, files) {
    const dbg = this.wc.debugger;
    const attached = dbg.isAttached();
    if (!attached) dbg.attach('1.3');
    try {
      const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
      const { nodeId } = await dbg.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error('파일 입력칸을 찾지 못했습니다.');
      await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files });
    } finally { if (!attached) dbg.detach(); }
  }
}

module.exports = { Page, sleep, PRELUDE };
