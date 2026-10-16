'use strict';
// 네이버 지도 교통비 조회 (앱 안의 별도 창).
// 규칙: 자차 (연료비+통행료)×2, 대중교통 버스 포함 총요금×2, 원 단위.
// 화면 구조가 바뀔 수 있어서 자동으로 읽은 값은 항상 확인받고, 못 읽으면 사용자가 그 창에서 직접 검색하게 한다.

const { Page, sleep } = require('./driver');
const { parseCarText, parseTransitText, roundTrip } = require('./rules');

const URL = mode => `https://map.naver.com/p/directions/-/-/-/${mode === 'car' ? 'car' : 'transit'}`;

/** 자동완성 '장소' 항목 글자 → { name, address } ("장소\n기업,빌딩\n텔레칩스 판교사옥\n경기 성남시 수정구 금토로80번길 27") */
function parsePlace(text) {
  const ls = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (ls[0] !== '장소' || ls.length < 3) return null;
  const addrAt = ls.findIndex((s, i) => i > 1 && /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|충청|전라|경상)/.test(s));
  if (addrAt < 0) return { name: ls[ls.length - 1], address: '' };
  const name = ls[addrAt - 1];
  const address = ls[addrAt].endsWith(' ' + name) ? ls[addrAt].slice(0, -name.length - 1).trim() : ls[addrAt];   // "… 공단1로 78 한국항공우주산업" → 이름 꼬리 떼기
  return { name, address };
}

async function trySearch(p, origin, dest, out = {}) {
  try {
    // 입력칸: placeholder 가 없어진 뒤로는 .input_search 순서(첫째 출발, 둘째 도착)로 찾는다. 옛 화면은 placeholder 로.
    for (const [k, value] of [[0, origin], [1, dest]]) {
      await p.clickWhere(idx => { const boxes = all('input.input_search, input[id^=input_search]').filter(vis); if (boxes.length >= 2) return boxes[idx];
        return all('input').find(i => vis(i) && new RegExp(idx === 0 ? '출발' : '도착|목적').test(i.placeholder || '')); }, k);
      await p.selectAll(); await p.type(value);
      await sleep(1500);
      // 자동완성(ul.list_place > li.item_place)엔 '검색어' 추천·최근 경로도 섞여 있다 → 글자가 '장소'로 시작하는 첫 항목만
      const hit = await p.eval(() => { const li = all('.list_place .item_place').find(e => vis(e) && /^장소/.test(e.innerText.trim())); return li ? { ...center(li), text: li.innerText } : null; });
      if (hit && k === 1) out.place = parsePlace(hit.text);   // 도착지의 정식 이름·주소 (출장지 칸에 쓴다)
      if (hit) await p.click(hit);
      else if (await p.eval(() => all('.list_place .item_place').some(vis))) return false;   // 목록은 떴는데 장소가 없음
      else { await p.key('Down'); await p.key('Enter'); }
      await sleep(900);
    }
    if (await p.eval(() => /검색 결과가 없습니다/.test(document.body.innerText))) return false;
    // 왼쪽 메뉴의 '길찾기(선택됨)' 버튼을 누르면 입력이 초기화된다 → 글자가 정확히 '길찾기'인 패널 버튼(마지막 것)만
    try { await p.clickWhere(() => all('button').filter(b => vis(b) && norm(b.textContent) === '길찾기').pop()); } catch (e) { /* 자동 검색되는 경우 */ }
    await sleep(4000);
    return true;
  } catch (e) { return false; }
}

/**
 * @returns {{mode, oneWay, fuel?, toll?, total, describe, screenshot, source}}
 */
async function lookupFare({ makeWindow, mode, origin, dest, shotPath, ui, log }) {
  const win = makeWindow();
  const p = new Page(win);
  try {
    try { await p.goto(URL(mode)); }
    catch (e) {
      log(`네이버 지도를 열 수 없어요 (${e.message.split(' loading')[0]}).`);
      const t = await ui.askInt(`네이버 지도에 접속할 수 없어요. ${mode === 'car' ? '(연료비+통행료)' : '버스 포함 총 요금'} 편도 금액을 입력해 주세요 (원)`);
      return { mode, oneWay: t, total: roundTrip(t), source: 'manual', screenshot: '', describe: `${t.toLocaleString('ko-KR')} × 2 = ${roundTrip(t).toLocaleString('ko-KR')}원 (직접 입력)` };
    }
    await sleep(2500);
    log(`네이버 지도 ${mode === 'car' ? '자동차' : '대중교통'} 길찾기: ${origin} → ${dest}`);
    const where = {};
    const found = await trySearch(p, origin, dest, where);
    // 경로 목록이 뜰 때까지 (대중교통: '상세보기', 자동차: '연료비')
    if (found) await p.waitFor(re => new RegExp(re).test(document.body.innerText), [mode === 'car' ? '연료비' : '상세보기'], { timeout: 15000 });
    const text = found ? await p.allText() : '';
    require('fs').mkdirSync(require('path').dirname(shotPath), { recursive: true });
    await p.screenshot(shotPath);
    // 못 읽으면 바로 사람에게: [네이버 지도 열기]로 직접 검색해서 금액만 입력
    const manualHint = `자동 교통비 검색이 안 됐어요${found ? '' : ` ('${dest}'를 지도에서 못 찾음 — 지도 검색어 칸에 주소를 넣으면 다음엔 자동)`}. 위 [네이버 지도 열기]를 눌러 직접 길찾기한 뒤 `;

    if (mode === 'car') {
      let v = found ? parseCarText(text) : null;
      if (v && !(await ui.confirm(`읽은 값: 연료비 ${v.fuel.toLocaleString('ko-KR')}원, 통행료 ${v.toll.toLocaleString('ko-KR')}원 (편도). 맞나요?`))) v = null;
      const source = v ? 'naver' : 'manual';
      if (!v) v = { fuel: await ui.askInt(manualHint + '연료비(편도, 원)를 입력해 주세요'), toll: await ui.askInt('통행료(편도, 원, 없으면 0)') };
      const oneWay = v.fuel + v.toll;
      return { mode, oneWay, ...v, total: roundTrip(oneWay), source, screenshot: shotPath, place: where.place || null,
        describe: `(연료비 ${v.fuel.toLocaleString('ko-KR')} + 통행료 ${v.toll.toLocaleString('ko-KR')}) × 2 = ${roundTrip(oneWay).toLocaleString('ko-KR')}원` };
    }
    let t = found ? parseTransitText(text) : null;
    if (t && !(await ui.confirm(`읽은 값: 총 요금 ${t.toLocaleString('ko-KR')}원 (편도). 맞나요?`))) t = null;
    const source = t ? 'naver' : 'manual';
    if (!t) t = await ui.askInt(manualHint + '버스 포함 총 요금(편도, 원)을 입력해 주세요');
    return { mode, oneWay: t, total: roundTrip(t), source, screenshot: shotPath, place: where.place || null,
      describe: `${t.toLocaleString('ko-KR')} × 2 = ${roundTrip(t).toLocaleString('ko-KR')}원` };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

module.exports = { lookupFare, parsePlace };
