// 0단계 점검 (읽기 전용): 물건·결과 테이블 상태 요약
const items = $('물건 조회').first().json.list || [];
const results = $input.first().json.list || [];
const kst = new Date(Date.now() + 9 * 3600e3);
const today = kst.toISOString().slice(0, 10);
const since = '2026-11-12';
const d = (v) => (v ? String(v).replace(/\./g, '-').slice(0, 10) : '');
const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const active = items.filter((i) => i.status === '진행중' && !i.is_hidden);
const stale = active.filter((i) => d(i.bid_date) && d(i.bid_date) < today);
const losses = active.map((i) => Number(i.loss_count) || 0);
const newResults = results.filter((r) => d(r.CreatedAt) >= since);
return [{ json: {
  checked_at_kst: kst.toISOString().slice(0, 16),
  items_total: items.length,
  status_counts: count(items, (i) => i.status || '(빈값)'),
  active_count: active.length,
  stale_active_count: stale.length,
  stale_by_court: count(stale, (i) => i.court || '(빈값)'),
  stale_by_month: count(stale, (i) => d(i.bid_date).slice(0, 7)),
  court_counts_active: count(active, (i) => i.court || '(빈값)'),
  yangsan_not_ulsan: active.filter((i) => /양산시/.test(i.location || '') && i.court !== '울산지방법원').length,
  loss_count_max: Math.max(0, ...losses),
  loss_count_over_8: losses.filter((x) => x > 8).length,
  item_no_filled_active: active.filter((i) => i.item_no).length,
  needs_manual_review: items.filter((i) => i.needs_manual_review).map((i) => i.case_no),
  last_checked_since_1112: items.filter((i) => d(i.last_checked) >= since).length,
  engine_recalc_since_1112: items.filter((i) => d(i.bid_strategy_updated) >= since).length,
  results_total: results.length,
  results_new_since_1112: newResults.length,
  results_new: newResults.map((r) => ({ case_no: r.case_no, item_no: r.item_no, court: r.court, result_type: r.result_type, loss_count: r.loss_count, rate: r.actual_bid_rate, bidders: r.bidder_count, err: r.engine_error_rate })),
} }];
