#!/bin/bash
# 와니의 결재 도우미 dev 실행 (Finder에서 더블클릭)
cd "$(dirname "$0")" || exit 1
if [ ! -d node_modules/electron/dist ]; then
  echo "▶ 의존성 설치 중 (처음 한 번, 1~2분)..."
  yarn install --frozen-lockfile || { echo "yarn install 실패"; read -r -p "Enter로 닫기"; exit 1; }
fi
echo "▶ 앱 실행 (앱 창을 닫으면 종료)"
yarn start
