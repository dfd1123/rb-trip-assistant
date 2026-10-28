'use strict';
const { placeTokens, AMBIGUOUS_PLACES } = require('./rules');
// "한 줄 메모" → 신청서 입력값. AI 없이 동작하는 규칙 파서 + 회사 규정 경비 계산.
// AI 키가 있으면 ai.js 가 사유·목적 문장을 더 자연스럽게 다듬고, 금액은 항상 여기 규칙으로 계산한다.

const DEFAULT_RATES = { lodgingPerNight: 70000, breakfast: 8000, lunch: 15000, dinner: 15000 };
// 끼니 시간대: 첫날은 출발이 시작 시각 이전이면, 마지막 날은 복귀가 끝 시각 이후면 그 끼니를 넣는다
const DEFAULT_MEAL_TIMES = { breakfast: ['07:00', '08:00'], lunch: ['12:00', '13:00'], dinner: ['18:00', '19:00'] };
const MEALS = [['breakfast', '아침'], ['lunch', '점심'], ['dinner', '저녁']];
const toMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };

// ---------- 날짜 ----------
const DOW = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 0 };
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));

const WEEKDAY_PAREN = /\s*\(\s*[월화수목금토일](?:요일)?\s*\)/g;
/** 월/일만 있을 때: 오늘보다 많이 지난 날짜면 내년으로 */
function md(today, m, d) {   // 60일 전 ~ 그 뒤 1년 안의 날짜로 (1월에 쓴 "12/30"은 작년 12월)
  const y = today.getFullYear(), lo = addDays(today, -60);
  return [y - 1, y, y + 1].map(yy => new Date(yy, m - 1, d)).find(c => c >= lo);
}

/**
 * 예) 다음주 화~목 / 이번주 수 / 10/20~22 / 10.20-10.22 / 10월 20일~22일 / 10월 20일부터 2박3일 / 내일 / 모레 당일
 * @returns {{start, end, matched: string[]}}
 */
