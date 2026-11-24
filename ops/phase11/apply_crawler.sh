#!/usr/bin/env bash
# 11단계(2026-11-24): 서류가 아직 안 올라온 신건에서 사이트 '메뉴 글자'를 등기부·건축물대장으로 저장하던 문제 수정
#   - nuri 직접 PDF 실패 시 래퍼 폴백 안 함(빈값) / 감정평가서 filenotfund → 빈값
#   되돌리기: cp $LIVE/crawler/myauction.py.bak-20261124 $LIVE/crawler/myauction.py
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIVE=/Volumes/docker/auction-crawler
cp -p "$LIVE/crawler/myauction.py" "$LIVE/crawler/myauction.py.bak-20261124"
cp "$HERE/crawler/myauction.py" "$LIVE/crawler/myauction.py"
echo "반영 완료"
