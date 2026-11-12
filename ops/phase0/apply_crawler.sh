#!/usr/bin/env bash
# 0단계 크롤러 패치를 NAS 라이브 폴더에 반영합니다. (NAS 쓰기라 사용자가 직접 실행)
#   bash ops/phase0/apply_crawler.sh          # 변경 내용만 보여줌 (dry-run)
#   bash ops/phase0/apply_crawler.sh --apply  # 백업 후 반영
# 반영 뒤 DSM > Container Manager 에서 auction-crawler 컨테이너를 재시작해야 적용됩니다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LIVE=/Volumes/docker/auction-crawler/crawler
STAMP=bak-20261112

for f in myauction.py myauction_tracker.py; do
  # 작업 기준이 된 라이브 원본(backup/)과 현재 라이브가 다르면, 그 사이 누가 수정한 것 → 중단
  if ! cmp -s "$HERE/backup/$f" "$LIVE/$f"; then
    echo "중단: $LIVE/$f 가 패치 작성 이후 바뀌었습니다. 다시 맞춰야 합니다." >&2
    exit 1
  fi
done

diff -u "$LIVE/myauction_tracker.py" "$HERE/crawler/myauction_tracker.py" || true
diff -u "$LIVE/myauction.py" "$HERE/crawler/myauction.py" || true

if [[ "${1:-}" != "--apply" ]]; then
  echo; echo "dry-run입니다. 반영하려면 --apply 를 붙여 실행하세요."
  exit 0
fi

for f in myauction.py myauction_tracker.py; do
  cp -p "$LIVE/$f" "$LIVE/$f.$STAMP"
  cp "$HERE/crawler/$f" "$LIVE/$f"
done
echo "반영 완료. 백업: $LIVE/*.$STAMP"
echo "이제 DSM에서 auction-crawler 컨테이너를 재시작하세요."
echo "되돌리기: for f in myauction.py myauction_tracker.py; do cp \"$LIVE/\$f.$STAMP\" \"$LIVE/\$f\"; done"