function parseDates(text, today = new Date()) {
  today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  text = String(text || '').replace(WEEKDAY_PAREN, '');   // "10/27(화)~10/29(목)" 의 요일 괄호는 날짜 사이를 끊는다
  const matched = [];
  let start = null, end = null, m;

  // 주 단위: (이번|다음|다다음)주 X(요일)? (~|부터) Y(요일)?
  if ((m = /(이번\s*주|금주|다음\s*주|차주|다다음\s*주)\s*([월화수목금토일])(?:요일)?(?:날)?(?:\s*(?:~|-|부터|에서)\s*([월화수목금토일])(?:요일)?(?:날)?)?(?:부터|까지|에서|에|날)?(?![가-힣])/.exec(text))) {   // 요일 뒤 조사(에·까지·부터·날)는 날짜로 소비, 그 밖의 한글이 붙으면 요일 아님 (다음주 일본·수원)
    const w = m[1].replace(/\s/g, '');
    const offset = w === '다다음주' ? 14 : (w === '다음주' || w === '차주') ? 7 : 0;
    const mon = addDays(mondayOf(today), offset);
    const at = c => addDays(mon, (DOW[c] + 6) % 7);
    start = at(m[2]); end = m[3] ? at(m[3]) : start; matched.push(m[0]);
    if (end < start) end = addDays(end, 7);   // "금~월": 주말을 넘김 (월~금으로 뒤집지 않음)
    if (!m[3]) {   // "다음주 화 저녁 출발 목 3시 복귀" 처럼 끝 요일이 떨어져 있는 경우
      const rest = text.slice(m.index + m[0].length);
      const e2 = /(?:^|[\s~\-])([월화수목금토일])(?:요일)?(?=[\s\d~]|$|까지|에)/.exec(rest);
      if (e2) { end = at(e2[1]); if (end < start) end = addDays(end, 7); matched.push(e2[0].trim()); }
    }
  }
  // 2026-10-20 ~ 2026-10-22 / 2026.10.20~22
  else if ((m = /(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?:\s*(?:~|-|부터)\s*(?:(?:\d{4})\s*[-./]\s*)?(?:(\d{1,2})\s*[-./]\s*)?(\d{1,2})(?!\s*박))?/.exec(text))) {
    start = new Date(+m[1], +m[2] - 1, +m[3]);
    end = m[5] ? new Date(+m[1], (m[4] ? +m[4] : +m[2]) - 1, +m[5]) : start; matched.push(m[0]);
  }
  // 10/20~22, 10/20~10/22, 10.20-22
  else if ((m = [...text.matchAll(/(?<![A-Za-z\d.])(\d{1,2})\s*[\/.]\s*(\d{1,2})(?!\d|\.\d|\s*(?:km|㎞|키로|kg|%))(?:\s*(?:~|-|부터)\s*(?:(\d{1,2})\s*[\/.]\s*)?(\d{1,2})(?!\s*박))?/g)]
      .find(x => +x[1] >= 1 && +x[1] <= 12 && +x[2] >= 1 && +x[2] <= 31))) {   // 'v2.3'·'5.5km'·'13/5' 는 날짜 아님
    start = md(today, +m[1], +m[2]);
    end = m[4] ? md(today, m[3] ? +m[3] : +m[1], +m[4]) : start; matched.push(m[0]);
    if (!m[4]) {   // 끝 날짜가 떨어져 있는 경우 ("10/27 13시 출발 10/28 21시 복귀"). 31일 안쪽만 (거리 "10.5km" 같은 숫자 오인 방지)
      const e2 = /(?<![\d.])(\d{1,2})\s*[\/.]\s*(\d{1,2})(?![\d.]|\s*(?:km|㎞|키로|kg|%))/.exec(text.slice(m.index + m[0].length));
      if (e2 && +e2[1] >= 1 && +e2[1] <= 12 && +e2[2] >= 1 && +e2[2] <= 31) {
        const e = md(today, +e2[1], +e2[2]); const gap = (e - start) / 86400000;
        if (gap > 0 && gap <= 31) { end = e; matched.push(e2[0]); }
      }
    }
  }
  // 10월 20일~22일 / 10월 20일부터 11월 2일까지
  else if ((m = /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일?(?:\s*(?:~|-|부터)\s*(?:(\d{1,2})\s*월\s*)?(\d{1,2})(?!\s*박)\s*일?(?:까지)?)?/.exec(text))) {
    const y = m[1] ? +m[1] : null;
    start = y ? new Date(y, +m[2] - 1, +m[3]) : md(today, +m[2], +m[3]);
    end = m[5] ? (y ? new Date(y, (m[4] ? +m[4] : +m[2]) - 1, +m[5]) : md(today, m[4] ? +m[4] : +m[2], +m[5])) : start; matched.push(m[0]);
  }
  // 오늘/내일/모레
  else if ((m = /(오늘|내일|모레|글피)/.exec(text))) {
    start = addDays(today, { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[1]]); end = start; matched.push(m[0]);
  }
  // 월 없이 16일(날) / 16~18일 / 16일부터 18일까지 → 이번 달(지났으면 다음 달)
  else if ((m = /(?<![A-Za-z\d.\/월박]\s*)(\d{1,2})\s*(?:일(?:날)?\s*(?:(?:~|-|부터)\s*(\d{1,2})\s*일(?:날)?(?:까지)?)?|(?:~|-|부터)\s*(\d{1,2})\s*일(?:날)?(?:까지)?)(?!\s*(?:간|동안))/.exec(text)) && +m[1] >= 1 && +m[1] <= 31) {
    const e = m[2] || m[3];
    let mon = today.getMonth() + 1;
    if (+m[1] < today.getDate()) mon = mon === 12 ? 1 : mon + 1;
    start = md(today, mon, +m[1]);
    end = e ? md(today, +e < +m[1] ? (mon === 12 ? 1 : mon + 1) : mon, +e) : start; matched.push(m[0]);
  }
  if (end && start && end < start) {
    const next = new Date(end.getFullYear() + 1, end.getMonth(), end.getDate());
    if ((next - start) / 86400000 <= 31) end = next; else [start, end] = [end, start];
  }

  // N박M일 / N일간 (시작일 기준)
  if ((m = /(\d+)\s*박\s*(\d+)\s*일/.exec(text))) { if (start) end = addDays(start, +m[2] - 1); matched.push(m[0]); }
  else if ((m = /(\d+)\s*일\s*(?:간|동안)/.exec(text))) { if (start) end = addDays(start, +m[1] - 1); matched.push(m[0]); }
  if (/당일/.test(text)) { if (start) end = start; matched.push('당일'); }

  return start ? { start: iso(start), end: iso(end), matched } : { start: '', end: '', matched };
}

