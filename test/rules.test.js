'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/engine/rules');

test('로/으로', () => {
  assert.equal(R.ro('회의'), '회의로');
  assert.equal(R.ro('FCC인증'), 'FCC인증으로');
  assert.equal(R.ro('설치'), '설치로');
  assert.equal(R.ro('판교 출장 지원'), '판교 출장 지원으로');
  assert.equal(R.ro('검증'), '검증으로');
  assert.equal(R.ro('전시회 참관'), '전시회 참관으로');
  assert.equal(R.ro('세미나 발표'), '세미나 발표로');
  assert.equal(R.ro('행사 3'), '행사 3으로');
  assert.equal(R.ro('RBY1'), 'RBY1로');
  assert.equal(R.ro('PyFM'), 'PyFM으로');
  assert.equal(R.ro('물'), '물로');
});

test('제목 형식', () => {
  assert.equal(R.applyTitle('SIMTOS 전시회 참관'), '[출장신청 및 출장경비 사전품의] SIMTOS 전시회 참관으로 인한 출장의 건');
  assert.equal(R.reportTitle('고객사 미팅'), '[출장보고서 및 정산 품의서] 고객사 미팅으로 인한 출장 보고의 건');
});

test('네이버 지도 금액 읽기 / 왕복', () => {
  const car = R.parseCarText('1시간 39분 | 131km\n택시비 168,820원 | 통행료 7,100원 | 연료비 30,307원');
  assert.deepEqual(car, { fuel: 30307, toll: 7100 });
  assert.equal(R.roundTrip(car.fuel + car.toll), 74814);
  assert.equal(R.parseCarText('통행료 없음'), null);
  assert.equal(R.parseTransitText('총 요금 16,050원'), 16050);
});

test('신청서 검증과 기본 적요', () => {
  const a = R.parseApply({ reason: '판교 출장', destination: '판교', dates: { start: '2026-10-20', end: '2026-10-22', start_time: '09:00', end_time: '18:00' },
    transport: { mode: 'car', to: '판교' }, purpose: '목적', expenses: [{ item: 'meal', amount: '90,000원' }] });
  assert.equal(a.period, '2026.10.20 - 2026.10.22');
  assert.equal(a.expenses[0].amount, 90000);
  assert.equal(a.expenses[0].memo, '출장 식대');
  assert.equal(a.expenses[0].code, '8120004');
  assert.deepEqual(a.transport.check, ['자차']);
  assert.throws(() => R.parseApply({ ...a, dates: { start: '2026-10-22', end: '2026-10-20' } }), R.InputError);
  assert.throws(() => R.parseApply({ reason: 'x', destination: 'y', dates: { start: '2026-10-20', end: '2026-10-20', start_time: '09:00', end_time: '18:00' }, transport: { mode: 'car' }, purpose: 'p' }), /도착지/);
  assert.throws(() => R.parseApply({ reason: 'x', destination: 'y', dates: { start: '2026-10-20', end: '2026-10-20' }, transport: { mode: 'car', to: 'z' }, purpose: 'p' }), /시각은 필수/);
  assert.throws(() => R.parseApply({ reason: 'x', destination: 'y', dates: { start: '2026-10-20', end: '2026-10-20', start_time: '09:00', end_time: '18:00' }, transport: { mode: 'car', to: 'z' }, purpose: 'p',
    expenses: [{ item: 'domestic_transport', amount: 1 }] }), /국내교통비/);
});

test('AI 답변에서 YAML 꺼내기 (날짜는 문자열로)', () => {
  const d = R.extractYaml('네!\n```yaml\nreason: 회의\ndates: {start: 2026-10-20, end: 2026-10-21}\n```\n끝');
  assert.equal(d.reason, '회의');
  assert.equal(d.dates.start, '2026-10-20');
  assert.throws(() => R.extractYaml('그냥 문장'), R.InputError);
});

test('보고서: 정부과제는 과제명 필수', () => {
  const base = { reason: 'r', name: 'n', period: 'p', destination: 'd', purpose: 'p', report: 'r', schedule: [{ date: '10/20', place: 'x', detail: '점검' }], expenses: [{ item: 'meal', amount: 1000, proofs: ['/tmp/영수증.jpg'] }] };
  assert.throws(() => R.parseReport({ ...base, category: '정부과제' }), /과제명/);
  assert.equal(R.parseReport({ ...base, category: '로봇' }).category, '로봇');
  assert.throws(() => R.parseReport({ ...base, schedule: [{ date: '10/20', place: 'x', detail: '' }] }), /세부 활동/);   // 세부 활동 내용 필수
  assert.throws(() => R.parseReport({ ...base, expenses: [] }), /경비/);                                              // 경비 필수
  assert.throws(() => R.parseReport({ ...base, expenses: [{ item: 'meal', amount: 1000 }] }), /증빙/);                 // 줄마다 증빙 필수
  assert.throws(() => R.parseReport({ ...base, expenses: [{ item: 'meal', amount: 1000, proofs: ['/tmp/a.docx'] }] }), /이미지나 PDF/);
  assert.deepEqual(R.parseReport({ ...base, category: '로봇' }).attachments, ['/tmp/영수증.jpg']);                    // 증빙은 보고서 첨부로
});

