'use strict';
// 정산 E2E: 가짜 아마란스(mock-gw/settle.js)에서 runReport 를 끝까지 — 품의서승인 → 결의서전송(채주·첨부·환원·전송) → 결의서입력 → 결재상신 → 본문
// 실행: npx electron test/e2e-settle.js

const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const mock = require('./mock-gw/server');
const runner = require('../src/engine/runner');
const { Store } = require('../src/engine/store');

if (app.dock) app.dock.hide();
const won = n => n.toLocaleString('en-US');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

// 신청 품의 (실제 사용자 사례: 19일·20일 식대가 따로 잡힌 품의, 숙박, 교통비)
const APPLY = () => ({ key: '2026-10|14|4', 품의연월: '2026-10', 품의일: '14', 순번: '4', 품의구분: '지출', 적요: 'FCC인증의 건', 총금액: '238,000', 결재상태: '결재완료', 진행상태: '승인완료',
  budgets: [
    { 부서: '매니퓰레이터 사업부', 예산과목: '여비교통비(판)_식대', 예산과목비고: '10/19 (9시 본사 출발 예정)', 품의금액: '30,000' },
    { 부서: '매니퓰레이터 사업부', 예산과목: '여비교통비(판)_식대', 예산과목비고: '10/20 (7시 출발 예정)', 품의금액: '38,000' },
    { 부서: '매니퓰레이터 사업부', 예산과목: '여비교통비(판)_국내숙박비', 예산과목비고: '10/19 ~ 20 숙박 예정', 품의금액: '70,000' },
    { 부서: '매니퓰레이터 사업부', 예산과목: '여비교통비(판)_국내교통비', 예산과목비고: 'ktx, 버스이용 복귀', 품의금액: '100,000' },
  ], resolutions: [] });
const STATE = (extra = {}) => ({ approve: [APPLY()], vendors: [['110747', '이정우(임직원)', ''], ['109323', '정우소바', '이정우'], ['100001', '김용완(CFO)', ''], ['109046', '김용완(임직원_개발2팀)', ''], ['900207', '김용완[5302]', '']],
  resList: [], nextResNo: 27, nextGisuSq: 23, alerts: 0, closed: 0, ...extra });

