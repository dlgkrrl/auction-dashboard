#!/usr/bin/env bash
# 2단계 크롤러 반영: 법원 매각결과 표본 수집(/court-results) 추가. (NAS 쓰기라 사용자가 직접 실행)
#   bash ops/phase2/apply_crawler.sh          # 변경 내용만 보여줌
#   bash ops/phase2/apply_crawler.sh --apply  # 백업 후 반영
# 컨테이너가 켜져 있으면 DSM에서 auction-crawler 재시작 (꺼져 있으면 다음 00:50 자동 시작 때 적용)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIVE=/Volumes/docker/auction-crawler
STAMP=bak-20261113

if ! cmp -s "$HERE/backup/app.py" "$LIVE/app.py"; then
  echo "중단: $LIVE/app.py 가 패치 작성 이후 바뀌었습니다." >&2; exit 1
fi
if [ -e "$LIVE/crawler/court_results.py" ]; then
  echo "중단: $LIVE/crawler/court_results.py 가 이미 있습니다." >&2; exit 1
fi

diff -u "$LIVE/app.py" "$HERE/crawler/app.py" || true
echo "+ 새 파일: crawler/court_results.py ($(wc -l < "$HERE/crawler/court_results.py")줄)"

if [[ "${1:-}" != "--apply" ]]; then echo; echo "dry-run입니다. 반영하려면 --apply"; exit 0; fi

cp -p "$LIVE/app.py" "$LIVE/app.py.$STAMP"
cp "$HERE/crawler/app.py" "$LIVE/app.py"
cp "$HERE/crawler/court_results.py" "$LIVE/crawler/court_results.py"
echo "반영 완료. 백업: $LIVE/app.py.$STAMP"
echo "되돌리기: cp \"$LIVE/app.py.$STAMP\" \"$LIVE/app.py\" && rm \"$LIVE/crawler/court_results.py\""
