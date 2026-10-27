'use strict';
// 네이버 지도 교통비 조회 (앱 안의 별도 창).
// 규칙: 자차 (연료비+통행료)×2, 대중교통 버스 포함 총요금×2, 원 단위.
// 화면 구조가 바뀔 수 있어서 자동으로 읽은 값은 항상 확인받고, 못 읽으면 사용자가 그 창에서 직접 검색하게 한다.

const { Page, sleep } = require('./driver');
const { parseCarText, parseTransitText, roundTrip } = require('./rules');

const URL = mode => `https://map.naver.com/p/directions/-/-/-/${mode === 'car' ? 'car' : 'transit'}`;
// 도착지 좌표(지역 검색)를 길찾기 주소에 바로 넣는다 → 도착지 글자 입력·자동완성 클릭이 없어진다. 출발지(번지 주소)는 지역 검색에 안 나와 글자로 입력
// (경로를 찾은 뒤 주소에 남는 출발지 좌표는 네이버 자체 부호라 다시 쓸 수 없음)
const geoSeg = g => g && Number(g.lng) && Number(g.lat) ? `${g.lng},${g.lat},${encodeURIComponent(g.name || '')},,` : '-';
const directionsUrl = (mode, originGeo, destGeo) => `https://map.naver.com/p/directions/${geoSeg(originGeo)}/${geoSeg(destGeo)}/-/${mode === 'car' ? 'car' : 'transit'}`;

/** 자동완성 '장소' 항목 글자 → { name, address } ("장소\n기업,빌딩\n텔레칩스 판교사옥\n경기 성남시 수정구 금토로80번길 27") */
function parsePlace(text) {
  const ls = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (ls[0] !== '장소' || ls.length < 2) return null;   // 번지로 찾은 곳은 '장소\n세종 집현동 1095' 두 줄뿐
  const addrAt = ls.findIndex((s, i) => i > 1 && /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|충청|전라|경상)/.test(s));
  if (addrAt < 0) return { name: ls[ls.length - 1], address: '' };
  const name = ls[addrAt - 1];
  const address = ls[addrAt].endsWith(' ' + name) ? ls[addrAt].slice(0, -name.length - 1).trim() : ls[addrAt];   // "… 공단1로 78 한국항공우주산업" → 이름 꼬리 떼기
  return { name, address };
}

/** 출발·도착 입력 → 자동완성의 '장소' 항목을 골라 길찾기. 도착지가 여러 곳이면 사람이 고른다.
 *  @returns {boolean} 경로 화면까지 갔는지. 못 찾으면 false (사람에게 더 정확한 이름을 물음) */
/** 자동완성 '주소' 항목 ("주소\n세종특별자치시 집현동 1095") → { name: 입력한 글자, address } */
function parseAddr(text, typed) {
  const ls = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  return ls[0] === '주소' && ls[1] ? { name: typed, address: ls[1] } : null;
}

