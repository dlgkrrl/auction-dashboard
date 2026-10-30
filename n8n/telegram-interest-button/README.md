# 신규물건 텔레그램 알림 → [⭐ 관심물건 추가] 버튼

크롤링 후 오는 "신규 경매 물건 발견" 메시지에 인라인 버튼을 달고, 누르면 해당 물건의
NocoDB `is_interested`를 켭니다. 대시보드는 `is_interested`를 그대로 읽으므로
(`index.html`의 `toggleStar`와 같은 필드: `is_interested=true, interest_level=1, interested_at`)
별도 수정 없이 관심물건 목록에 바로 나타납니다.

## 동작 흐름

1. **010.[DAILY] 파이프라인 › 텔레그램 신규 물건 알림** 메시지에 버튼 추가
   (`callback_data = fav:{사건번호}`, 64바이트 제한 내).
2. **011.[BOT] 봇 파이프라인 › Telegram Trigger**가 `callback_query`도 수신.
3. **보안 필터 및 명령어 파싱**이 `fav:` 콜백을 기존 `/관심 {사건번호}`와 같은
   `ADD_INTEREST` 명령으로 변환 → 기존 `NocoDB 조회 → NocoDB 관심 등록 → 관심등록 응답 생성`
   흐름을 그대로 재사용. chat id 화이트리스트 검사도 동일하게 적용.
4. 등록 후 **버튼 콜백 응답**(answerCallbackQuery)으로 버튼 로딩을 끄고 토스트 표시.

## 적용 방법 (n8n 편집기)

| 워크플로우 | 노드 | 변경 |
|---|---|---|
| 011 봇 | Telegram Trigger | Trigger On에 `Callback Query` 추가 |
| 011 봇 | 보안 필터 및 명령어 파싱 | 코드를 `011_보안필터_및_명령어파싱.js`로 교체 |
| 011 봇 | (신규) 버튼 콜백 여부, 버튼 콜백 응답 | `011_콜백응답_nodes.json` 참고, `관심등록 응답 생성` 뒤에 연결 |
| 010 데일리 | 텔레그램 신규 물건 알림 | Reply Markup = Inline Keyboard, 버튼 `⭐ 관심물건 추가` / callback data `fav:{{ $json.사건번호 }}` |

두 워크플로우 모두 저장 후 다시 Publish 해야 Telegram webhook의 `allowed_updates`가 갱신됩니다.
