// 엔진 V4 · 계층 축소 추정 (2026-11-14, 4단계)
// 아이디어: 낙찰가율을 직접 맞히는 대신 '그 회차 최저가 대비 배수'(낙찰가 ÷ 최저가)를 추정한다.
//   배수는 법원별 저감률(20%·30%)이나 회차가 달라도 비교가 쉽고, 최저가는 입찰 시점에 확정된 값이다.
// 계층: 전체 → 법원 → 시군구 → 읍면동 → 단지. 아래 단계 표본이 적으면 위 단계 값 쪽으로 당긴다(경험적 베이즈식 가중 평균).
//   est(level) = (n·median(level) + K·est(parent)) / (n + K)
// 유찰 구간(0·1·2·3·4+)별로 따로 계산하고, 구간 표본이 없으면 전 구간 값으로 대신한다.
// 같은 코드를 n8n 010·012 Code 노드와 백테스트에서 함께 쓴다 (module.exports 는 노드에서 무시).

const V4 = (() => {
  const K = 10;   // 백테스트(11-14): K=2·5·10·20 중 10이 오차·편향 균형이 가장 좋음
  const BIN = (n) => Math.min(Math.max(Number(n) || 0, 0), 4);
  const clean = (s) => String(s || '').trim();
  const median = (a) => { if (!a.length) return null; const v = [...a].sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const quant = (a, p) => { if (!a.length) return null; const v = [...a].sort((x, y) => x - y); const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return v[lo] + (v[hi] - v[lo]) * (i - lo); };

  // 행(결과 이벤트 또는 물건) → 계층 키 [전체, 법원, 시군구, 읍면동, 단지]
  function keysOf(r) {
    const court = clean(r.court), sgg = clean(r.sgg), emd = clean(r.emd), cx = clean(r.complex_name);
    const out = [['전체', '전체']];
    if (court) out.push(['법원', court]);
    if (sgg) out.push(['시군구', sgg]);
    if (sgg && emd) out.push(['읍면동', `${sgg} ${emd}`]);
    if (sgg && cx && cx.length >= 2 && !/^\d|^제?\d+층|필지|^[가-힣]?동$|^\d+호$/.test(cx)) out.push(['단지', `${sgg} ${cx}`]);
    return out;
  }

  // 결과 이벤트(낙찰만, 통계 제외 행 빼고)에서 (단계|범위|구간) → 배수 목록
  function buildIndex(events) {
    const idx = new Map();
    const push = (k, v) => { if (!idx.has(k)) idx.set(k, []); idx.get(k).push(v); };
    for (const r of events) {
      const rate = Number(r.actual_bid_rate), mr = Number(r.min_price_rate);
      if (!(rate > 0 && mr > 0)) continue;
      const m = rate / mr;
      const bin = BIN(r.loss_count);
      for (const [lv, sc] of keysOf(r)) { push(`${lv}|${sc}|${bin}`, m); push(`${lv}|${sc}|*`, m); }
    }
    return idx;
  }

  // n8n 049 통계 행(auction_stats)으로도 같은 인덱스를 흉내 낼 수 있게: 중앙값·표본 수만 있으면 됨
  function indexFromStats(statsRows) {
    const idx = new Map();
    for (const s of statsRows) {
      if (!(Number(s.over_min_median) > 0) || !(Number(s.n_sold) > 0)) continue;
      idx.set(`${s.level}|${s.scope}|${BIN(s.loss_bin)}`, { n: Number(s.n_sold), med: Number(s.over_min_median),
        q1: Number(s.over_min_q1) || null, q3: Number(s.over_min_q3) || null });
    }
    // 구간 무관(*) 값: 구간별 중앙값을 표본 수로 가중 평균(근사)
    const agg = new Map();
    for (const [k, v] of idx) { const [lv, sc] = k.split('|'); const a = agg.get(`${lv}|${sc}`) || { n: 0, s: 0 }; a.n += v.n; a.s += v.med * v.n; agg.set(`${lv}|${sc}`, a); }
    for (const [k, a] of agg) idx.set(`${k}|*`, { n: a.n, med: a.s / a.n });
    return idx;
  }

  const stat = (idx, key) => {
    const v = idx.get(key);
    if (!v) return null;
    if (Array.isArray(v)) return { n: v.length, med: median(v), q1: quant(v, 0.25), q3: quant(v, 0.75) };
    return v;
  };

  // 물건 → 추정 배수와 근거
  function estimate(idx, item) {
    const bin = BIN(item.loss_count);
    const path = keysOf(item);
    let est = null, q1 = null, q3 = null, used = [];
    for (const [lv, sc] of path) {
      const s = stat(idx, `${lv}|${sc}|${bin}`) || (est == null ? stat(idx, `${lv}|${sc}|*`) : null);
      if (!s || !(s.med > 0)) continue;
      if (est == null) { est = s.med; q1 = s.q1 ?? null; q3 = s.q3 ?? null; }
      else {
        const w = s.n / (s.n + K);
        est = w * s.med + (1 - w) * est;
        if (s.q1 && q1) q1 = w * s.q1 + (1 - w) * q1;
        if (s.q3 && q3) q3 = w * s.q3 + (1 - w) * q3;
      }
      used.push(`${lv}${lv === '전체' ? '' : ' ' + sc}(${s.n}건)`);
    }
    return { mult: est, q1, q3, bin, used };
  }

  return { K, BIN, keysOf, buildIndex, indexFromStats, estimate, median, quant };
})();

if (typeof module !== 'undefined') module.exports = V4;