async function trySearch(p, origin, dest, out = {}, { ui, debugDir, only = [0, 1] } = {}) {
  try {
    const names = [];
    // 입력칸: placeholder 가 없어진 뒤로는 .input_search 순서(첫째 출발, 둘째 도착)로 찾는다. 옛 화면은 placeholder 로.
    for (const [k, value] of [[0, origin], [1, dest]].filter(([k]) => only.includes(k))) {
      await p.clickWhere(idx => { const boxes = all('input.input_search, input[id^=input_search]').filter(vis); if (boxes.length >= 2) return boxes[idx];
        return all('input').find(i => vis(i) && new RegExp(idx === 0 ? '출발' : '도착|목적').test(i.placeholder || '')); }, k);
      await p.selectAll(); await p.type(value);
      await sleep(1500);
      // 자동완성 항목(li.item_place 안에 id=instant-search-item-…)만. 아래 '최근 검색' 목록도 같은 class 라 섞이면 안 됨
      const readHits = () => p.eval(() => { const li = all('.list_place .item_place').filter(e => vis(e) && e.querySelector('[id^=instant-search-item]')); return li.map((e, i) => ({ i, text: e.innerText })); })
        .then(items => items.map(h => ({ ...h, place: parsePlace(h.text) || parseAddr(h.text, value) })).filter(h => h.place));
      let hits = await readHits();
      // 자동완성에 장소·주소가 없으면 못 찾은 것. (예전엔 ↓+Enter 로 아무거나 골랐는데, 최근 경로가 잡혀 엉뚱한 곳으로 길찾기함)
      if (!hits.length) { out.failed = k; await dump(p, debugDir, k === 0 ? 'no-place-origin' : 'no-place'); return false; }
      // 출발지는 첫 항목. 도착지는 이름이 딱 맞는 것 → 하나뿐이면 그것 → 여럿이면 사람이 고름 (예: 삼성전자 구미 1사업장 / 2사업장)
      let pick = k === 0 ? hits[0] : hits.find(h => norm(h.place.name) === norm(value)) || (hits.length === 1 ? hits[0] : null);
      if (!pick) {
        const idx = ui && ui.askChoice ? await ui.askChoice(`'${value}' 검색 결과가 여러 곳이에요. 어디로 가나요?`, hits.map(h => `${h.place.name}${h.place.address ? ` — ${h.place.address}` : ''}`)) : 0;
        if (idx === '' || idx == null || !hits[Number(idx)]) return false;   // 다른 이름으로 다시 찾기
        const chosen = hits[Number(idx)].place;
        // 고르는 동안 자동완성이 닫히거나 바뀌었을 수 있으니, 고른 이름을 다시 쳐서 같은 항목을 찾는다
        await p.clickWhere(idx2 => all('input.input_search, input[id^=input_search]').filter(vis)[idx2], k);
        await p.selectAll(); await p.type(chosen.name); await sleep(1500);
        hits = await readHits();
        pick = hits.find(h => h.place.name === chosen.name && (!chosen.address || h.place.address === chosen.address)) || hits.find(h => h.place.name === chosen.name);
        if (!pick) { await dump(p, debugDir, 'chosen-gone'); return false; }
      }
      if (k === 1) out.place = pick.place;   // 도착지의 정식 이름·주소 (출장지 칸에 쓴다)
      names[k] = pick.place.name;
      const pt = await p.eval(i => { const li = all('.list_place .item_place').filter(e => vis(e) && e.querySelector('[id^=instant-search-item]'))[i]; return li ? center(li) : null; }, pick.i);
      if (!pt) return false;
      await p.click(pt);
      await sleep(900);
    }
    // 입력칸에 고른 장소가 그대로 들어갔는지 (이전 경로가 남아 있으면 엉뚱한 곳으로 조회됨). 고르면 화면이 새로 그려지니 값이 찰 때까지 기다림
    const same = (a, b) => a && b && norm(a) === norm(b);   // 글자 일부 포함으로 하면 '사천' ↔ '사천해변'도 맞다고 봄 → 꼭 같아야
    const vals = (await p.waitFor(() => { const v = all('input.input_search, input[id^=input_search]').filter(vis).slice(0, 2).map(i => i.value.trim()); return v.length === 2 && v.every(Boolean) ? v : null; }, [], { timeout: 8000 }).catch(() => null)) || [];
    const want = [names[0] || origin, names[1] || (out.place && out.place.name) || dest];   // 좌표로 넣은 칸은 그 장소 이름
    if (vals.length === 2 && (!(same(vals[0], want[0]) || same(vals[0], origin)) || !(same(vals[1], want[1]) || same(vals[1], dest)))) { await dump(p, debugDir, 'mismatch'); return false; }
    if (await p.eval(() => /검색 결과가 없습니다/.test(document.body.innerText))) return false;
    // 왼쪽 메뉴의 '길찾기(선택됨)' 버튼을 누르면 입력이 초기화된다 → 글자가 정확히 '길찾기'인 패널 버튼(마지막 것)만
    try { await p.clickWhere(() => all('button').filter(b => vis(b) && norm(b.textContent) === '길찾기').pop()); } catch (e) { /* 자동 검색되는 경우 */ }
    await sleep(4000);
    return true;
  } catch (e) { return false; }
}
const norm = s => String(s || '').replace(/[\s​ ]/g, '');

const KM_PER_L = 8;   // 회사 기준: 자차 유류대는 연비 8km/L 로 조회한 네이버 지도 캡처가 증빙
// 내 차 (설정): 네이버 차종/연료 설정 팝업의 칸 id. 전기·수소는 단위가 km/L 가 아니라 연비는 네이버 기본값 그대로
const CAR_FUELS = { gasoline: { id: 'fuel_type_1', label: '휘발유', eff: KM_PER_L }, diesel: { id: 'fuel_type_3', label: '경유', eff: KM_PER_L },
  lpg: { id: 'fuel_type_4', label: 'LPG', eff: KM_PER_L }, electric: { id: 'fuel_type_6', label: '전기', eff: null } };