const ONLY = (process.env.E2E_ONLY || '').split(',').filter(Boolean).map(Number);
const run = n => !ONLY.length || ONLY.includes(n);
app.whenReady().then(async () => {
  let code = 0;
  process.env.MOCK_FORM = 'report_settle_body.html';
  const { srv, url } = await mock.start();
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-settle-'));
    const store = new Store(dir);
    store.saveConfig({ baseUrl: url, name: '이정우', budgetDept: '매니퓰레이터 사업부', defaultOrigin: '세종' });
    const proofDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-proof-'));
    const png = n => { const f = path.join(proofDir, n); fs.writeFileSync(f, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')); return f; };
    store.save('t1', { id: 't1', created: '2026-10-14T00:00:00Z', status: '그룹웨어', title: 'x', gwApply: { key: '2026-10|14|4', ym: '2026-10', day: '14', seq: '4' },
      apply: { reason: 'FCC인증의 건', destination: '한국항공우주산업', start: '2026-10-19', end: '2026-10-20', start_time: '09:00', end_time: '18:00', companions: [], purpose: 'FCC 인증', transport: { mode: 'corporate' }, expenses: [] } });

    let gw;
    const gwWindow = () => {
      if (gw && !gw.isDestroyed()) return gw;
      gw = new BrowserWindow({ width: 1400, height: 950, show: !!process.env.E2E_SHOW, webPreferences: { partition: 'e2e-settle-' + Date.now(), backgroundThrottling: false } });
      gw.webContents.setWindowOpenHandler(() => ({ action: 'allow', overrideBrowserWindowOptions: { show: false, webPreferences: { backgroundThrottling: false } } }));
      if (!process.env.E2E_SHOW) gw.webContents.on('did-create-window', w => w.on('show', () => w.hide()));
      return gw;
    };
    const asked = [];
    const ui = { logs: [], info(m) { this.logs.push(m); }, async assist(m) { throw new Error(`자동화가 사람 도움을 요청함: ${m}`); }, async confirm(t) { asked.push(t); return this.redo; }, async askInt(t) { throw new Error(`입력 요청: ${t}`); },
      async askChoice(t, opts) { asked.push(t + ' :: ' + opts.join(' / ')); const i = opts.findIndex(o => /임직원/.test(o)); return i >= 0 ? i : 0; }, async pause(m) { throw new Error(`멈춤: ${m}`); }, redo: true };
    const env = { cfg: store.config(), store, ui, log: m => { ui.info(m); if (process.env.E2E_LOG) console.log('  ·', m); }, gwWindow, makeNaverWindow: () => { throw new Error('no naver'); }, creds: () => ({ id: 'tester', pw: 'pw1234' }), debugDir: null };
    const report = (expenses) => ({ trip_id: 't1', reason: 'FCC인증의 건', name: '이정우', companions: [], category: '로봇', project: '', destination: '한국항공우주산업', visit_org: '한국항공우주산업', fund: '일반경비',
      period: '2026.10.19 09:00 - 2026.10.20 18:00', purpose: 'FCC 인증', report: 'FCC 시험 완료', schedule: [{ date: '10/19', place: 'KAI', detail: '시험' }, { date: '10/20', place: 'KAI', detail: '시험' }], attachments: [], expenses });
    const E = (item, amount, memo, date, meal, people, file) => ({ item, amount, memo, date, meal, people, pay: 'personal', proofs: file ? [png(file)] : [] });

    const exp1 = [E('meal', 42000, '10/19 3인 석식', '2026-10-19', '석식', 3, '1_석식.png'), E('domestic_lodging', 70000, '10/19 숙박 1박', '2026-10-19', '', 0, '1_숙박.png'),
        E('meal', 8000, '10/20 1인 조식', '2026-10-20', '조식', 1, '2_조식.png'), E('meal', 13900, '10/20 1인 중식', '2026-10-20', '중식', 1, '2_중식.png'), E('meal', 15000, '10/20 1인 석식', '2026-10-20', '석식', 1, '2_석식.png')];
    if (run(1) || run(2) || run(3)) {
      // ---- 1) 처음 정산: 19일 석식 42,000(3인) · 20일 조·중·석 3장 · 숙박 70,000 → 날짜별 예산 줄, 같은 날 식대 한 줄, 증빙 여러 장 ----
      mock.setSettle(STATE());
      const t0 = Date.now();
      await runner.runReport(env, report(exp1));
      const s1 = mock.getSettle();
      const r1 = s1.approve[0].resolutions;
      const exp = r1.find(r => r.결의구분 === '지출결의서');
      assert.ok(exp && exp.결의번호, '지출결의서가 전송돼야 함');
      const P = bi => exp.budgets[bi].payees.map(p => [p.거래처명, p.총금액, p.거래처비고, (p.files || []).length]);
      assert.deepEqual(P(0), [['이정우(임직원)', '30,000', '10/19 3인 석식', 1]], '19일 식대 줄: 한도 30,000 까지');
      assert.deepEqual(P(1), [['이정우(임직원)', '36,900', '10/20 1인 조식·중식·석식 3건', 3]], '20일 식대 줄: 하루 한 줄, 증빙 3장');
      assert.deepEqual(P(2), [['이정우(임직원)', '70,000', '10/19 숙박 1박', 1]]);
      assert.deepEqual(P(3), []);
      assert.deepEqual(exp.budgets.slice(0, 3).map(b => [b.결제수단, b.과세구분]), [['외상', '기타'], ['외상', '기타'], ['외상', '기타']]);
      const refund = r1.find(r => r.결의구분 === '환원');
      assert.equal(refund && refund.금액, 238000 - 30000 - 36900 - 70000, '환원 금액');
      assert.equal(s1.closed, 0, '결의서전송 창 맨 아래 [확인]을 누르면 안 됨');
      assert.equal(s1.alerts, 0, '그룹웨어 오류 창이 뜨면 안 됨');
      assert.ok(asked.some(q => /검색됐어요/.test(q)), '같은 이름 거래처는 사람에게 물어야 함: ' + JSON.stringify(asked));
      assert.equal(asked.filter(q => /검색됐어요/.test(q)).length, 1, '한 번 고르면 같은 작업에선 다시 안 물음');
      assert.deepEqual(s1.approvalFor, [exp.결의번호], '그 결의만 결재상신');
      assert.ok(/출장보고서/.test(s1.approvalTitle || ''), '상신 제목');
      console.log(`E2E 정산 처음 입력 OK (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  
      // ---- 2) 다시 돌리기: 전송된 결의를 [예] → 전송취소·삭제·새로 입력. 같은 결과여야 하고 결의는 하나만 ----
      asked.length = 0;
      await runner.runReport(env, report(exp1));
      const s2 = mock.getSettle();
      const r2 = s2.approve[0].resolutions;
      assert.equal(r2.filter(r => r.결의구분 === '지출결의서').length, 1, '지출결의서는 하나만');
      assert.equal(r2.filter(r => r.결의구분 === '환원').length, 1, '환원도 하나만');
      const exp2 = r2.find(r => r.결의구분 === '지출결의서');
      assert.ok(exp2.결의번호 && exp2.결의번호 !== exp.결의번호, '새 결의번호');
      assert.deepEqual(exp2.budgets[1].payees.map(p => [p.총금액, (p.files || []).length]), [['36,900', 3]]);
      assert.equal(s2.resList.length, 1, '결의서입력 목록엔 새 결의 하나');
      assert.ok(asked.some(q => /이미 전송된 정산 결의/.test(q)), '다시 넣을지 물어야 함');
      assert.equal(s2.closed, 0); assert.equal(s2.alerts, 0);
      console.log('E2E 정산 다시 넣기 OK');
  
      // ---- 3) 다시 넣기를 [아니오]: 전송된 결의는 그대로, 결의서입력에서 그 결의로 결재상신만 ----
      asked.length = 0; ui.redo = false;
      const before3 = JSON.stringify(mock.getSettle().approve[0].resolutions);
      await runner.runReport(env, report(exp1));
      const s3 = mock.getSettle();
      assert.equal(JSON.stringify(s3.approve[0].resolutions), before3, '[아니오]면 결의를 건드리지 않음');
      assert.deepEqual(s3.approvalFor, [exp2.결의번호]);
      ui.redo = true;
      console.log('E2E 정산 다시 넣기 아니오 OK');
    }
    if (run(4)) {
      // ---- 4) 전에 하다 만 결의(전송 안 함)와 환원이 남아 있음: 지우고 새로. 옛 채주(19일 줄 15,000)가 섞이면 안 됨 ----
      const st4 = STATE(); st4.approve[0].resolutions = [
        { 순번: '1', 결의일자: today(), 결의구분: '지출결의서', 집행용도: '출장신청 및 출장경비 사전품의', 결의번호: '', budgets: [{ 결제수단: '외상', 과세구분: '기타', payees: [{ 거래처코드: '110747', 거래처명: '이정우(임직원)', 총금액: '15,000', 공급가액: '15,000', 부가세액: '0', 거래처비고: '10/19 1인 석식', 자금과목: '일반경비', 자금계획일: '2026-10-23', saved: true, files: ['x.png'], group: 26001 }] }, { 결제수단: '', 과세구분: '', payees: [] }, { 결제수단: '', 과세구분: '', payees: [] }, { 결제수단: '', 과세구분: '', payees: [] }] },
        { 순번: '2', 결의일자: today(), 결의구분: '환원', 집행용도: '', 금액: 223000, 결의번호: '' }];
      mock.setSettle(st4);
      await runner.runReport(env, report(exp1));
      const s4 = mock.getSettle(), e4 = s4.approve[0].resolutions.filter(r => r.결의구분 === '지출결의서');
      assert.equal(e4.length, 1);
      assert.deepEqual(e4[0].budgets[0].payees.map(p => [p.총금액, p.거래처비고]), [['30,000', '10/19 3인 석식']], '옛 채주가 남으면 안 됨');
      assert.equal(s4.approve[0].resolutions.filter(r => r.결의구분 === '환원').length, 1);
      assert.equal(s4.closed, 0); assert.equal((s4.alertTexts || []).length, 0, '오류 창: ' + (s4.alertTexts || []).join(' / '));
      console.log('E2E 정산 하다 만 결의 지우고 새로 OK');
    }
    if (run(5)) {
      // ---- 5) 법인카드 숙박: 결제수단 신용카드·과세, 부가세 = 합계/11 ----
      mock.setSettle(STATE());
      const card = { ...E('domestic_lodging', 66000, '10/19 숙박 1박', '2026-10-19', '', 0, 'c.png'), pay: 'card' };
      await runner.runReport(env, report([card]));
      const s5 = mock.getSettle(), e5 = s5.approve[0].resolutions.find(r => r.결의구분 === '지출결의서');
      assert.deepEqual([e5.budgets[2].결제수단, e5.budgets[2].과세구분], ['신용카드', '과세']);
      assert.deepEqual(e5.budgets[2].payees.map(p => [p.공급가액, p.부가세액, p.총금액]), [['60,000', '6,000', '66,000']]);
      console.log('E2E 정산 법인카드 부가세 OK');
    }
    if (run(6)) {
      // ---- 6) 백그라운드 환원 점검: 전송됐는데 환원이 빠진 결의 → [환원]만. 사람에게 '다시 넣을까요' 를 절대 묻지 않음 (2026-10-22 실제로 물었던 버그) ----
      const st6 = STATE(); const sentNo = `${today().replace(/-/g, '')}-00099`;
      st6.approve[0].resolutions = [{ 순번: '1', 결의일자: today(), 결의구분: '지출결의서', 집행용도: '출장신청 및 출장경비 사전품의', 결의번호: sentNo, budgets: APPLY().budgets.map((b, i) => ({ 결제수단: '외상', 과세구분: '기타', payees: i === 2 ? [{ 거래처코드: '110747', 거래처명: '이정우(임직원)', 총금액: '70,000', 공급가액: '70,000', 부가세액: '0', 거래처비고: '10/19 숙박 1박', saved: true }] : [] })) }];
      st6.resList = [{ 결의연월: today().slice(0, 7), 결의일: String(Number(today().slice(8))), 순번: '50', 결의구분: '지출결의서', 집행용도: '출장신청 및 출장경비 사전품의', 총금액: '70,000', 결재상태: '결재중', 결의번호: sentNo }];
      mock.setSettle(st6);
      const rec6 = store.load('t1'); rec6.resolutionNo = sentNo; delete rec6.refundChecked; store.save('t1', rec6);
      asked.length = 0; const conf = ui.confirm; ui.confirm = async t => { throw new Error('환원 점검이 사람에게 물음: ' + t); };
      await runner.runRefundCheck(env);
      ui.confirm = conf;
      const s6 = mock.getSettle();
      assert.equal(s6.approve[0].resolutions.filter(r => r.결의구분 === '환원').length, 1, '환원 줄이 생겨야 함');
      assert.equal(s6.approve[0].resolutions.find(r => r.결의구분 === '지출결의서').결의번호, sentNo, '전송된 결의는 그대로');
      assert.ok(store.load('t1').refundChecked, '점검 완료 표시');
      console.log('E2E 환원 점검 (묻지 않음) OK');
    }
    if (run(7)) {
      // ---- 7) 앱이 만든 품의(날짜 없는 예산 줄 하나씩): 3일 식대(같은 날 묶음) · 택시 2번 같은 금액 · 숙박 2장 · 식대 한도 초과 ----
      const st7 = STATE({ ...(process.env.E2E_VIEWPORT ? { payViewport: Number(process.env.E2E_VIEWPORT) } : {}), ...(process.env.E2E_ROWS ? { payRows: Number(process.env.E2E_ROWS) } : {}) }); st7.approve[0].budgets = [
        { 부서: '매니퓰레이터 사업부', 예산과목: '여비교통비(판)_국내교통비', 예산과목비고: '출장 대중교통비 (왕복)', 품의금액: '50,000' },
        { 부서: '매니퓰레이터 사업부', 예산과목: '여비교통비(판)_국내숙박비', 예산과목비고: '출장 숙박비 (2박 × 70,000원)', 품의금액: '140,000' },
        { 부서: '매니퓰레이터 사업부', 예산과목: '여비교통비(판)_식대', 예산과목비고: '출장 식대 (아침 2회, 점심 3회, 저녁 2회)', 품의금액: '60,000' }];
      mock.setSettle(st7); asked.length = 0;
      const exp7 = [E('domestic_transport', 8000, '10/19 택시', '2026-10-19', '', 0, 't1.png'), E('domestic_transport', 8000, '10/19 택시', '2026-10-19', '', 0, 't2.png'),
        E('domestic_lodging', 70000, '10/19 숙박 1박', '2026-10-19', '', 0, 'l1.png'), E('domestic_lodging', 70000, '10/20 숙박 1박', '2026-10-20', '', 0, 'l2.png'),
        E('meal', 15000, '10/19 1인 석식', '2026-10-19', '석식', 1, 'm1.png'), E('meal', 8000, '10/20 1인 조식', '2026-10-20', '조식', 1, 'm2.png'), E('meal', 15000, '10/20 1인 중식', '2026-10-20', '중식', 1, 'm3.png'),
        E('meal', 15000, '10/20 1인 석식', '2026-10-20', '석식', 1, 'm4.png'), E('meal', 8000, '10/21 1인 조식', '2026-10-21', '조식', 1, 'm5.png'), E('meal', 15000, '10/21 1인 중식', '2026-10-21', '중식', 1, 'm6.png')];
      await runner.runReport(env, report(exp7));
      const s7 = mock.getSettle(), e7 = s7.approve[0].resolutions.find(r => r.결의구분 === '지출결의서');
      const P7 = bi => e7.budgets[bi].payees.map(p => [p.총금액, p.거래처비고, (p.files || []).length]);
      assert.deepEqual(P7(0), [['8,000', '10/19 택시', 1], ['8,000', '10/19 택시 (2)', 1]], '같은 택시 두 번은 (2) 로 둘 다');
      assert.deepEqual(P7(1), [['70,000', '10/19 숙박 1박', 1], ['70,000', '10/20 숙박 1박', 1]]);
      assert.deepEqual(P7(2), [['15,000', '10/19 1인 석식', 1], ['38,000', '10/20 1인 조식·중식·석식 3건', 3], ['7,000', '10/21 1인 조식·중식 2건', 2]], '식대 한도 60,000: 앞 날짜부터, 넘는 건 깎음');
      assert.equal(s7.approve[0].resolutions.find(r => r.결의구분 === '환원').금액, 50000 - 16000, '교통비 남은 것만 환원');
      assert.equal(s7.closed, 0); assert.equal((s7.alertTexts || []).length, 0, '오류 창: ' + (s7.alertTexts || []).join(' / '));
      console.log('E2E 정산 여러 장(묶음·중복 택시·한도 초과) OK');
    }
    if (run(8)) {
      // ---- 8) 채주내역이 가로로 잘리는 화면(실제처럼): 거래처비고·자금과목·자금계획일·첨부파일은 옮겨야 보임, 첨부 뒤엔 오른쪽 끝에 멈춰 키가 안 먹음 ----
      mock.setSettle(STATE({ payViewport: 640 })); asked.length = 0;
      await runner.runReport(env, report(exp1));
      const s8 = mock.getSettle(), e8 = s8.approve[0].resolutions.find(r => r.결의구분 === '지출결의서');
      assert.ok(e8 && e8.결의번호, '전송');
      assert.deepEqual(e8.budgets.slice(0, 3).map(b => b.payees.map(p => [p.총금액, p.거래처비고, p.자금과목, p.자금계획일, (p.files || []).length])),
        [[['30,000', '10/19 3인 석식', '일반경비', e8.budgets[0].payees[0].자금계획일, 1]], [['36,900', '10/20 1인 조식·중식·석식 3건', '일반경비', e8.budgets[1].payees[0].자금계획일, 3]], [['70,000', '10/19 숙박 1박', '일반경비', e8.budgets[2].payees[0].자금계획일, 1]]]);
      assert.ok(e8.budgets.slice(0, 3).every(b => /^\d{4}-\d{2}-\d{2}$/.test(b.payees[0].자금계획일)), '자금계획일');
      assert.equal(s8.closed, 0); assert.equal((s8.alertTexts || []).length, 0, '오류 창: ' + (s8.alertTexts || []).join(' / '));
      console.log('E2E 정산 가로로 잘린 채주 그리드 OK');
    }

    if (run(9)) {
      // ---- 9) 지난달에 신청한 품의: 품의서승인 목록 기본(이번 달)엔 안 보임 → 품의일자를 그 달 1일로 바꿔 조회 ----
      const st9 = STATE(); Object.assign(st9.approve[0], { key: '2026-09|28|7', 품의연월: '2026-09', 품의일: '28', 순번: '7' });
      mock.setSettle(st9); asked.length = 0;
      const rec9 = store.load('t1'); const keep = rec9.gwApply; rec9.gwApply = { key: '2026-09|28|7', ym: '2026-09', day: '28', seq: '7' }; store.save('t1', rec9);
      await runner.runReport(env, report(exp1));
      const r9 = store.load('t1'); r9.gwApply = keep; store.save('t1', r9);
      const s9 = mock.getSettle(), e9 = s9.approve[0].resolutions.find(r => r.결의구분 === '지출결의서');
      assert.ok(e9 && e9.결의번호, '지난달 품의도 정산·전송');
      assert.equal(s9.closed, 0); assert.equal((s9.alertTexts || []).length, 0, '오류 창: ' + (s9.alertTexts || []).join(' / '));
      console.log('E2E 정산 지난달 품의 OK');
    }

    if (run(10)) {
      // ---- 10) 신청이 아직 결재 중: 정산하지 않고 알기 쉬운 말로 멈춤. 경비 0원(전액 환원)도 따로 ----
      const st10 = STATE(); Object.assign(st10.approve[0], { 결재상태: '결재진행', 진행상태: '품의대기' });
      mock.setSettle(st10);
      await assert.rejects(() => runner.runReport(env, report(exp1)), /승인완료돼야/);
      assert.equal(mock.getSettle().approve[0].resolutions.length, 0, '결의를 만들면 안 됨');
      mock.setSettle(STATE()); asked.length = 0;
      await runner.runReport(env, report([]));
      const s10 = mock.getSettle(), rs = s10.approve[0].resolutions;
      assert.equal(rs.find(r => r.결의구분 === '환원').금액, 238000, '쓴 돈이 없으면 전액 환원');
      assert.equal((s10.alertTexts || []).length, 0, '오류 창: ' + (s10.alertTexts || []).join(' / '));
      console.log('E2E 정산 결재 중 신청·전액 환원 OK');
    }

  } catch (e) {
    code = 1; console.error('E2E 정산 실패:', e.stack || e);
    try { const w = BrowserWindow.getAllWindows().find(x => /127\.0\.0\.1/.test(x.webContents.getURL()));   // 화면 상태 (칸 위치·맨 위 요소)
      if (w) fs.writeFileSync(path.join(os.tmpdir(), 'e2e-settle-fail.png'), (await w.webContents.capturePage()).toPNG());
      if (w) console.error(await w.webContents.executeJavaScript(`(() => { const g = document.querySelector('#pay'); if (!g) return 'no pay grid'; const td = g.querySelector('td[data-c=첨부파일]'); const b = td && td.getBoundingClientRect(); const top = b && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        const hb = [...document.querySelectorAll('button')].filter(x => x.textContent.replace(/\\s/g, '') === '환원').pop(); const hr = hb && hb.getBoundingClientRect(); const ht = hr && document.elementFromPoint(hr.left + hr.width / 2, hr.top + hr.height / 2);
        return JSON.stringify({ win: [innerWidth, innerHeight], scroll: [scrollX, scrollY], rect: b && [b.left, b.top, b.width, b.height], top: top && (top.className || top.tagName), refundBtn: hr && [hr.left, hr.top, hr.width, hr.height], refundTop: ht && ht.textContent }); })()`)); } catch (x) { /* */ }
    try { const s = mock.getSettle(); console.error(JSON.stringify({ buttons: s.buttons, closed: s.closed, alerts: s.alertTexts, res: s.approve[0].resolutions.map(r => [r.결의구분, r.결의번호, (r.budgets || []).map(b => b.payees.length)]) })); } catch (x) { /* */ }
  } finally { srv.close(); app.exit(code); }
});
setTimeout(() => { console.error('E2E 정산 시간 초과'); process.exit(3); }, 1200000);
