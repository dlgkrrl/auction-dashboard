// 043 · 크롤러 이벤트 중 결과 테이블에 아직 없는 (상세번호, 기일)만 남기고 행 형식으로 변환
const job = $('완료됐나').first().json; // 반복 노드 대신 한 번만 실행되는 '완료됐나'에서 최종 상태를 읽음
const jobId = $('수집 작업 시작').first().json.job_id || null; // 상태 응답에는 job_id가 없음
const events = job.events || [];
const existingRows = $input.first().json.list || [];
const existing = new Set(existingRows.map((r) => `${r.detail_uid}|${String(r.bid_date || '').slice(0, 10)}`));
// 같은 물건의 낙찰은 기일 표기가 하루 어긋나도 같은 사건 → 10일 안의 기존 낙찰이 있으면 중복으로 봄
const soldDates = {};
for (const r of existingRows) if (r.result_type === '매각') (soldDates[r.detail_uid] = soldDates[r.detail_uid] || []).push(String(r.bid_date || '').slice(0, 10));
const dayDiff = (a, b) => Math.abs(new Date(a) - new Date(b)) / 86400e3;
// 법원이 비어 오면(상세 제목 약칭 미매핑) 주소로 관할 법원 채움
function jurisdiction(addr) {
  const a = String(addr || '');
  if (/양산시/.test(a)) return '울산지방법원';
  if (/마산합포구|마산회원구|함안군|의령군/.test(a)) return '창원지방법원 마산지원';
  if (/통영시|거제시|고성군/.test(a)) return '창원지방법원 통영지원';
  if (/진주시|사천시|남해군|하동군|산청군/.test(a)) return '창원지방법원 진주지원';
  if (/밀양시|창녕군/.test(a)) return '창원지방법원 밀양지원';
  if (/거창군|함양군|합천군/.test(a)) return '창원지방법원 거창지원';
  if (/경상남도/.test(a)) return '창원지방법원';
  return '';
}
const fetchedAt = new Date().toISOString();
const rows = [];
let dup = 0;
for (const e of events) {
  const key = `${e.detail_uid}|${e.bid_date}`;
  if (existing.has(key)) { dup++; continue; }
  if (e.result_type === '매각' && (soldDates[e.detail_uid] || []).some((d) => dayDiff(d, e.bid_date) <= 10)) { dup++; continue; }
  existing.add(key);
  const ap = Number(e.appraisal_price) || 0;
  const mp = Number(e.min_price) || 0;
  const rate = e.actual_bid_rate;
  rows.push({
    ...e,
    court: e.court || jurisdiction(e.location),
    source: 'court_list',
    engine_version: null,
    fetched_at: fetchedAt,
    is_outlier: (rate != null && (rate < 5 || rate > 200)) || (ap > 0 && mp > ap * 1.05),
  });
}
const chunks = [];
for (let i = 0; i < rows.length; i += 100) chunks.push({ json: { rows: rows.slice(i, i + 100) } });
const summary = { job_id: jobId, events: events.length, duplicate: dup, inserted: rows.length,
  sold: rows.filter((r) => r.result_type === '매각').length, failed: rows.filter((r) => r.result_type === '유찰').length,
  progress: job.progress || {}, status: job.status, error: job.error || null };
return chunks.length ? chunks.map((c) => ({ json: { ...c.json, summary } })) : [{ json: { rows: [], summary } }];