// ---------- 시각 ----------
const WORD_TIME = [[/새벽/, '06:00'], [/아침\s*일찍|이른\s*아침|첫\s*차/, '06:30'], [/아침|오전\s*일찍/, '08:00'], [/점심\s*먹고|점심\s*후|점심\s*이후/, '13:00'],
  [/점심/, '11:30'], [/오전/, '10:00'], [/오후\s*늦게/, '16:00'], [/오후/, '14:00'], [/저녁\s*(?:먹고|식사\s*(?:하고|후)|이후)/, '20:30'], [/퇴근\s*(후|하고)|저녁/, '19:00'], [/밤/, '21:00']];
function clock(seg, morning = false) {   // morning: 오전/오후 없는 1~6시를 오전으로 (당일 출장에서 출발이 복귀보다 늦게 읽힐 때 다시 읽음)
  // 구간에 시각이 여러 개면 출발/복귀 바로 앞의 마지막 것을 쓴다 ("오전 9시 출발 18시 복귀" → 복귀 18:00)
  const all = [...seg.matchAll(/(오전|오후|저녁|밤|아침|새벽)?\s*(?<![A-Za-z\d.])(\d{1,2})\s*(?::\s*(\d{2})|시(?!간)(?:\s*(\d{1,2})\s*분|\s*(반))?)/g)];   // "3.5시간"·"2시간"·"RBY1 시연"·"K5 시험" 은 시각 아님
  if (all.length) {
    const m = all[all.length - 1];
    let h = +m[2]; const mi = m[3] ? +m[3] : m[4] ? +m[4] : m[5] ? 30 : 0;
    if (/저녁|밤/.test(m[1] || '') && h === 12) return '23:59';   // 밤 12시 = 자정 (낮 12시 아님)
    if (/오후|저녁|밤/.test(m[1] || '') && h < 12) h += 12;
    else if (!m[1] && h >= 1 && h <= 6 && !morning) h += 12;   // "3시 복귀" → 15시 (오전/오후 없는 1~6시는 오후로 봄)
    return `${pad(h)}:${pad(mi)}`;
  }
  let best = null;    // 단어 시각도 마지막에 나온 것
  for (const [re, t] of WORD_TIME)
    for (const mm of seg.matchAll(new RegExp(re.source, 'g')))
      if (!best || mm.index > best.i || (mm.index === best.i && mm[0].length > best.n)) best = { i: mm.index, n: mm[0].length, t };
  if (best) return best.t;
  return '';
}
/** "화 19시 출발 ~ 목 15시 복귀", "저녁에 출발", "오후 3시 도착" → {startTime, endTime} */
function parseTimes(text, am = false) {
  let startTime = '', endTime = '';
  const DEP = '출발|가서|떠나', RET = '복귀|귀가|귀사|도착해서\\s*퇴근|돌아옴|돌아와';
  const dep = new RegExp(`([^,~\\-]{0,14}?)\\s*(?:에|부터)?\\s*(?:${DEP})`).exec(text);
  const ret = new RegExp(`([^,~\\-]{0,14}?)\\s*(?:에|까지)?\\s*(?:${RET})`).exec(text);
  // 낱말 바로 뒤의 시각 ("출발 9:00 복귀 17:30", "출발: 오전 9시") — 다음 낱말 전까지만
  const after = (re, stop) => { const m = new RegExp(`(?:${re})(?:\\s*(?:시간|시각))?\\s*(?:은|는)?\\s*[:：]?\\s*((?:오전|오후|저녁|밤|아침|새벽)?\\s*\\d{1,2}\\s*(?::\\s*\\d{2}|시(?:\\s*\\d{1,2}\\s*분|\\s*반)?))`).exec(text);
    return m && !new RegExp(stop).test(text.slice(m.index, m.index + m[0].length).replace(new RegExp(`^(?:${re})`), '')) ? clock(m[1], re === DEP && am) : ''; };
  const depAfter = after(DEP, RET), retAfter = after(RET, DEP);
  if (depAfter && retAfter) return { startTime: depAfter, endTime: retAfter };   // 낱말이 앞에 오는 꼴
  if (dep) startTime = clock(dep[1], am) || depAfter;
  if (ret) endTime = clock(ret[1].replace(new RegExp(`^.*(?:${DEP})`), '')) || retAfter;   // 복귀 앞 구간에서 출발 뒤 시각은 출발 것이라 뺌
  if (!dep && !ret) {                     // "화 19시~목 15시" 처럼 시각만 두 개
    const all = [...text.matchAll(/(?:오전|오후|저녁|밤|아침)?\s*(?<![A-Za-z\d.])\d{1,2}\s*(?::\s*\d{2}|시(?!간)(?:\s*\d{1,2}\s*분|\s*반)?)/g)];
    const times = all.map((m, i) => clock(m[0], am && i === 0));
    if (times[0]) startTime = times[0];
    if (times[1]) endTime = times[1];
  }
  return { startTime, endTime };
}

