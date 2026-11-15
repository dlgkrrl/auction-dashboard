#!/usr/bin/env bash
# 5단계: 크롤러에 /real-trade(실거래만 다시 받기) 추가. 11-15 반영함(백업 app.py.bak-20261115).
#   되돌리기: cp /Volumes/docker/auction-crawler/app.py.bak-20261115 /Volumes/docker/auction-crawler/app.py && rm /Volumes/docker/auction-crawler/crawler/real_trade.py
#   반영 후 DSM에서 auction-crawler 컨테이너 재시작
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIVE=/Volumes/docker/auction-crawler
cp -p "$LIVE/app.py" "$LIVE/app.py.bak-20261115"
cp "$HERE/crawler/app.py" "$LIVE/app.py"
cp "$HERE/crawler/real_trade.py" "$LIVE/crawler/real_trade.py"
echo "반영 완료 — DSM에서 auction-crawler 재시작"
