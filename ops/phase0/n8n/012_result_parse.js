// 012 · 결과 파싱 (2026-11-12 0단계 개편)
// - 판정: sold / rescheduled(유찰·변경·불허가·미납 후 다음 기일) / canceled / hold(기일 미정·미확인·애매) / unchanged
// - 매칭: 상세페이지 번호 > 사건번호 + 물건번호 (다물건 사건에서 엉뚱한 물건 결과가 붙지 않게)
// - 유찰 횟수: 트래커가 기일표에서 센 값 우선 (매일 +1 되던 버그 제거)
// - 법원: 트래커가 읽은 실제 관할로 보정 (양산 = 울산지방법원)
// - 다음 기일이 잡히면 V3 엔진으로 목표가를 바로 다시 계산 (유찰 후 목표가가 그대로 남던 문제)

let splitItem;
try { splitItem = $('Split In Batches').item.json; } catch (e) { splitItem = {}; }

const raw = $input.first().json || {};
const extractedList = raw.data || raw.extractedResult || [];
const storedItems = splitItem.items || [];
if (storedItems.length === 0) return [];

const keyOf = (s) => {
  const m = (s || '').match(/(\d{4})타경(\d+)/);
  return m ? `${m[1]}타경${m[2]}` : (s || '').replace(/\s+/g, '');
};
const normDate = (s) => (s ? String(s).trim().replace(/\./g, '-').slice(0, 10) : '');
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

const formatPrice = (val) => {
  if (!val || val <= 0) return '0원';
  const eok = Math.floor(val / 100000000);
  const remainder = Math.round((val % 100000000) / 10000);
  return eok > 0 ? (remainder > 0 ? `${eok}억 ${remainder.toLocaleString()}만원` : `${eok}억`) : `${remainder.toLocaleString()}만원`;
};

// ── V3 입찰가 엔진 (010 '입찰가 엔진 및 GAP SCORE 계산'과 같은 규칙; 복합통계 테이블은 비어 있어 표 기반) ──
function runEngineV3(s, minPrice, lossCount) {
  const appraisal = num(s.appraisal_price);
  const realAvg = num(s.real_trade_3m_avg) || num(s.real_trade_6m_avg) || num(s.real_trade_12m_avg);
  const areaSqm = num(s.area_m2);
  const inheritedAmt = num(s.inherited_amount) > 0 ? num(s.inherited_amount) : 0;
  const tenantDeposit = num(s.tenant_deposit_total) > 0 ? num(s.tenant_deposit_total) : 0;
  const aiRisk = s.ai_risk || '주의';

  const LOSS_RATE_TABLE = { 0: 82, 1: 76, 2: 70, 3: 65, 4: 60 };
  const baseRate = LOSS_RATE_TABLE[Math.min(lossCount, 4)] || 60;
  const rateSource = `유찰보정규칙(유찰${lossCount}회)`;
  const confidence = '낮음';

  let riskAdjust = 0;
  if (aiRisk === '위험') riskAdjust = -5;
  if (aiRisk === '주의') riskAdjust = -2;
  if (aiRisk === '안전') riskAdjust = +1;
  let areaAdjust = 0;
  if (areaSqm < 60) areaAdjust = +2;
  else if (areaSqm > 99) areaAdjust = -2;

  const adjustedRate = Math.max(50, Math.min(100, baseRate + riskAdjust + areaAdjust));
  const basePrice = realAvg > 0 ? Math.min(realAvg, appraisal) : appraisal;
  const effectiveBase = Math.max(0, basePrice - inheritedAmt);
  const bidTarget = Math.round(effectiveBase * (adjustedRate / 100));
  const finalBidMin = Math.max(Math.round(bidTarget * 0.95), minPrice);
  const finalBidTarget = Math.max(bidTarget, minPrice);
  const finalBidMax = Math.max(Math.round(bidTarget * 1.03), minPrice);

  const tradeBase = num(s.real_trade_3m_avg) || num(s.real_trade_6m_avg) || num(s.real_trade_12m_avg);
  let gapAmt = null, gapRate = null, gapBaseScore = 0;
  if (finalBidTarget && tradeBase) {
    gapAmt = finalBidTarget - tradeBase;
    gapRate = Math.round((gapAmt / tradeBase) * 1000) / 10;
    if (gapRate <= -20) gapBaseScore = 60;
    else if (gapRate <= -15) gapBaseScore = 52;
    else if (gapRate <= -10) gapBaseScore = 45;
    else if (gapRate <= -5) gapBaseScore = 38;
    else if (gapRate <= 0) gapBaseScore = 30;
    else if (gapRate <= 5) gapBaseScore = 20;
    else if (gapRate <= 10) gapBaseScore = 10;
  }
  const riskScore = aiRisk === '안전' ? 20 : aiRisk === '주의' ? 10 : 0;
  const compScore = lossCount >= 3 ? 20 : lossCount >= 2 ? 15 : lossCount >= 1 ? 10 : 5;
  let dataPenalty = 5; // confidence 낮음
  if (!num(s.real_trade_3m_avg) && !num(s.real_trade_6m_avg)) dataPenalty += 5;
  if (num(s.real_trade_sample_count) < 3) dataPenalty += 5;
  const gapScore = Math.max(0, Math.min(100, gapBaseScore + riskScore + compScore - dataPenalty));
  const gapGrade = gapScore >= 80 ? 'S' : gapScore >= 65 ? 'A' : gapScore >= 50 ? 'B' : gapScore >= 35 ? 'C' : 'D';

  const toEok = (v) => `${(Math.round(v / 1000000) / 100).toFixed(2)}억`;
  const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const strategyText =
    `📊 입찰가 산출 근거 (V3 엔진 · 결과추적 후 재계산)\n` +
    `기준 낙찰가율: ${adjustedRate}% (${rateSource})\n` +
    `  └─ 기본: ${baseRate}% + 리스크보정: ${riskAdjust > 0 ? '+' : ''}${riskAdjust}% + 면적보정: ${areaAdjust > 0 ? '+' : ''}${areaAdjust}%\n` +
    `기준가: ${toEok(basePrice)} (${realAvg > 0 ? '실거래vs감정 최솟값' : '감정가'})\n` +
    (inheritedAmt > 0 ? `인수비용 차감: -${toEok(inheritedAmt)}\n` : '') +
    `\n💰 추천 입찰가 범위\n  하한: ${toEok(finalBidMin)}\n  ★ 목표: *${toEok(finalBidTarget)}*\n  상한: ${toEok(finalBidMax)}\n` +
    (bidTarget < minPrice ? `⚠️ 계산 목표가(${toEok(bidTarget)})가 최저가보다 낮음 — 이번 회차 유찰 가능성 높음\n` : '') +
    `\n신뢰도: ${confidence}\n` +
    (num(s.inherited_amount) === -1 ? '⚠️ 인수금액 불명 — 실제 부담 추가될 수 있음\n' : '') +
    (tenantDeposit > 0 ? `⚠️ 임차인 보증금 ${toEok(tenantDeposit)} — 대항력 여부 재확인 필요\n` : '');

  return {
    bid_min: finalBidMin, bid_max: finalBidMax, bid_target: finalBidTarget,
    bid_rate_used: adjustedRate, bid_confidence: confidence,
    bid_strategy_text: strategyText, bid_strategy_updated: nowStr,
    bid_vs_trade_gap_amt: gapAmt, bid_vs_trade_gap_rate: gapRate,
    gap_score: gapScore, gap_score_grade: gapGrade, gap_calculated_at: nowStr,
  };
}

