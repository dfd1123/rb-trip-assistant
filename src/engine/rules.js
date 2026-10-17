'use strict';
// 회사 규칙: 제목, 예산과목, 교통비 계산, 입력 검증. (그룹웨어/브라우저와 무관한 순수 로직)

const yaml = require('js-yaml');

const APPLY_FORM = '출장신청 및 출장경비 사전품의';
const REPORT_FORM = '출장보고서 및 경비정산 지출결의서';   // 결의서입력 → 결재상신 양식 (예전 '출장보고서 및 정산 품의서'는 안 씀)

// 예산과목 (사업코드도움에서 코드로 검색)
const BUDGET_ITEMS = {
  domestic_transport: ['8120002', '여비교통비(판)_국내교통비'],
  domestic_lodging: ['8120003', '여비교통비(판)_국내숙박비'],
  meal: ['8120004', '여비교통비(판)_식대'],
  overseas_transport: ['8120005', '여비교통비(판)_해외교통비'],
  overseas_lodging: ['8120006', '여비교통비(판)_해외숙박비'],
  airfare: ['8120007', '여비교통비(판)_항공권'],
  overseas_per_diem: ['8120008', '여비교통비(판)_해외일비'],
  travel_etc: ['8120001', '여비교통비(판)_기타'],   // 해외 로밍(여행잡비)·여행자 보험
};

const TRANSPORT_MODES = {
  car: { check: ['자차'], autoFare: true },
  transit: { check: ['기차', '버스'], autoFare: true },
  corporate: { check: ['법인차량'], autoFare: false },
  overseas: { check: [], autoFare: false },   // 해외출장: 국내 교통편 체크 없음 (항공·현지교통은 경비 줄로)
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
const reportTitle = reason => `[${REPORT_FORM}] ${String(reason).trim()} 출장 보고의 건`;   // 예: [출장보고서 및 경비정산 지출결의서] KAI 기술 지원 출장 보고의 건

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
  // 2026 네이버 지도: 총 요금 줄이 없고 첫 경로 블록에 구간별 "30분10,700원" 만 있다 → 첫 경로(첫 '상세보기' 전)의 구간 요금 합
  const first = text.split(/상세보기/)[0];
  const legs = [...first.matchAll(/(?:분|시간)\s*([\d,]+)\s*원/g)].map(m => toNum(m[1]));
  return legs.length ? legs.reduce((a, b) => a + b, 0) : null;
}
/** 자차 (연료비+통행료)×2, 대중교통 총요금×2, 원 단위 */
/** 품의 행 적요: 결재 제목에서 양식 이름과 '의 건'을 뺀 것 (예: "RBY1 정비로 인한 출장") */
const budgetMemo = title => String(title).replace(/^\[[^\]]*\]\s*/, '').replace(/의 건$/, '').trim();
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

