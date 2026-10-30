# 일간/주간 리포트 이메일: 관심 추가 · AI 요약 · 매각물건명세서

대상 워크플로우
- `[REPORT] 경매 일일 대시보드 리포트 (V4.1)` (cjOgYndfnkWqGzM5)
- `013.[REPORT] 주간 경매 및 갭 분석 동향 리포트 (V4.0.1)` (dAIUwhMyKMAZvFc0)

## 변경 내용 (워크플로우마다 동일)
1. NocoDB 조회 노드의 `fields`에 `ai_summary,ai_flags` 추가
2. `HTML 리포트 생성` → **`이메일 액션 삽입`**(Code, `inject-email-actions.js`) → `Gmail — 리포트 발송`
   - `__DASHBOARD_URL__`: 대시보드 주소, `__SOURCE_NODE__`: 해당 워크플로우의 NocoDB 조회 노드 이름
   - 텔레그램 노드는 그대로 `HTML 리포트 생성`에 연결
3. 각 물건 행 아래에 AI 요약(180자) + `⭐ 관심 추가` + `📄 AI요약·명세서 보기` 버튼 추가
   - 버튼은 대시보드 `functions/api/item.js` (`/api/item?id=…`)로 연결
   - `&action=interest` 링크는 클릭 한 번으로 `is_interested=true, interest_level=1, interested_at` 저장 (대시보드 toggleStar와 동일)
   - 낙찰/유찰 물건은 상세 보기 버튼만 표시

기존 `HTML 리포트 생성` 코드는 수정하지 않으므로, 되돌릴 때는 새 노드만 빼고 Gmail을 다시 연결하면 됩니다.
