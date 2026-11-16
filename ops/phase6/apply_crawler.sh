#!/usr/bin/env bash
# 6단계: 크롤러 /crawl 에 {"uids": [...]} (지정 물건만 다시 수집) 추가
#   크롤러·browserless 는 00:50~04:00 에만 켜짐(auction_ondemand.sh). 그 밖의 시간에 반영하면 재시작 없이 다음 00:50 시작 때 적용됨.
#   켜져 있는 시간에 반영했다면 DSM에서 auction-crawler 재시작.
#   되돌리기: cp $LIVE/app.py.bak-20261117 $LIVE/app.py && cp $LIVE/crawler/myauction.py.bak-20261117 $LIVE/crawler/myauction.py
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIVE=/Volumes/docker/auction-crawler
cp -p "$LIVE/app.py" "$LIVE/app.py.bak-20261117"
cp -p "$LIVE/crawler/myauction.py" "$LIVE/crawler/myauction.py.bak-20261117"
cp "$HERE/crawler/app.py" "$LIVE/app.py"
cp "$HERE/crawler/myauction.py" "$LIVE/crawler/myauction.py"
echo "반영 완료"
