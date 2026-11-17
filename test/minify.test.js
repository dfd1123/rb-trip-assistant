// 화면으로 보내는 함수는 toString 으로 가서 PRELUDE 헬퍼(norm, all …)를 이름으로 찾는다. 같은 파일에 같은 이름 변수가 있으면
// 배포본 최소화가 둘을 같이 바꿔 화면에서 'Script failed to execute' (v0.4.8) → 이름 뭉개기 전후로 헬퍼 호출 수가 같아야 한다.
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'src/engine', f), 'utf8');
const NAMES = [...src('driver.js').match(/const PRELUDE = String\.raw`([\s\S]*?)`;/)[1].matchAll(/^const (\w+) =/gm)].map(m => m[1]);
const count = (s, n) => (s.match(new RegExp(`(?<![\\w.$])${n}\\(`, 'g')) || []).length;
const min = (s, minifyIdentifiers) => esbuild.transformSync(s, { minifyWhitespace: true, minifySyntax: true, minifyIdentifiers, format: 'cjs', platform: 'node', target: 'node20' }).code;

for (const f of ['gw.js', 'naver.js', 'runner.js']) {
  test(`최소화해도 페이지 헬퍼 이름 유지: ${f}`, () => {
    const before = min(src(f), false), after = min(src(f), true);
    const lost = NAMES.filter(n => count(before, n) !== count(after, n)).map(n => `${n} ${count(before, n)}→${count(after, n)}`);
    assert.deepEqual(lost, [], `${f}: 화면으로 보내는 함수 안 헬퍼 이름이 최소화로 바뀜 — 이 파일에 같은 이름 변수가 있음`);
  });
}