const Q = require('../src/engine/quick');
const AI = require('../src/engine/ai');
const TODAY = new Date(2026, 9, 15); // 2026-10-15 목
const PLACES = require('../src/engine/store').PRESET_PLACES;

test('날짜 말 해석', () => {
  const d = s => { const r = Q.parseDates(s, TODAY); return [r.start, r.end]; };
  assert.deepEqual(d('다음주 화~목'), ['2026-10-20', '2026-10-22']);
  assert.deepEqual(d('이번주 금'), ['2026-10-16', '2026-10-16']);
  assert.deepEqual(d('10/28~30'), ['2026-10-28', '2026-10-30']);
  assert.deepEqual(d('10/30~11/2'), ['2026-10-30', '2026-11-02']);
  assert.deepEqual(d('11월 3일부터 2박3일'), ['2026-11-03', '2026-11-05']);
  assert.deepEqual(d('내일 당일'), ['2026-10-16', '2026-10-16']);
  assert.deepEqual(d('1/5~7'), ['2027-01-05', '2027-01-07']);
});

test('규정 경비: 숙박 7만/박, 식대 3.8만/일 (판교 4박5일 = 28만 + 19만)', () => {
  const e = Q.computeExpenses({ start: '2026-09-28', end: '2026-10-02', reason: '판교', rates: Q.DEFAULT_RATES }).expenses;
  assert.deepEqual(e.map(x => [x.item, x.amount]), [['domestic_lodging', 280000], ['meal', 190000]]);
  const day = Q.computeExpenses({ start: '2026-10-16', end: '2026-10-16', reason: 'x', rates: Q.DEFAULT_RATES }).expenses;
  assert.deepEqual(day.map(x => [x.item, x.amount]), [['meal', 38000]]);
});

test('한 줄 메모 → 신청서', () => {
  const { data, missing } = Q.quickApply('다음주 화~목 판교 RBY1 Muscat 연동 검증, 자차, 홍길동이랑 같이', { today: TODAY, places: PLACES, rates: Q.DEFAULT_RATES, origin: '세종' });
  assert.equal(data.reason, 'RBY1 Muscat 연동 검증');
  assert.equal(data.destination, '레인보우로보틱스 판교 AI 사무소');
  assert.deepEqual(data.companions, ['홍길동']);
  assert.equal(data.transport.mode, 'car');
  assert.deepEqual(missing, ['출발 시각', '복귀 시각']);
  assert.equal(data.purpose, '레인보우로보틱스 판교 AI 사무소에서 RBY1 Muscat 연동 검증을 수행하기 위해 홍길동과 함께 출장을 신청합니다.');
  const r2 = Q.quickApply('11월 3일부터 2박3일 KINTEX 로봇 전시회 참관 법인차 스타렉스', { today: TODAY, places: PLACES });
  assert.equal(r2.data.destination, '킨텍스');
  assert.equal(r2.data.reason, '로봇 전시회 참관');
  assert.equal(r2.data.transport.corporate_car, '스타렉스');
  assert.ok(Q.quickApply('판교 미팅', { today: TODAY, places: PLACES }).missing.includes('날짜'));
  // 신청서 검증까지 통과해야 함
  assert.equal(R.parseApply({ ...data, dates: { ...data.dates, start_time: '09:00', end_time: '18:00' }, transport: { ...data.transport, total: 74814 } }).expenses.length, 2);
  // 연도·장소·'하러 감'이 섞인 메모
  const r3 = Q.quickApply('2026년 10월 15일부터 19일까지\n판교에 레인보우로보틱스 판교 사무소에 RBY1에 Muscat 연동하러 감 오전 9시 출발 18시 복귀', { today: TODAY, places: PLACES });
  assert.deepEqual(r3.data.dates, { start: '2026-10-15', end: '2026-10-19', start_time: '09:00', end_time: '18:00' });
  assert.equal(r3.data.reason, 'RBY1 Muscat 연동');
  assert.deepEqual(Q.parseTimes('아침에 출발해서 저녁에 복귀'), { startTime: '08:00', endTime: '19:00' });
});