const CAR_TYPES = { '6': '1종(경차)', '1': '1종', '2': '2종', '3': '3종', '4': '4종', '5': '5종', '9': '이륜차' };   // 키 = 네이버 car_type_N
const carOf = (c = {}) => ({ type: CAR_TYPES[c.type] ? String(c.type) : '1', fuel: CAR_FUELS[c.fuel] ? c.fuel : 'gasoline' });
/** 증빙 기준 글자 (캐시·보고서에서 같은 기준으로 조회했는지 비교). 예) '1종 휘발유 8km/L' */
const carBasis = c => { const { type, fuel } = carOf(c), f = CAR_FUELS[fuel]; return `${CAR_TYPES[type]} ${f.label}${f.eff ? ` ${f.eff}km/L` : ''}`; };

/** 개발 중: 네이버 화면이 바뀌어 못 읽을 때 고치려고 화면 글자를 남긴다 */
async function dump(p, debugDir, tag) {
  if (!debugDir) return;
  try {
    const fs = require('fs'), path = require('path'); fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(path.join(debugDir, `naver-${tag}.txt`), await p.allText());
    fs.writeFileSync(path.join(debugDir, `naver-${tag}.html`), await p.eval(() => document.body.outerHTML));
  } catch (e) { /* 진단 실패는 무시 */ }
}

/** 자동차 길찾기 '1종 휘발유차량 기준' → 차종/연료 설정 팝업에서 차종·연료(설정의 내 차), 연비 사용자 설정 8, 하이패스 켬 → [저장].
 *  팝업을 다시 열어 값이 8 로 남았는지 확인되면 true (네이버가 이 창의 저장소에 기억하므로 다음부턴 이미 8) */
async function setCarEfficiency(p, { log, debugDir, car }) {
  const { type, fuel } = carOf(car), f = CAR_FUELS[fuel], typeId = `car_type_${type}`;
  const open = async () => { await p.clickWhere(() => all('button.config_btn').find(vis)); await sleep(1000); };
  const state = () => p.eval((fid, tid) => { const d = all('dialog').find(x => x.open && /연비/.test(x.textContent)); if (!d) return null;
    const on = id => { const x = d.querySelector('#' + id); return !!(x && x.checked); }, inp = d.querySelector('input.input_value');
    return { type: on(tid), gas: on(fid), eff: inp ? inp.value.trim() : '', hipass: on('config_hipass') }; }, f.id, typeId);
  const pick = id => p.clickWhere(x => all(`dialog label[for=${x}]`).find(vis), id);
  try {
    await open();
    let st = await state();
    if (!st) { await dump(p, debugDir, 'car-setting'); return false; }
    const effOk = x => !f.eff || Number(x.eff) === f.eff;
    if (!(st.type && st.gas && effOk(st) && st.hipass)) {
      if (!st.type) { await pick(typeId); await sleep(500); }
      if (!st.gas) { await pick(f.id); await sleep(500); }
      if (!st.hipass) { await pick('config_hipass'); await sleep(300); }
      if (f.eff) { await p.clickWhere(() => all('dialog input.input_value').find(vis)); await p.selectAll(); await p.type(String(f.eff)); await sleep(300); }
      await p.clickWhere(() => all('dialog button.btn_save').find(vis));   // 지도 오른쪽에도 '저장' 버튼이 있어서 팝업 안의 것만
      await sleep(2500);
      await open(); st = await state();
    }
    const ok = !!st && st.type && st.gas && effOk(st);   // 하이패스는 못 켜져도 진행 (차종·연료·연비가 증빙 기준)
    await p.clickWhere(() => all('dialog button.btn_close').find(vis)).catch(() => {});   // 확인용으로 연 팝업 닫기
    await sleep(1500);
    if (!ok) await dump(p, debugDir, 'car-after-setting');
    return ok;
  } catch (e) { log(`(차량 연비 설정을 자동으로 못 했어요: ${String(e.message).slice(0, 80)})`); await dump(p, debugDir, 'car-setting'); return false; }
}

