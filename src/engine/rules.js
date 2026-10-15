'use strict';
// 회사 규칙: 제목, 예산과목, 교통비 계산, 입력 검증. (그룹웨어/브라우저와 무관한 순수 로직)

const yaml = require('js-yaml');

const APPLY_FORM = '출장신청 및 출장경비 사전품의';
const REPORT_FORM = '출장보고서 및 정산 품의서';

// 예산과목 (사업코드도움에서 코드로 검색)
const BUDGET_ITEMS = {
  domestic_transport: ['8120002', '여비교통비(판)_국내교통비'],
  domestic_lodging: ['8120003', '여비교통비(판)_국내숙박비'],
  meal: ['8120004', '여비교통비(판)_식대'],
  overseas_transport: ['8120005', '여비교통비(판)_해외교통비'],
  overseas_lodging: ['8120006', '여비교통비(판)_해외숙박비'],
  airfare: ['8120007', '여비교통비(판)_항공권'],
  overseas_per_diem: ['8120008', '여비교통비(판)_해외일비'],
};

const TRANSPORT_MODES = {
  car: { check: ['자차'], autoFare: true },
  transit: { check: ['기차', '버스'], autoFare: true },
  corporate: { check: ['법인차량'], autoFare: false },
};
const CORPORATE_CARS = ['스타렉스', '스포티지(2550)', '스포티지(5717)', '스포티지(5718)', '그랜져', '캐스퍼', 'QM6', 'K5'];
const APPLY_CATEGORIES = ['일반', '연구과제'];
const REPORT_CATEGORIES = ['로봇', '천문', '생산', '기타', '정부과제'];

class InputError extends Error {}

// ---------- 조사 ----------
const DIGIT_FINAL = { 0: 'o', 1: 'ㄹ', 2: null, 3: 'o', 4: null, 5: null, 6: 'o', 7: 'ㄹ', 8: 'ㄹ', 9: null };
function finalConsonant(word) {
  const chars = [...String(word).trim()].reverse();
  const ch = chars.find(c => /[\p{L}\p{N}]/u.test(c));
  if (!ch) return null;
  const code = ch.codePointAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    if (jong === 0) return null;
    return jong === 8 ? 'ㄹ' : 'o';
  }
  if (/\d/.test(ch)) return DIGIT_FINAL[ch];
  if (/[lL]/.test(ch)) return 'ㄹ';
  if (/[mnMN]/.test(ch)) return 'o';
  return null; // 영문은 대부분 모음으로 끝나게 읽힘 (비, 씨, 디 ...)
}
/** '로/으로' : 받침 없음·ㄹ받침 → 로, 그 외 → 으로 */
const ro = w => `${w}${finalConsonant(w) === 'o' ? '으로' : '로'}`;
const applyTitle = reason => `[${APPLY_FORM}] ${ro(String(reason).trim())} 인한 출장의 건`;
const reportTitle = reason => `[${REPORT_FORM}] ${ro(String(reason).trim())} 인한 출장 보고의 건`;

// ---------- 교통비 (네이버 지도) ----------
const toNum = s => Number(String(s).replace(/,/g, ''));
/** '통행료 7,100원 | 연료비 30,307원' → {fuel, toll} */
function parseCarText(text) {
  const fuel = /연료비\s*([\d,]+)\s*원/.exec(text);
  if (!fuel) return null;
  const toll = /통행료\s*([\d,]+)\s*원/.exec(text);
  return { fuel: toNum(fuel[1]), toll: toll ? toNum(toll[1]) : 0 };
}
/** 대중교통 상세의 총 요금 */
function parseTransitText(text) {
  const pats = [/(?:총\s*요금|요금\s*합계|카드\s*요금|총\s*금액)\s*:?\s*([\d,]+)\s*원/, /([\d,]+)\s*원\s*\(?\s*(?:카드|총)/];
  for (const p of pats) { const m = p.exec(text); if (m) return toNum(m[1]); }
  return null;
}
/** 자차 (연료비+통행료)×2, 대중교통 총요금×2, 원 단위 */
const roundTrip = oneWay => oneWay * 2;

// ---------- 입력 검증 ----------
function req(d, key, where) {
  const v = d ? d[key] : undefined;
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) throw new InputError(`${where}: '${key}' 값이 필요합니다.`);
  return v;
}
function amount(v, where) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  const s = String(v).replace(/[,\s원]/g, '');
  if (!/^\d+$/.test(s)) throw new InputError(`${where}: 금액은 숫자여야 합니다: ${v}`);
  return Number(s);
}
function date(v, key) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw new InputError(`'${key}' 날짜 형식은 YYYY-MM-DD 입니다: ${v}`);
  return s;
}
const asList = v => (v == null || v === '') ? [] : (typeof v === 'string' ? v.split(',') : v).map(s => String(s).trim()).filter(Boolean);
const shortLabel = item => BUDGET_ITEMS[item][1].split('_').pop();

