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
  const a = R.parseApply({ reason: '판교 출장', destination: '판교', dates: { start: '2026-10-20', end: '2026-10-22' },
    transport: { mode: 'car', to: '판교' }, purpose: '목적', expenses: [{ item: 'meal', amount: '90,000원' }] });
  assert.equal(a.period, '2026.10.20 - 2026.10.22');
  assert.equal(a.expenses[0].amount, 90000);
  assert.equal(a.expenses[0].memo, '판교 출장 출장 식대');
  assert.equal(a.expenses[0].code, '8120004');
  assert.deepEqual(a.transport.check, ['자차']);
  assert.throws(() => R.parseApply({ ...a, dates: { start: '2026-10-22', end: '2026-10-20' } }), R.InputError);
  assert.throws(() => R.parseApply({ reason: 'x', destination: 'y', dates: { start: '2026-10-20', end: '2026-10-20' }, transport: { mode: 'car' }, purpose: 'p' }), /도착지/);
  assert.throws(() => R.parseApply({ reason: 'x', destination: 'y', dates: { start: '2026-10-20', end: '2026-10-20' }, transport: { mode: 'car', to: 'z' }, purpose: 'p',
    expenses: [{ item: 'domestic_transport', amount: 1 }] }), /국내교통비/);
});

test('AI 답변에서 YAML 꺼내기 (날짜는 문자열로)', () => {
  const d = R.extractYaml('네!\n```yaml\nreason: 회의\ndates: {start: 2026-10-20, end: 2026-10-21}\n```\n끝');
  assert.equal(d.reason, '회의');
  assert.equal(d.dates.start, '2026-10-20');
  assert.throws(() => R.extractYaml('그냥 문장'), R.InputError);
});

test('보고서: 정부과제는 과제명 필수', () => {
  const base = { reason: 'r', name: 'n', period: 'p', destination: 'd', purpose: 'p', report: 'r' };
  assert.throws(() => R.parseReport({ ...base, category: '정부과제' }), /과제명/);
  assert.equal(R.parseReport({ ...base, category: '로봇' }).category, '로봇');
});