// ---------- 교통편 / 동행자 ----------
const CARS = ['스타렉스', '스포티지(2550)', '스포티지(5717)', '스포티지(5718)', '그랜져', '캐스퍼', 'QM6', 'K5'];
function parseMode(text) {
  const car = CARS.find(c => text.includes(c.replace(/\(.*\)/, '')) && (c.includes('(') ? text.includes(c.match(/\((\d+)\)/)[1]) : true));
  if (/법인\s*차|회사\s*차|법인\s*차량/.test(text) || car) return { mode: 'corporate', corporate_car: car || '', matched: [] };
  if (/KTX|SRT|기차|열차|대중\s*교통|버스|지하철|고속버스|ITX/i.test(text)) return { mode: 'transit', matched: [] };
  if (/자차|자가용|내\s*차|차\s*로|운전|자동차/.test(text)) return { mode: 'car', matched: [] };
  return { mode: '', matched: [] };
}
const NOT_NAMES = /자차|기차|버스|열차|법인|차량|검증|미팅|회의|지원|출장|업무|당일|스타렉스|스포티지|그랜져|캐스퍼|렉스/;
function parseCompanions(text) {
  let m = /동행(?:자)?\s*[:：]\s*([가-힣]{2,4}(?:\s*[,、]\s*[가-힣]{2,4})*)/.exec(text);
  if (m) return m[1].split(/[,、]/).map(s => s.trim()).filter(Boolean);
  m = /([가-힣]{2,3}?)(?:님)?\s*(?:이랑|랑|하고|와|과)\s*(?:같이|함께|동행)/.exec(text);
  if (m) {
    const names = [m[1]];
    const before = text.slice(0, m.index).match(/(?:^|[^가-힣])([가-힣]{2,3})\s*(?:님)?\s*[,、]\s*$/);   // "김철수, 홍길동이랑 같이" (낱말 경계에서만: '스타렉스,'의 '타렉스' 아님)
    if (before && !NOT_NAMES.test(before[1])) names.unshift(before[1]);
    return names;
  }
  return [];
}
const COMPANION_RE = /(?:(?<![가-힣])[가-힣]{2,3}\s*(?:님)?\s*[,、]\s*)?(?<![가-힣])[가-힣]{2,3}?(?:님)?\s*(?:이랑|랑|하고|와|과)\s*(?:같이|함께|동행)|동행(?:자)?\s*[:：]\s*[가-힣,、\s]+/g;

