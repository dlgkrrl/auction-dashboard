# 0단계 · 파이프라인 응급 복구 (2026-11-12)

계획서: `docs/plans/2026-11-12-auction-improvement-plan.md` 4장 0단계

## 무엇을 고치나

| 문제 | 고치는 곳 | 파일 |
|---|---|---|
| 양산(울산지법) 물건이 창원지법으로 저장 → 결과 추적 실패 | 크롤러(상세 제목에서 실제 법원), 기존 데이터 보정 | `crawler/myauction.py`, `n8n/041_migration.sdk.js` |
| 유찰 횟수가 매일 +1 | 트래커가 기일표의 '유찰' 수를 반환 → 012가 그 값 사용 | `crawler/myauction_tracker.py`, `n8n/012_result_parse.js` |
| '변경'(기일변경) 미처리로 125건 무한 재추적 | 다음 기일 있으면 갱신, 없으면 7일마다 재확인 | `n8n/012_result_parse.js`, `n8n/012_date_filter.js` |
| 매각불허가·대금미납이 낙찰로 기록 | 트래커 키워드 분리, 012 판정 분리 | 트래커, 012 |
| 유찰 후 목표가 미갱신 | 012에서 다음 기일이 잡히면 V3 엔진으로 즉시 재계산 | `n8n/012_result_parse.js` |
| 다물건 사건 결과 뒤섞임 | 상세페이지 번호(/view/uid) > 물건번호로 매칭 | 트래커, 010 중복 판별, 012 |
| 지분·여러 호수 일괄 | 010에서 수집 제외, 기존 7건은 상태 '제외' | `n8n/010_parse_filter.js`, 보정 |
| 결과 테이블 `loss_count` 0 → 빈값, 오차 0% → 빈값 | 012 낙찰결과 입력 본문 | `n8n/012_bodies.json` |

## 반영 순서

1. **크롤러** (사용자 실행, NAS 쓰기):
   `bash ops/phase0/apply_crawler.sh` (미리보기) → `bash ops/phase0/apply_crawler.sh --apply` → DSM에서 `auction-crawler` 컨테이너 재시작
2. **NocoDB 컬럼 추가 + 기존 데이터 보정**: n8n `041.[ONCE] 경매 0단계 데이터 보정` 수동 실행 1회
   - 컬럼: 물건 `item_no, usage, is_share, is_bulk` / 결과 `court, item_no, location, usage, result_type, min_price`
   - 보정(11-11 기준 미리 계산): 법원 194건(울산 114, 마산지원 72, 통영·거창·진주지원 8), 지분 7건 → `status=제외`
3. **n8n 012** 노드 교체 후 게시 (`012_*.js`, `012_bodies.json`, `NocoDB 보류 업데이트` 노드 추가)
4. **n8n 010** 노드 교체 후 게시 (`010_patched_nodes.json`)

크롤러를 먼저 바꿔야 012가 새 필드(`loss_count`, `item_no`, `court`, `detail_uid`)를 받습니다. 순서가 바뀌어도 깨지지는 않습니다(새 필드가 없으면 예전 방식으로 동작).

## 되돌리기

- 크롤러: `apply_crawler.sh --apply`가 남긴 `*.bak-20261112`를 원래 이름으로 복사 후 컨테이너 재시작
- n8n 010·012: n8n 버전 기록에서 이전 버전 복원 (010 `edc3fff7…`, 012 `8a7d5c1c…`). 010 정의는 `backup/010_live_20261112.json`
- NocoDB: 추가 컬럼은 남겨도 무해. 법원 보정을 되돌리려면 `court`를 `창원지방법원`으로 일괄 수정

## 검증 (반영 후 첫 01:00 실행 다음 날)

- 기일 지난 '진행중' 물건 수가 줄어드는지 (11-11 기준 125건)
- 양산 물건에 낙찰/유찰 결과가 잡히는지
- `loss_count`가 기일표 유찰 수와 같은지 (최대값 39 → 한 자릿수)
- `needs_manual_review=true` 물건 목록 확인 (물건번호를 못 정한 다물건 사건)

## 반영 기록 (2026-11-12)

| 대상 | 결과 | 되돌릴 버전 |
|---|---|---|
| 041 일회성 보정 (`phgiFY5puCZupiAb`) | 컬럼 10개 추가, 진행중 364건 중 법원 194건 보정(울산 114·마산지원 72·통영 5·거창 2·진주 1), 지분 7건 `is_share`+`is_hidden` | — |
| 012 결과 추적 | 게시 `bc828026…` | `8a7d5c1c…` |
| 010 수집 | 게시 `7ab084fe…` | `edc3fff7…` |
| 일간 리포트 `cjOgYndfnkWqGzM5` | 게시 `dfbd6b2a…` (서명 지원, 비밀키 자리표시자) | `c0bf5e02…` |
| 주간 리포트 `dAIUwhMyKMAZvFc0` | 게시 `9bcff264…` (서명 지원, 비밀키 자리표시자) | `4bdccfa7…` |

변경 사항: status는 선택형 컬럼(진행중·낙찰·유찰·취하·기각·정지)이라 '제외' 대신 `is_hidden=true`로 숨김.
010 업데이트는 크롤러가 기본값 '창원지방법원'을 줄 때 DB의 법원을 유지하고, 양산 주소는 신규 입력 때 울산지방법원으로 고정 (크롤러 패치 전에도 보정값이 되돌아가지 않게).

### 남은 일 (사용자)
1. `bash ops/phase0/apply_crawler.sh --apply` → DSM에서 auction-crawler 재시작
2. Cloudflare Pages 환경변수 `DASHBOARD_PASSWORD`, `DASHBOARD_SECRET`(32자 이상) 설정
3. n8n 리포트 2개 `이메일 액션 삽입` 노드의 `'__DASHBOARD_SECRET__'`를 같은 값으로 교체 후 게시
4. 브랜치 `phase0-pipeline-api-auth`를 main에 반영(배포)
