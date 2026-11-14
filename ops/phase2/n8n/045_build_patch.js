// 045 · 트래커 응답(기일표 기준 유찰 수·낙찰 회차 최저가)으로 결과 행 교정 값 만들기
const batch = $('재조회 묶음').item.json;
const resp = $input.first().json || {};
const data = resp.data || [];
const keyOf = (s) => { const m = String(s || '').match(/(\d{4})타경(\d+)/); return m ? `${m[1]}타경${m[2]}` : ''; };
const rows = [];
let matched = 0;
for (const r of batch.rows) {
  const cands = data.filter((d) => keyOf(d.case_no) === keyOf(r.case_no));
  // 상세번호가 있는 행은 같은 상세번호일 때만 교정 (11-14 실행에서 물건번호 추정으로 다른 물건 값이 들어간 사례: Id 37·88)
  const d = r.detail_uid
    ? cands.find((c) => String(c.detail_uid) === String(r.detail_uid))
    : (cands.length === 1 ? cands[0] : cands.find((c) => String(c.item_no || '1') === String(r.item_no || '1')));
  if (!d || !Number.isInteger(d.loss_count)) continue;
  // 낙찰 회차 최저가가 감정가보다 크면 다른 물건으로 보고 건너뜀
  if (d.last_min_price > 0 && Number(r.appraisal_price) > 0 && d.last_min_price > Number(r.appraisal_price) * 1.05) continue;
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
