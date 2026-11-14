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


// ── V4 입찰가 엔진 (4단계, 2026-11-14) ─────────────────────────────────────
// 010 '입찰가 엔진 및 GAP SCORE 계산'과 012 '결과 파싱'에 같은 내용으로 들어간다. 원본: ops/phase4/
// 추천가 = 이번 회차 최저가 × '최저가 대비 낙찰가 배수' 추정치 (통계 auction_stats, 계층 축소 추정)
//   목표가 = 배수 중앙값(≈ 낙찰 확률 50%), 상한 = 75% 분위(≈ 65%), 하한 = 25% 분위(최저가 이상)
// 백테스트(08-15 이후 낙찰 254건, 그 기일 이전 자료만 사용): 평균 오차 V3 운영 19.2%p → V4 9.3%p
// 인수금액은 빼지 않는다(시장 낙찰가 추정치). 인수 부담은 경고로 표시하고 수익 계산(대시보드)에서 반영.
function runEngineV4(s, minPrice, lossCount, statsRows) {
  const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
  const appraisal = num(s.appraisal_price);
  const minRate = appraisal > 0 && minPrice > 0 ? (minPrice / appraisal) * 100 : 0;
  const addr = String(s.location || '');
  const t = addr.split(/\s+/);
  let sgg = '', emd = '';
  if (t.length >= 2) {
    sgg = t[1]; let rest = t.slice(2);
    if (rest[0] && /구$/.test(rest[0])) { sgg += ' ' + rest[0]; rest = rest.slice(1); }
    const e = rest.find((x) => /(동|읍|면|가)$/.test(x) && !/^\d/.test(x));
    if (e) emd = e;
  }
  const idx = V4.indexFromStats(statsRows || []);
  const est = minRate > 0 ? V4.estimate(idx, { court: s.court, sgg, emd, complex_name: s.complex_name, loss_count: lossCount }) : { mult: null, used: [] };
  if (!est.mult) return null;   // 통계 없음 → 호출한 쪽에서 V3로 대신 계산

  const clampMin = (v) => Math.max(Math.round(v), minPrice);
  const target = clampMin(minPrice * est.mult);
  const hi = clampMin(minPrice * (est.q3 || est.mult * 1.08));
  const lo = clampMin(minPrice * (est.q1 || est.mult * 0.95));
  const rateUsed = Math.round((target / appraisal) * 1000) / 10;
  // 신뢰도: 이 유찰 구간에서 표본 5건 이상인 가장 좁은 단계
  const deep = est.used.filter((u) => Number((u.match(/\((\d+)건\)/) || [])[1]) >= 5).map((u) => u.split(' ')[0].replace(/\(.*/, ''));
  const confidence = deep.some((l) => l === '단지' || l === '읍면동') ? '높음' : deep.some((l) => l === '시군구' || l === '법원') ? '보통' : '낮음';

  // GAP SCORE: V3와 같은 규칙 (목표가 vs 실거래 평균)
  const aiRisk = s.ai_risk || '주의';
  const tradeBase = num(s.real_trade_3m_avg) || num(s.real_trade_6m_avg) || num(s.real_trade_12m_avg);
  let gapAmt = null, gapRate = null, gapBaseScore = 0;
  if (target && tradeBase) {
    gapAmt = target - tradeBase;
    gapRate = Math.round((gapAmt / tradeBase) * 1000) / 10;
    if (gapRate <= -20) gapBaseScore = 60; else if (gapRate <= -15) gapBaseScore = 52; else if (gapRate <= -10) gapBaseScore = 45;
    else if (gapRate <= -5) gapBaseScore = 38; else if (gapRate <= 0) gapBaseScore = 30; else if (gapRate <= 5) gapBaseScore = 20; else if (gapRate <= 10) gapBaseScore = 10;
  }
  const riskScore = aiRisk === '안전' ? 20 : aiRisk === '주의' ? 10 : 0;
  const compScore = lossCount >= 3 ? 20 : lossCount >= 2 ? 15 : lossCount >= 1 ? 10 : 5;
  let dataPenalty = confidence === '낮음' ? 5 : 0;
  if (!num(s.real_trade_3m_avg) && !num(s.real_trade_6m_avg)) dataPenalty += 5;
  if (num(s.real_trade_sample_count) < 3) dataPenalty += 5;
  const gapScore = Math.max(0, Math.min(100, gapBaseScore + riskScore + compScore - dataPenalty));
  const gapGrade = gapScore >= 80 ? 'S' : gapScore >= 65 ? 'A' : gapScore >= 50 ? 'B' : gapScore >= 35 ? 'C' : 'D';

  const toEok = (v) => `${(Math.round(v / 1000000) / 100).toFixed(2)}억`;
  const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const inherited = num(s.inherited_amount);
  const tenantDeposit = num(s.tenant_deposit_total);
  const text =
    `📊 입찰가 산출 근거 (V4 엔진 · 실제 낙찰 통계)\n` +
    `이번 회차 최저가: ${toEok(minPrice)} (감정가의 ${Math.round(minRate * 10) / 10}%, 유찰 ${lossCount}회)\n` +
    `최저가 대비 낙찰가 배수: ×${est.mult.toFixed(3)}${est.q1 && est.q3 ? ` (보통 ×${est.q1.toFixed(2)}~×${est.q3.toFixed(2)})` : ''}\n` +
    `  └─ 근거: ${est.used.join(' → ')}\n` +
    `예상 낙찰가율: ${rateUsed}% (감정가 대비)\n` +
    `\n💰 추천 입찰가 범위\n  하한: ${toEok(lo)}\n  ★ 목표: *${toEok(target)}* (낙찰 확률 약 50%)\n  상한: ${toEok(hi)} (약 65%)\n` +
    `\n신뢰도: ${confidence}\n` +
    (inherited > 0 ? `⚠️ 인수금액 ${toEok(inherited)} — 추천가는 시장 낙찰가 추정이며 인수금액은 별도 부담\n` : '') +
    (inherited === -1 ? '⚠️ 인수금액 불명 — 실제 부담 추가될 수 있음\n' : '') +
    (tenantDeposit > 0 ? `⚠️ 임차인 보증금 ${toEok(tenantDeposit)} — 대항력 여부 재확인 필요\n` : '');

  return {
    bid_min: lo, bid_max: hi, bid_target: target, bid_rate_used: rateUsed, bid_confidence: confidence,
    bid_strategy_text: text, bid_strategy_updated: nowStr,
    bid_vs_trade_gap_amt: gapAmt, bid_vs_trade_gap_rate: gapRate,
    gap_score: gapScore, gap_score_grade: gapGrade, gap_calculated_at: nowStr,
  };
}

// ── 050 · 진행중 물건 목표가 V4 일괄 재계산 (1회) ──
const stats = $('통계 조회').all().flatMap((i) => (i.json && i.json.list) || []);
const items = $input.all().flatMap((i) => (i.json && i.json.list) || []);
const patches = [], before = [], skipped = [];
for (const it of items) {
  if (it.is_hidden || it.is_share || it.is_bulk) { skipped.push(it.Id); continue; }
  const minPrice = Number(it.min_price) || 0;
  const r = runEngineV4(it, minPrice, Number(it.loss_count) || 0, stats);
  if (!r) { skipped.push(it.Id); continue; }
  before.push({ Id: it.Id, case_no: it.case_no, bid_min: it.bid_min, bid_target: it.bid_target, bid_max: it.bid_max, bid_rate_used: it.bid_rate_used,
    bid_confidence: it.bid_confidence, bid_strategy_text: it.bid_strategy_text, bid_strategy_updated: it.bid_strategy_updated,
    bid_vs_trade_gap_amt: it.bid_vs_trade_gap_amt, bid_vs_trade_gap_rate: it.bid_vs_trade_gap_rate, gap_score: it.gap_score, gap_score_grade: it.gap_score_grade });
  patches.push({ Id: it.Id, ...r });
}
const chunks = [];
for (let i = 0; i < patches.length; i += 50) chunks.push({ json: { rows: patches.slice(i, i + 50), before: before.slice(i, i + 50), total: patches.length, skipped } });
return chunks;
