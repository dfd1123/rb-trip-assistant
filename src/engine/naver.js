'use strict';
// 네이버 지도 교통비 조회 (앱 안의 별도 창).
// 규칙: 자차 (연료비+통행료)×2, 대중교통 버스 포함 총요금×2, 원 단위.
// 화면 구조가 바뀔 수 있어서 자동으로 읽은 값은 항상 확인받고, 못 읽으면 사용자가 그 창에서 직접 검색하게 한다.

const { Page, sleep } = require('./driver');
const { parseCarText, parseTransitText, roundTrip } = require('./rules');

const URL = mode => `https://map.naver.com/p/directions/-/-/-/${mode === 'car' ? 'car' : 'transit'}`;

async function trySearch(p, origin, dest) {
  try {
    for (const [ph, value] of [['출발', origin], ['도착|목적', dest]]) {
      await p.clickWhere(re => all('input').find(i => vis(i) && new RegExp(re).test(i.placeholder || '')), ph);
      await p.selectAll(); await p.type(value);
      await sleep(1300);
      await p.key('Down'); await p.key('Enter');
      await sleep(900);
    }
    try { await p.clickWhere(() => all('button').find(b => vis(b) && norm(b.textContent).includes('길찾기'))); } catch (e) { /* 자동 검색되는 경우 */ }
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
    await p.goto(URL(mode));
    await sleep(2500);
    log(`네이버 지도 ${mode === 'car' ? '자동차' : '대중교통'} 길찾기: ${origin} → ${dest}`);
    if (!(await trySearch(p, origin, dest)))
      await ui.assist('자동 검색에 실패했습니다. 열린 네이버 지도 창에서 직접 길찾기를 해서 첫 번째 경로가 보이게 한 뒤 [계속]을 눌러주세요.');
    if (mode === 'transit') {
      try { await p.clickWhere(() => byText('상세보기')[0]); await sleep(2000); } catch (e) { /* 없음 */ }
      await ui.pause('버스 포함 총 요금이 지도 창에 보이는지 확인하고 [계속]을 눌러주세요. (안 보이면 첫 경로의 상세보기를 열어주세요)');
    }
    const text = await p.allText();
    require('fs').mkdirSync(require('path').dirname(shotPath), { recursive: true });
    await p.screenshot(shotPath);

    if (mode === 'car') {
      let v = parseCarText(text);
      if (v && !(await ui.confirm(`읽은 값: 연료비 ${v.fuel.toLocaleString('ko-KR')}원, 통행료 ${v.toll.toLocaleString('ko-KR')}원 (편도). 맞나요?`))) v = null;
      const source = v ? 'naver' : 'manual';
      if (!v) v = { fuel: await ui.askInt('연료비(편도, 원)'), toll: await ui.askInt('통행료(편도, 원, 없으면 0)') };
      const oneWay = v.fuel + v.toll;
      return { mode, oneWay, ...v, total: roundTrip(oneWay), source, screenshot: shotPath,
        describe: `(연료비 ${v.fuel.toLocaleString('ko-KR')} + 통행료 ${v.toll.toLocaleString('ko-KR')}) × 2 = ${roundTrip(oneWay).toLocaleString('ko-KR')}원` };
    }
    let t = parseTransitText(text);
    if (t && !(await ui.confirm(`읽은 값: 총 요금 ${t.toLocaleString('ko-KR')}원 (편도). 맞나요?`))) t = null;
    const source = t ? 'naver' : 'manual';
    if (!t) t = await ui.askInt('버스 포함 총 요금(편도, 원)');
    return { mode, oneWay: t, total: roundTrip(t), source, screenshot: shotPath,
      describe: `${t.toLocaleString('ko-KR')} × 2 = ${roundTrip(t).toLocaleString('ko-KR')}원` };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

module.exports = { lookupFare };
