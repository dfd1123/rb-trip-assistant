#!/bin/bash
# 배포: 버전 올리기 → 전 플랫폼 빌드(맥 서명·공증) → 이 저장소 Release(v<버전>)에 설치 파일 + version.json → 버전 커밋·태그
# (참고: web-rainbow-ui/apps/electron/management/scripts/deploy-management.sh)
#
#   yarn deploy
#
# 필요 (하나라도 없으면 멈춤):
#   - gh 로그인
#   - Docker 실행 중 (리눅스 deb·rpm)
#   - 키체인에 회사 Developer ID Application 인증서 (맥 서명)
#   - APPLE_ID · APPLE_APP_SPECIFIC_PASSWORD (맥 공증) — 환경변수 또는 ~/.zshrc 의 export 줄 (web-rainbow-ui 배포와 같은 값)
#   - .env 의 GEMINI_API_KEY (팀 공용 AI 키, 앱에 내장)
#   - .env 의 OPEN_API_KEY (한국수출입은행 환율 키, 앱에 내장)
#   - .env 의 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET (네이버 지역 검색 키, 앱에 내장)
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_REPO="dfd1123/rb-trip-assistant"
VERSION_JSON_URL="https://github.com/${RELEASE_REPO}/releases/latest/download/version.json"
cd "$APP_DIR"

# ---------- 사전 확인 ----------
# 맥 앱은 맥에서만 빌드·서명·공증할 수 있다. 맥이 아니면 맥 빌드만 빼고 배포한다
# (맥 사용자 앱은 Release 에 맥 파일이 없으면 업데이트를 띄우지 않고 이전 버전을 그대로 쓴다)
IS_MAC=0; [ "$(uname)" = "Darwin" ] && IS_MAC=1
[ $IS_MAC = 1 ] || echo "  ⓘ 맥이 아니라서 맥 빌드는 빼고 배포해요 (맥 사용자는 이전 버전 유지)."
command -v gh >/dev/null || { echo "Error: GitHub CLI(gh)가 필요합니다. 설치: https://cli.github.com (맥 brew install gh / 윈도우 winget install GitHub.cli / 우분투 sudo apt install gh)"; exit 1; }
GH_OUT=$(gh auth status 2>&1) || { echo "Error: GitHub CLI 로그인 확인 실패 — gh 가 알려 준 내용:"; echo "$GH_OUT" | sed -E 's/(gh[opsu]_)[A-Za-z0-9_]+/\1****/g'; echo "  로그인이 풀렸으면: gh auth login"; exit 1; }
[ -f .env ] && set -a && . ./.env && set +a
# 공증 계정: 환경변수 → 없으면 ~/.zshrc · ~/.zprofile 의 export 줄에서 (web-rainbow-ui 배포와 같은 값)
for v in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do
  if [ -z "${!v}" ]; then
    line=$(grep -hE "^[[:space:]]*export[[:space:]]+${v}=" ~/.zshrc ~/.zprofile ~/.bash_profile 2>/dev/null | tail -1)
    [ -n "$line" ] && eval "$line"
  fi
done
[ -n "$GEMINI_API_KEY" ] || { echo "Error: .env 에 GEMINI_API_KEY 가 없습니다 (팀 공용 AI 키, 앱에 내장)."; exit 1; }
[ -n "$OPEN_API_KEY" ] || { echo "Error: .env 에 OPEN_API_KEY 가 없습니다 (한국수출입은행 환율 키, 앱에 내장)."; exit 1; }
[ -n "$NAVER_CLIENT_ID" ] && [ -n "$NAVER_CLIENT_SECRET" ] || { echo "Error: .env 에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 없습니다 (네이버 지역 검색 키, 앱에 내장)."; exit 1; }
docker info >/dev/null 2>&1 || { echo "Error: Docker 가 실행 중이 아닙니다 (리눅스 deb·rpm 빌드). Docker 를 켜고 다시 실행하세요."; exit 1; }
if [ $IS_MAC = 1 ]; then
  if [ -z "$APPLE_ID" ] || [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
    echo "Error: 맥 공증에 APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD 가 필요합니다 (환경변수나 ~/.zshrc 의 export 줄에서 못 찾음)."
    exit 1
  fi
  security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application" || { echo "Error: 키체인에 Developer ID Application 인증서가 없습니다 (맥 서명)."; exit 1; }
fi
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-UZZ8BPHPA2}"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "Error: main 브랜치에서만 배포할 수 있습니다."; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Error: 커밋 안 된 변경이 있어요. 배포본과 태그가 어긋나지 않게 먼저 커밋해 주세요:"; git status --short; exit 1; }

echo "▶ main 최신화"; git pull --rebase origin main

echo "▶ 테스트"; yarn test

