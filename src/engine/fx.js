'use strict';
// 해외출장 환율: 한국수출입은행 환율 Open API (정부 공개 API, 개인 인증키, 하루 1,000회).
// 영업일 11시쯤 고시라 주말·공휴일·고시 전엔 빈 결과 → 하루씩 거슬러 가장 최근 고시값(USD 매매기준율)을 쓴다.

const fs = require('fs');
const path = require('path');

const API = 'https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON';
const KEY_URL = 'https://www.koreaexim.go.kr/ir/HPHKIR020M01?apino=2&viewtype=C';
const ERR = { 2: '수출입은행 API 데이터 코드 오류', 3: '수출입은행 인증키가 올바르지 않아요. 설정 › 환율에서 키를 확인해 주세요.', 4: '수출입은행 API 오늘 조회 한도(1,000회)를 넘었어요.' };
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 오늘(from)부터 거슬러 가장 최근 고시된 USD 매매기준율 */
async function usdRate(key, { from = new Date(), fetch: f = fetch, days = 10 } = {}) {
  if (!key) throw new Error('설정 › 환율에서 한국수출입은행 인증키를 먼저 넣어 주세요.');
  for (let i = 0; i < days; i++) {
    const d = new Date(from); d.setDate(d.getDate() - i);
    const res = await f(`${API}?authkey=${encodeURIComponent(key)}&searchdate=${ymd(d).replace(/-/g, '')}&data=AP01`);
    if (!res.ok) throw new Error(`수출입은행 환율 조회 실패 (HTTP ${res.status})`);
    const rows = await res.json();
    const bad = rows.find(r => r.result && r.result !== 1);
    if (bad) throw new Error(ERR[bad.result] || `수출입은행 환율 조회 실패 (결과 ${bad.result})`);
    const usd = rows.find(r => r.cur_unit === 'USD');
    if (usd) return { rate: Number(String(usd.deal_bas_r).replace(/,/g, '')), date: ymd(d), row: usd };
  }
  throw new Error(`최근 ${days}일 동안 고시된 USD 환율이 없어요.`);
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function proofHtml({ date, row }, at = new Date()) {
  const cell = (k, v) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`;
  return `<!doctype html><meta charset="utf-8"><style>body{font:15px -apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;margin:28px;color:#111}
h1{font-size:19px;margin:0 0 4px}p{color:#555;margin:0 0 16px;font-size:13px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:9px 12px;text-align:left}
th{background:#f3f6fa;width:38%;font-weight:600}tr.k td{font-weight:700;font-size:17px;color:#0b4f9c}</style>
<h1>한국수출입은행 환율 (USD)</h1><p>고시일 ${esc(date)} · 조회 ${esc(ymd(at))} ${at.toTimeString().slice(0, 5)} · 출처: 한국수출입은행 환율 Open API</p>
<table>${cell('통화', `${row.cur_unit} (${row.cur_nm || '미국 달러'})`)}<tr class="k"><th>매매기준율</th><td>${esc(row.deal_bas_r)}</td></tr>${cell('전신환 받으실 때', row.ttb)}${cell('전신환 보내실 때', row.tts)}${cell('장부가격', row.bkpr)}</table>`;
}

/** 조회 결과를 결재 첨부용 이미지로 */
async function saveProof(r, shotPath) {
  const { BrowserWindow } = require('electron');
  const w = new BrowserWindow({ show: false, width: 640, height: 300, webPreferences: { sandbox: true, javascript: false } });
  try {
    await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(proofHtml(r)));
    fs.mkdirSync(path.dirname(shotPath), { recursive: true });
    fs.writeFileSync(shotPath, (await w.webContents.capturePage()).toPNG());
    return shotPath;
  } finally { w.destroy(); }
}

module.exports = { KEY_URL, usdRate, proofHtml, saveProof };
