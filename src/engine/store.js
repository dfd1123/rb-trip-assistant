'use strict';
// 개인 설정과 출장 기록. 모두 이 PC의 앱 데이터 폴더에만 저장된다.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  baseUrl: 'https://gw.rainbow-robotics.com',
  name: '',
  budgetDept: '',   // 그룹웨어 로그인 후 품의부서로 채움 (설정에서 사업코드 목록 중 선택)
  hasCar: null,          // 자차 있음 (null = 아직 안 물어봄 → 로그인 뒤 한 번 물어봄)
  carFuel: 'gasoline',   // 내 차 연료 (자차 유류대 조회): gasoline 휘발유 · diesel 경유 · lpg LPG · electric 전기
  carType: '1',          // 내 차 차종 (네이버 차종 선택): 6 경차 · 1 1종 · 2 2종 · 3 3종 · 4 4종 · 5 5종 · 9 이륜차
  rank: 'staff',   // 출장 규정 직급: staff = 부장 이하, exec = 임원 (숙박 한도·해외 일비가 다름)
  budgetDepts: [],          // 그룹웨어 사업코드도움 목록
  defaultOrigin: '세종특별자치시 집현동 1095',   // 교통비 조회 출발지 기본값 (설정에서 바꿀 수 있음)
  rates: { lodgingPerNight: 70000, breakfast: 8000, lunch: 15000, dinner: 15000, fareMargin: 20000, uberUsdPerDay: 70, lodgingExec: 350000 },   // uberUsdPerDay: 해외 현지교통(우버) 1일 예상 USD   // 국내 출장 규정 (fareMargin: 자차·대중교통 신청 교통비에 더하는 여유분)
  aiProvider: '',          // '' | anthropic | openai | gemini
  aiModel: '',
  aiKeyEnc: '',            // OS 보안 저장소로 암호화된 개인 API 키
  gwId: '',                // 그룹웨어 아이디 (자동 로그인)
  gwPwEnc: '',             // OS 보안 저장소로 암호화된 그룹웨어 비밀번호
};