const results = [];
for (const stored of storedItems) {
  const storedCaseNo = stored.case_no || stored.사건번호 || stored.saNo || '';
  if (!storedCaseNo) continue;
  const key = keyOf(storedCaseNo);
  const storedItemNo = stored.item_no ? String(stored.item_no) : '';

  // ── 매칭: 상세페이지 번호 > 사건번호 + 물건번호 ──
  const cands = extractedList.filter((r) => keyOf(r.case_no || r.사건번호 || r.saNo || '') === key);
  let matched = null;
  let ambiguous = false;
  // 1순위: 상세페이지 번호(court_url의 /view/{uid})가 같으면 같은 물건
  const uidM = String(stored.court_url || stored.url || '').match(/\/view\/(\d+)|idx=(\d+)/);
  const storedUid = uidM ? (uidM[1] || uidM[2]) : '';
  if (storedUid) matched = cands.find((r) => String(r.detail_uid || '') === storedUid) || null;
  if (matched) {
    // 확정
  } else if (cands.length === 1) {
    matched = cands[0];
  } else if (cands.length > 1) {
    if (storedItemNo) matched = cands.find((r) => String(r.item_no || '1') === storedItemNo) || null;
    if (!matched) ambiguous = true; // 물건번호를 모르는 다물건 사건 → 쓰지 않고 수동 확인 표시
  }

  const m = matched || {};
  const resultText = (m.result || 'pending').trim();
  const nextBidDate = m.next_bid_date || null;
  const nextMinPrice = num(m.next_min_price);
  const storedLoss = num(stored.loss_count);
  const storedDate = normDate(stored.bid_date);
  const trackerLoss = Number.isInteger(m.loss_count) ? m.loss_count : null;
  const newCourt = m.court || stored.court || '';
  const newItemNo = matched ? String(m.item_no || storedItemNo || '1') : storedItemNo;

  // ── 판정 ──
  let resultStatus = 'hold';
  if (!matched) {
    resultStatus = 'hold';
  } else if (m.is_unchanged === true) {
    const needsFix =
      (trackerLoss !== null && trackerLoss !== storedLoss) ||
      (m.court && m.court !== stored.court) ||
      (m.item_no && !storedItemNo);
    resultStatus = needsFix ? 'hold' : 'unchanged';
  } else if (resultText.includes('불허') || resultText.includes('미납')) {
    resultStatus = nextBidDate ? 'rescheduled' : 'hold';
  } else if (resultText.includes('매각')) {
    resultStatus = 'sold';
  } else if (resultText.includes('취하') || resultText.includes('기각') || resultText.includes('정지')) {
    resultStatus = 'canceled';
  } else if (nextBidDate) {
    resultStatus = 'rescheduled';
  }

  // ── 유찰 횟수: 트래커 값 우선, 없으면 '기일이 바뀐 유찰'만 +1 ──
  const newLoss = trackerLoss !== null
    ? trackerLoss
    : (resultText === '유찰' && nextBidDate && normDate(nextBidDate) !== storedDate ? storedLoss + 1 : storedLoss);

  const newMinPrice = resultStatus === 'rescheduled' && nextMinPrice > 0 ? nextMinPrice : num(stored.min_price);
  const engine = resultStatus === 'rescheduled' ? runEngineV3(stored, newMinPrice, newLoss) : {};

  const actualBidPrice = num(m.actual_bid_price);
  const bidderCount = num(m.bidder_count);
  const appraisalPrice = num(stored.appraisal_price);
  const actualBidRate = appraisalPrice > 0 && actualBidPrice > 0
    ? Math.round((actualBidPrice / appraisalPrice) * 1000) / 10 : null;
  const ourBidTarget = num(stored.bid_target);
  const engineError = ourBidTarget > 0 && actualBidPrice > 0
    ? Math.round(((ourBidTarget - actualBidPrice) / actualBidPrice) * 1000) / 10 : null;
  const saleMinPrice = num(m.last_min_price) || num(stored.min_price);

  // 텔레그램(비활성) 호환용 표시 필드
  const trade3m = num(stored.real_trade_3m_avg);
  const trade6m = num(stored.real_trade_6m_avg);
  const tradeBase = trade3m || trade6m;
  let tradeDiffText = '';
  if (actualBidPrice > 0 && tradeBase > 0) {
    const diff = actualBidPrice - tradeBase;
    const rate = Math.round((diff / tradeBase) * 1000) / 10;
    tradeDiffText = rate <= 0
      ? `✅ 실거래대비 ${Math.abs(rate)}% 저렴 (${Math.round(Math.abs(diff) / 10000).toLocaleString()}만원 마진)`
      : `⚠️ 실거래대비 +${rate}% (${Math.round(diff / 10000).toLocaleString()}만원 비쌈)`;
  }
  const searchKey = stored.complex_name || stored.location || '';

  results.push({
    json: {
      ...stored,
      __resultStatus: resultStatus,
      __resultText: resultText,
      __isUnchanged: m.is_unchanged === true,
      __skippedReason: m.skipped_reason || null,
      __ambiguous: ambiguous,
      __candidates: cands.length,
      new_loss_count: newLoss,
      new_min_price: newMinPrice,
      new_court: newCourt,
      new_item_no: newItemNo,
      sale_min_price: saleMinPrice,
      engine,
      actual_bid_price: actualBidPrice,
      actual_bid_rate: actualBidRate,
      bidder_count: bidderCount,
      next_bid_date: nextBidDate,
      next_min_price: nextMinPrice,
      engine_error: engineError,
      fetched_at: new Date().toISOString(),
      court_url: stored.court_url || stored.url || 'https://www.my-auction.co.kr',
      naver_url: stored.naver_url || (searchKey ? 'https://m.land.naver.com/search/result/' + encodeURIComponent(searchKey) : 'https://m.land.naver.com'),
      appraisal_price_fmt: formatPrice(appraisalPrice),
      min_price_fmt: formatPrice(num(stored.min_price)),
      actual_bid_price_fmt: formatPrice(actualBidPrice),
      real_trade_3m_fmt: formatPrice(trade3m),
      real_trade_6m_fmt: formatPrice(trade6m),
      trade_diff_text: tradeDiffText,
      bid_diff_text: ourBidTarget > 0 && actualBidPrice > 0
        ? `(${ourBidTarget - actualBidPrice >= 0 ? '+' : ''}${Math.round((ourBidTarget - actualBidPrice) / 10000).toLocaleString()}만원)` : '',
    },
  });
}
return results;