function parseExpenses(rows, where = 'expenses', reason = '') {
  return (rows || []).map((r, i) => {
    const w = `${where}[${i + 1}]`;
    const item = req(r, 'item', w);
    if (!BUDGET_ITEMS[item]) throw new InputError(`${w}: 알 수 없는 item '${item}'. 가능: ${Object.keys(BUDGET_ITEMS).join(', ')}`);
    const memo = String(r.memo || '').trim() || `${reason} 출장 ${shortLabel(item)}`;
    return { item, amount: amount(req(r, 'amount', w), w), memo, code: BUDGET_ITEMS[item][0], label: BUDGET_ITEMS[item][1] };
  });
}

function parseApply(data) {
  const where = '신청서';
  const t = req(data, 'transport', where);
  const mode = req(t, 'mode', 'transport');
  if (!TRANSPORT_MODES[mode]) throw new InputError(`transport.mode 는 ${Object.keys(TRANSPORT_MODES).join(', ')} 중 하나입니다: ${mode}`);
  const car = String(t.corporate_car || '');
  if (mode === 'corporate' && car && !CORPORATE_CARS.includes(car)) throw new InputError(`corporate_car 는 ${CORPORATE_CARS.join(', ')} 중 하나입니다.`);
  const transport = {
    mode, to: String(t.to || ''), from: String(t.from || ''), corporate_car: car,
    check: asList(t.check).length ? asList(t.check) : TRANSPORT_MODES[mode].check,
    total: (t.total === undefined || t.total === null || t.total === '') ? null : amount(t.total, 'transport.total'),
    screenshot: String(t.screenshot || ''),
  };
  if (TRANSPORT_MODES[mode].autoFare && transport.total === null && !transport.to)
    throw new InputError('도착지(transport.to) 또는 교통비(transport.total)가 필요합니다.');

  const category = String(data.category || '일반');
  if (!APPLY_CATEGORIES.includes(category)) throw new InputError(`category 는 ${APPLY_CATEGORIES.join(', ')} 중 하나입니다.`);
  const dates = req(data, 'dates', where);
  const start = date(req(dates, 'start', 'dates'), '시작일'), end = date(req(dates, 'end', 'dates'), '종료일');
  if (end < start) throw new InputError('종료일이 시작일보다 빠릅니다.');
  const hm = (v, k) => { const t = String(v || '').trim(); if (t && !/^\d{1,2}:\d{2}$/.test(t)) throw new InputError(`${k}은 HH:MM 형식입니다: ${t}`); return t ? t.padStart(5, '0') : ''; };
  const startTime = hm(dates.start_time, '출발 시각'), endTime = hm(dates.end_time, '복귀 시각');
  if (!startTime || !endTime) throw new InputError('출발 시각과 복귀 시각은 필수예요. 식대 계산에 쓰여요.');
  if (start === end && startTime && endTime && endTime < startTime) throw new InputError('복귀 시각이 출발 시각보다 빠릅니다.');
  const reason = String(req(data, 'reason', where)).trim();
  const expenses = parseExpenses(data.expenses, 'expenses', reason);
  if (expenses.some(e => e.item === 'domestic_transport') && TRANSPORT_MODES[mode].autoFare)
    throw new InputError('국내교통비는 교통비 칸(네이버 지도 조회)으로 넣어 주세요. 경비 목록에서는 빼 주세요.');
  return {
    reason, destination: String(req(data, 'destination', where)).trim(), start, end, start_time: startTime, end_time: endTime,
    period: `${start.replace(/-/g, '.')} - ${end.replace(/-/g, '.')}`,
    category, project: String(data.project || ''), transport,
    companions: asList(data.companions), companion_purpose: String(data.companion_purpose || ''),
    purpose: String(req(data, 'purpose', where)).trim(), expenses,
  };
}

function parseReport(data) {
  const where = '보고서';
  const category = String(data.category || '기타');
  if (!REPORT_CATEGORIES.includes(category)) throw new InputError(`출장구분은 ${REPORT_CATEGORIES.join(', ')} 중 하나입니다.`);
  if (category === '정부과제' && !data.project) throw new InputError('정부과제는 과제명이 필수입니다.');
  const reason = String(req(data, 'reason', where)).trim();
  return {
    trip_id: String(data.trip_id || ''), reason, name: String(req(data, 'name', where)).trim(),
    companions: asList(data.companions), category, project: String(data.project || ''),
    period: String(req(data, 'period', where)), destination: String(req(data, 'destination', where)),
    visit_org: String(data.visit_org || ''), purpose: String(req(data, 'purpose', where)).trim(),
    report: String(req(data, 'report', where)).trim(),
    schedule: (data.schedule || []).map(r => ({ date: String(r.date || ''), place: String(r.place || ''), detail: String(r.detail || '').trim() })),
    expenses: parseExpenses(data.expenses, 'expenses', reason),
    attachments: (data.attachments || []).map(String),
  };
}