/** 대중교통: 경로 목록에 요금이 안 나오면 첫 경로 [상세보기]를 열어 요금을 읽는다 */
async function transitDetailFare(p, { debugDir }) {
  try {
    await p.clickWhere(() => all('a,button,span').filter(vis).find(e => /^상세보기/.test(norm(e.textContent)) && e.children.length <= 2));
    await sleep(2500);
  } catch (e) { return null; }
  const text = await p.allText();
  const t = parseTransitText(text.replace(/[\s\S]*?상세보기/, ''));   // 상세 화면 글자
  if (!t) await dump(p, debugDir, 'transit-detail');
  return t;
}

/**
 * @returns {{mode, oneWay, fuel?, toll?, total, describe, screenshot, source, basis?}}
 */
/** 도착지 좌표 정하기: 넘어온 좌표 → 네이버 지역 검색 (이름이 딱 맞는 곳 → 하나뿐이면 그것 → 여럿이면 사람이 고름).
 *  null = 검색 결과 없음(번지 주소·미등록 회사 → 지도 창에서 글자로), undefined = 사람이 '다른 이름으로' 를 고름 */
async function resolveDest(dest, destPlace, { places, ui, log }) {
  if (destPlace && Number(destPlace.lng) && Number(destPlace.lat)) return destPlace;
  if (!places) return null;
  let list;
  try { list = await places(dest); } catch (e) { log(`(지역 검색 안 됨: ${String(e.message).slice(0, 100)} — 지도 창에서 글자로 찾아요)`); return null; }
  if (!list || !list.length) return null;
  const exact = list.find(x => norm(x.name) === norm(dest));
  if (exact) return exact;
  if (list.length === 1 || !ui.askChoice) return list[0];
  const idx = await ui.askChoice(`'${dest}' 검색 결과가 여러 곳이에요. 어디로 가나요?`, list.map(x => `${x.name}${x.address ? ` — ${x.address}` : ''}`));
  if (idx === '' || idx == null || !list[Number(idx)]) return undefined;
  return list[Number(idx)];
}