test('AI 결과 병합: 출장지 이름은 기존 목록으로, 금액은 규칙으로', () => {
  const base = Q.quickApply('다음주 화~목 판교 검증', { today: TODAY, places: PLACES }).data;
  const m = Q.mergeAi(base, { reason: 'RBY1-Muscat 연동 검증', destination: '판교 AI 사무소', dates: { start: '2026-10-20', end: '2026-10-22' }, purpose: 'AI 문장', transport: { mode: 'transit' } }, PLACES, { defaultOrigin: '세종' });
  assert.equal(m.destination, '레인보우로보틱스 판교 AI 사무소');
  assert.equal(m.transport.to, '텔레칩스 판교사옥');   // 지도 검색어는 네이버에 등록된 이름
  assert.equal(m.transport.mode, 'transit');
  assert.equal(m.transport.from, '세종');
  assert.equal(m.purpose, 'AI 문장');
});

test('AI 호출 형식 (Claude / OpenAI / Gemini)', async () => {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opt) => {
    calls.push({ url, headers: opt.headers, body: JSON.parse(opt.body) });
    const yamlText = '```yaml\nreason: 테스트\n```';
    const body = url.includes('anthropic') ? { content: [{ type: 'text', text: yamlText }] }
      : url.includes('openai') ? { choices: [{ message: { content: yamlText } }] }
      : { candidates: [{ content: { parts: [{ text: yamlText }] } }] };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    for (const provider of ['anthropic', 'openai', 'gemini']) {
      const d = await AI.draftApply({ provider, key: 'k', model: '' }, '다음주 판교', { places: PLACES, today: TODAY });
      assert.equal(d.reason, '테스트');
    }
    assert.equal(calls[0].headers['x-api-key'], 'k');
    assert.equal(calls[0].body.model, 'claude-haiku-5-5');
    assert.ok(calls[0].body.messages[0].content.includes('2026-10-15 (목요일)'));
    assert.ok(calls[0].body.messages[0].content.includes('expenses 는 쓰지 마'));
    assert.equal(calls[1].headers.authorization, 'Bearer k');
    assert.equal(calls[2].headers['x-goog-api-key'], 'k');
  } finally { global.fetch = orig; }
});

test('시각 기준 식대: 저녁 출발이면 첫날 아침·점심 없음', () => {
  const c = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-22', startTime: '19:00', endTime: '15:00', reason: 'r' });
  assert.equal(c.summary, '10/20 없음 · 10/21 아침·점심·저녁 · 10/22 아침·점심');
  assert.deepEqual(c.expenses.map(e => e.amount), [140000, 8000 * 2 + 15000 * 2 + 15000]);
  const e17 = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-21', startTime: '17:30', endTime: '12:30', reason: 'r' });
  assert.equal(e17.summary, '10/20 저녁 · 10/21 아침');
  const one = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-20', startTime: '09:00', endTime: '18:30', reason: 'r' });
  assert.equal(one.summary, '10/20 점심');
  const early = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-20', startTime: '06:30', endTime: '20:00', reason: 'r' });
  assert.equal(early.summary, '10/20 아침·점심·저녁');
});

test('시각 말 해석', () => {
  assert.deepEqual(Q.parseTimes('화 19시 출발 ~ 목 15시 복귀'), { startTime: '19:00', endTime: '15:00' });
  assert.deepEqual(Q.parseTimes('저녁에 출발 목 오후 3시 복귀'), { startTime: '19:00', endTime: '15:00' });
  assert.deepEqual(Q.parseTimes('점심 먹고 출발'), { startTime: '13:00', endTime: '' });
  assert.deepEqual(Q.parseTimes('화 19:30~목 3시'), { startTime: '19:30', endTime: '15:00' });
  const q = Q.quickApply('다음주 화 저녁에 출발 목 3시 복귀 판교 RBY1 연동 검증 자차', { today: TODAY, places: PLACES });
  assert.deepEqual(q.data.dates, { start: '2026-10-20', end: '2026-10-22', start_time: '19:00', end_time: '15:00' });
  assert.equal(q.data.reason, 'RBY1 연동 검증');
  assert.deepEqual(q.data.expenses.map(e => e.amount), [140000, 61000]);
  assert.equal(Q.parseDates('다음주 월 목적지 판교', TODAY).end, '2026-10-19');   // '목적지'는 목요일 아님
  const a = R.parseApply({ ...q.data, transport: { ...q.data.transport, total: 1 }, purpose: 'p' });
  assert.equal(a.start_time, '19:00');
  assert.throws(() => R.parseApply({ ...q.data, dates: { start: '2026-10-20', end: '2026-10-20', start_time: '19:00', end_time: '09:00' }, transport: { mode: 'car', total: 1 }, purpose: 'p' }), /복귀 시각/);
});

