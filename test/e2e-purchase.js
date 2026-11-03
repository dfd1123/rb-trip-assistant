'use strict';
// 구매의뢰 E2E: 가짜 아마란스 결재작성 → 구매의뢰서 작성 창 (제목·본문·첨부·수신및참조, 임시 저장 본문 [취소])
// 실행: npx electron test/e2e-purchase.js

const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const mock = require('./mock-gw/server');
const runner = require('../src/engine/runner');
const R = require('../src/engine/rules');
const { Store } = require('../src/engine/store');

if (app.dock) app.dock.hide();
app.whenReady().then(async () => {
  let code = 0;
  process.env.MOCK_TEMPDRAFT = process.env.MOCK_TEMPDRAFT || '1';
  process.env.MOCK_LOADING = process.env.MOCK_LOADING || '2500';   // 작성 창 불러오는 덮개가 제목 칸 클릭을 먹는 경우
  const { srv, url } = await mock.start();
  try {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-pu-')));
    store.saveConfig({ baseUrl: url, name: '이정우', budgetDept: '매니퓰레이터 사업부' });
    let gw;
    const gwWindow = () => {
      if (gw && !gw.isDestroyed()) return gw;
      gw = new BrowserWindow({ width: 1400, height: 950, show: false, webPreferences: { partition: 'e2e-pu-' + Date.now(), backgroundThrottling: false } });
      gw.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } } }));
      gw.webContents.on('did-create-window', w => w.on('show', () => w.hide()));
      return gw;
    };
    const ui = { logs: [], info(m) { this.logs.push(m); }, async assist(m) { throw new Error(`자동화가 사람 도움을 요청함: ${m}`); }, async confirm() { return true; }, async askInt(t) { throw new Error(t); }, async pause() {} };
    const env = { cfg: store.config(), store, ui, log: m => { ui.info(m); if (process.env.E2E_LOG) console.log('  ·', m); }, gwWindow, creds: () => ({ id: 'tester', pw: 'pw1234' }), debugDir: null };
    const po = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ta-po-')), '견적서_다성오토메이션.pdf'); fs.writeFileSync(po, '%PDF-1.4 x');
    const data = { vendor: { name: '다성 오토메이션', contact: '서성문' }, purpose: '기타', purpose_etc: '시험 장비', project: '기타', project_etc: '디스플레이 2차', urgency: '긴급', substitutable: false,
      items: [{ name: '모션 컨트롤러', qty: 2, unit_price: 105000, due: '2026-11-05', note: '' }, { name: '케이블', qty: 1.5, unit_price: 10000, note: '1.5m' }, { name: '할인', qty: 1, unit_price: -10000 }],
      vat_included: true, reason: '양팔로봇 시험 장비 제어용', title: '[구매의뢰서 - 디스플레이 2차] 모션 컨트롤러 구매 요청의 건', file: po, memo: 'x' };
    const { title } = await runner.runPurchase(env, data);
    const pop = BrowserWindow.getAllWindows().find(w => /compose\.html/.test(w.webContents.getURL()));
    assert.ok(pop, '작성 창');
    const st = await pop.webContents.executeJavaScript(`({ title: document.getElementById('title').value, chips: window.__chips || [], files: window.__files || [], temp: window.__tempdraft || '',
      body: document.getElementById('editorView_UBAP001').contentDocument.body.innerText.replace(/\\s+/g, ' ') })`);
    assert.equal(st.temp, 'cancel', '임시 저장 본문은 [취소]');
    assert.equal(st.title, title);
    assert.deepEqual(st.chips, ['구매팀', '경영지원부(전자결재용)', '연구지원팀', '개발 2팀'], '수신및참조: 기본 3곳 + 작성부서 (경로 말풍선·비슷한 이름은 안 누름)');
    assert.deepEqual(st.files, ['견적서_다성오토메이션.pdf']);
    for (const needle of ['다성 오토메이션 / 서성문', '모션 컨트롤러', '케이블', '할인', '-10,000', '210,000', '15,000'])
      assert.ok(st.body.includes(needle), `본문에 '${needle}' 없음: ${st.body.slice(0, 600)}`);
    const pu = R.parsePurchase(data);
    assert.equal(pu.supply, 210000 + 15000 - 10000); assert.equal(pu.total, Math.round(215000 * 1.1));
    assert.equal(store.purchases().length, 1);
    console.log('E2E 구매의뢰 작성 창 OK');

    // ---- 외부 방문객 출입 신청서: 같은 결재작성 → 양식 이름 정확히 같은 줄('방문자 신청' 아님) → 제목·본문·수신및참조(경영지원부) ----
    for (const w of BrowserWindow.getAllWindows()) if (w !== gw && !w.isDestroyed()) w.destroy();
    const vdate = (() => { const d = new Date(); d.setDate(d.getDate() + 14); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
    const vdata = { type: 'C', name: '김철수', org: '현대자동차', position: '부장', count: 3, date: vdate, time: '14:00~16:00', purpose: 'AMR 협업 미팅', dept: '자율주행팀', host: '이정우',
      areas: [{ area: '7층', detail: '외부회의실' }, { area: '7층 대회의실' }], shoot: ['해당없음'] };
    const vr = await runner.runVisitor(env, vdata);
    const vpop = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && /compose\.html/.test(w.webContents.getURL()) && /방문객|%EB%B0%A9%EB%AC%B8%EA%B0%9D/.test(w.webContents.getURL()));
    assert.ok(vpop, '방문객 작성 창: ' + BrowserWindow.getAllWindows().map(w => w.isDestroyed() ? '' : w.webContents.getURL()).join(' | '));
    const vs = await vpop.webContents.executeJavaScript(`({ title: document.getElementById('title').value, chips: window.__chips || [],
      note: (document.getElementById('__taNote') || {}).innerText || '', body: document.getElementById('editorView_UBAP001').contentDocument.body.innerText.replace(/\\s+/g, ' '), checked: document.getElementById('editorView_UBAP001').contentDocument.querySelectorAll('table input[checked]').length })`);
    assert.equal(vs.title, vr.title); assert.ok(vs.title.includes('현대자동차 김철수 외 2명'), vs.title);
    assert.deepEqual(vs.chips, ['경영지원부(전자결재용)'], '수신및참조: 경영지원부만');
    for (const needle of ['김철수', '현대자동차', '3명', '(외부회의실)', 'AMR 협업 미팅', '14:00~16:00'])
      assert.ok(vs.body.includes(needle), `본문에 '${needle}' 없음: ${vs.body.slice(0, 600)}`);
    assert.equal(vs.checked, 3, '7층·7층 대회의실·해당없음');
    assert.ok(ui.logs.some(m => /방문 사무실 사업부서장/.test(m)), '유형 C 결재선 안내');
    assert.ok(/유형 C 결재선/.test(vs.note) && /방문 사무실 사업부서장/.test(vs.note) && /3부/.test(vs.note), '작성 창 결재선 안내 카드: ' + vs.note);
    assert.ok(!vs.body.includes('결재선'), '안내 카드는 본문에 안 들어감');
    console.log('E2E 방문객 신청 작성 창 OK');
  } catch (e) { code = 1; console.error('E2E 구매의뢰 실패:', e.stack || e); }
  finally { srv.close(); app.exit(code); }
});
setTimeout(() => { console.error('E2E 구매의뢰 시간 초과'); process.exit(3); }, 300000);
