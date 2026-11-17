# 프론트엔드 자동 점검
가짜 데이터로 대시보드를 띄우고 폭 8가지 × 화면 5개에서 가로 넘침·짧은 글자 줄바꿈·잘림을 찾는다.

    node ops/frontend-check/mock-server.js &          # http://localhost:8765
    npm i -g playwright-core                          # 한 번만
    CHROME_PATH=/path/to/chrome node ops/frontend-check/audit.js   # 결과: ops/frontend-check/out/audit.json + 스크린샷

out/ 은 git 제외. 보고서: docs/plans/2026-11-17-frontend-audit.md
