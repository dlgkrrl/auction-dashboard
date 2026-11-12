// 043 · 크롤러 이벤트 중 결과 테이블에 아직 없는 (상세번호, 기일)만 남기고 행 형식으로 변환
const job = $('완료됐나').first().json; // 반복 노드 대신 한 번만 실행되는 '완료됐나'에서 최종 상태를 읽음
const events = job.events || [];
const existing = new Set(($input.first().json.list || []).map((r) => `${r.detail_uid}|${String(r.bid_date || '').slice(0, 10)}`));
const fetchedAt = new Date().toISOString();
const rows = [];
let dup = 0;
for (const e of events) {
  const key = `${e.detail_uid}|${e.bid_date}`;
  if (existing.has(key)) { dup++; continue; }
  existing.add(key);
  const ap = Number(e.appraisal_price) || 0;
  const mp = Number(e.min_price) || 0;
  const rate = e.actual_bid_rate;
  rows.push({
    ...e,
    source: 'court_list',
    engine_version: null,
    fetched_at: fetchedAt,
    is_outlier: (rate != null && (rate < 5 || rate > 200)) || (ap > 0 && mp > ap * 1.05),
  });
}
const chunks = [];
for (let i = 0; i < rows.length; i += 100) chunks.push({ json: { rows: rows.slice(i, i + 100) } });
const summary = { job_id: job.job_id || null, events: events.length, duplicate: dup, inserted: rows.length,
  sold: rows.filter((r) => r.result_type === '매각').length, failed: rows.filter((r) => r.result_type === '유찰').length,
  progress: job.progress || {}, status: job.status, error: job.error || null };
return chunks.length ? chunks.map((c) => ({ json: { ...c.json, summary } })) : [{ json: { rows: [], summary } }];
