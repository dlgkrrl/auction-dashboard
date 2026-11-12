// 045 · 재조회 대상 묶기: 11-12 이전에 들어온 tracked 낙찰 결과 행을 법원별 12건씩
const rows = ($input.first().json.list || []).filter((r) =>
  (r.source === 'tracked' || !r.source) && r.result_type === '매각' && String(r.CreatedAt || '') < '2026-11-12');
const byCourt = {};
for (const r of rows) {
  const court = r.court || '창원지방법원';
  (byCourt[court] = byCourt[court] || []).push({ Id: r.Id, case_no: r.case_no, item_no: r.item_no, detail_uid: r.detail_uid, bidder_count: r.bidder_count, appraisal_price: r.appraisal_price });
}
const out = [];
for (const [court, list] of Object.entries(byCourt)) {
  for (let i = 0; i < list.length; i += 12) {
    const chunk = list.slice(i, i + 12);
    out.push({ json: { court, case_nos: [...new Set(chunk.map((r) => r.case_no))], rows: chunk } });
  }
}
return out;
