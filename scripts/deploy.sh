#!/bin/bash
# 배포: 버전 올리기 → 전 플랫폼 빌드(맥 서명·공증) → 이 저장소 Release(v<버전>)에 설치 파일 + version.json → 버전 커밋·태그
# (참고: web-rainbow-ui/apps/electron/management/scripts/deploy-management.sh)
#
#   yarn deploy
#
# 필요: gh(로그인), Docker(리눅스 deb·rpm), 키체인에 회사 Developer ID 인증서,
#       APPLE_ID · APPLE_APP_SPECIFIC_PASSWORD 환경변수 (공증), .env 에 GEMINI_API_KEY (팀 공용 키 내장, 선택)
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_REPO="dfd1123/rb-trip-assistant"
VERSION_JSON_URL="https://github.com/${RELEASE_REPO}/releases/latest/download/version.json"
cd "$APP_DIR"

# ---------- 사전 확인 ----------
command -v gh >/dev/null || { echo "Error: GitHub CLI(gh)가 필요합니다. brew install gh"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "Error: gh auth login 이 필요합니다."; exit 1; }
docker info >/dev/null 2>&1 || { echo "Error: Docker 가 실행 중이 아닙니다 (리눅스 deb·rpm 빌드에 필요)."; exit 1; }
[ -f .env ] && set -a && . ./.env && set +a
# 공증 자격 증명이 없으면 electron-builder 가 공증을 조용히 건너뛰어 경고 뜨는 dmg 가 나간다 → 미리 막는다
if [ -z "$APPLE_ID" ] || [ -z "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
  echo "Error: macOS 공증에 APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD 가 필요합니다."
  echo "       export APPLE_ID=developer@rainbow-robotics.com"
  echo "       export APPLE_APP_SPECIFIC_PASSWORD=<앱 암호>   # appleid.apple.com 에서 생성"
  exit 1
fi
export APPLE_TEAM_ID="${APPLE_TEAM_ID:-UZZ8BPHPA2}"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "Error: main 브랜치에서만 배포할 수 있습니다."; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Error: 커밋 안 된 변경이 있습니다. 먼저 커밋해 주세요."; exit 1; }

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
node scripts/write-builtin-key.js
echo "▶ macOS (arm64·x64, 서명+공증)"
npx electron-builder --mac --arm64 --x64 --publish never
echo "▶ Windows (x64·arm64)"
npx electron-builder --win --x64 --arm64 --publish never
echo "▶ Linux (x64·arm64 · AppImage·deb·rpm) — Docker"
docker run --rm -v "${APP_DIR}:/project" -v "${HOME}/.cache/electron:/root/.cache/electron" -v "${HOME}/.cache/electron-builder:/root/.cache/electron-builder" \
  -w /project electronuserland/builder:18 /bin/bash -c "npx electron-builder --linux AppImage deb rpm --x64 --arm64 --publish never"
rm -f src/engine/builtin-key.json

# ---------- 확인 ----------
shopt -s nullglob
FILES=(dist/*.dmg dist/*-mac-*.zip dist/*.exe dist/*.AppImage dist/*.deb dist/*.rpm)
for want in '*-mac-arm64.dmg' '*-mac-x64.dmg' '*-mac-arm64.zip' '*-mac-x64.zip' '*.exe' '*.AppImage' '*.deb' '*.rpm'; do
  ls dist/$want >/dev/null 2>&1 || { echo "Error: dist/${want} 가 없습니다."; exit 1; }
done
for APP in dist/mac*/*.app; do
  spctl -a -t exec "$APP" >/dev/null 2>&1 || { echo "Error: ${APP} 가 공증되지 않았습니다."; exit 1; }
done
printf '  %s\n' "${FILES[@]}"

# ---------- 버전 커밋·태그 → Release(설치 파일 + version.json) ----------
git add package.json
git commit -m "chore: v${VERSION} 배포"
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
echo ""
echo "✅ v${VERSION} 배포 완료 — https://github.com/${RELEASE_REPO}/releases/tag/${TAG}"
echo "   설치된 앱은 켜거나 창에 다시 들어올 때 업데이트를 물어봐요."
