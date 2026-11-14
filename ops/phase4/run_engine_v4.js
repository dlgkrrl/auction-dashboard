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