test('월 없는 날짜·조사 정리 (16일날, 16~18일, 정비를)', () => {
  const Qk = require('../src/engine/quick');
  const ctx = { today: new Date('2026-10-15T10:00'), places: [{ name: '레인보우로보틱스 판교 AI 사무소', aliases: ['판교'] }], rates: { lodgingPerNight: 70000, breakfast: 8000, lunch: 15000, dinner: 15000 } };
  const q = m => Qk.quickApply(m, ctx).data;
  let d = q('16일날 판교 RBY1 정비를 하러 감 9시 출발 18시 복귀');
  assert.deepEqual([d.dates.start, d.dates.end, d.reason], ['2026-10-16', '2026-10-16', 'RBY1 정비']);
  d = q('16~18일 판교 RBY1 정비 9시 출발 18시 복귀');
  assert.deepEqual([d.dates.start, d.dates.end], ['2026-10-16', '2026-10-18']);
  d = q('3일 판교 미팅 9시 출발 18시 복귀');
  assert.equal(d.dates.start, '2026-11-03');
  d = q('판교 정비 1박2일 내일 9시 출발 18시 복귀');
  assert.deepEqual([d.dates.start, d.dates.end, d.reason], ['2026-10-16', '2026-10-17', '정비']);
});

test('품의 삭제 가능 여부 (결재상태)', () => {
  const { Amaranth } = require('../src/engine/gw');
  for (const t of ['상신대기', '작성', '보관', '반려', '']) assert.equal(Amaranth.locked(t), false, t);
  for (const t of ['결재중', '진행중', '결재완료', '승인', '종결']) assert.equal(Amaranth.locked(t), true, t);
});

test('신청 직전 교통비 필수 (자차·대중교통)', () => {
  const { planApply } = require('../src/engine/runner');
  const base = { reason: 'x', destination: 'y', dates: { start: '2026-10-20', end: '2026-10-20', start_time: '09:00', end_time: '18:00' }, purpose: 'p' };
  assert.throws(() => planApply({ ...base, transport: { mode: 'car', to: '판교' } }, { budgetDept: 'x' }), /교통비는 필수/);
  assert.throws(() => planApply({ ...base, transport: { mode: 'transit', to: '판교', total: 0 } }, { budgetDept: 'x' }), /교통비는 필수/);
  assert.ok(planApply({ ...base, transport: { mode: 'car', to: '판교', total: 74814 } }, { budgetDept: 'x' }).transport.total === 74814);
  assert.ok(planApply({ ...base, transport: { mode: 'corporate' } }, { budgetDept: 'x' }));
});

test('품의 적요', () => {
  assert.equal(R.budgetMemo(R.applyTitle('RBY1 정비')), 'RBY1 정비로 인한 출장');
  assert.equal(R.budgetMemo(R.reportTitle('FCC인증')), 'FCC인증으로 인한 출장 보고');
});

test('한 줄: "9시부터 가서 … 복귀"', () => {
  const Q = require('../src/engine/quick');
  const r = Q.quickApply('다음주 화~목 아침 9시부터 가서 오후 6시에 복귀 레인보우로보틱스 판교 사무소로 RBY1 정비를 위해 출장', { today: new Date('2026-10-15'), places: require('../src/engine/store').PRESET_PLACES });
  assert.equal(r.data.dates.start_time, '09:00');
  assert.equal(r.data.dates.end_time, '18:00');
  assert.equal(r.data.reason, 'RBY1 정비');
});

test('네이버 대중교통: 총 요금 줄이 없으면 첫 경로 구간 요금 합', () => {
  assert.equal(R.parseTransitText('최적\n1시간59분\n세종\nB4\n33분\nKTX-산천\n30분10,700원\n6003\n44분3,200원\n상세보기\n최소시간\n30분10,700원\n상세보기'), 13900);
  assert.equal(R.parseTransitText('총 요금 4,500원'), 4500);
  assert.equal(R.parseTransitText('경로 없음'), null);
});

test('연구과제는 과제명 필수', () => {
  const base = { reason: 'x', destination: 'y', dates: { start: '2026-10-20', end: '2026-10-20', start_time: '09:00', end_time: '18:00' }, purpose: 'p', transport: { mode: 'car', to: 'z', total: 1000 } };
  assert.throws(() => R.parseApply({ ...base, category: '연구과제' }), /과제명/);
  assert.equal(R.parseApply({ ...base, category: '연구과제', project: 'RBY1 과제' }).project, 'RBY1 과제');
});

test('예산 부서 없으면 신청 막기', () => {
  const { planApply } = require('../src/engine/runner');
  const base = { reason: 'x', destination: 'y', dates: { start: '2026-10-20', end: '2026-10-20', start_time: '09:00', end_time: '18:00' }, purpose: 'p', transport: { mode: 'corporate' } };
  assert.throws(() => planApply(base, {}), /예산 부서/);
});
