// 045 · 재조회 대상 묶기: 11-12 이전에 들어온 tracked 낙찰 결과 행을 법원별 12건씩
// 11-14 02:20 실행(#24357)에서 이미 교정한 144행은 건너뜀 (그 실행은 30분 제한으로 창원 12묶음만 처리)
const DONE = new Set([3,4,5,6,9,10,11,12,13,14,15,16,17,18,19,21,22,24,26,27,33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,49,50,51,53,55,72,73,74,75,76,77,78,79,81,82,83,85,88,90,92,93,94,95,96,98,100,105,106,107,108,109,110,111,113,114,115,116,117,118,120,126,127,128,129,131,132,133,134,135,136,137,138,139,141,142,143,144,145,146,147,148,149,150,158,159,160,161,163,162,164,165,166,168,169,170,173,174,175,176,177,178,179,180,181,182,183,184,185,187,188,189,190,191,194,195,197,198,199,200,201,202,203,204,206,205,207,208,209]);
const rows = ($input.first().json.list || []).filter((r) =>
  (r.source === 'tracked' || !r.source) && r.result_type === '매각' && String(r.CreatedAt || '') < '2026-11-12' && !DONE.has(r.Id));
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
