'use strict';
// 개인 설정과 출장 기록. 모두 이 PC의 앱 데이터 폴더에만 저장된다.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  baseUrl: 'https://gw.rainbow-robotics.com',
  name: '',
  budgetDept: '매니퓰레이터 사업부',
  defaultOrigin: '세종특별자치시 집현동 1095',
  rates: { lodgingPerNight: 70000, breakfast: 8000, lunch: 15000, dinner: 15000 },   // 국내 출장 규정
  mealTimes: { breakfast: ['07:00', '08:00'], lunch: ['12:00', '13:00'], dinner: ['18:00', '19:00'] },   // 첫날 출발이 시작 전 / 마지막 날 복귀가 끝 이후면 포함
  aiProvider: '',          // '' | anthropic | openai | gemini
  aiModel: '',
  aiKeyEnc: '',            // OS 보안 저장소로 암호화된 개인 API 키
  gwId: '',                // 그룹웨어 아이디 (자동 로그인)
  gwPwEnc: '',             // OS 보안 저장소로 암호화된 그룹웨어 비밀번호
};

// 처음부터 알고 있는 출장지 (이후엔 신청 기록에서 자동으로 늘어남)
const PRESET_PLACES = [
  { name: '레인보우로보틱스 판교 AI 사무소', to: '레인보우로보틱스 판교 AI 사무소', aliases: ['판교', '판교 AI 사무소', '판교 사무소', '판교 AI 연구소'] },
];
const FARE_TTL_DAYS = 30;

class Store {
  constructor(dir) {
    this.dir = dir;
    this.tripsDir = path.join(dir, 'trips');
    fs.mkdirSync(this.tripsDir, { recursive: true });
  }

  get configPath() { return path.join(this.dir, 'config.json'); }
  hasConfig() { return fs.existsSync(this.configPath); }
  config() {
    try { const c = JSON.parse(fs.readFileSync(this.configPath, 'utf8')); return { ...DEFAULT_CONFIG, ...c, rates: { ...DEFAULT_CONFIG.rates, ...(c.rates || {}) }, mealTimes: { ...DEFAULT_CONFIG.mealTimes, ...(c.mealTimes || {}) } }; }
    catch (e) { return { ...DEFAULT_CONFIG }; }
  }
  saveConfig(patch) {
    const c = { ...this.config(), ...patch };
    fs.writeFileSync(this.configPath, JSON.stringify(c, null, 2));
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
  save(id, rec) { fs.writeFileSync(path.join(this.tripDir(id), 'trip.json'), JSON.stringify(rec, null, 2)); return rec; }
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
    fs.writeFileSync(this.farePath, JSON.stringify(all, null, 2));
  }

  list() {
    return fs.readdirSync(this.tripsDir).sort().reverse().flatMap(id => {
      try {
        const r = this.load(id);
        return [{ id, reason: r.apply.reason, start: r.apply.start, end: r.apply.end, status: r.status || '', report: r.reportStatus || '' }];
      } catch (e) { return []; }
    });
  }
}

module.exports = { Store, DEFAULT_CONFIG, PRESET_PLACES };
