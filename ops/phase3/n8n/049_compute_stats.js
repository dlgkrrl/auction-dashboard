// 049 · 결과 테이블 → 통계 (단계, 범위, 유찰 구간) 1행
// 입력: '결과 조회'(페이지별 { list }) / 출력: 100행씩 { rows, run_id, summary }
// 제외: is_outlier·is_share·is_bulk·loss_count_suspect, 최근 24개월 밖
const pages = typeof $input !== 'undefined' ? $input.all().map((i) => i.json) : globalThis.__pages;
const all = pages.flatMap((p) => p.list || []);
const isTrue = (v) => v === true || v === 1 || v === '1' || v === 'true';
const kst = new Date(Date.now() + 9 * 3600e3);
const today = kst.toISOString().slice(0, 10);
const from = new Date(kst.getTime() - 730 * 86400e3).toISOString().slice(0, 10);
const runId = kst.toISOString().slice(0, 16).replace(/[-:T]/g, '');
const d10 = (v) => String(v || '').replace(/\./g, '-').slice(0, 10);

const rows = all.filter((r) => !isTrue(r.is_outlier) && !isTrue(r.is_share) && !isTrue(r.is_bulk) && !isTrue(r.loss_count_suspect)
  && (r.result_type === '매각' || r.result_type === '유찰') && d10(r.bid_date) >= from && d10(r.bid_date) <= today);

const binOf = (n) => Math.min(Math.max(Number(n) || 0, 0), 4);   // 4 = 4회 이상
const clean = (s) => String(s || '').trim();
// 단계별 범위 키
function scopes(r) {
  const court = clean(r.court), sgg = clean(r.sgg), emd = clean(r.emd), cx = clean(r.complex_name);
  const out = [{ level: '전체', scope: '전체', court: '', sgg: '', emd: '', complex_name: '' }];
  if (court) out.push({ level: '법원', scope: court, court, sgg: '', emd: '', complex_name: '' });
  if (sgg) out.push({ level: '시군구', scope: sgg, court, sgg, emd: '', complex_name: '' });
  if (sgg && emd) out.push({ level: '읍면동', scope: `${sgg} ${emd}`, court, sgg, emd, complex_name: '' });
  // 단지: 이름이 '3층301호'·'외 1필지'처럼 단지명이 아닌 값은 제외
  if (sgg && cx && cx.length >= 2 && !/^\d|^제?\d+층|필지|^[가-힣]?동$|^\d+호$/.test(cx)) {
    out.push({ level: '단지', scope: `${sgg} ${cx}`, court, sgg, emd, complex_name: cx });
  }
  return out;
}

const groups = new Map();
for (const r of rows) {
  const bin = binOf(r.loss_count);
  for (const s of scopes(r)) {
    const key = `${s.level}|${s.scope}|${bin}`;
    if (!groups.has(key)) groups.set(key, { ...s, loss_bin: bin, rates: [], mins: [], over: [], bidders: [], fail: 0, dates: [] });
    const g = groups.get(key);
    g.dates.push(d10(r.bid_date));
    if (r.result_type === '유찰') { g.fail++; continue; }
    const rate = Number(r.actual_bid_rate);
    if (!(rate > 0)) continue;
    g.rates.push(rate);
    const mr = Number(r.min_price_rate);
    if (mr > 0) { g.mins.push(mr); g.over.push(rate / mr); }
    const b = Number(r.bidder_count);
    if (b > 0) g.bidders.push(b);
  }
}

const q = (arr, p) => {   // 선형 보간 분위수
  if (!arr.length) return null;
  const v = [...arr].sort((a, b) => a - b);
  const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return v[lo] + (v[hi] - v[lo]) * (i - lo);
};
const r1 = (x, k = 1) => (x == null ? null : Math.round(x * 10 ** k) / 10 ** k);
const computedAt = new Date().toISOString();
const out = [];
for (const g of groups.values()) {
  const n = g.rates.length;
  if (n === 0 && g.fail === 0) continue;
  g.dates.sort();
  out.push({
    level: g.level, scope: g.scope, court: g.court, sgg: g.sgg, emd: g.emd, complex_name: g.complex_name, loss_bin: g.loss_bin,
    n_sold: n, n_fail: g.fail, sale_ratio: r1(n / (n + g.fail) * 100),
    rate_median: r1(q(g.rates, 0.5)), rate_q1: r1(q(g.rates, 0.25)), rate_q3: r1(q(g.rates, 0.75)),
    min_rate_median: r1(q(g.mins, 0.5)), over_min_median: r1(q(g.over, 0.5), 2),
    bidders_avg: g.bidders.length ? r1(g.bidders.reduce((a, b) => a + b, 0) / g.bidders.length) : null,
    period_from: g.dates[0], period_to: g.dates[g.dates.length - 1], run_id: runId, computed_at: computedAt,
  });
}
const summary = { run_id: runId, results: all.length, used: rows.length, stats_rows: out.length,
  by_level: out.reduce((m, r) => ((m[r.level] = (m[r.level] || 0) + 1), m), {}) };
const chunks = [];
for (let i = 0; i < out.length; i += 100) chunks.push({ json: { rows: out.slice(i, i + 100), run_id: runId, summary } });
return chunks.length ? chunks : [{ json: { rows: [], run_id: runId, summary } }];
