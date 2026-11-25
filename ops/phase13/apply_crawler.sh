#!/bin/bash
# 13단계(2026-11-26): 마이옥션 검색 페이지에서 지역/법원 라디오(stc)가 사라져 043·010이 30초 타임아웃 → 있을 때만 클릭
#   되돌리기: cp $LIVE/crawler/myauction.py.bak-20261126 $LIVE/crawler/myauction.py
#             cp $LIVE/crawler/court_results.py.bak-20261126 $LIVE/crawler/court_results.py
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
LIVE=/Volumes/docker/auction-crawler
for f in myauction.py court_results.py; do
  cp -p "$LIVE/crawler/$f" "$LIVE/crawler/$f.bak-20261126"
  cp "$HERE/crawler/$f" "$LIVE/crawler/$f"
done
echo "적용 완료 — 컨테이너는 00:50 자동 시작 때 새 파일로 뜸"