// ---------- 장소 ----------
/** places: [{name, to?, aliases:[]}] 중 메모에 나온 것 */
function matchPlace(text, places) {
  let best = null;
  for (const p of places) {
    for (const key of [p.name, ...(p.aliases || [])]) {
      if (key && text.replace(/\s/g, '').includes(key.replace(/\s/g, '')) && (!best || key.length > best.len)) best = { place: p, len: key.length, key };
    }
  }
  return best;
}
const PLACE_SUFFIX = /((?:[가-힣A-Za-z0-9()]+\s){0,3}[가-힣A-Za-z0-9()]*(?:사무소|연구소|연구원|공장|센터|본사|지사|캠퍼스|대학교|대학|전시장|병원|공단|청사|작업장|사업장|사옥|빌딩|타워|공항))/;
const PLACE_STOP = /^(?:.*\s)?(?:설치|지원|점검|미팅|회의|시험|검증|출장|업무|방문|참석|참관|교육|데모|협의|테스트|정비|수리|이동)\s/;   // "설치 지원 공장" 처럼 업무 낱말 뒤부터만 장소
const VENUES = [['KINTEX', '킨텍스', '일산 킨텍스'], ['킨텍스', '킨텍스', '일산 킨텍스'], ['COEX', '코엑스', '삼성동 코엑스'], ['코엑스', '코엑스', '삼성동 코엑스'], ['BEXCO', '벡스코', '부산 벡스코'], ['벡스코', '벡스코', '부산 벡스코']];
// 해외 출장지: 도시·나라 이름 (도시를 먼저 — "미국 라스베이거스" 면 라스베이거스). 국내 장소를 못 찾았을 때만
const OVERSEAS_PLACES = ['뉴욕', '샌프란시스코', '샌프란', '산호세', '실리콘밸리', '로스앤젤레스', '라스베이거스', '라스베가스', '시애틀', '보스턴', '시카고', '디트로이트', '오스틴', '샌디에이고', '휴스턴', '댈러스', '애틀랜타', '토론토', '밴쿠버', '몬트리올',
  '런던', '파리', '베를린', '뮌헨', '프랑크푸르트', '하노버', '함부르크', '슈투트가르트', '쾰른', '뒤셀도르프', '로마', '밀라노', '마드리드', '바르셀로나', '암스테르담', '브뤼셀', '취리히', '제네바', '스톡홀름', '코펜하겐', '헬싱키', '프라하', '바르샤바', '부다페스트',
  '도쿄', '오사카', '나고야', '후쿠오카', '상하이', '베이징', '광저우', '홍콩', '타이베이', '하노이', '호치민', '방콕', '쿠알라룸푸르', '자카르타', '마닐라', '시드니', '멜버른', '두바이', '리야드',
  '미국', '캐나다', '싱가포르', '영국', '프랑스', '독일', '이탈리아', '스페인', '네덜란드', '벨기에', '스위스', '오스트리아', '스웨덴', '덴마크', '핀란드', '폴란드', '체코', '헝가리', '일본', '중국', '대만', '베트남', '태국', '인도네시아', '말레이시아', '필리핀', '호주', '멕시코', '브라질', '사우디', '이스라엘'];
const looseRe = key => new RegExp([...key.replace(/\s/g, '')].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'gi');
const strip = (s, key) => key ? s.replace(looseRe(key), ' ') : s;

// ---------- 경비 ----------
function nightsDays(start, end) {
  const d = Math.round((new Date(end + 'T00:00:00') - new Date(start + 'T00:00:00')) / 86400000) + 1;
  return { days: d, nights: Math.max(0, d - 1) };
}
/** 날짜별 끼니 — 출장여비지급규정 별첨 1 (국내출장 지급기준표, 2026.05.12)
 *  당일 출장: 중식. 오전 7시 이전 출발이면 조식, 복귀가 20시를 넘으면 석식. 13시 이후 출발이면 중식 없음(본사 중식 제공)
 *  1박 이상: 첫날 중식·석식(13시 이후 출발이면 중식 없음) / 중간 날 조식·중식·석식 / 마지막 날 조식·중식(복귀가 20시를 넘으면 석식도)
 *  시각이 없으면 시각 조건 없이 위 기본만 */
const RULE_T = { breakfastBefore: 7 * 60, lunchDepartLimit: 13 * 60, lunchReturnAfter: 12 * 60, dinnerReturnAfter: 20 * 60 };
function mealPlan({ start, end, startTime = '', endTime = '' }) {
  const { days } = nightsDays(start, end);
  const dep = toMin(startTime), ret = toMin(endTime);
  const noLunchByDep = dep !== null && dep >= RULE_T.lunchDepartLimit;
  const plan = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(new Date(start + 'T00:00:00'), i), first = i === 0, last = i === days - 1;
    const m = new Set();
    if (days === 1) {
      if (dep !== null && dep < RULE_T.breakfastBefore) m.add('breakfast');
      if (!noLunchByDep && !(ret !== null && ret < RULE_T.lunchReturnAfter)) m.add('lunch');
      if (ret !== null && ret > RULE_T.dinnerReturnAfter) m.add('dinner');
    } else if (first) { if (!noLunchByDep) m.add('lunch'); m.add('dinner'); }
    else if (last) { m.add('breakfast'); if (!(ret !== null && ret < RULE_T.lunchReturnAfter)) m.add('lunch'); if (ret !== null && ret > RULE_T.dinnerReturnAfter) m.add('dinner'); }
    else { m.add('breakfast'); m.add('lunch'); m.add('dinner'); }
    plan.push({ date: iso(d), meals: MEALS.map(([k]) => k).filter(k => m.has(k)) });
  }
  return plan;
}
const KO = Object.fromEntries(MEALS);
function mealSummary(plan) {
  return plan.map(p => `${+p.date.slice(5, 7)}/${+p.date.slice(8)} ${p.meals.length ? p.meals.map(m => KO[m]).join('·') : '없음'}`).join(' · ');
}

