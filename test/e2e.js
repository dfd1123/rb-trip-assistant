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
const R = require('../src/engine/rules');
const { Store } = require('../src/engine/store');

const ui = {
  logs: [],
  info(m) { this.logs.push(m); },
  async assist(m) { throw new Error(`자동화가 사람 도움을 요청함: ${m}`); },
  async confirm() { return true; },
  async askInt(t) { throw new Error(`입력 요청: ${t}`); },
  async pause() {},
};

if (app.dock) app.dock.hide();   // 테스트용 앱이 Dock 에 두 번째 아이콘으로 뜨지 않게
app.whenReady().then(async () => {
  let code = 0;
  const { srv, url, saved } = await mock.start();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-e2e-'));
    const store = new Store(dir);
    store.saveConfig({ baseUrl: url, name: '김종완', budgetDept: '매니퓰레이터 사업부', defaultOrigin: '세종특별자치시 집현동 1095' });
    let gw;
    const gwWindow = () => {
      if (gw && !gw.isDestroyed()) return gw;
      // 앱처럼 숨긴 창(백그라운드)에서 진행
      gw = new BrowserWindow({ width: 1400, height: 950, show: !!process.env.E2E_SHOW, webPreferences: { partition: 'e2e-' + Date.now(), backgroundThrottling: false } });
      gw.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } } }));
      if (!process.env.E2E_SHOW) gw.webContents.on('did-create-window', w => w.on('show', () => w.hide()));   // 성공 시 띄우는 작성 팝업도 테스트에선 숨김
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
    const mineTop = s.top.find(r => r.순번 === '45');
    assert.equal(mineTop.품의구분, '지출');
    assert.equal(mineTop.총금액, '344,814');   // 교통비 74,814 + 여유분 20,000
    assert.equal(mineTop.적요, '판교 AI 사무소 RBY1-Muscat 연동 검증으로 인한 출장');
    assert.deepEqual(s.bot.slice(0, 3).map(r => [r.부서, r.예산과목, r.품의금액]), [
      ['매니퓰레이터 사업부', '여비교통비(판)_국내교통비', '94,814'],
      ['매니퓰레이터 사업부', '여비교통비(판)_국내숙박비', '160,000'],
      ['매니퓰레이터 사업부', '여비교통비(판)_식대', '90,000'],
    ]);
    assert.equal(s.bot[1].적요, '출장 국내숙박비');
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
    draft.fund = '일반경비';
    draft.schedule[0].detail = '로봇 셋업'; draft.schedule[1].detail = '실기 검증'; draft.schedule[2].detail = '결과 공유';
    draft.expenses[1].amount = 150000;            // 실제 숙박비
    draft.attachments = [];
    // 정산 경비는 줄마다 증빙(이미지·PDF) 필수 → 테스트용 파일을 만들어 붙인다
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-proof-'));
    draft.expenses.forEach((e, i) => { const f = path.join(proofDir, `proof${i}.${i % 2 ? 'pdf' : 'png'}`); fs.writeFileSync(f, 'x'); e.proofs = [f]; });
    // 보고서 그룹웨어 입력은 이제 품의서승인 → 결의서전송 흐름이라 가짜 아마란스에 그 화면이 생기면 다시 넣는다. 지금은 초안 검증까지만
    const rp = R.parseReport(draft);
    assert.equal(rp.fund, '일반경비');
    assert.equal(rp.attachments.length, draft.expenses.length, '증빙이 전부 첨부 대상');
    console.log('E2E 보고서(초안) OK');

    // 올린 품의 목록·삭제: 결재 진행 중(순번 44)은 잠김, 나머지만 삭제
    const { rows } = await runner.runListBudget(env);
    assert.equal(rows.find(r => r.seq === '44').locked, true);
    const mine = rows.filter(r => !r.locked);
    assert.ok(mine.length >= 1, `삭제 가능한 품의가 1건 이상이어야 함: ${JSON.stringify(rows)}`);
    const res = await runner.runDeleteBudget(env, [...mine.map(r => r.key), rows.find(r => r.seq === '44').key]);
    assert.equal(res.deleted, mine.length); assert.equal(res.skipped, 1);
    assert.deepEqual(res.rows.map(r => r.seq), ['40', '41', '42', '43', '44']);   // 결재완료·진행중만 남음
    console.log('E2E 품의 삭제 OK');

    // 출장 기록 삭제: 연결된 품의(신청)까지 삭제. 새로 신청 하나 더 만든 뒤 지운다
    delete process.env.MOCK_FORM;   // 다시 신청서 양식
    const { id: id2 } = await runner.runApply(env, { ...data, reason: '삭제 테스트 출장' });
    const link = store.load(id2).gwApply;
    assert.ok(link && link.seq, '신청 품의 순번이 기록돼야 함');
    const dr = await runner.runDeleteTrip(env, id2);
    assert.ok(!dr.rows.some(r => r.key === link.key), '연결된 품의가 지워져야 함');
    assert.ok(!store.list().some(t => t.id === id2), '출장 기록이 지워져야 함');
    console.log('E2E 출장 삭제 OK');

    // 취소: 품의 입력이 끝난 직후 [취소] → 그룹웨어 품의 행 삭제 + 출장 기록 삭제
    {
      const before = (await runner.runListBudget(env)).rows.length;
      const cui = { ...ui, cancelled: false, logs: [], info(m) { if (this.cancelled) throw new Error('취소했어요.'); this.logs.push(m); if (/품의 입력 완료/.test(m)) this.cancelled = true; } };
      await assert.rejects(runner.runApply({ ...env, ui: cui, log: m => cui.info(m) }, { ...data, reason: '취소 테스트 출장' }), /취소했어요/);
      assert.ok(cui.logs.some(m => /품의.*삭제했어요/.test(m)), `롤백 로그 없음: ${cui.logs.slice(-3).join(' / ')}`);
      assert.equal((await runner.runListBudget(env)).rows.length, before, '취소한 품의가 그룹웨어에 남아 있음');
      assert.ok(!store.list().some(t => t.apply && t.apply.reason === '취소 테스트 출장'), '취소한 출장 기록이 남아 있음');
      console.log('E2E 취소 롤백 OK');
    }
  } catch (e) {
    console.error('E2E FAIL:', e.stack || e.message);
    code = 1;
  } finally {
    srv.close();
    app.exit(code);
  }
});
