#!/usr/bin/env bash
# 2단계 마무리: 크롤러 /court-results 에 유찰 보강 모드(mode=sweep) 추가.
#   bash ops/phase2b/apply_crawler.sh          # 변경 내용만 보여줌
#   bash ops/phase2b/apply_crawler.sh --apply  # 백업 후 반영 → DSM에서 auction-crawler 재시작
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIVE=/Volumes/docker/auction-crawler
STAMP=bak-20261114

for f in app.py crawler/court_results.py; do
  if ! cmp -s "$HERE/backup/$(basename $f)" "$LIVE/$f"; then
    echo "중단: $LIVE/$f 가 패치 작성 이후 바뀌었습니다." >&2; exit 1
  fi
done
diff -u "$LIVE/app.py" "$HERE/crawler/app.py" || true
diff -u "$LIVE/crawler/court_results.py" "$HERE/crawler/court_results.py" || true
if [[ "${1:-}" != "--apply" ]]; then echo; echo "dry-run입니다. 반영하려면 --apply"; exit 0; fi

cp -p "$LIVE/app.py" "$LIVE/app.py.$STAMP"
cp -p "$LIVE/crawler/court_results.py" "$LIVE/crawler/court_results.py.$STAMP"
cp "$HERE/crawler/app.py" "$LIVE/app.py"
cp "$HERE/crawler/court_results.py" "$LIVE/crawler/court_results.py"
mkdir -p "$LIVE/data"
echo "반영 완료. 백업: *.$STAMP — DSM에서 auction-crawler 컨테이너를 재시작하세요."
echo "되돌리기: cp \"$LIVE/app.py.$STAMP\" \"$LIVE/app.py\" && cp \"$LIVE/crawler/court_results.py.$STAMP\" \"$LIVE/crawler/court_results.py\""