/** 숙박 1박 7만 × (일수−1), 식대는 시각 기준 끼니별 단가 합 */
function computeExpenses({ start, end, startTime = '', endTime = '', reason, rates = DEFAULT_RATES, rank = 'staff' }) {
  rates = { ...DEFAULT_RATES, ...(rates || {}) };
  if (rank === 'exec') rates = { ...rates, lodgingPerNight: rates.lodgingExec ?? 350000 };   // 임원 숙박 한도 35만 (규정 별첨 1)
  const { nights } = nightsDays(start, end);
  const plan = mealPlan({ start, end, startTime, endTime });
  const mealTotal = plan.reduce((s, p) => s + p.meals.reduce((a, m) => a + rates[m], 0), 0);
  const counts = MEALS.map(([k, ko]) => [ko, plan.filter(p => p.meals.includes(k)).length]).filter(([, n]) => n);
  const out = [];
  if (nights > 0) out.push({ item: 'domestic_lodging', amount: rates.lodgingPerNight * nights, memo: `출장 숙박비 (${nights}박 × ${rates.lodgingPerNight.toLocaleString('ko-KR')}원)` });
  if (mealTotal > 0) out.push({ item: 'meal', amount: mealTotal, memo: `출장 식대 (${counts.map(([ko, n]) => `${ko} ${n}회`).join(', ')})` });
  return { expenses: out, plan, summary: mealSummary(plan), timed: Boolean(startTime || endTime) };
}

