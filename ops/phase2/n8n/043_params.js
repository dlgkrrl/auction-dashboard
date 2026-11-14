// 043 · 수집 조건
// 02:00(daily): 전날(KST) 매각기일의 매각+유찰, 수집 지역(창원·김해·양산) 주거용
// 04:00(sweep, 11-14 추가): 유찰된 물건은 다음 기일이 바로 잡혀 전날 기일 검색에 안 잡힘 →
//   다음 기일이 오늘~60일 뒤인 '진행(유찰/재진행)' 물건의 기일표에서 지난 유찰을 기록(크롤러 캐시로 이미 본 물건은 건너뜀)
const sweep = $json.mode === 'sweep' || (() => { try { return $('매일 04:00 유찰 보강').isExecuted; } catch (e) { return false; } })();
const base = { sdCd: '48', sggCd: '48120,48250,48330', usageMcl: '주거용건물' };
if (sweep) return [{ json: { ...base, mode: 'sweep', maxItems: 600, timeBudgetSec: 900 } }];
const kst = new Date(Date.now() + 9 * 3600e3);
const y = new Date(kst.getTime() - 86400e3).toISOString().slice(0, 10);
const dateFrom = $json.dateFrom || y;   // 수동 실행 때 dateFrom/dateTo를 넣어 과거 날짜 재수집 가능
const dateTo = $json.dateTo || dateFrom;
return [{ json: { ...base, dateFrom, dateTo, statuses: ['매각', '유찰'], maxItems: 150 } }];
