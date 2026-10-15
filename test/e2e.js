'use strict';
// 자동 입력 엔진 E2E: 가짜 아마란스에 신청서를 끝까지 입력하고 보관된 본문을 검사한다.
// 실행: xvfb-run -a npx electron test/e2e.js --no-sandbox   (Mac/Windows 는 npx electron test/e2e.js)

const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const mock = require('./mock-gw/server');
const runner = require('../src/engine/runner');
const { Store } = require('../src/engine/store');

const ui = {
  logs: [],
  info(m) { this.logs.push(m); },
  async assist(m) { throw new Error(`자동화가 사람 도움을 요청함: ${m}`); },
  async confirm() { return true; },
  async askInt(t) { throw new Error(`입력 요청: ${t}`); },
  async pause() {},
};

app.whenReady().then(async () => {
  let code = 0;
  const { srv, url, saved } = await mock.start();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-e2e-'));
    const store = new Store(dir);
    store.saveConfig({ baseUrl: url, name: '김종완' });
    let gw;
    const gwWindow = () => {
      if (gw && !gw.isDestroyed()) return gw;
      gw = new BrowserWindow({ width: 1400, height: 950, show: true, webPreferences: { partition: 'e2e-' + Date.now() } });
      gw.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));
      return gw;
    };
    const env = { cfg: store.config(), store, ui, log: m => { ui.info(m); console.log('  ·', m); }, gwWindow, makeNaverWindow: () => { throw new Error('no naver'); }, creds: () => ({ id: 'tester', pw: 'pw1234' }) };

    const data = {
      reason: '판교 AI 사무소 RBY1-Muscat 연동 검증', destination: '레인보우로보틱스 판교 AI 사무소',
      dates: { start: '2026-10-20', end: '2026-10-22', start_time: '09:00', end_time: '18:00' }, category: '연구과제', project: 'RBY1 과제',
      transport: { mode: 'car', to: '판교', total: 74814 }, companions: ['홍길동'], companion_purpose: '셋업 지원',
      purpose: 'SDK 래핑 및 실기 검증\n두번째 줄',
      expenses: [{ item: 'domestic_lodging', amount: 160000 }, { item: 'meal', amount: 90000, memo: '판교 출장 식대' }],
    };
    // 자동 로그인: 틀린 비밀번호는 실패, 맞으면 성공
    {
      const { Amaranth } = require('../src/engine/gw');
      const g = new Amaranth({ win: gwWindow(), baseUrl: url, ui, log: () => {} });
      assert.equal(await g.loginNeeded(), true);
      assert.equal(await g.autoLogin('tester', 'wrong'), false);
      await gw.webContents.executeJavaScript("location.reload()"); await new Promise(r => setTimeout(r, 1500));
      console.log('  자동 로그인 실패 케이스 OK');
    }
    const t0 = Date.now();
    const { id } = await runner.runApply(env, data);
    console.log(`  runApply ${((Date.now() - t0) / 1000).toFixed(1)}s, id=${id}`);

    // 그리드 상태
    const st = await gw.webContents.executeJavaScript('JSON.stringify({top:S.top, bot:S.bot, approval:window.__approval})');
    const s = JSON.parse(st);
    assert.equal(s.top[1].품의구분, '지출');
    assert.equal(s.top[1].총금액, '324,814');
    assert.deepEqual(s.bot.slice(0, 3).map(r => [r.부서, r.예산과목, r.품의금액]), [
      ['매니퓰레이터 사업부', '여비교통비(판)_국내교통비', '74,814'],
      ['매니퓰레이터 사업부', '여비교통비(판)_국내숙박비', '160,000'],
      ['매니퓰레이터 사업부', '여비교통비(판)_식대', '90,000'],
    ]);
    assert.equal(s.bot[1].적요, '판교 AI 사무소 RBY1-Muscat 연동 검증 출장 국내숙박비');
    assert.equal(s.approval.form, '출장신청 및 출장경비 사전품의');

    // 보관된 문서
    assert.equal(saved.length, 1, '보관이 1번 되어야 함');
    const doc = saved[0];
    assert.equal(doc.title, '[출장신청 및 출장경비 사전품의] 판교 AI 사무소 RBY1-Muscat 연동 검증으로 인한 출장의 건');
    for (const needle of ['레인보우로보틱스 판교 AI 사무소', '2026.10.20 - 2026.10.22', 'SDK 래핑 및 실기 검증<br>두번째 줄', '홍길동', '셋업 지원', 'RBY1 과제'])
      assert.ok(doc.body.includes(needle), `본문에 '${needle}' 없음`);
    const checked = (doc.body.match(/checked="checked"/g) || []).length;
    assert.equal(checked, 2, '연구과제 + 자차 체크');
    assert.equal(store.load(id).status, '보관됨');
    console.log('E2E 신청서 OK');

    // ---- 보고서: 신청 기록으로 초안 → 보고 내용 채워서 입력 ----
    process.env.MOCK_FORM = 'report_form_body.html';
    const draft = runner.reportDraft(store, store.config(), id);
    assert.equal(draft.schedule.length, 3);
    assert.equal(draft.expenses[0].item, 'domestic_transport');
    draft.report = 'SDK 래핑 완료\n실기 검증 3건 통과';
    draft.schedule[0].detail = '로봇 셋업'; draft.schedule[2].detail = '결과 공유';
    draft.expenses[1].amount = 150000;            // 실제 숙박비
    draft.attachments = [];
    await runner.runReport(env, draft);
    const st2 = JSON.parse(await gw.webContents.executeJavaScript('JSON.stringify({top:S.top, approval:window.__approval})'));
    assert.equal(st2.approval.form, '출장보고서 및 정산 품의서');
    assert.equal(st2.top[1].총금액, '314,814');
    const rep = saved[1];
    assert.equal(rep.title, '[출장보고서 및 정산 품의서] 판교 AI 사무소 RBY1-Muscat 연동 검증으로 인한 출장 보고의 건');
    for (const needle of ['김종완', 'SDK 래핑 완료<br>실기 검증 3건 통과', '로봇 셋업', '결과 공유', '10/22'])
      assert.ok(rep.body.includes(needle), `보고서 본문에 '${needle}' 없음`);
    assert.equal(store.load(id).reportStatus, '보관됨');
    console.log('E2E 보고서 OK');
  } catch (e) {
    console.error('E2E FAIL:', e.stack || e.message);
    code = 1;
  } finally {
    srv.close();
    app.exit(code);
  }
});