// ---------- 문장 템플릿 (AI 없을 때) ----------
function cleanReason(text, removed) {
  let s = text.replace(COMPANION_RE, ' ');
  for (const r of [...removed].sort((a, b) => b.length - a.length)) s = s.replace(new RegExp(looseRe(r).source + '(에서|에|으로|로)?', 'gi'), ' ');
  s = s.replace(/\d{4}\s*년/g, ' ');
  for (const c of CARS) s = strip(s, c);
  s = s.replace(/당일/g, ' ')
    .replace(/(?:오전|오후|저녁|밤|아침|새벽)?\s*(?<![A-Za-z\d.])\d{1,2}\s*(?::\s*\d{2}|시(?!간)(?:\s*\d{1,2}\s*분|\s*반)?)\s*(?:에|까지|부터)?\s*(?:출발|복귀|귀가|귀사|도착|가서)?/g, ' ')
    .replace(/(^|\s)[~\-–](?=\s|$)/g, ' ')
    .replace(/(새벽|아침\s*일찍|이른\s*아침|아침|오전|점심\s*먹고|점심|오후\s*늦게|오후|퇴근\s*후|저녁|밤)\s*(?:에|까지|부터)?\s*(출발|복귀|귀가|귀사|가서)/g, ' ')
    .replace(/(출발|복귀|귀가|귀사|가서)/g, ' ');
  s = s.replace(/(이번\s*주|다음\s*주|다다음\s*주|금주|차주)/g, ' ')
    .replace(/(^|\s)[월화수목금토일](?:요일)?(?=\s|$)/g, ' ')
    .replace(/(자차|자가용|내\s*차로?|차로|운전해서|대중\s*교통|KTX|SRT|기차|열차|고속버스|버스|지하철|법인\s*차량?|회사\s*차)\s*(로|으로|타고)?\s*(이동|가서|감)?/gi, ' ')
    .replace(/\d{1,2}\s*월\s*(?:초순|중순|하순|초|말|중)/g, ' ')
    .replace(/(아침|점심|저녁)\s*(?:먹고|식사\s*(?:하고|후)|이후)/g, ' ')
    .replace(/,|。|(?<!\d)\.|\.(?!\d)/g, ' ')   // 숫자 사이 점(5.5km·v2.3)은 그대로
    .replace(/\s*(출장|으로|로)?\s*(갑니다|가요|감|예정|가야\s*함|가야해|다녀옴|다녀와요)\s*$/g, ' ')
    .replace(/(하러|하기\s*위해|하려고|하기\s*위한)\s*$/g, ' ')
    .replace(/([A-Za-z0-9])(에|에서|의)(?=\s)/g, '$1')
    .replace(/\s+출장\s*$/g, ' ')
    .replace(/(^|\s)(부터|까지|에서|에|로|으로)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return s.replace(/^(에서|에|로|으로|날|일날)\s+/, '').replace(/(^|\s)(날|일날)(?=\s)/g, ' ')
    .replace(/\s*(때문에|위해서|위해|건|하고)$/, '')
    .replace(/([가-힣A-Za-z0-9])(을|를)\s*(하러|하기|하려|)$/, '$1')     // "RBY1 정비를" → "RBY1 정비"
    .replace(/\s+/g, ' ').trim();
}
const hasFinal = w => { const c = [...String(w).trim()].pop() || ''; const code = c.codePointAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  return /[0136lmnLMN]$/.test(c); };
const eul = w => `${w}${hasFinal(w) ? '을' : '를'}`;
const gwa = w => `${w}${hasFinal(w) ? '과' : '와'}`;
function templatePurpose({ destination, reason, companions }) {
  const withWho = companions.length ? ` ${gwa(companions.join(', '))} 함께` : '';
  reason = strip(reason, destination).replace(/\s+/g, ' ').trim() || reason;
  const work = /업무|협의|미팅|회의|참관|참석|교육|설치|점검|지원|검증|시험|테스트/.test(reason.slice(-4)) ? reason : `${reason} 업무`;
  return `${destination}에서 ${eul(work)} 수행하기 위해${withWho} 출장을 신청합니다.`;
}

/**
 * 한 줄 메모 → 신청서 데이터 (금액 포함). AI 없이도 완결.
 * ctx: { today, places, defaults: {mode}, rates, origin }
 */
function quickApply(memo, ctx = {}) {
  const text = String(memo || '').trim().replace(WEEKDAY_PAREN, '');   // 날짜 뒤 요일 괄호는 처음부터 지워야 사유에서도 날짜가 빠진다
  const today = ctx.today || new Date();
  const places = ctx.places || [];
  const dates = parseDates(text, today);
  let times = parseTimes(text);
  // 당일 출장인데 출발이 복귀보다 늦으면 모순 → 오전/오후 없는 출발 시각을 오전으로 다시 읽음 ("6시 출발 13시 복귀")
  if (dates.start && dates.start === dates.end && times.startTime && times.endTime && times.startTime > times.endTime) {
    const t2 = parseTimes(text, true); if (t2.startTime && t2.startTime <= times.endTime) times = { ...times, startTime: t2.startTime };
  }
  const mode = parseMode(text);
  const companions = parseCompanions(text);
  const hit = matchPlace(text, places);
  let destination = hit ? hit.place.name : '';
  let to = hit ? (hit.place.to || hit.place.name) : '';
  const removed = [...dates.matched];
  if (hit) removed.push(hit.key, hit.place.name, ...(hit.place.aliases || []), ...hit.place.name.split(/\s+/).filter(w => w.length >= 2));
  if (!destination) {
    const v = VENUES.find(([k]) => looseRe(k).test(text));
    if (v) { destination = v[1]; to = v[2]; removed.push(v[0]); }
  }
  if (!destination) {   // 해외: 도시·나라 이름
    const toks = placeTokens(text), has = k => toks.has(k.toUpperCase());   // 낱말 단위로 (파리바게뜨 ≠ 파리)
    const sure = OVERSEAS_PLACES.filter(has).some(x => !AMBIGUOUS_PLACES.includes(x));   // '로마 피자'·'파리바게뜨'처럼 흔한 말과 같은 이름만 있으면 해외 아님
    const k = sure && OVERSEAS_PLACES.find(has);   // 목록 순서 = 도시 먼저
    if (k) { destination = k; to = ''; removed.push(...OVERSEAS_PLACES.filter(has)); }   // 나라 이름도 사유에서 뺌 ("미국 라스베이거스")
  }
  if (!destination) {
    let rest = text;
    for (const r of removed) rest = strip(rest, r);
    rest = rest.replace(/(오늘|내일|모레|글피|당일|이번\s*주|다음\s*주|다다음\s*주)/g, ' ').replace(/(출발|복귀|귀가|귀사|가서)/g, ' ')   // "월 출발 금 복귀 대전 공장" → '대전 공장'
      .replace(/(?<![A-Za-z\d.])\d{1,2}\s*(?::\s*\d{2}|시(?:\s*\d{1,2}\s*분|\s*반)?)/g, ' ');   // "9시~18시 판교 사무소" 의 18시
    const pm = PLACE_SUFFIX.exec(rest);
    if (pm) { destination = pm[1].replace(PLACE_STOP, '').trim(); to = destination; }
  }
  let reason = cleanReason(text, removed);
  const missing = [];
  if (!reason) { missing.push('사유'); reason = destination ? `${(hit && hit.key) || destination} 업무 협의` : ''; }
  if (!dates.start) missing.push('날짜');
  if (!times.startTime) missing.push('출발 시각');
  if (!times.endTime) missing.push('복귀 시각');
  if (!destination) missing.push('출장지');
  const m = mode.mode || (ctx.defaults && ctx.defaults.mode) || 'car';
  const data = {
    reason, destination, dates: { start: dates.start, end: dates.end, start_time: times.startTime, end_time: times.endTime }, category: '일반', project: '',
    transport: { mode: m, to, from: ctx.origin || '', ...(m === 'corporate' && mode.corporate_car ? { corporate_car: mode.corporate_car } : {}) },
    companions, companion_purpose: companions.length ? `${reason} 공동 수행` : '',
    purpose: destination && reason ? templatePurpose({ destination, reason, companions }) : '',
    expenses: dates.start && reason ? computeExpenses({ start: dates.start, end: dates.end, startTime: times.startTime, endTime: times.endTime, reason, rates: ctx.rates, rank: ctx.rank }).expenses : [],
  };
  return { data, missing };
}

/** 보고서 템플릿: 메모를 보고사항으로, 일정은 날짜별 기본 문구 */
function quickReport(draft, memo) {
  const lines = String(memo || '').split(/\n|(?<=[.。])\s+/).map(s => s.trim()).filter(Boolean);
  const report = lines.length ? lines.map(l => `- ${l.replace(/^[-•]\s*/, '')}`).join('\n') : '';
  const schedule = draft.schedule.map((s, i) => ({
    ...s,
    detail: s.detail || (i === 0 ? `${draft.destination} 도착, ${draft.reason} 업무 착수`
      : i === draft.schedule.length - 1 ? `${draft.reason} 업무 마무리 및 결과 정리, 복귀` : `${draft.reason} 업무 수행`),
  }));
  return { ...draft, report: report || draft.report, schedule };
}

/** AI 결과를 규칙 결과 위에 얹는다. 출장지 이름·출발지·금액은 규칙이 최종 결정. */
function mergeAi(base, d, places, cfg) {
  // AI 가 비워 둔 칸("", null, [])이 규칙으로 읽은 값을 지우지 않게 값 있는 것만 (사유·목적·교통편이 빈 칸으로 덮이던 문제)
  const has = v => v !== '' && v != null && !(Array.isArray(v) && !v.length);
  const pick = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => has(v)));
  d = pick(d);
  const hit = matchPlace(String(d.destination || ''), places);
  const data = {
    ...base, ...d,
    destination: hit ? hit.place.name : (d.destination || base.destination),
    dates: { start: (d.dates && d.dates.start) || base.dates.start, end: (d.dates && d.dates.end) || (d.dates && d.dates.start && d.dates.start !== base.dates.start ? d.dates.start : base.dates.end) || (d.dates && d.dates.start) || '',   // AI 가 끝 날짜를 비우면 규칙으로 읽은 끝 날짜 (화~목이 하루로 줄 뻔)
      start_time: (d.dates && d.dates.start_time) || base.dates.start_time || '', end_time: (d.dates && d.dates.end_time) || base.dates.end_time || '' },
    transport: { ...base.transport, ...pick(d.transport), from: cfg.defaultOrigin },
    companions: Array.isArray(d.companions) ? d.companions : base.companions,
  };
  if (hit) data.transport.to = hit.place.to || hit.place.name;
  if (!data.transport.to && data.destination) data.transport.to = data.destination;
  return data;
}

module.exports = { mergeAi, DEFAULT_RATES, DEFAULT_MEAL_TIMES, parseTimes, mealPlan, mealSummary, parseDates, parseMode, parseCompanions, matchPlace, computeExpenses, nightsDays, quickApply, quickReport, cleanReason };