# ---------- 버전 ----------
DEPLOYED=$(curl -fsSL "${VERSION_JSON_URL}?t=$(date +%s)" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).version)}catch{}})" || true)
CURRENT=$(node -p "require('./package.json').version")
BASE="${DEPLOYED:-$CURRENT}"
echo "  배포된 버전: v${DEPLOYED:-없음(첫 배포)} / package.json: v${CURRENT}"
read -r -p "▶ 올릴 단계 [patch/minor/major] (기본 patch): " BUMP; BUMP=${BUMP:-patch}
VERSION=$(node -e "const v='${BASE}'.split('.').map(Number);const t='${BUMP}';
  if(t==='major'){v[0]++;v[1]=0;v[2]=0}else if(t==='minor'){v[1]++;v[2]=0}else if(t==='patch'){v[2]++}else{process.exit(1)}
  process.stdout.write(v.join('.'))") || { echo "Error: 알 수 없는 단계 ${BUMP}"; exit 1; }
TAG="v${VERSION}"
read -r -p "  → v${VERSION} 로 배포할까요? 바뀐 점 한 줄 (Release 노트): " NOTES
NOTES=${NOTES:-"v${VERSION}"}
read -r -p "  진행? [y/N]: " OK; [ "$OK" = "y" ] || [ "$OK" = "Y" ] || { echo "취소"; exit 0; }
gh release view "$TAG" --repo "$RELEASE_REPO" >/dev/null 2>&1 && { echo "Error: ${TAG} 가 이미 있습니다."; exit 1; }

node -e "const f='package.json',j=JSON.parse(require('fs').readFileSync(f,'utf8'));j.version='${VERSION}';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"

# ---------- 빌드 ----------
rm -rf dist
trap 'rm -f "$APP_DIR/src/engine/builtin-key.json"' EXIT   # 중간에 실패해도 키 파일은 남기지 않음
node scripts/write-builtin-key.js
[ -s src/engine/builtin-key.json ] || { echo "Error: 팀 공용 키(AI·환율)를 앱에 넣지 못했습니다."; exit 1; }
if [ $IS_MAC = 1 ]; then
  echo "▶ macOS (arm64·x64, 서명+공증)"
  npx electron-builder --mac --arm64 --x64 --publish never
fi
echo "▶ Windows (x64·arm64)"
npx electron-builder --win --x64 --arm64 --publish never
echo "▶ Linux (x64·arm64 · AppImage·deb·rpm) — Docker"
docker run --rm -v "${APP_DIR}:/project" -v "${HOME}/.cache/electron:/root/.cache/electron" -v "${HOME}/.cache/electron-builder:/root/.cache/electron-builder" \
  -w /project electronuserland/builder:18 /bin/bash -c "npx electron-builder --linux AppImage deb rpm --x64 --arm64 --publish never"
rm -f src/engine/builtin-key.json

# ---------- 확인 ----------
shopt -s nullglob
FILES=(dist/*.dmg dist/*-mac-*.zip dist/*.exe dist/*.AppImage dist/*.deb dist/*.rpm)
WANT=('*.exe' '*.AppImage' '*.deb' '*.rpm'); [ $IS_MAC = 1 ] && WANT+=('*-mac-arm64.dmg' '*-mac-x64.dmg' '*-mac-arm64.zip' '*-mac-x64.zip')
for want in "${WANT[@]}"; do
  ls dist/$want >/dev/null 2>&1 || { echo "Error: dist/${want} 가 없습니다."; exit 1; }
done
if [ $IS_MAC = 1 ]; then
  for APP in dist/mac*/*.app; do   # 공증 안 됐으면 멈춤
    spctl -a -t exec "$APP" >/dev/null 2>&1 || { echo "Error: ${APP} 가 공증되지 않았습니다."; exit 1; }
  done
fi
printf '  %s\n' "${FILES[@]}"

# ---------- 버전 커밋·태그 → Release(설치 파일 + version.json) ----------
git add package.json
if git diff --cached --quiet; then echo "  ⓘ package.json 이 이미 v${VERSION} 이라 버전 커밋은 없이 태그만 달아요."; else git commit -m "chore: v${VERSION} 배포"; fi
git tag "$TAG"
git push origin main "$TAG"

BASE_URL="https://github.com/${RELEASE_REPO}/releases/download/${TAG}"
NOTES="$NOTES" node -e "
  const files=process.argv.slice(1).map(f=>require('path').basename(f));
  const out={version:'${VERSION}',notes:process.env.NOTES,assets:files.map(n=>({name:n,url:'${BASE_URL}/'+encodeURIComponent(n)})),updated_at:new Date().toISOString()};
  require('fs').writeFileSync('dist/version.json',JSON.stringify(out,null,2)+'\n');
" "${FILES[@]}"
echo "▶ Release ${TAG} → ${RELEASE_REPO}"
gh release create "$TAG" --repo "$RELEASE_REPO" --title "와니의 결재 도우미 v${VERSION}" --notes "$NOTES" --latest "${FILES[@]}" dist/version.json
# 정리: 빌드 결과물(수백 MB~GB)은 Release 에 올라갔으니 지운다.
# Docker 는 --rm 이라 컨테이너가 남지 않고, 이미지(electronuserland/builder:18)는 web-rainbow-ui 배포와 같이 쓰는 것이라 그대로 둔다.
rm -rf dist

echo ""
echo "✅ v${VERSION} 배포 완료 — https://github.com/${RELEASE_REPO}/releases/tag/${TAG}"
echo "   설치된 앱은 켜거나 창에 다시 들어올 때 업데이트를 물어봐요."
