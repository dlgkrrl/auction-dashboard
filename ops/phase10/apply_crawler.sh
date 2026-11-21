#!/usr/bin/env bash
# 10단계(2026-11-21): NocoDB 사전 조회가 실패(401 등)하거나 토큰이 없으면 /crawl 을 오류로 멈춤
#   (전에는 조용히 '전부 신규'로 보고 기존 물건 28건만 다시 수집 → 11/18~11/21 신규 0건)
#   되돌리기: cp $LIVE/crawler/myauction.py.bak-20261121 $LIVE/crawler/myauction.py
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIVE=/Volumes/docker/auction-crawler
cp -p "$LIVE/crawler/myauction.py" "$LIVE/crawler/myauction.py.bak-20261121"
cp "$HERE/crawler/myauction.py" "$LIVE/crawler/myauction.py"
echo "반영 완료"
