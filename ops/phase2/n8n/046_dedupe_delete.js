// 046 · 결과 테이블 중복 정리 (사용자 승인 2026-11-13)
// 1) 같은 상세번호+기일+가격  2) 같은 상세번호의 같은 낙찰가가 10일 안에 두 번 (가격까지 같아야 같은 사건 — 다물건 사건 오삭제 방지) → 정보가 가장 많은 행 1개만 남김(같으면 Id 작은 것)
const rows = $input.first().json.list || [];
const filled = (r) => Object.values(r).filter((v) => v !== null && v !== '' && v !== undefined && v !== false).length;
const better = (a, b) => (filled(a) !== filled(b) ? filled(a) > filled(b) : a.Id < b.Id);
const day = (s) => String(s || '').slice(0, 10);
const price = (r) => Number(r.actual_bid_price) || Number(r.min_price) || 0;
const del = new Map();

const byKey = {};
for (const r of rows) if (r.detail_uid) { const k = `${r.detail_uid}|${day(r.bid_date)}|${price(r)}`; (byKey[k] = byKey[k] || []).push(r); }
for (const g of Object.values(byKey)) {
  if (g.length < 2) continue;
  const keep = g.reduce((a, b) => (better(a, b) ? a : b));
  for (const r of g) if (r.Id !== keep.Id) del.set(r.Id, { Id: r.Id, case_no: r.case_no, bid_date: day(r.bid_date), reason: 'same_uid_date', keep: keep.Id });
}
const sold = {};
for (const r of rows) if (r.detail_uid && r.result_type === '매각' && !del.has(r.Id)) { const k = `${r.detail_uid}|${price(r)}`; (sold[k] = sold[k] || []).push(r); }
for (const g of Object.values(sold)) {
  g.sort((a, b) => day(a.bid_date).localeCompare(day(b.bid_date)));
  for (let i = 1; i < g.length; i++) {
    const a = g[i - 1], b = g[i];
    if (Math.abs(new Date(day(a.bid_date)) - new Date(day(b.bid_date))) / 86400e3 <= 10) {
      const loser = better(a, b) ? b : a;
      const keep = loser === a ? b : a;
      del.set(loser.Id, { Id: loser.Id, case_no: loser.case_no, bid_date: day(loser.bid_date), reason: 'sale_within_10d', keep: keep.Id });
      g[i] = keep;
    }
  }
}
const list = [...del.values()];
return [{ json: { total: rows.length, delete_count: list.length, list, ids: list.map((x) => ({ Id: x.Id })) } }];
