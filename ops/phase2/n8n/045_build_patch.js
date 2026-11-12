// 045 · 트래커 응답(기일표 기준 유찰 수·낙찰 회차 최저가)으로 결과 행 교정 값 만들기
const batch = $('재조회 묶음').item.json;
const resp = $input.first().json || {};
const data = resp.data || [];
const keyOf = (s) => { const m = String(s || '').match(/(\d{4})타경(\d+)/); return m ? `${m[1]}타경${m[2]}` : ''; };
const rows = [];
let matched = 0;
for (const r of batch.rows) {
  const cands = data.filter((d) => keyOf(d.case_no) === keyOf(r.case_no));
  const d = (r.detail_uid && cands.find((c) => String(c.detail_uid) === String(r.detail_uid)))
    || (cands.length === 1 ? cands[0] : cands.find((c) => String(c.item_no || '1') === String(r.item_no || '1')));
  if (!d || !Number.isInteger(d.loss_count)) continue;
  matched++;
  const p = { Id: r.Id, loss_count: d.loss_count, loss_count_suspect: false };
  if (d.court) p.court = d.court;
  if (d.item_no) p.item_no = String(d.item_no);
  if (d.detail_uid) p.detail_uid = String(d.detail_uid);
  if (d.last_min_price > 0) {
    p.min_price = d.last_min_price;
    if (Number(r.appraisal_price) > 0) p.min_price_rate = Math.round(d.last_min_price / Number(r.appraisal_price) * 1000) / 10;
  }
  if (!(Number(r.bidder_count) > 0) && d.bidder_count > 0) p.bidder_count = d.bidder_count;
  rows.push(p);
}
return [{ json: { court: batch.court, asked: batch.rows.length, matched, rows } }];