function transportExpense(a, total) {
  const memo = a.transport.mode === 'car' ? `${a.reason} 출장 유류비 및 통행료 (왕복)` : `${a.reason} 출장 대중교통비 (왕복)`;
  return { item: 'domestic_transport', amount: total, memo, code: BUDGET_ITEMS.domestic_transport[0], label: BUDGET_ITEMS.domestic_transport[1] };
}

// ---------- AI 프롬프트 ----------
function applyPrompt(today = new Date().toISOString().slice(0, 10)) {
  return `너는 레인보우로보틱스 출장신청서 입력 도우미야.
아래 [메모]를 읽고 YAML 하나만 출력해. 설명이나 다른 말은 쓰지 마.
오늘 날짜는 ${today} 이야. '다음주 화요일' 같은 표현은 실제 날짜로 바꿔.

규칙
- reason: 제목에 들어갈 출장 사유. 짧은 명사구. 끝에 '출장', '건'은 붙이지 마.
  (제목은 "[${APPLY_FORM}] {reason}로 인한 출장의 건" 으로 자동 생성됨)
- destination: 국내 출장지 이름 (예: 레인보우로보틱스 판교 AI 사무소)
- category: 일반 | 연구과제   (연구과제면 project 에 과제명)
- transport.mode: car(자차) | transit(대중교통) | corporate(법인차량)
- dates.start_time / end_time: 출발·복귀 시각 HH:MM ('저녁에 출발'→19:00, '3시 복귀'→15:00). 모르면 "" (식대 계산에 쓰임)
- transport.to: 네이버 지도에서 검색할 도착지 (주소나 장소명)
- 교통비는 앱이 네이버 지도로 계산하니 expenses 에 국내교통비를 넣지 마.
- expenses.item: domestic_lodging(국내숙박비) | meal(식대)
- 금액을 모르면 그 줄은 빼. 지어내지 마.
- purpose: 출장목적을 2~4문장의 업무 문체로 다듬어. 메모에 없는 사실은 추가하지 마.

출력 형식
\`\`\`yaml
reason: 판교 AI 사무소 RBY1-Muscat 연동 검증
destination: 레인보우로보틱스 판교 AI 사무소
dates: {start: 2026-09-28, start_time: "09:00", end: 2026-10-02, end_time: "18:00"}
category: 일반
project: ""
transport: {mode: car, to: 레인보우로보틱스 판교 AI 사무소}
companions: []
companion_purpose: ""
purpose: |
  판교 AI 연구소의 RBY1 로봇과 Muscat 플랫폼의 정식 연동을 위해 ...
expenses:
  - {item: domestic_lodging, amount: 280000, memo: 판교 AI 사무소 출장 숙박비}
  - {item: meal, amount: 190000, memo: 판교 AI 사무소 출장 식대}
\`\`\`

[메모]
`;
}

function reportPrompt(draft) {
  return `너는 레인보우로보틱스 출장보고서 작성 도우미야.
아래 [초안 YAML]의 빈 칸을 [메모]로 채워서 YAML 하나만 출력해. 설명은 쓰지 마.
- report: '출장시 담당업무 및 보고사항'. 수행 내용, 결과, 이슈, 후속 조치를 업무 문체로 정리.
- schedule: 날짜별 detail 에 그날 한 일(면담자, 협의사항)을 한두 문장으로.
- category: ${REPORT_CATEGORIES.join(' | ')}
- expenses 는 실제 쓴 금액으로 고쳐. 모르면 그대로 둬.
- 메모에 없는 사실은 지어내지 마.

[초안 YAML]
${yaml.dump(draft, { lineWidth: 1000 })}
[메모]
`;
}

/** AI 답변에서 \`\`\`yaml 블록(없으면 전체)을 꺼낸다 */
function extractYaml(text) {
  const m = /```(?:ya?ml)?\s*\n([\s\S]*?)```/.exec(text || '');
  const data = yaml.load(m ? m[1] : text, { schema: yaml.JSON_SCHEMA });
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InputError('YAML 을 읽지 못했습니다. AI 답변 전체를 그대로 붙여 넣어 주세요.');
  return data;
}

module.exports = {
  APPLY_FORM, REPORT_FORM, BUDGET_ITEMS, TRANSPORT_MODES, CORPORATE_CARS, APPLY_CATEGORIES, REPORT_CATEGORIES,
  InputError, ro, applyTitle, reportTitle, parseCarText, parseTransitText, roundTrip,
  parseApply, parseReport, parseExpenses, transportExpense, applyPrompt, reportPrompt, extractYaml,
};
