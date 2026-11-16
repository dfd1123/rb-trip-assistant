// 배포본을 번들·최소화·이름 뭉개기 해서 app/ 으로 뽑는다 (리버스 엔지니어링 늦추기).
// 개발(npm start)은 원본 src/ 로 그대로 돌아간다 — 이 스크립트는 패키징 직전에만 돈다.
// write-builtin-key.js 다음에 돌려야 builtin-key.json 이 main 번들 안으로 박힌다.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const R = p => path.join(__dirname, '..', p);
const OUT = R('app');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'renderer'), { recursive: true });

const common = { bundle: true, minify: true, legalComments: 'none', logLevel: 'info' };

(async () => {
  // 메인 + engine/* 한 파일로. electron·electron-updater·js-yaml 은 공개 라이브러리라 숨길 게 없고
  // node_modules 에서 그대로 로드 (번들하면 네이티브/electron require 가 깨짐).
  await esbuild.build({
    ...common,
    entryPoints: [R('src/main.js')],
    outfile: path.join(OUT, 'main.js'),
    platform: 'node', format: 'cjs', target: 'node20',
    external: ['electron', 'electron-updater', 'js-yaml'],
  });

  // preload 은 contextBridge 로 따로 로드되니 별도 파일
  await esbuild.build({
    ...common,
    entryPoints: [R('src/preload.js')],
    outfile: path.join(OUT, 'preload.js'),
    platform: 'node', format: 'cjs', target: 'node20',
    external: ['electron'],
  });

  // 화면: app.js + ux.js 는 최상위 const/function 을 서로 공유한다 (스크립트 스코프).
  // 한 덩어리로 이어 붙여 IIFE 로 감싸면 그 공유가 클로저 안에서 유지되고, 이름까지 뭉갤 수 있다.
  // (index.html 에 인라인 핸들러 0개, 이 둘 밖에서 참조하는 전역 없음 — 확인함)
  const combined = ['src/renderer/app.js', 'src/renderer/ux.js']
    .map(f => fs.readFileSync(R(f), 'utf8')).join('\n;\n');
  await esbuild.build({
    ...common,
    stdin: { contents: combined, resolveDir: R('src/renderer'), loader: 'js' },
    outfile: path.join(OUT, 'renderer', 'renderer.js'),
    format: 'iife', platform: 'browser',
  });

  // index.html: 두 스크립트 태그를 번들 하나로 바꾼다
  let html = fs.readFileSync(R('src/renderer/index.html'), 'utf8')
    .replace(/<script src="app\.js"><\/script>/, '<script src="renderer.js"></script>')
    .replace(/\s*<script src="ux\.js"><\/script>/, '');
  if (html.includes('src="app.js"') || html.includes('src="ux.js"'))
    throw new Error('index.html 의 app.js/ux.js 스크립트 태그를 못 바꿨다 — 태그 형태 확인');
  fs.writeFileSync(path.join(OUT, 'renderer', 'index.html'), html);

  // renderer 의 정적 파일(favicon.png, logo.png 등)은 그대로 복사
  for (const f of fs.readdirSync(R('src/renderer'))) {
    if (['app.js', 'ux.js', 'index.html'].includes(f)) continue;
    const s = R('src/renderer/' + f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(OUT, 'renderer', f));
  }

  console.log('[bundle] app/ 생성 완료 (main, preload, renderer 번들·최소화)');
})().catch(e => { console.error('[bundle] 실패:', e); process.exit(1); });
