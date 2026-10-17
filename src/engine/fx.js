'use strict';
// 해외출장 환율: 서울외국환중개 '오늘의 환율' 화면.
// 이 사이트는 크롤러·스크래퍼·봇·매크로 등 자동 수단으로 접근하거나 데이터를 수집하는 것을 금지한다(사이트 '저작권보호정책 안내').
// 그래서 앱은 값을 자동으로 읽지 않는다: 사람이 보는 창으로 열어 주고, 사람이 환율을 적고, 사람이 누를 때 그 창을 캡처만 한다
// (화면을 보고 스크린샷을 찍는 것과 같음).

const fs = require('fs');
const path = require('path');

const PAGE_URL = 'http://www.smbs.biz/ExRate/TodayExRate.jsp';

/** 사람이 연 환율 창을 그대로 캡처해 파일로 (결재 문서 첨부용) */
async function captureWindow(win, shotPath) {
  if (!win || win.isDestroyed()) throw new Error('환율 화면이 열려 있지 않아요. [환율 확인]으로 먼저 열어 주세요.');
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, (await win.webContents.capturePage()).toPNG());
  return shotPath;
}

module.exports = { PAGE_URL, captureWindow };