// 처음부터 알고 있는 출장지 (이후엔 신청 기록에서 자동으로 늘어남)
const PRESET_PLACES = [
  { name: '레인보우로보틱스 판교 AI 사무소', to: '텔레칩스 판교사옥', aliases: ['판교', '판교 AI 사무소', '판교 사무소', '판교 AI 연구소', '텔레칩스'] },   // 네이버 지도엔 텔레칩스 사옥으로 등록 (경기 성남시 수정구 금토로80번길 27)
];
const FARE_TTL_DAYS = 30;
// 쓰다가 꺼져도(정전·강제 종료) 반쯤 쓴 파일이 남지 않게: 임시 파일에 다 쓰고 바꿔 끼운다
function writeJson(file, data) {
  const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  for (let i = 0; ; i++) {   // 윈도우: 백신이 막 쓴 파일을 잡고 있으면 바꿔 끼우기가 잠깐 EPERM/EBUSY → 조금 기다렸다 다시
    try { fs.renameSync(tmp, file); return; }
    catch (e) { if (i >= 9 || !/EPERM|EBUSY|EACCES/.test(e.code || '')) throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); }
  }
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.tripsDir = path.join(dir, 'trips');
    fs.mkdirSync(this.tripsDir, { recursive: true });
  }

  get configPath() { return path.join(this.dir, 'config.json'); }
  hasConfig() { return fs.existsSync(this.configPath); }
  /** 저장된 설정 그대로. 파일이 없으면 {}, 있는데 못 읽으면(잠김·깨짐) 던진다 */
  rawConfig() {
    try { return JSON.parse(fs.readFileSync(this.configPath, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') return {};
      if (e instanceof SyntaxError) { try { fs.renameSync(this.configPath, `${this.configPath}.broken-${Date.now()}`); } catch (e2) { /* */ } return {}; }   // 깨진 파일은 옆에 남겨 두고 새로 (다시 켜도 안 고쳐짐)
      throw new Error(`설정 파일을 못 읽었어요(${e.code || e.message}). 잠시 뒤 다시 해 주세요.`);   // 잠김(백신 등)은 잠깐 — 기본값으로 덮어쓰지 않음
    }
  }
  config() {
    try { const c = this.rawConfig(); return { ...DEFAULT_CONFIG, ...c, rates: { ...DEFAULT_CONFIG.rates, ...(c.rates || {}) } }; }
    catch (e) { return { ...DEFAULT_CONFIG }; }
  }
  saveConfig(patch) {
    const c = { ...DEFAULT_CONFIG, ...this.rawConfig(), ...patch };   // 못 읽었으면 기본값으로 덮어쓰지 않고 멈춤 (로그인 정보·AI 키가 지워질 뻔 — 윈도우 백신이 파일을 잠깐 잡을 때)
    c.rates = { ...DEFAULT_CONFIG.rates, ...(c.rates || {}) };
    writeJson(this.configPath, c);
    return c;
  }

  newId(start, reason) {
    const slug = String(reason).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 30);
    const base = `${start.replace(/-/g, '')}-${slug}`;
    let id = base, i = 1;
    while (fs.existsSync(path.join(this.tripsDir, id))) id = `${base}-${++i}`;
    return id;
  }
  tripDir(id) { const d = path.join(this.tripsDir, id); fs.mkdirSync(d, { recursive: true }); return d; }
  save(id, rec) { writeJson(path.join(this.tripDir(id), 'trip.json'), rec); return rec; }
  remove(id) { if (!id || /[\/\\]/.test(String(id)) || String(id).includes('..')) throw new Error('잘못된 출장 ID'); fs.rmSync(path.join(this.tripsDir, id), { recursive: true, force: true }); }
  load(id) { return JSON.parse(fs.readFileSync(path.join(this.tripsDir, id, 'trip.json'), 'utf8')); }
  /** 자주 가는 곳: 기록에서 많이 간 순 + 기본 목록 */
  places() {
    const count = new Map();
    for (const t of this.records()) {
      const a = t.apply; if (!a || !a.destination) continue;
      const k = a.destination;
      const cur = count.get(k) || { name: k, to: (a.transport && a.transport.to) || k, aliases: [], n: 0, last: '' };
      cur.n++; cur.last = cur.last > (t.created || '') ? cur.last : (t.created || '');
      count.set(k, cur);
    }
    for (const p of PRESET_PLACES) {
      const c = count.get(p.name);
      count.set(p.name, { ...p, n: c ? c.n : 0, last: c ? c.last : '' });
    }
    return [...count.values()].sort((a, b) => b.n - a.n || (b.last > a.last ? 1 : -1));
  }
  lastMode() { const r = this.records().find(t => t.apply && t.apply.transport); return r ? r.apply.transport.mode : 'car'; }
  records() { return fs.readdirSync(this.tripsDir).sort().reverse().flatMap(id => { try { return [this.load(id)]; } catch (e) { return []; } }); }

  // 교통비 캐시 (같은 경로는 30일간 다시 조회하지 않음)
  get farePath() { return path.join(this.dir, 'fare-cache.json'); }
  fareKey(mode, from, to) { return [mode, from, to].map(s => String(s).replace(/\s/g, '')).join('|'); }
  getFare(mode, from, to) {
    try {
      const c = JSON.parse(fs.readFileSync(this.farePath, 'utf8'))[this.fareKey(mode, from, to)];
      if (c && Date.now() - c.at < FARE_TTL_DAYS * 86400000 && (!c.screenshot || fs.existsSync(c.screenshot))) return c;
    } catch (e) { /* 없음 */ }
    return null;
  }
  putFare(mode, from, to, fare) {
    let all = {}; try { all = JSON.parse(fs.readFileSync(this.farePath, 'utf8')); } catch (e) { /* 새로 */ }
    all[this.fareKey(mode, from, to)] = { ...fare, at: Date.now() };
    writeJson(this.farePath, all);
  }

  // 구매의뢰서 기록 (이 PC 에서 작성 창까지 채운 것). 상신 여부는 그룹웨어 결재 문서 목록으로 확인
  get purchasesPath() { return path.join(this.dir, 'purchases.json'); }
  /** 파일이 없으면 [], 있는데 못 읽으면 던진다 (빈 목록으로 보고 덮어쓰면 기록이 다 지워짐) */
  purchases() { try { return JSON.parse(fs.readFileSync(this.purchasesPath, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return [];
    if (e instanceof SyntaxError) { try { fs.renameSync(this.purchasesPath, `${this.purchasesPath}.broken-${Date.now()}`); } catch (e2) { /* */ } return []; }   // 깨진 파일은 옆에 남기고 새로
    throw new Error(`구매의뢰 기록 파일을 못 읽었어요(${e.code || e.message}).`); } }
  // 같은 제목이라도 그룹웨어에 올라간 기록(docNo)은 남기고, 아직 안 올린 초안만 새것으로 (같은 물건을 다음 달에 또 사도 예전 기록이 안 지워짐)
  addPurchase(rec) { const all = [rec, ...this.purchases().filter(x => x.title !== rec.title || x.docNo)].slice(0, 100); writeJson(this.purchasesPath, all); return rec; }
  linkPurchase(created, docNo) { const all = this.purchases(); const r = all.find(x => x.created === created); if (r && !r.docNo) { r.docNo = docNo; writeJson(this.purchasesPath, all); } }
  removePurchase(created) { writeJson(this.purchasesPath, this.purchases().filter(x => x.created !== created)); }

  list() {
    return fs.readdirSync(this.tripsDir).sort().reverse().flatMap(id => {
      try {
        const r = this.load(id);
        return [{ id, reason: r.apply.reason, start: r.apply.start, end: r.apply.end, status: r.status || '', report: r.reportStatus || '', reportStatus: r.reportStatus || '', resolutionNo: r.resolutionNo || '', refundChecked: r.refundChecked || '', gwApply: r.gwApply || null, gwReport: r.gwReport || null }];
      } catch (e) { return []; }
    });
  }
}

module.exports = { Store, DEFAULT_CONFIG, PRESET_PLACES };
