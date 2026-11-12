// 043 · 수집 조건: 전날(KST) 매각기일, 지금 수집 지역(창원·김해·양산), 주거용, 매각+유찰
const kst = new Date(Date.now() + 9 * 3600e3);
const y = new Date(kst.getTime() - 86400e3).toISOString().slice(0, 10);
const dateFrom = $json.dateFrom || y;   // 수동 실행 때 dateFrom/dateTo를 넣어 과거 날짜 재수집 가능
const dateTo = $json.dateTo || dateFrom;
return [{ json: { sdCd: '48', sggCd: '48120,48250,48330', usageMcl: '주거용건물', dateFrom, dateTo, statuses: ['매각', '유찰'], maxItems: 150 } }];
