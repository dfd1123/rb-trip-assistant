'use strict';
// 개인 설정과 출장 기록. 모두 이 PC의 앱 데이터 폴더에만 저장된다.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  baseUrl: 'https://gw.rainbow-robotics.com',
  name: '',
  budgetDept: '매니퓰레이터 사업부',
  defaultOrigin: '세종특별자치시 집현동 1095',
};

class Store {
  constructor(dir) {
    this.dir = dir;
    this.tripsDir = path.join(dir, 'trips');
    fs.mkdirSync(this.tripsDir, { recursive: true });
  }

  get configPath() { return path.join(this.dir, 'config.json'); }
  hasConfig() { return fs.existsSync(this.configPath); }
  config() {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(this.configPath, 'utf8')) }; }
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
  list() {
    return fs.readdirSync(this.tripsDir).sort().reverse().flatMap(id => {
      try {
        const r = this.load(id);
        return [{ id, reason: r.apply.reason, start: r.apply.start, end: r.apply.end, status: r.status || '', report: r.reportStatus || '' }];
      } catch (e) { return []; }
    });
  }
}

module.exports = { Store, DEFAULT_CONFIG };
