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
  assert.equal(R.reportTitle('고객사 미팅'), '[출장보고서 및 경비정산 지출결의서] 고객사 미팅 출장 보고의 건');
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
  const base = { reason: 'r', name: 'n', fund: '일반경비', period: 'p', destination: 'd', purpose: 'p', report: 'r', schedule: [{ date: '10/20', place: 'x', detail: '점검' }], expenses: [{ item: 'meal', amount: 1000, proofs: ['/tmp/영수증.jpg'] }] };
  assert.throws(() => R.parseReport({ ...base, category: '정부과제' }), /과제명/);
  assert.equal(R.parseReport({ ...base, category: '로봇' }).category, '로봇');
  assert.throws(() => R.parseReport({ ...base, schedule: [{ date: '10/20', place: 'x', detail: '' }] }), /세부 활동/);   // 세부 활동 내용 필수
  assert.equal(R.parseReport({ ...base, expenses: [] }).expenses.length, 0);                                            // 정산할 경비가 없어도 됨 (전액 환원)
  assert.equal(R.parseReport({ ...base, expenses: [{ item: 'meal', amount: 1000 }] }).expenses[0].proofs.length, 0);   // 증빙 없이도 됨 (화면에서 두 번 확인)
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

test('규정 경비 (별첨 1): 숙박 7만/박, 첫날 중·석 · 중간 조·중·석 · 마지막 날 조·중, 당일은 중식', () => {
  const e = Q.computeExpenses({ start: '2026-09-28', end: '2026-10-02', reason: '판교', rates: Q.DEFAULT_RATES }).expenses;
  assert.deepEqual(e.map(x => [x.item, x.amount]), [['domestic_lodging', 280000], ['meal', 30000 + 38000 * 3 + 23000]]);   // 4박 5일
  const day = Q.computeExpenses({ start: '2026-10-16', end: '2026-10-16', reason: 'x', rates: Q.DEFAULT_RATES }).expenses;
  assert.deepEqual(day.map(x => [x.item, x.amount]), [['meal', 15000]]);
  const ex = Q.computeExpenses({ start: '2026-09-28', end: '2026-09-29', reason: 'x', rates: Q.DEFAULT_RATES, rank: 'exec' }).expenses;   // 임원 숙박 35만
  assert.equal(ex[0].amount, 350000);
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

test('시각 기준 식대 (규정): 13시 이후 출발이면 중식 없음, 당일 7시 전 출발이면 조식, 20시 넘어 복귀하면 석식', () => {
  const c = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-22', startTime: '19:00', endTime: '15:00', reason: 'r' });
  assert.equal(c.summary, '10/20 저녁 · 10/21 아침·점심·저녁 · 10/22 아침·점심');
  assert.deepEqual(c.expenses.map(e => e.amount), [140000, 15000 + 38000 + 23000]);
  const e17 = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-21', startTime: '17:30', endTime: '12:30', reason: 'r' });
  assert.equal(e17.summary, '10/20 저녁 · 10/21 아침·점심');
  const one = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-20', startTime: '09:00', endTime: '18:30', reason: 'r' });
  assert.equal(one.summary, '10/20 점심');
  const early = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-20', startTime: '06:30', endTime: '20:00', reason: 'r' });
  assert.equal(early.summary, '10/20 아침·점심');                       // 20시 정각 복귀는 '초과' 아님
  const late = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-20', startTime: '06:30', endTime: '20:30', reason: 'r' });
  assert.equal(late.summary, '10/20 아침·점심·저녁');
  const pm = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-20', startTime: '13:30', endTime: '18:00', reason: 'r' });
  assert.equal(pm.expenses.length, 0);                                   // 13시 이후 출발 당일: 식대 없음
  const back = Q.computeExpenses({ start: '2026-10-20', end: '2026-10-21', startTime: '09:00', endTime: '21:00', reason: 'r' });
  assert.equal(back.summary, '10/20 점심·저녁 · 10/21 아침·점심·저녁');   // 마지막 날도 20시 넘어 복귀하면 석식
});

test('시각 말 해석', () => {
  assert.deepEqual(Q.parseTimes('화 19시 출발 ~ 목 15시 복귀'), { startTime: '19:00', endTime: '15:00' });
  assert.deepEqual(Q.parseTimes('저녁에 출발 목 오후 3시 복귀'), { startTime: '19:00', endTime: '15:00' });
  assert.deepEqual(Q.parseTimes('점심 먹고 출발'), { startTime: '13:00', endTime: '' });
  assert.deepEqual(Q.parseTimes('화 19:30~목 3시'), { startTime: '19:30', endTime: '15:00' });
  const q = Q.quickApply('다음주 화 저녁에 출발 목 3시 복귀 판교 RBY1 연동 검증 자차', { today: TODAY, places: PLACES });
  assert.deepEqual(q.data.dates, { start: '2026-10-20', end: '2026-10-22', start_time: '19:00', end_time: '15:00' });
  assert.equal(q.data.reason, 'RBY1 연동 검증');
  assert.deepEqual(q.data.expenses.map(e => e.amount), [140000, 15000 + 38000 + 23000]);   // 19시 출발: 첫날 석식만 (규정)
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
  assert.ok(planApply({ ...base, transport: { mode: 'transit', to: '판교', total: 0 } }, { budgetDept: 'x' }));   // 0원도 입력으로 인정
  assert.ok(planApply({ ...base, transport: { mode: 'car', to: '판교', total: 74814 } }, { budgetDept: 'x' }).transport.total === 74814);
  assert.ok(planApply({ ...base, transport: { mode: 'corporate' }, expenses: [{ item: 'meal', amount: 9000 }] }, { budgetDept: 'x' }));
});

test('품의 적요', () => {
  assert.equal(R.budgetMemo(R.applyTitle('RBY1 정비')), 'RBY1 정비로 인한 출장');
  assert.equal(R.budgetMemo(R.reportTitle('FCC인증')), 'FCC인증 출장 보고');
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

test('신청 교통비 여유분: 자차·대중교통만 +2만원', () => {
  const t = mode => ({ transport: { mode } });
  assert.equal(R.transportExpense(t('car'), 54528, 20000).amount, 74528);
  assert.match(R.transportExpense(t('car'), 54528, 20000).memo, /여유 20,000원/);
  assert.equal(R.transportExpense(t('transit'), 37000, 20000).amount, 57000);
  assert.equal(R.transportExpense(t('corporate'), 0, 20000).amount, 0);
  assert.equal(R.transportExpense(t('car'), 54528).amount, 54528);
});

test('동행자가 있으면 동행목적 필수', () => {
  const base = { reason: 'x', destination: 'y', dates: { start: '2026-10-20', end: '2026-10-20', start_time: '09:00', end_time: '18:00' }, purpose: 'p', transport: { mode: 'car', to: 'z', total: 1000 } };
  assert.throws(() => R.parseApply({ ...base, companions: ['홍길동'] }), /동행목적/);
  assert.equal(R.parseApply({ ...base, companions: ['홍길동'], companion_purpose: '셋업 지원' }).companion_purpose, '셋업 지원');
  assert.equal(R.parseApply(base).companions.length, 0);   // 동행자 없으면 비워도 됨
});

test('네이버 지도 장소 → 출장지 이름·주소', () => {
  const { parsePlace } = require('../src/engine/naver');
  assert.deepEqual(parsePlace('장소\n항공기제조업\n한국항공우주산업\n경남 사천시 사남면 공단1로 78 한국항공우주산업'), { name: '한국항공우주산업', address: '경남 사천시 사남면 공단1로 78' });
  assert.deepEqual(parsePlace('장소\n기업,빌딩\n텔레칩스 판교사옥\n경기 성남시 수정구 금토로80번길 27'), { name: '텔레칩스 판교사옥', address: '경기 성남시 수정구 금토로80번길 27' });
  assert.equal(parsePlace('검색어\n판교 텔레칩스'), null);
});

test('교통비·경비 0원 허용, 비운 교통비만 막음', () => {
  const { planApply } = require('../src/engine/runner');
  const cfg = { budgetDept: 'D', defaultOrigin: 'o' };
  const base = { reason: 'x', destination: 'y', dates: { start: '2026-10-20', end: '2026-10-20', start_time: '09:00', end_time: '18:00' }, purpose: 'p' };
  assert.ok(planApply({ ...base, transport: { mode: 'transit', to: 'z', total: 0 }, expenses: [{ item: 'meal', amount: 9000 }] }, cfg));
  assert.ok(planApply({ ...base, transport: { mode: 'transit', to: 'z', total: 0 }, expenses: [{ item: 'meal', amount: 0 }] }, cfg));   // 전부 0원도 사용자가 넣은 그대로
  assert.throws(() => planApply({ ...base, transport: { mode: 'transit', to: 'z' }, expenses: [{ item: 'meal', amount: 9000 }] }, cfg), /교통비는 필수/);
});

test('결의서전송 규칙: 자금계획일 · 공급가액', () => {
  const d = s => new Date(`${s}T09:00:00`);
  assert.equal(R.fundPlanDate('personal', { today: d('2026-10-16') }), '2026-10-20');   // 10~19일 → 20일(화)
  assert.equal(R.fundPlanDate('personal', { today: d('2026-10-05') }), '2026-10-08');   // 1~9일 → 10일(토) → 9일 한글날 → 8일(목)
  assert.equal(R.fundPlanDate('personal', { today: d('2026-10-20') }), '2026-10-23');   // 20~24일 → 25일(일) → 23일(금)
  assert.equal(R.fundPlanDate('personal', { today: d('2026-10-25') }), '2026-11-10');   // 25일~ → 다음 달 10일(화)
  assert.equal(R.fundPlanDate('personal', { today: d('2026-12-28') }), '2027-01-08');   // 2027-01-10(일) → 8일(금)
  assert.equal(R.fundPlanDate('personal', { today: d('2026-06-15') }), '2026-06-19');   // 6/20(토) → 19일(금)
  assert.equal(R.fundPlanDate('card', { today: d('2026-11-03'), usedOn: '2026-10-02' }), '2026-11-23');
  assert.equal(R.fundPlanDate('card', { today: d('2026-12-05') }), '2027-01-23');
  assert.equal(R.supplyAmount(11000, 'card'), 10000);
  assert.equal(R.supplyAmount(11000, 'personal'), 11000);
});

test('정산은 품의 금액까지만', () => {
  const l = (amount, pay = 'personal') => ({ amount, pay });
  assert.deepEqual(R.capToBudget([l(79000)], 60000).map(x => [x.supply, x.cut]), [[60000, 19000]]);
  assert.deepEqual(R.capToBudget([l(40000), l(40000), l(10000)], 60000).map(x => [x.amount, x.cut]), [[40000, 0], [20000, 20000]]);
  assert.deepEqual(R.capToBudget([l(15000)], 190000).map(x => x.supply), [15000]);
  assert.deepEqual(R.capToBudget([l(110000, 'card')], 66000).map(x => [x.amount, x.supply]), [[66000, 60000]]);   // 법인카드: 합계 66,000 = 공급 60,000 + 부가세 6,000
});

test('예산과목비고에 날짜가 있는 예산 줄: 그 날짜 영수증만, 넘쳐도 다른 날 줄로 안 넘김', () => {
  const budgets = [
    { 예산과목: '여비교통비(판)_식대', 예산과목비고: '10/19 (9시 본사 출발) 식대', 품의금액: '30,000', 미지출액: '30,000' },
    { 예산과목: '여비교통비(판)_식대', 예산과목비고: '10/20 (7시 출발 예정) 식대', 품의금액: '38,000', 미지출액: '38,000' },
    { 예산과목: '여비교통비(판)_국내숙박비', 예산과목비고: '10/19 ~ 20 숙박 예정', 품의금액: '70,000', 미지출액: '70,000' },
    { 예산과목: '여비교통비(판)_국내교통비', 예산과목비고: 'ktx, 버스이용 복귀', 품의금액: '100,000', 미지출액: '100,000' },
  ];
  const L = (label, memo, amount, date = '') => ({ label: `여비교통비(판)_${label}`, pay: 'personal', amount, supply: amount, memo, date });
  const { plan } = R.planPayees(budgets, [L('식대', '10/19 3인 석식', 42000, '2026-10-19'), L('식대', '10/20 1인 조식·중식·석식 3건', 36900, '2026-10-20'), L('국내숙박비', '10/19 숙박 1박', 70000), L('국내교통비', '출장 대중교통비 (왕복)', 45000)]);
  assert.deepEqual(plan.map(pb => pb.lines.map(l => [l.memo, l.amount, l.cut])), [
    [['10/19 3인 석식', 30000, 12000]],   // 19일 줄 한도까지, 나머지는 깎음 (20일 줄로 안 감)
    [['10/20 1인 조식·중식·석식 3건', 36900, 0]],
    [['10/19 숙박 1박', 70000, 0]],
    [['출장 대중교통비 (왕복)', 45000, 0]],   // 날짜 없는 줄엔 날짜 없는 영수증
  ]);
  // 날짜 줄 한도가 0이면 그 줄 dropped
  const z = R.planPayees([{ ...budgets[0], 미지출액: '0', 품의금액: '0' }], [L('식대', '10/19 1인 석식', 15000, '2026-10-19')]);
  assert.equal(z.plan[0].dropped, 1);
});

test('같은 과목 예산 줄이 여러 개(비고에 날짜 없음): 영수증은 한 번만, 앞 줄부터 채우고 넘치면 다음 줄로', () => {
  const budgets = [
    { 예산과목: '여비교통비(판)_식대', 품의금액: '30,000', 미지출액: '30,000' },
    { 예산과목: '여비교통비(판)_식대', 품의금액: '38,000', 미지출액: '38,000' },
    { 예산과목: '여비교통비(판)_국내숙박비', 품의금액: '70,000', 미지출액: '70,000' },
  ];
  const meal = (memo, amount) => ({ label: '여비교통비(판)_식대', pay: 'personal', amount, supply: amount, memo });
  const { plan } = R.planPayees(budgets, [meal('3인 석식', 42000), meal('1인 조식·중식·석식 3건', 36900), { label: '여비교통비(판)_국내숙박비', pay: 'personal', amount: 70000, supply: 70000, memo: '10/19 숙박 1박' }]);
  assert.deepEqual(plan.map(pb => pb.lines.map(l => [l.memo, l.amount, l.cut])), [
    [['3인 석식', 30000, 0]],
    [['3인 석식', 12000, 0], ['1인 조식·중식·석식 3건', 26000, 10900]],
    [['10/19 숙박 1박', 70000, 0]],
  ]);
  assert.equal(plan[0].lines[0].amount + plan[1].lines[0].amount, 42000);   // 두 번 청구 안 됨
  assert.deepEqual(plan.map(pb => pb.dropped), [0, 0, 0]);
  const two = R.planPayees(budgets.slice(0, 1), [meal('a', 30000), meal('b', 5000), meal('c', 0)]);   // 한도 다 쓰면 뒤 영수증은 dropped, 0원은 안 셈
  assert.deepEqual(two.plan[0].lines.map(l => l.memo), ['a']); assert.equal(two.plan[0].dropped, 1);
});

test('식대 여러 번(4일 출장): 예산 줄 하나 아래 채주 여러 줄, 한도까지', () => {
  const budgets = [
    { 예산과목: '여비교통비(판)_국내교통비', 품의금액: '60,000', 미지출액: '60,000' },
    { 예산과목: '여비교통비(판)_국내숙박비', 품의금액: '280,000', 미지출액: '280,000' },
    { 예산과목: '여비교통비(판)_식대', 품의금액: '190,000', 미지출액: '190,000' },
  ];
  const meal = (memo, amount) => ({ label: '여비교통비(판)_식대', pay: 'personal', amount, supply: amount, memo });
  const lines = [
    { label: '여비교통비(판)_국내교통비', pay: 'personal', amount: 79000, supply: 79000, memo: '10/2 주유비' },
    meal('9/27 1인 석식', 15000), meal('9/28 1인 조식', 9000), meal('9/28 1인 중식', 12000), meal('9/28 1인 석식', 18000),
    meal('9/29 1인 조식', 9000), meal('9/29 1인 중식', 11000), meal('9/29 1인 석식', 20000), meal('9/30 1인 조식', 8000),
  ];
  const { plan, left } = R.planPayees(budgets, lines);
  assert.equal(left.length, 0);
  assert.deepEqual(plan.map(x => x.lines.length), [1, 0, 8]);            // 식대 영수증 8장 → 식대 예산 줄 아래 채주 8줄
  assert.equal(plan[2].lines.reduce((s, l) => s + l.supply, 0), 102000);   // 한도 190,000 안이라 그대로
  assert.equal(plan[0].lines[0].supply, 60000);                            // 교통비는 품의 60,000 까지
  // 한도를 넘으면 뒤 영수증부터 깎이고 빠진다
  const tight = R.planPayees([{ ...budgets[2], 미지출액: '30,000' }], lines.slice(1)).plan[0];
  assert.deepEqual(tight.lines.map(l => l.supply), [15000, 9000, 6000]);
  assert.equal(tight.dropped, 5);
});

test('해외출장 사전품의: 규정·예시대로 경비 줄과 적요', () => {
  const r = R.overseasExpenses({ start: '2026-04-23', end: '2026-04-30', name: '안재용', grade: '가', rate: 1480.3, airfare: 3000000, lodging: 2800000, uberUsd: 70, roaming: 100000, insurance: 50000 });
  assert.equal(r.days, 8);
  const by = Object.fromEntries(r.expenses.map(e => [e.memo.split('해외출장 ')[1].split(/[ (]/)[0], e]));
  assert.equal(by['일비'].amount, 1065600);                     // $90 x 8일 x 1,480 (예시와 같음)
  assert.equal(by['일비'].memo, '04/23~04/30 안재용 1인 해외출장 일비 신청($90 x 8일 x 1,480) - 신청일 환율 기준');
  assert.equal(by['우버'].amount, 828800);                      // $70 x 8일 x 1,480
  assert.equal(by['항공'].item, 'airfare'); assert.equal(by['숙박'].item, 'overseas_lodging'); assert.equal(by['로밍'].item, 'travel_etc'); assert.equal(by['여행자'].item, 'travel_etc');
  // 나 등급, 숙박 견적 없음 → 일비 $50, 숙박은 한도 $150 x 박
  const n = R.overseasExpenses({ start: '2026-11-02', end: '2026-11-04', name: '김종완', grade: '나', rate: 1348.5 });
  const ex = R.overseasExpenses({ start: '2026-11-02', end: '2026-11-04', name: '김종완', grade: '가', rate: 1348.5, rank: 'exec' });   // 임원: 일비 없음, 숙박 한도 $280
  assert.deepEqual(ex.expenses.map(e => [e.item, e.amount]), [['overseas_lodging', 280 * 2 * 1349]]);
  assert.deepEqual(n.expenses.map(e => [e.item, e.amount]), [['overseas_per_diem', 50 * 3 * 1349], ['overseas_lodging', 150 * 2 * 1349]]);
  assert.deepEqual(R.overseasGuess('1월 라스베가스 CES'), { overseas: true, grade: '가' });
  assert.deepEqual(R.overseasGuess('도쿄 고객사 미팅'), { overseas: true, grade: '나' });
  assert.equal(R.overseasGuess('판교 AI 사무소').overseas, false);
});

test('보고서 부가세: 개인 = 공급가액만, 법인카드 과세 = 공급가액+부가세, 법인카드 면세(항공권·주유비) = 부가세 0', () => {
  assert.deepEqual([R.supplyAmount(55000, 'personal'), R.vatAmount(55000, 'personal')], [55000, 0]);
  assert.deepEqual([R.supplyAmount(55000, 'card'), R.vatAmount(55000, 'card')], [50000, 5000]);
  assert.deepEqual([R.supplyAmount(79000, 'card', true), R.vatAmount(79000, 'card', true)], [79000, 0]);
  assert.equal(R.noVatOf({ item: 'airfare', memo: '' }), true);
  assert.equal(R.noVatOf({ item: 'domestic_transport', memo: '10/2 주유비' }), true);
  assert.equal(R.noVatOf({ item: 'meal', memo: '9/28 1인 석식' }), false);
  assert.equal(R.noVatOf({ item: 'meal', memo: '주유', noVat: false }), false);   // 화면에서 끈 값이 우선
  const [c] = R.capToBudget([{ amount: 66000, pay: 'card', noVat: false }], 60000);   // 한도까지 깎은 뒤 부가세 계산
  assert.deepEqual([c.amount, c.supply, c.vat], [60000, 54546, 5454]);
});

test('수출입은행 환율: 고시 없는 날은 거슬러 가고, 키 오류는 알려 줌', async () => {
  const FX = require('../src/engine/fx');
  const seen = [];
  const fake = byDate => async url => { const d = /searchdate=(\d+)/.exec(url)[1]; seen.push(d); return { ok: true, json: async () => byDate[d] || [] }; };
  const usd = [{ result: 1, cur_unit: 'JPY(100)', deal_bas_r: '950.1' }, { result: 1, cur_unit: 'USD', cur_nm: '미국 달러', deal_bas_r: '1,348.5', ttb: '1,335', tts: '1,362', bkpr: '1,348' }];
  const r = await FX.usdRate('k', { from: new Date(2026, 9, 18), fetch: fake({ '20261016': usd }) });   // 일요일 → 금요일 고시값
  assert.deepEqual([r.rate, r.date, seen], [1348.5, '2026-10-16', ['20261018', '20261017', '20261016']]);
  await assert.rejects(FX.usdRate('bad', { fetch: fake({ '20261018': [{ result: 3 }] }), from: new Date(2026, 9, 18) }), /인증키/);
  await assert.rejects(FX.usdRate(''), /OPEN_API_KEY/);
  assert.match(FX.proofHtml(r), /1,348\.5/);
});

test('네이버 자동완성 장소 글자 해석: 번지만 있는 두 줄도 장소', () => {
  const { parsePlace } = require('../src/engine/naver');
  assert.deepEqual(parsePlace('장소\n세종 집현동 1095'), { name: '세종 집현동 1095', address: '' });
  assert.deepEqual(parsePlace('장소\n기업,빌딩\n한국항공우주산업\n경남 사천시 사남면 공단1로 78 한국항공우주산업'), { name: '한국항공우주산업', address: '경남 사천시 사남면 공단1로 78' });
  assert.equal(parsePlace('대중교통\n출발\n세종 집현동 1095'), null);
  assert.equal(parsePlace('장소'), null);
});

test('네이버 지역 검색: 이름·도로명 주소·좌표로 정리, 키 없으면 null', async () => {
  const { searchPlaces } = require('../src/engine/places');
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ items: [
    { title: '<b>한국항공우주산업</b>', address: '경상남도 사천시 사남면 유천리 802', roadAddress: '경상남도 사천시 사남면 공단1로 78 한국항공우주산업', mapx: '1280652238', mapy: '350761198', category: '서비스,산업>기업' },
    { title: '좌표 없음', address: '', roadAddress: '', mapx: '0', mapy: '0', category: '' }] }) });
  const r = await searchPlaces('한국항공우주산업', { keys: { id: 'a', secret: 'b' }, fetch: fake });
  assert.deepEqual(r, [{ name: '한국항공우주산업', address: '경상남도 사천시 사남면 공단1로 78 한국항공우주산업', category: '서비스,산업>기업', lng: 128.0652238, lat: 35.0761198 }]);
  assert.equal(await searchPlaces('x', { keys: null, fetch: fake }), null);
  assert.deepEqual(await searchPlaces('   ', { keys: { id: 'a', secret: 'b' }, fetch: fake }), []);
  await assert.rejects(searchPlaces('x', { keys: { id: 'a', secret: 'b' }, fetch: async () => ({ ok: false, status: 401 }) }), /키가 올바르지/);
});

test('네이버 길찾기 주소: 도착지 좌표를 주소에 넣고 출발지는 -', () => {
  const { directionsUrl } = require('../src/engine/naver');
  const d = { name: '한국항공우주산업', lng: 128.0652238, lat: 35.0761198 };
  assert.equal(directionsUrl('car', null, d), 'https://map.naver.com/p/directions/-/128.0652238,35.0761198,%ED%95%9C%EA%B5%AD%ED%95%AD%EA%B3%B5%EC%9A%B0%EC%A3%BC%EC%82%B0%EC%97%85,,/-/car');
  assert.equal(directionsUrl('transit', null, d).split('/').pop(), 'transit');
  assert.equal(directionsUrl('car', null, { name: 'x', lng: 0, lat: 0 }), 'https://map.naver.com/p/directions/-/-/-/car');
});

test('보고서 자차 교통비: 유류대만 왕복, 통행료는 빠짐', () => {
  const e = R.fuelOnlyExpense({ fuel: 50166, toll: 9800, total: 119932, basis: '1종 휘발유 8km/L', screenshot: '/x/교통비_car_1.png' });
  assert.deepEqual(e, { item: 'domestic_transport', amount: 100332, memo: '출장 유류비 (왕복, 1종 휘발유 8km/L 네이버 지도 기준)', proofs: ['/x/교통비_car_1.png'] });
  assert.equal(R.fuelOnlyExpense({ total: 1000 }).amount, 0);
});

test('구매의뢰서 입력 검증: 납기 필수, 합계는 VAT 포함이면 1.1배, 제목 자동', () => {
  const base = { vendor: { name: '다성 오토메이션' }, purpose: '생산 운영', project: 'KAI', items: [{ name: '모션 컨트롤러', part_no: 'Ez-ML', qty: 2, unit_price: 105000, due: '2026-04-22' }], vat_included: true, reason: '사유', file: '/x/po.pdf' };
  const p = R.parsePurchase(base);
  assert.deepEqual([p.items[0].amount, p.supply, p.total, p.urgency, p.substitutable, p.title], [210000, 210000, 231000, '일반', false, '[구매의뢰서 - KAI] 모션 컨트롤러 구매 요청의 건']);
  assert.equal(R.parsePurchase({ ...base, vat_included: false, total: '' }).total, 210000);
  assert.equal(R.parsePurchase({ ...base, items: [{ ...base.items[0], amount: 0 }] }).items[0].amount, 0);   // 0 도 그대로
  assert.equal(R.parsePurchase({ ...base, items: [{ ...base.items[0], due: '' }] }).items[0].due, '');   // 납기는 선택
  assert.throws(() => R.parsePurchase({ ...base, project: '기타' }), /세부 프로젝트명/);
  assert.throws(() => R.parsePurchase({ ...base, project: '정부과제' }), /세부 프로젝트명/);
  assert.equal(R.parsePurchase({ ...base, project: '정부과제', project_etc: '핵심부품 국산화' }).title, '[구매의뢰서 - 핵심부품 국산화] 모션 컨트롤러 구매 요청의 건');
  assert.equal(R.parsePurchase({ ...base, project_etc: 'KAI 정비 3차' }).title, '[구매의뢰서 - KAI 정비 3차] 모션 컨트롤러 구매 요청의 건');
  assert.throws(() => R.parsePurchase({ ...base, items: [] }), /비어/);
  assert.equal(R.purchaseTitle('', '무선 LAN 안테나'), '[구매의뢰서] 무선 LAN 안테나 구매 요청의 건');
});

test('워드·엑셀 발주서 글자 뽑기', () => {
  const { officeText } = require('../src/engine/office');
  const path = require('path');
  assert.equal(officeText(path.join(__dirname, 'fixtures', 'po.docx')), '구매 발주서\n품명\t수량\n모션 컨트롤러 & 케이블\t1');
  assert.equal(officeText(path.join(__dirname, 'fixtures', 'po.xlsx')), '품명\t단가\n모션 컨트롤러\t105000\n합계\t115500');
  assert.throws(() => officeText('x.xls'), /docx/);
});

test('구매의뢰서: 제품 페이지 링크면 사유 칸에 링크·캡처·글 (html), 아니면 글만', () => {
  const { purchasePayload } = require('../src/engine/editorFill');
  const base = { vendor: { name: 'v' }, purpose: '생산 운영', project: 'KAI', items: [{ name: 'a', qty: 1, unit_price: 100, due: '2026-05-01' }], reason: '사유 <한 줄>\n둘째 줄', file: '/x/po.pdf' };
  assert.throws(() => R.parsePurchase({ ...base, link: { url: 'https://shop.example/x' } }), /둘 중 하나/);
  assert.throws(() => R.parsePurchase({ ...base, file: '' }), /발주서 파일이나 제품 페이지/);
  const p1 = R.parsePurchase({ ...base, file: '', link: { url: 'https://shop.example/x', title: '안테나 | 알에프마트', shot: '/t/s.png' } });
  assert.deepEqual(p1.link, { url: 'https://shop.example/x', title: '안테나 | 알에프마트', shot: '/t/s.png' });
  assert.deepEqual([p1.vat_included, p1.price_vat, p1.total], [true, true, 100]);   // 온라인 판매가는 부가세 포함 그대로
  const f = purchasePayload(p1, { shotDataUrl: 'data:image/png;base64,AAA' }).fields.find(x => x.label === '구매 상세 사유');
  assert.ok(f.html.includes('href="https://shop.example/x"') && f.html.includes('src="data:image/png;base64,AAA"') && f.html.includes('사유 &lt;한 줄&gt;<br />둘째 줄'));
  assert.throws(() => R.parsePurchase({ ...base, file: '', link: { url: 'javascript:alert(1)' } }), /발주서 파일이나 제품 페이지/);
  assert.equal(purchasePayload(R.parsePurchase(base)).fields.find(x => x.label === '구매 상세 사유').text, base.reason);
  assert.deepEqual(R.PURCHASE_RECIPIENTS, ['구매팀', '경영지원부(전자결재용)', '연구지원팀']);
});

test('구매의뢰서 거래처 담당자 칸: 거래처명 / 담당자명, 하나만 있으면 그것만', () => {
  const { purchasePayload } = require('../src/engine/editorFill');
  const mk = v => purchasePayload(R.parsePurchase({ vendor: v, purpose: '생산 운영', project: 'KAI', items: [{ name: 'a', qty: 1, unit_price: 1 }], reason: 'r', file: '/x.pdf' })).fields.find(f => f.label === '담당자').text;
  assert.equal(mk({ name: '㈜은성일렉콤', contact: '이현규' }), '㈜은성일렉콤 / 이현규');
  assert.equal(mk({ name: '알에프씨엠', contact: '' }), '알에프씨엠');
  assert.equal(mk({ name: '알에프씨엠', contact: '알에프씨엠' }), '알에프씨엠');
});

test('오류 기록 슬랙 전송: 메시지 → 파일 올리기 → 스레드에 묶기, 비밀번호 칸 지움, 키 없으면 건너뜀', async () => {
  const { sendReport, scrubHtml } = require('../src/engine/errreport');
  const calls = [];
  const fake = async (url, opt) => { calls.push([url.replace('https://slack.com/api/', ''), opt.body]);
    if (url.endsWith('chat.postMessage')) return { ok: true, json: async () => ({ ok: true, ts: '1.2', channel: 'C1' }) };
    if (url.endsWith('files.getUploadURLExternal')) return { ok: true, json: async () => ({ ok: true, upload_url: 'https://up/1', file_id: 'F1' }) };
    if (url === 'https://up/1') return { ok: true };
    return { ok: true, json: async () => ({ ok: true }) }; };
  const r = await sendReport({ token: 't', channel: 'C1', fetch: fake, text: '실패', files: [{ name: 'log.txt', data: 'hello' }, { name: 'empty.txt', data: '' }] });
  assert.deepEqual(r, { ts: '1.2', files: 1 });
  assert.deepEqual(calls.map(c => c[0]), ['chat.postMessage', 'files.getUploadURLExternal', 'https://up/1', 'files.completeUploadExternal']);
  assert.deepEqual(JSON.parse(calls[3][1]), { files: [{ id: 'F1', title: 'log.txt' }], channel_id: 'C1', thread_ts: '1.2' });
  assert.equal(scrubHtml('<input type="password" name="pw" value="secret1">'), '<input type="password" name="pw" value="***">');
  assert.deepEqual(await sendReport({ token: '', channel: 'C1', fetch: fake, text: 'x' }), { skipped: true });
});

test('결재 문서 출장일 글자 읽기: 여러 꼴, 연도 없으면 품의일 해, 못 읽으면 빈 값', () => {
  const P = R.parseTripPeriod;
  assert.deepEqual(P('2026.10.19 09:00 - 2026.10.20 18:00', '2026-10-14'), { start: '2026-10-19', end: '2026-10-20', start_time: '09:00', end_time: '18:00' });
  assert.deepEqual(P('2026-10-19 ~ 2026-10-20', '2026-10-14'), { start: '2026-10-19', end: '2026-10-20', start_time: '', end_time: '' });
  assert.deepEqual(P('2026년 10월 19일 ~ 20일', '2026-10-14'), { start: '2026-10-19', end: '2026-10-20', start_time: '', end_time: '' });
  assert.deepEqual(P('10/19~10/20', '2026-10-14'), { start: '2026-10-19', end: '2026-10-20', start_time: '', end_time: '' });
  assert.deepEqual(P('10월 19일(월) 9시 ~ 10월 20일(화) 18시', '2026-10-14'), { start: '2026-10-19', end: '2026-10-20', start_time: '09:00', end_time: '18:00' });
  assert.deepEqual(P('1/6~1/12', '2026-12-20'), { start: '2027-01-06', end: '2027-01-12', start_time: '', end_time: '' });   // 해 넘김
  assert.deepEqual(P('10.22', '2026-10-21'), { start: '2026-10-22', end: '2026-10-22', start_time: '', end_time: '' });
  assert.deepEqual(P('', '2026-10-14'), { start: '', end: '', start_time: '', end_time: '' });
});

test('식대 규정 한도: 조식 8,300 → 8,000, 2인 중식 28,000 은 그대로, 끼니 모르면 안 깎음', () => {
  const rates = { breakfast: 8000, lunch: 15000, dinner: 15000 };
  const c = R.capMealRows([
    { item: 'meal', amount: 8300, meal: '조식', people: 1, memo: '10/21 1인 조식' },
    { item: 'meal', amount: 28000, meal: '중식', people: 2, memo: '10/21 2인 중식' },
    { item: 'meal', amount: 42000, people: 3, memo: '10/19 3인 석식' },   // 끼니는 적요에서
    { item: 'meal', amount: 50000, people: 1, memo: '10/19 1인 편의점' },   // 끼니 모름
    { item: 'domestic_lodging', amount: 90000, memo: '숙박 1박' },
  ], rates);
  assert.deepEqual(c.map(r => [r.amount, !!r.capped, r.paid]), [[8000, true, 8300], [28000, false, undefined], [42000, false, undefined], [50000, false, undefined], [90000, false, undefined]]);
  assert.equal(R.capMealRows([{ item: 'meal', amount: 20000, meal: '석식', people: 1 }], rates)[0].amount, 15000);
});

test('같은 날 식대 영수증은 한 줄로 (10/19~21 네이버페이 영수증 9장, 2026-10-22)', () => {
  const rc = (path, item, amount, date, memo, vendor, people = 0) => ({ path, item, amount, date, memo, vendor, people, proofs: [path] });
  const rows = [
    rc('a.png', 'meal', 13500, '2026-10-21', '1인 중식', '키오스크_스마트로_A', 1),
    rc('b.png', 'meal', 8300, '2026-10-21', '1인 조식', '씨유인계중앙점', 1),
    rc('c.png', 'meal', 15000, '2026-10-20', '1인 석식', '양복점 인계점', 1),
    rc('d.png', 'domestic_lodging', 65000, '2026-10-20', '숙박 1박', '여기어때컴퍼니'),
    rc('e.png', 'meal', 15000, '2026-10-20', '1인 중식', '윤돈', 1),
    rc('f.png', 'meal', 6900, '2026-10-20', '1인 조식', 'GS25 수원다모아점', 1),
    rc('g.png', 'meal', 42000, '2026-10-19', '3인 석식', '계화정', 3),
    rc('h.png', 'domestic_lodging', 70000, '2026-10-19', '숙박 1박', '아늑 료칸 호텔 수원 인계'),
    rc('i.png', 'meal', 15000, '2026-10-20', '1인 중식', '윤돈', 1),   // 같은 영수증 두 번 올림 → 금액은 합쳐지고 증빙 2개 (사람이 표에서 확인)
  ];
  const m = R.mergeMealRows(rows);
  assert.deepEqual(m.map(r => [r.date, r.item, r.amount, r.memo, r.people, r.proofs.length]), [
    ['2026-10-21', 'meal', 21800, '1인 조식·중식 2건', 1, 2],
    ['2026-10-20', 'meal', 51900, '1인 조식·중식·석식 4건', 1, 4],
    ['2026-10-20', 'domestic_lodging', 65000, '숙박 1박', 0, 1],
    ['2026-10-19', 'meal', 42000, '3인 석식', 3, 1],   // 하루 한 장이면 그대로
    ['2026-10-19', 'domestic_lodging', 70000, '숙박 1박', 0, 1],
  ]);
  assert.deepEqual(m[0].proofs, ['a.png', 'b.png']);
  assert.equal(m[1].vendor, '양복점 인계점, 윤돈, GS25 수원다모아점');
  assert.equal(m[1].dup, 4);
  // 화면 표 줄(적요 "10/20 1인 조식")을 채주로 묶을 때: 날짜·인원은 첫 줄 적요에서, 결제수단 다르면 따로
  const scr = [
    { item: 'meal', amount: 6900, date: '2026-10-20', memo: '10/20 1인 조식', pay: 'personal', proofs: ['a'] },
    { item: 'meal', amount: 15000, date: '2026-10-20', memo: '10/20 1인 중식', pay: 'personal', proofs: ['b'] },
    { item: 'meal', amount: 15000, date: '2026-10-20', memo: '10/20 1인 석식', pay: 'card', proofs: ['c'] },
  ];
  assert.deepEqual(R.mergeMealRows(scr).map(r => [r.amount, r.memo, r.pay, r.proofs]), [[21900, '10/20 1인 조식·중식 2건', 'personal', ['a', 'b']], [15000, '10/20 1인 석식', 'card', ['c']]]);
  // 끼니는 AI 가 읽은 meal 필드가 적요 글자보다 우선 (적요를 사람이 고쳐도 됨)
  const byField = [{ item: 'meal', amount: 1000, date: '2026-10-20', memo: '10/20 1인 편의점', meal: '조식', proofs: ['a'] }, { item: 'meal', amount: 2000, date: '2026-10-20', memo: '10/20 1인 윤돈', meal: '중식', proofs: ['b'] }];
  assert.equal(R.mergeMealRows(byField)[0].memo, '10/20 1인 조식·중식 2건');
  // 날짜를 못 읽은 식대·실패한 줄은 안 묶음
  const n = R.mergeMealRows([rc('x', 'meal', 1000, '', '중식', ''), rc('y', 'meal', 2000, '', '석식', ''), { path: 'z', item: '', amount: 0, failed: '못 읽음', date: '2026-10-20', proofs: ['z'] }]);
  assert.equal(n.length, 3);
  assert.deepEqual(n[2].proofs, ['z']);
});

test('한 줄 메모 날짜·시각: 요일 괄호, 떨어진 끝 날짜, 거꾸로 쓴 기간, 낱말 뒤 시각, 시간(기간)은 시각 아님 (자가 테스트 2026-10-22)', () => {
  const today = new Date(2026, 9, 22);
  const d = m => { const r = Q.parseDates(m, today); return `${r.start}~${r.end}`; };
  const t = m => { const r = Q.parseTimes(m); return `${r.startTime}/${r.endTime}`; };
  assert.equal(d('10/27(화)~10/29(목) 판교'), '2026-10-27~2026-10-29');
  assert.equal(d('10/27 13시 출발 10/28 21시 복귀 판교'), '2026-10-27~2026-10-28');
  assert.equal(d('10/27 판교 왕복 10.5km'), '2026-10-27~2026-10-27');   // 거리 숫자를 끝 날짜로 안 봄
  assert.equal(d('10/29~10/27 판교'), '2026-10-27~2026-10-29');         // 1년짜리가 되지 않음
  assert.equal(d('12/30~1/2 부산'), '2026-12-30~2027-01-02');           // 연말은 해를 넘김
  assert.equal(t('10/27 판교 출발 9:00 복귀 17:30'), '09:00/17:30');
  assert.equal(t('출발은 9시, 복귀는 6시'), '09:00/18:00');
  assert.equal(t('10/27 판교 3.5시간 운전'), '/');
  assert.equal(t('10/27 판교 2시간 회의 9시 출발'), '09:00/');
  assert.equal(t('9시 출발 18시 복귀'), '09:00/18:00');
  assert.equal(t('화 19시 출발 목 15시 복귀'), '19:00/15:00');
});

test('한 줄 메모: 작업장·공항·빌딩 같은 장소, 사유 정리(교통수단 이동·N월 말·저녁 먹고), 저녁 먹고 복귀 = 20시 넘음 (자가 테스트 2026-10-22)', () => {
  const today = new Date(2026, 9, 22);
  const qa = m => Q.quickApply(m, { today, places: PLACES, rates: Q.DEFAULT_RATES, origin: '세종' });
  assert.equal(qa('10/27 삼성전자 구미 A동 작업장 설치 지원').data.destination, '삼성전자 구미 A동 작업장');
  assert.equal(qa('10/27 설치 지원 LG전자 창원 공장').data.destination, 'LG전자 창원 공장');   // 업무 낱말은 장소에서 뺌
  assert.equal(qa('10/27 인천공항 장비 통관').data.destination, '인천공항');
  assert.equal(qa('10/27 화성 현대차 남양연구소 테스트 지원 자차 이동').data.reason, '화성 현대차 남양연구소 테스트 지원');
  const late = qa('10/27 판교 본사 가서 회의 하고 저녁 먹고 복귀');
  assert.equal(late.data.reason, '본사 회의');
  assert.equal(late.data.dates.end_time, '20:30');
  assert.deepEqual(late.data.expenses.map(e => e.amount), [30000]);   // 중식 + 석식
  const vague = qa('10월 말 판교 출장');
  assert.ok(vague.missing.includes('사유') && vague.missing.includes('날짜'));
});

test('한 줄 메모 동행자·사유: 차 이름 조각을 사람으로 안 봄, 요일 괄호·홀로 남은 요일 글자는 사유에서 뺌 / 빈 칸 오류는 한글 (자가 테스트 2026-10-22)', () => {
  const today = new Date(2026, 9, 22);
  const qa = m => Q.quickApply(m, { today, places: PLACES, rates: Q.DEFAULT_RATES }).data;
  const a = qa('다음주 화~목 판교 RBY1 Muscat 연동 검증, 법인차 스타렉스, 홍길동이랑 같이 9시 출발 목 18시 복귀');
  assert.deepEqual(a.companions, ['홍길동']);
  assert.equal(a.reason, 'RBY1 Muscat 연동 검증');
  assert.equal(qa('10/27(화)~10/29(목) 대전 ETRI 연구원 과제 회의').reason, '대전 ETRI 연구원 과제 회의');
  assert.deepEqual(qa('김철수, 홍길동이랑 같이 10/27 판교 회의').companions, ['김철수', '홍길동']);
  assert.throws(() => R.parseApply({ transport: { mode: 'corporate' }, dates: { start: '2026-10-27', end: '2026-10-27', start_time: '09:00', end_time: '18:00' }, reason: '회의', destination: '  ', purpose: 'x', expenses: [] }), /출장지을\(를\) 넣어 주세요/);
});

test('채주 계획: 다른 날짜 예산 줄로 안 넘김, 나뉜 영수증 증빙은 첫 조각에만, 같은 적요·금액 채주는 (2) 로 구분, 묶은 식대 적요 인원은 최대 (자가 테스트 2026-10-22)', () => {
  const L = (label, memo, amount, date, id) => ({ id, label: `여비교통비(판)_${label}`, pay: 'personal', amount, supply: amount, memo, date, proofs: [`${id}.png`] });
  const dated = [{ 예산과목: '여비교통비(판)_식대', 예산과목비고: '10/19 식대', 미지출액: '30,000' }, { 예산과목: '여비교통비(판)_식대', 예산과목비고: '10/20 식대', 미지출액: '38,000' }];
  const a = R.planPayees(dated, [L('식대', '10/21 1인 중식', 15000, '2026-10-21', 'x')]);
  assert.deepEqual(a.plan.map(p => p.lines.length), [0, 0]);   // 21일 영수증은 19·20일 줄에 안 들어감
  assert.equal(a.plan[1].dropped, 1);
  const two = [{ 예산과목: '여비교통비(판)_국내교통비', 예산과목비고: '교통비', 미지출액: '10,000' }, { 예산과목: '여비교통비(판)_국내교통비', 예산과목비고: '교통비', 미지출액: '10,000' }];
  const b = R.planPayees(two, [L('국내교통비', '택시', 15000, '', 't')]);
  assert.deepEqual(b.plan.map(p => p.lines.map(l => [l.amount, l.proofs.length])), [[[10000, 1]], [[5000, 0]]]);
  const c = R.planPayees([{ 예산과목: '여비교통비(판)_국내교통비', 예산과목비고: '교통비', 미지출액: '50,000' }], [L('국내교통비', '10/20 택시', 8000, '', 'a'), L('국내교통비', '10/20 택시', 8000, '', 'b')]);
  assert.deepEqual(c.plan[0].lines.map(l => l.memo), ['10/20 택시', '10/20 택시 (2)']);
  const m = R.mergeMealRows([{ item: 'meal', amount: 8000, date: '2026-10-20', memo: '10/20 1인 조식', meal: '조식', people: 1, proofs: ['a'] }, { item: 'meal', amount: 45000, date: '2026-10-20', memo: '10/20 3인 석식', meal: '석식', people: 3, proofs: ['b'] }]);
  assert.equal(m[0].memo, '10/20 3인 조식·석식 2건');
});

test('구매의뢰 금액: 음수는 막고 ₩·원 표기는 받음, 수량 소수(1.5m), 단가 없이 금액만 있는 줄 (자가 테스트 2026-10-22)', () => {
  const base = { vendor: { name: '다성' }, purpose: '기타', purpose_etc: '시험', project: '기타', project_etc: '디스플레이 2차', reason: '사유', file: '/a.pdf' };
  const P = items => R.parsePurchase({ ...base, items }).items.map(i => [i.qty, i.unit_price, i.amount]);
  assert.deepEqual(P([{ name: 'A', qty: '3', unit_price: '₩12,345원' }]), [[3, 12345, 37035]]);
  assert.deepEqual(P([{ name: '케이블', qty: '1.5', unit_price: 1000 }]), [[1.5, 1000, 1500]]);
  assert.deepEqual(P([{ name: 'A', qty: 2, unit_price: '', amount: '50,000' }]), [[2, 25000, 50000]]);
  assert.deepEqual(P([{ name: 'A', qty: 1, unit_price: 50000 }, { name: '할인', qty: 1, unit_price: '-5,000' }]), [[1, 50000, 50000], [1, -5000, -5000]]);   // 견적 할인 줄
  assert.throws(() => P([{ name: '할인', qty: 1, unit_price: -1000 }]), /0원보다 작아요/);
  assert.throws(() => R.parseExpenses([{ item: 'meal', amount: -5000 }]), /금액은 숫자/);
});

test('출장지 검색 순서: 지역 붙인 이름("부산 벡스코")에 식당만 나와도 컨벤션센터·기업이 먼저, 식당·카페는 뒤 (자가 테스트 2026-10-22)', () => {
  const { rankPlaces } = require('../src/engine/places');
  const P = (name, category) => ({ name, category, address: '', lng: 129, lat: 35 });
  const r = rankPlaces('부산 벡스코', [P('고담현불고기 해운대센텀시티 본점', '한식>육류,고기요리'), P('W웨딩 벡스코웨딩홀', '연애,결혼>웨딩컨설팅,플래너'), P('BEXCO', '문화,예술>컨벤션센터'), P('손의손 센텀벡스코점', '해물,생선요리>주꾸미요리')]);
  assert.equal(r[0].name, 'BEXCO');
  assert.equal(rankPlaces('판교 맛집', [P('A식당', '음식점>한식'), P('B빌딩', '기업,빌딩')])[0].name, 'A식당');   // 식당을 찾을 땐 그대로
  assert.equal(rankPlaces('한국항공우주산업', [P('에비오시스테크놀러지스', '서비스,산업>제조업'), P('한국항공우주산업', '서비스,산업>기업')])[0].name, '한국항공우주산업');
});

test('보고서 경비의 식대 인원은 엔진까지 넘어가야 함 — 빠지면 보낼 때 3인 식대를 1인 한도로 깎음 (자가 테스트 2026-10-22)', () => {
  const base = { trip_id: 't', reason: 'r', name: 'n', destination: 'd', fund: '일반경비', period: '2026.10.19 - 2026.10.20', purpose: 'p', report: 'x', schedule: [{ date: '10/19', place: 'a', detail: 'b' }] };
  const rep = R.parseReport({ ...base, expenses: [{ item: 'meal', amount: 42000, memo: '10/19 3인 석식', meal: '석식', people: 3, pay: 'personal' }] });
  assert.equal(rep.expenses[0].people, 3);
  assert.equal(R.capMealRows(rep.expenses, { breakfast: 8000, lunch: 15000, dinner: 15000 })[0].amount, 42000);
  assert.equal(R.capMealRows([{ item: 'meal', amount: 42000, memo: '10/19 3인 석식' }], { dinner: 15000 })[0].amount, 42000);   // 인원 칸 없이 적요만
});

test('정산 줄 날짜: 직접 쓴 줄의 "1/1" 은 해를 넘긴 출장(12/30~1/2)이면 다음 해 (자가 테스트 2026-10-22)', () => {
  const runner = require('../src/engine/runner');
  const rep = { period: '2026.12.30 09:00 - 2027.01.02 18:00', expenses: [{ item: 'meal', label: '여비교통비(판)_식대', amount: 15000, memo: '12/31 1인 석식', pay: 'personal' }, { item: 'meal', label: '여비교통비(판)_식대', amount: 8000, memo: '1/1 1인 조식', pay: 'personal' }] };
  assert.deepEqual(runner.settleLines(rep, { rates: { breakfast: 8000, lunch: 15000, dinner: 15000 } }).map(l => l.date), ['2026-12-31', '2027-01-01']);
});

test('한 줄 메모: 해외 도시·나라를 출장지로, 나라 이름은 사유에서 빼고, "다음주 일본·수원"의 일·수는 요일 아님 (자가 테스트 2026-10-22)', () => {
  const today = new Date(2026, 9, 22);
  const qa = m => Q.quickApply(m, { today, places: PLACES, rates: Q.DEFAULT_RATES }).data;
  const sg = qa('다음주 화~목 싱가포르 고객사 RBY1 데모 9시 출발 18시 복귀');
  assert.equal(sg.destination, '싱가포르'); assert.ok(sg.purpose.startsWith('싱가포르에서'));
  const lv = qa('1/6~1/9 미국 라스베이거스 CES 참관');
  assert.equal(lv.destination, '라스베이거스'); assert.equal(lv.reason, 'CES 참관');
  const jp = qa('다음주 일본 도쿄 로봇 전시회');
  assert.equal(jp.reason, '로봇 전시회'); assert.equal(jp.dates.start, '');   // '다음주 일(요일)' 로 읽으면 안 됨
  const sw = qa('다음주 월 수원 출장');
  assert.equal(sw.dates.start, '2026-10-26'); assert.equal(sw.dates.end, '2026-10-26');   // '수원'의 수 ≠ 수요일
});

test('AI 결과 병합: AI 가 비워 둔 칸은 규칙으로 읽은 값을 지우지 않음 (자가 테스트 2026-10-23)', () => {
  const base = Q.quickApply('10/27 킨텍스 로봇 전시회 참관 법인차 8시 출발 21시 복귀', { today: new Date(2026, 9, 22), places: PLACES, rates: Q.DEFAULT_RATES }).data;
  const m = Q.mergeAi(base, { reason: '', purpose: null, destination: '', transport: { mode: '' }, companions: [], dates: { start: '' } }, PLACES, { defaultOrigin: '세종' });
  assert.equal(m.reason, base.reason); assert.equal(m.destination, '킨텍스'); assert.equal(m.transport.mode, 'corporate'); assert.equal(m.dates.start, '2026-10-27'); assert.ok(m.purpose);
});

test('법인차량 출장의 주유·통행료는 차량유지비(판) 예산 줄로, 택시는 국내교통비 그대로 (최병관 2026-10-28)', () => {
  const { settleLines } = require('../src/engine/runner');
  const rep = R.parseReport({ reason: 'x', name: '홍길동', period: '2026.10.22 - 2026.10.22', destination: 'd', purpose: 'p', report: 'r', fund: '일반경비',
    schedule: [{ date: '10/22', place: 'd', detail: 'a' }], transport: { mode: 'corporate' },
    expenses: [{ item: 'domestic_transport', amount: 50000, memo: '10/22 주유' }, { item: 'domestic_transport', amount: 12000, memo: '10/22 택시' }] });
  const lines = settleLines(rep, {});
  assert.equal(lines.find(l => l.amount === 50000).label, '차량유지비(판)');
  assert.equal(lines.find(l => l.amount === 12000).label, '여비교통비(판)_국내교통비');
  const { plan, left } = R.planPayees([{ 예산과목: '여비교통비(판)_식대', 품의금액: '30,000' }, { 예산과목: '차량유지비(판)', 품의금액: '150,000' }], lines);
  assert.equal(plan[1].lines[0].amount, 50000); assert.deepEqual(left.map(l => l.amount), [12000]);
  const car = R.parseReport({ ...rep, name: '홍길동', fund: '일반경비', transport: { mode: 'car' }, expenses: [{ item: 'domestic_transport', amount: 50000, memo: '10/22 주유' }] });
  assert.equal(settleLines(car, {})[0].label, '여비교통비(판)_국내교통비');   // 자차는 그대로
});