const PROOF_EXT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|pdf)$/i;
function parseExpenses(rows, where = 'expenses', reason = '') {
  return (rows || []).map((r, i) => {
    const w = `${where}[${i + 1}]`;
    const item = req(r, 'item', w);
    if (!BUDGET_ITEMS[item]) throw new InputError(`${w}: 알 수 없는 item '${item}'. 가능: ${Object.keys(BUDGET_ITEMS).join(', ')}`);
    const memo = String(r.memo || '').trim() || `출장 ${shortLabel(item)}`;
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
  if (category === '연구과제' && !String(data.project || '').trim()) throw new InputError('연구과제는 과제명이 필수예요.');
  const dates = req(data, 'dates', where);
  const start = date(req(dates, 'start', 'dates'), '시작일'), end = date(req(dates, 'end', 'dates'), '종료일');
  if (end < start) throw new InputError('종료일이 시작일보다 빠릅니다.');
  const hm = (v, k) => { const t = String(v || '').trim(); if (t && !/^\d{1,2}:\d{2}$/.test(t)) throw new InputError(`${k}은 HH:MM 형식입니다: ${t}`); return t ? t.padStart(5, '0') : ''; };
  const startTime = hm(dates.start_time, '출발 시각'), endTime = hm(dates.end_time, '복귀 시각');
  if (!startTime || !endTime) throw new InputError('출발 시각과 복귀 시각은 필수예요. 식대 계산에 쓰여요.');
  if (start === end && startTime && endTime && endTime < startTime) throw new InputError('복귀 시각이 출발 시각보다 빠릅니다.');
  const reason = String(req(data, 'reason', where)).trim();
  const expenses = parseExpenses(data.expenses, 'expenses', reason);
  const scope = data.scope === '해외' || mode === 'overseas' ? '해외' : '국내';
  let overseas = null;
  if (scope === '해외') {
    const grade = String(data.grade || '');
    if (!OVERSEAS_GRADES.includes(grade)) throw new InputError('해외출장은 국가 등급(가·나)을 골라 주세요. 가 = 미국·유럽·캐나다·싱가포르, 나 = 그 외');
    const rate = Number(data.rate || 0);
    if (!(rate > 0)) throw new InputError('해외출장은 환율(USD)이 필요해요. [환율 조회]를 눌러 주세요.');
    overseas = { grade, rate, rateDate: String(data.rate_date || ''), rateShot: String(data.rate_shot || '') };
  }
  if (expenses.some(e => e.item === 'domestic_transport') && TRANSPORT_MODES[mode].autoFare)
    throw new InputError('국내교통비는 교통비 칸(네이버 지도 조회)으로 넣어 주세요. 경비 목록에서는 빼 주세요.');
  if (asList(data.companions).length && !String(data.companion_purpose || '').trim()) throw new InputError('동행자가 있으면 동행목적도 적어 주세요.');
  return {
    reason, destination: String(req(data, 'destination', where)).trim(), start, end, start_time: startTime, end_time: endTime,
    period: `${start.replace(/-/g, '.')} - ${end.replace(/-/g, '.')}`,
    category, project: String(data.project || ''), transport,
    companions: asList(data.companions), companion_purpose: String(data.companion_purpose || ''),
    purpose: String(req(data, 'purpose', where)).trim(), expenses, scope, overseas,
  };
}

// ---------- 해외출장 (출장여비지급규정 별첨 2·3, 부장 이하) ----------
const OVERSEAS_GRADES = ['가', '나'];
/** 등급별 1일 일비(식대 포함)·1박 숙박 한도, USD. 임원은 별도라 여기선 부장 이하 기준 */
const OVERSEAS_RATES = { 가: { perDiem: 90, lodging: 200 }, 나: { perDiem: 50, lodging: 150 } };
/** 임원: Business, 숙박 한도 가 $280·나 $265, 식대는 실비라 일비 없음 (규정 별첨 2) */
const OVERSEAS_RATES_EXEC = { 가: { perDiem: 0, lodging: 280 }, 나: { perDiem: 0, lodging: 265 } };
// 가 = 미국·유럽·캐나다·싱가포르 (도시 이름으로도). ponytail: 자주 가는 곳만 — 없으면 '나'로 보고 화면에서 바꿀 수 있음
const GRADE_A = /미국|USA|\bUS\b|뉴욕|샌프란|산호세|실리콘\s*밸리|LA\b|로스\s*앤젤레스|라스\s*베가스|시애틀|보스턴|시카고|디트로이트|오스틴|샌디에이고|워싱턴|휴스턴|댈러스|애틀랜타|피닉스|덴버|캐나다|토론토|밴쿠버|몬트리올|싱가포르|유럽|영국|런던|프랑스|파리|독일|베를린|뮌헨|프랑크푸르트|하노버|함부르크|슈투트가르트|쾰른|뒤셀도르프|이탈리아|로마|밀라노|스페인|마드리드|바르셀로나|네덜란드|암스테르담|벨기에|브뤼셀|스위스|취리히|제네바|오스트리아|빈|스웨덴|스톡홀름|노르웨이|오슬로|덴마크|코펜하겐|핀란드|헬싱키|포르투갈|리스본|아일랜드|더블린|폴란드|바르샤바|체코|프라하|헝가리|부다페스트|그리스|아테네/i;
const OVERSEAS_HINT = /해외|국외|출국|비행기|항공권|공항|미국|일본|도쿄|오사카|중국|상하이|베이징|선전|대만|타이베이|베트남|하노이|호치민|태국|방콕|인도|싱가포르|말레이시아|인도네시아|필리핀|호주|시드니|멜버른|두바이|사우디|이스라엘|멕시코|브라질|캐나다|유럽|영국|프랑스|독일|하노버|이탈리아|스페인|네덜란드|스위스|샌프란|뉴욕|라스\s*베가스|LA\b|CES|하노버\s*메세/i;
/** 메모·출장지로 해외 여부와 국가 등급 짐작 */
function overseasGuess(text) {
  const t = String(text || '');
  if (!OVERSEAS_HINT.test(t)) return { overseas: false, grade: '' };
  return { overseas: true, grade: GRADE_A.test(t) ? '가' : '나' };
}
const md = d => { const [, m, dd] = String(d).split('-'); return `${m}/${dd}`; };
/** 해외출장 품의 경비 줄. 적요 = "04/23~04/30 김종완 1인 해외출장 일비 신청($90 x 8일 x 1,480) - 신청일 환율 기준" (사전품의 작성 예시)
 *  환율은 원 단위로 반올림해 계산·표시 (예시와 같음). 비운 항목(null)은 빼고, 0 은 넣은 그대로 */
function overseasExpenses({ start, end, name, people = 1, grade, rate, rank = 'staff', rates = rank === 'exec' ? OVERSEAS_RATES_EXEC : OVERSEAS_RATES, airfare = null, lodging = null, uberUsd = null, roaming = null, insurance = null }) {
  const days = Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 864e5) + 1, nights = Math.max(0, days - 1);
  const r = Math.round(Number(rate) || 0), g = rates[grade] || OVERSEAS_RATES[grade];
  const pre = `${md(start)}~${md(end)} ${name} ${people}인 해외출장`, rf = r.toLocaleString('en-US');
  const out = [];
  if (airfare !== null) out.push({ item: 'airfare', amount: Number(airfare), memo: `${pre} 항공 비용` });
  if (g.perDiem) out.push({ item: 'overseas_per_diem', amount: g.perDiem * days * r * people, memo: `${pre} 일비 신청($${g.perDiem} x ${days}일 x ${rf}${people > 1 ? ` x ${people}인` : ''}) - 신청일 환율 기준` });
  if (lodging !== null) out.push({ item: 'overseas_lodging', amount: Number(lodging), memo: `${pre} 숙박 비용` });
  else if (nights) out.push({ item: 'overseas_lodging', amount: g.lodging * nights * r * people, memo: `${pre} 숙박 비용(한도 $${g.lodging} x ${nights}박 x ${rf}) - 신청일 환율 기준` });
  if (uberUsd !== null) out.push({ item: 'overseas_transport', amount: Number(uberUsd) * days * r, memo: `${pre} 우버 비용($${Number(uberUsd)} x ${days}일 x ${rf}) - 신청일 환율 기준` });
  if (roaming !== null) out.push({ item: 'travel_etc', amount: Number(roaming), memo: `${pre} 로밍 비용` });
  if (insurance !== null) out.push({ item: 'travel_etc', amount: Number(insurance), memo: `${pre} 여행자 보험 비용` });
  return { expenses: out, days, nights };
}

function parseReport(data) {
  const where = '보고서';
  const category = String(data.category || '기타');
  if (!REPORT_CATEGORIES.includes(category)) throw new InputError(`출장구분은 ${REPORT_CATEGORIES.join(', ')} 중 하나입니다.`);
  if (category === '정부과제' && !data.project) throw new InputError('정부과제는 과제명이 필수입니다.');
  const reason = String(req(data, 'reason', where)).trim();
  const out = {
    trip_id: String(data.trip_id || ''), reason, name: String(req(data, 'name', where)).trim(),
    companions: asList(data.companions), category, project: String(data.project || ''),
    period: String(req(data, 'period', where)), destination: String(req(data, 'destination', where)),
    visit_org: String(data.visit_org || ''), purpose: String(req(data, 'purpose', where)).trim(),
    report: String(req(data, 'report', where)).trim(),
    schedule: (data.schedule || []).map(r => ({ date: String(r.date || ''), place: String(r.place || ''), detail: String(r.detail || '').trim() })),
    expenses: parseExpenses(data.expenses, 'expenses', reason),
    attachments: (data.attachments || []).map(String),
  };
  if (!out.schedule.length || out.schedule.some(r => !r.detail)) throw new InputError('출장일정의 세부 활동 내용은 날짜마다 필수예요.');
  // 정산할 경비가 없을 수도 있다(전액 환원). 증빙도 없을 수 있다 — 화면에서 두 번 확인받고 넘어온다. 줄마다 증빙은 0~1개, 이미지·PDF만
  (data.expenses || []).forEach((e, i) => {
    const proofs = (e.proofs || []).map(String).filter(Boolean);
    if (proofs.length > 1) throw new InputError(`정산 경비 ${i + 1}번째 줄에는 증빙을 1개만 붙여 주세요.`);
    const bad = proofs.find(p => !PROOF_EXT.test(p));
    if (bad) throw new InputError(`증빙은 이미지나 PDF만 돼요: ${bad.split(/[\\/]/).pop()}`);
    out.expenses[i].proofs = proofs;
    out.expenses[i].pay = e.pay === 'card' ? 'card' : 'personal';
    out.expenses[i].noVat = noVatOf({ ...out.expenses[i], noVat: e.noVat });   // 법인카드 면세·불공제 (화면에서 고친 값 우선)
  });
  out.fund = String(data.fund || '');   // 자금과목: 일반경비 / 제조경비 (출장마다 사람이 고름)
  if (!FUNDS.includes(out.fund)) throw new InputError('자금과목(일반경비·제조경비)을 골라 주세요.');
  out.attachments = [...new Set([...out.attachments, ...out.expenses.flatMap(e => e.proofs)])];
  return out;
}

// ---------- 결의서전송(지출결의) 규칙 ----------
const FUNDS = ['일반경비', '제조경비'];
/** 결제수단별 예산 줄 결제수단·과세구분: 개인경비 = 외상+기타, 법인카드 = 신용카드+과세 (사용자 설명, 2026-10-16 재확인) */
const PAY_MODES = { personal: { method: '외상', tax: '기타' }, card: { method: '신용카드', tax: '과세' } };
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// 공휴일 (주말 아닌 날만 의미 있음). ponytail: 2026~2027 목록만 — 해가 바뀌면 여기에 추가 (음력 명절·대체공휴일·선거일은 해마다 다름)
const HOLIDAYS = new Set([
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-05', '2026-05-25', '2026-06-03', '2026-08-17',
  '2026-09-24', '2026-09-25', '2026-09-28', '2026-10-05', '2026-10-09', '2026-12-25',
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-01', '2027-05-05', '2027-05-13', '2027-08-16', '2027-09-14', '2027-09-15', '2027-09-16',
  '2027-10-04', '2027-10-11', '2027-12-27',
]);
const workday = d => d.getDay() !== 0 && d.getDay() !== 6 && !HOLIDAYS.has(ymd(d));
/** 그날이 주말·공휴일이면 바로 전 평일 */
const prevWorkday = d => { const x = new Date(d); while (!workday(x)) x.setDate(x.getDate() - 1); return x; };
/** 자금계획일 (올리는 날 기준). 개인경비 = 정기자금일: 1~9일 → 10일, 10~19일 → 20일, 20~24일 → 25일, 25일~말일 → 다음 달 10일.
 *  정기자금일이 주말·공휴일이면 바로 전 평일. 법인카드 = 사용한 달의 다음 달 23일 */
function fundPlanDate(pay, { today = new Date(), usedOn = '' } = {}) {
  if (pay === 'card') { const b = usedOn ? new Date(`${usedOn}T00:00:00`) : today; return ymd(new Date(b.getFullYear(), b.getMonth() + 1, 23)); }
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  const pay_ = d < 10 ? new Date(y, m, 10) : d < 20 ? new Date(y, m, 20) : d < 25 ? new Date(y, m, 25) : new Date(y, m + 1, 10);
  return ymd(prevWorkday(pay_));
}
/** 채주 금액은 공급가액만 넣는다(부가세·총액은 그룹웨어가 계산). 과세(법인카드)면 합계에서 부가세(합계/11, 버림)를 뺀다 */
// 부가세: 개인카드 = 공급가액만(부가세 없음). 법인카드 = 과세면 공급가액+부가세(합계/11, 버림), 면세·불공제(항공권·주유비 등)면 부가세 0
const NO_VAT = /항공|주유|유류|기름|휘발유|경유|LPG|면세|불공제/i;
const noVatOf = e => (e.noVat === true || e.noVat === false) ? e.noVat : (e.item === 'airfare' || NO_VAT.test(String(e.memo || '')));
const vatAmount = (total, pay, noVat) => pay === 'card' && !noVat ? Math.floor(total / 11) : 0;
const supplyAmount = (total, pay, noVat = false) => total - vatAmount(total, pay, noVat);
/** 품의한 금액보다 많이 청구할 수 없다: 예산 줄 한도(limit) 안에서 앞 영수증부터 채우고 넘는 만큼 깎는다. 한도를 다 쓰면 나머지 줄은 뺀다
 *  예) 교통비 품의 60,000 · 실제 79,000 → 공급가액 60,000 */
function capToBudget(lines, limit) {   // 한도는 합계(부가세 포함) 기준. 깎은 합계로 공급가액을 다시 계산
  let left = Math.max(0, Number(limit) || 0);
  return lines.map(l => { const amount = Math.min(l.amount, left); left -= amount; return { ...l, amount, supply: supplyAmount(amount, l.pay, l.noVat), vat: vatAmount(amount, l.pay, l.noVat), cut: l.amount - amount }; }).filter(l => l.amount > 0);
}
/** 예산 줄마다 넣을 채주: 같은 예산과목 영수증을 모아 품의 한도까지 → [{ index, label, lines, cut }]. 예산에 없는 과목은 left 로
 *  budgets: [{ 예산과목, 품의금액, 미지출액 }] (결의서전송 창 예산내역 그대로) */
function planPayees(budgets, lines) {
  const n = s => String(s || '').replace(/\s/g, '');
  const num = v => Number(String(v || '').replace(/[^\d]/g, '')) || 0;
  const plan = budgets.map((b, index) => {
    const mine = lines.filter(l => n(l.label) === n(b['예산과목']));
    const limit = num(b['미지출액']) || num(b['품의금액']);
    const capped = capToBudget(mine, limit);
    return { index, label: b['예산과목'], limit, lines: capped, dropped: mine.length - capped.length };
  });
  const left = lines.filter(l => !budgets.some(b => n(b['예산과목']) === n(l.label)));
  return { plan, left };
}

/** 신청 교통비 = 네이버 지도 왕복 + 여유분(자차·대중교통, 기본 2만원). 보고서 정산은 실제 금액으로 */
function transportExpense(a, total, margin = 0) {
  const extra = (a.transport.mode === 'car' || a.transport.mode === 'transit') ? Math.max(0, Number(margin) || 0) : 0;
  const base = a.transport.mode === 'car' ? '출장 유류비 및 통행료 (왕복' : '출장 대중교통비 (왕복';
  const memo = `${base}${extra ? ` + 여유 ${extra.toLocaleString('ko-KR')}원` : ''})`;
  return { item: 'domestic_transport', amount: total + extra, memo, code: BUDGET_ITEMS.domestic_transport[0], label: BUDGET_ITEMS.domestic_transport[1] };
}

// ---------- AI 프롬프트 ----------
function applyPrompt(today = new Date().toISOString().slice(0, 10)) {
  return `너는 레인보우로보틱스 출장신청서 입력 도우미야.
아래 [메모]를 읽고 YAML 하나만 출력해. 설명이나 다른 말은 쓰지 마.
오늘 날짜는 ${today} 이야. '다음주 화요일' 같은 표현은 실제 날짜로 바꿔.

규칙
- reason: 제목에 들어갈 출장 사유. 짧은 명사구. 끝에 '출장', '건'은 붙이지 마.
  (제목은 "[${APPLY_FORM}] {reason}로 인한 출장의 건" 으로 자동 생성됨)
- destination: 국내 출장지의 정식 이름. 약칭·영문 약자는 풀어서 (예: KAI → 한국항공우주산업, 레인보우로보틱스 판교 AI 사무소). 주소는 지어내지 마 (앱이 네이버 지도에서 붙임)
- category: 일반 | 연구과제   (연구과제면 project 에 과제명)
- transport.mode: car(자차) | transit(대중교통) | corporate(법인차량)
- dates.start_time / end_time: 출발·복귀 시각 HH:MM ('저녁에 출발'→19:00, '3시 복귀'→15:00). 모르면 "" (식대 계산에 쓰임)
- transport.to: 네이버 지도에서 검색할 도착지 (정식 장소명이나 주소. 약자 말고 풀네임, 예: 한국항공우주산업)
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
  - {item: domestic_lodging, amount: 140000, memo: 출장 숙박비 (2박 × 70,000원)}
  - {item: meal, amount: 106000, memo: 출장 식대 (아침 2회, 점심 3회, 저녁 3회)}
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
  InputError, ro, applyTitle, reportTitle, budgetMemo, parseCarText, parseTransitText, roundTrip,
  parseApply, parseReport, parseExpenses, transportExpense, applyPrompt, reportPrompt, extractYaml,
  OVERSEAS_GRADES, OVERSEAS_RATES, OVERSEAS_RATES_EXEC, overseasGuess, overseasExpenses,
  FUNDS, PAY_MODES, fundPlanDate, supplyAmount, vatAmount, noVatOf, capToBudget, planPayees,
};