async function lookupFare({ makeWindow, mode, origin, dest, shotPath, ui, log, debugDir, car, destPlace = null, places = null }) {   // dest 는 사람이 고쳐 주면 바뀜 → 결과 query 로 돌려줌
  const win = makeWindow();
  const p = new Page(win);
  const goto = async url => { try { await p.goto(url); await sleep(2500); return true; } catch (e) { log(`네이버 지도를 열 수 없어요 (${e.message.split(' loading')[0]}).`); return false; } };
  try {
    const where = {};
    // 한 번 시도: 도착지 좌표가 있으면 좌표 주소로 열고 출발지만 글자로, 없으면 둘 다 지도 창에서 글자로
    const attempt = async () => {
      where.failed = null;
      const d = await resolveDest(dest, destPlace, { places, ui, log }); destPlace = null;
      if (d === undefined) return false;   // 사람이 다른 이름으로 다시 찾겠다고 함
      if (d) {
        where.place = { name: d.name, address: d.address || '' }; where.geo = { name: d.name, address: d.address || '', lng: d.lng, lat: d.lat };
        log(`네이버 지도 ${mode === 'car' ? '자동차' : '대중교통'} 길찾기: ${origin} → ${d.name}${d.address ? ` (${d.address})` : ''}`);
        if (!(await goto(directionsUrl(mode, null, d)))) return false;
        return trySearch(p, origin, d.name, where, { ui, debugDir, only: [0] });
      }
      log(`네이버 지도 ${mode === 'car' ? '자동차' : '대중교통'} 길찾기: ${origin} → ${dest}`);
      if (!(await goto(URL(mode)))) return false;
      return trySearch(p, origin, dest, where, { ui, debugDir });
    };
    let found = await attempt();
    // 못 찾으면: 사람에게 더 정확한 이름·주소를 받아 다시 찾는다 (비우면 금액 직접 입력으로)
    // 출발지를 못 찾은 거면 도착지를 다시 물어도 소용없음 → 바로 직접 입력으로
    for (let i = 0; !found && where.failed !== 0 && ui.askText && i < 3; i++) {
      const q = String(await ui.askText(`'${dest}'(을)를 네이버 지도에서 못 찾았어요. 지도에서 찾을 수 있는 정확한 출장지 이름이나 주소를 입력해 주세요.\n예) 삼성전자 구미사업장, 경북 구미시 3공단3로 302`, dest) || '').trim();
      if (!q) break;
      dest = q; where.place = null; where.geo = null; log(`다시 찾기: ${dest}`);
      found = await attempt();
    }
    // 경로 목록이 뜰 때까지 (대중교통: '상세보기', 자동차: '연료비')
    if (found) found = !!(await p.waitFor(re => new RegExp(re).test(document.body.innerText), [mode === 'car' ? '연료비' : '상세보기'], { timeout: 15000 }));
    // 자차: 내 차 연료·연비 8km/L 로 맞춘 뒤 읽고 캡처 (그 캡처가 보고서 유류대 증빙). 자동으로 못 맞추면 사람이 그 창에서 맞춤
    let basis = null;
    if (found && mode === 'car') {
      const c = carOf(car), f = CAR_FUELS[c.fuel];
      if (!(await setCarEfficiency(p, { log, debugDir, car })))
        await ui.assist(`네이버 지도 창에서 '…차량 기준'을 눌러 차종 ${CAR_TYPES[c.type]}, 연료 ${f.label}${f.eff ? `, 연비 사용자 설정 ${f.eff}` : ''}, 하이패스 켬으로 바꾸고 [저장]해 주세요. 바꾼 뒤 [계속]을 누르면 그 금액으로 읽어요. (위 [작업 중인 창 열기]로 창을 띄워요)`);
      basis = carBasis(car);   // 자동으로 맞췄거나 사람이 맞췄다고 확인함
    }
    let text = found ? await p.allText() : '';
    let detailFare = null;
    if (found && mode !== 'car' && !parseTransitText(text)) { detailFare = await transitDetailFare(p, { debugDir }); if (detailFare) text = await p.allText(); }
    // 캡처는 경로를 찾았을 때만 (증빙). 캡처가 안 돼도 금액 입력은 이어간다
    let shot = '';
    if (found) {
      try { require('fs').mkdirSync(require('path').dirname(shotPath), { recursive: true }); shot = await p.screenshot(shotPath); }
      catch (e) { log(`(지도 화면 캡처 실패: ${String(e.message).slice(0, 80)} — 증빙 캡처는 직접 넣어 주세요)`); }
    }
    // 못 읽으면 바로 사람에게: [네이버 지도 열기]로 직접 검색해서 금액만 입력
    const manualHint = `자동 교통비 검색이 안 됐어요${found ? '' : where.failed === 0 ? ` (출발지 '${origin}'를 지도에서 못 찾음 — 설정의 기본 출발지를 지도에서 찾히는 주소로 바꿔 주세요)` : ` ('${dest}'를 지도에서 못 찾음 — 지도 검색어 칸에 주소를 넣으면 다음엔 자동)`}. 위 [네이버 지도 열기]를 눌러 직접 길찾기한 뒤 `;

    if (mode === 'car') {
      let v = found ? parseCarText(text) : null;
      if (v && !(await ui.confirm(`읽은 값: 연료비 ${v.fuel.toLocaleString('ko-KR')}원, 통행료 ${v.toll.toLocaleString('ko-KR')}원 (편도, ${basis} 기준). 맞나요?`))) v = null;
      const source = v ? 'naver' : 'manual';
      if (!v) v = { fuel: await ui.askInt(manualHint + '연료비(편도, 원)를 입력해 주세요'), toll: await ui.askInt('통행료(편도, 원, 없으면 0)') };
      const oneWay = v.fuel + v.toll;
      return { mode, oneWay, ...v, total: roundTrip(oneWay), source, screenshot: shot, place: where.geo || where.place || null, query: dest, basis,
        describe: `(연료비 ${v.fuel.toLocaleString('ko-KR')} + 통행료 ${v.toll.toLocaleString('ko-KR')}) × 2 = ${roundTrip(oneWay).toLocaleString('ko-KR')}원${basis ? ` (${basis})` : ''}` };
    }
    let t = found ? (detailFare || parseTransitText(text)) : null;
    if (t && !(await ui.confirm(`읽은 값: 총 요금 ${t.toLocaleString('ko-KR')}원 (편도). 맞나요?`))) t = null;
    const source = t ? 'naver' : 'manual';
    if (!t) t = await ui.askInt(manualHint + '버스 포함 총 요금(편도, 원)을 입력해 주세요');
    return { mode, oneWay: t, total: roundTrip(t), source, screenshot: shot, place: where.geo || where.place || null, query: dest,
      describe: `${t.toLocaleString('ko-KR')} × 2 = ${roundTrip(t).toLocaleString('ko-KR')}원` };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

module.exports = { lookupFare, parsePlace, directionsUrl, KM_PER_L, CAR_FUELS, CAR_TYPES, carBasis };
