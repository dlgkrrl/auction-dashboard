/**
 * 🏛️ THE CALIBRATION — 경매 낙찰 ROI 및 실투자금 계산 엔진 (V2.0)
 * 
 * 사용자 제공 [경매 낙찰 ROI 계산기 (경남 · 무주택자, 임대 운영 포함)] 공식 100% 이식
 * - 경락잔금대출 한도 및 초기 자기자본
 * - 잔금일 당장 준비해야 하는 현금 (Cash on Closing)
 * - 세입자 보증금 회수 후 실질 자기자본 (무피/플러스피 자동 판별)
 * - 취득세, 보유이자, 임대소득세, 양도소득세(보유기간 연동), 지방세 세후 순수익 산출
 * - 빌라/주택 실거래가 부재 시 보수적 감정가 할인율(85%) 및 수동 시세 지원
 * 
 * ※ 순수 계산 함수로 동작하며, 브라우저 로컬 저장소(localStorage) 대신
 *   NAS NocoDB 데이터와 직접 연동됩니다.
 */

const DEFAULT_PROFILE = {
  investorType: 'no_house',       // 'no_house' (무주택 1.1%), 'one_house' (1주택 1.1%), 'multi_house' (다주택 8.4%), 'corporate' (법인 12.4%)
  acquisitionTaxRate: 0.011,       // 기본 1.1%
  availableCash: 20000000,         // 기본 가용 현금: 2,000만원
  appraisalDiscountRate: 0.85,     // 빌라/주택 실거래가 없을 때 감정가 할인율: 85%
  loanInterestRate: 0.05,          // 대출 금리: 연 5.0%
  legalFee: 500000,                // 법무사/등기비용: 50만원
  evictionFee: 2000000,            // 명도비용(이사비 등): 200만원
  repairFee: 2000000,              // 수리비(자본적 지출): 200만원
  defaultHoldingMonths: 24,        // 기본 보유기간: 24개월
  brokerageRate: 0.005,            // 매도 중개수수료율: 0.5%
  rentalIncomeTaxRate: 0.154,      // 임대소득세율: 15.4% (지방소득세 포함)
  localIncomeTaxRate: 0.10,        // 지방소득세: 양도세의 10%
};

/**
 * 메인 ROI 및 실투자금 계산 함수 (Pure Function)
 * @param {Object} item 경매 물건 데이터 (NocoDB 원장)
 * @param {Object} customOverrides 개별 물건별 조정한 인풋값 (선택)
 * @param {Object} profileSettings 사용자 투자 설정 (선택)
 */
function calculateAuctionROI(item, customOverrides = {}, profileSettings = null) {
  const profile = profileSettings || DEFAULT_PROFILE;
  
  // 1. 기본 가격 파싱
  const appraisalPrice = Number(item.appraisal_price || item.감정가_숫자 || 0);
  const minPrice = Number(item.min_price || item.최저가_숫자 || 0);
  const targetBid = Number(item.bid_target || minPrice || 0);

  // 낙찰가 (사용자 직접 입력 > n8n 목표가 > 최저매각가)
  const bidPrice = Number(customOverrides.bidPrice ?? (targetBid > 0 ? targetBid : minPrice));

  // 시세 기준 산출 (수동 입력 > 실거래가 평균 > 감정가 할인율)
  const manualPrice = customOverrides.expectedSalePrice ?? item.manual_price;
  
  let baseMarketPrice = 0;
  let marketPriceType = 'real_trade'; // 'real_trade', 'appraisal_discount', 'manual'

  if (manualPrice && Number(manualPrice) > 0) {
    baseMarketPrice = Number(manualPrice);
    marketPriceType = 'manual';
  } else if (item.real_trade_3m_avg && Number(item.real_trade_3m_avg) > 0) {
    baseMarketPrice = Number(item.real_trade_3m_avg);
    marketPriceType = 'real_trade_3m';
  } else if (item.real_trade_6m_avg && Number(item.real_trade_6m_avg) > 0) {
    baseMarketPrice = Number(item.real_trade_6m_avg);
    marketPriceType = 'real_trade_6m';
  } else if (item.real_trade_12m_avg && Number(item.real_trade_12m_avg) > 0) {
    baseMarketPrice = Number(item.real_trade_12m_avg);
    marketPriceType = 'real_trade_12m';
  } else {
    // 빌라/주택 등 실거래가 부재 시: 감정가에 할인율(기본 85%) 적용
    baseMarketPrice = Math.round(appraisalPrice * (profile.appraisalDiscountRate || 0.85));
    marketPriceType = 'appraisal_discount';
  }

  // 예상 매도가
  const expectedSalePrice = Number(customOverrides.expectedSalePrice ?? baseMarketPrice);

  // 보유기간(개월)
  const holdingMonths = Number(customOverrides.holdingMonths ?? profile.defaultHoldingMonths ?? 24);

  // 임대 운영 조건 (전세 또는 월세)
  const rentalDeposit = Number(customOverrides.rentalDeposit ?? (customOverrides.isJeonse ? Math.round(expectedSalePrice * 0.65) : (item.default_rent_deposit || 0)));
  const monthlyRent = Number(customOverrides.monthlyRent ?? 0);
  const isDepositInherited = Number(customOverrides.isDepositInherited ?? 1); // 1: 매수자 인수, 0: 세입자 반환

  // 비용 요소
  const acquisitionTaxRate = Number(customOverrides.acquisitionTaxRate ?? profile.acquisitionTaxRate ?? 0.011);
  const legalFee = Number(customOverrides.legalFee ?? profile.legalFee ?? 500000);
  const evictionFee = Number(customOverrides.evictionFee ?? profile.evictionFee ?? 2000000);
  const repairFee = Number(customOverrides.repairFee ?? profile.repairFee ?? 2000000);
  const loanInterestRate = Number(customOverrides.loanInterestRate ?? profile.loanInterestRate ?? 0.05);
  const brokerageRate = Number(profile.brokerageRate ?? 0.005);
  const rentalIncomeTaxRate = Number(profile.rentalIncomeTaxRate ?? 0.154);
  const localIncomeTaxRate = Number(profile.localIncomeTaxRate ?? 0.10);

  // ----------------------------------------------------
  // ③ 경락잔금대출 한도 및 자기자본 계산
  // ----------------------------------------------------
  const loanLimitAppraisal = Math.round(appraisalPrice * 0.60); // 감정가 60%
  const loanLimitBid = Math.round(bidPrice * 0.80);             // 낙찰가 80%
  const loanLimit = Math.max(0, Math.min(loanLimitAppraisal, loanLimitBid)); // 낮은 값 적용

  // 초기 잔금 기준 순수 차액 (낙찰가 - 대출금)
  const initialCash = Math.max(0, bidPrice - loanLimit);

  // ----------------------------------------------------
  // ④ 취득 단계 비용
  // ----------------------------------------------------
  const acquisitionTax = Math.round(bidPrice * acquisitionTaxRate);
  const acquisitionCostTotal = acquisitionTax + legalFee + evictionFee + repairFee;

  // 💡 [핵심 지표 1] 잔금일 당장 준비해야 하는 현금 (Cash on Closing)
  const cashOnClosing = initialCash + acquisitionCostTotal;

  // 💡 [핵심 지표 2] 세입자 보증금 회수 후 최종 실질 자기자본 부담 (Net Cash Invested)
  const realCashNeeded = cashOnClosing - (isDepositInherited ? rentalDeposit : 0);
  const isPlusFee = realCashNeeded <= 0; // 무피 / 플러스피

  // ----------------------------------------------------
  // ⑤ 보유 단계 비용 및 임대수익
  // ----------------------------------------------------
  const totalLoanInterest = Math.round(loanLimit * (loanInterestRate / 12) * holdingMonths);
  const totalRentIncome = Math.round(monthlyRent * holdingMonths);
  const rentalIncomeTax = Math.round(totalRentIncome * rentalIncomeTaxRate);
  const netRentalIncome = totalRentIncome - rentalIncomeTax;

  // ----------------------------------------------------
  // ⑥ 매도 및 양도소득세
  // ----------------------------------------------------
  const brokerageFee = Math.round(expectedSalePrice * brokerageRate);
  
  // 양도세 인정 필요경비 (취득세 + 법무사 + 수리비(자본적지출) + 매도중개수수료)
  const capitalGainsExpenses = acquisitionTax + legalFee + repairFee + brokerageFee;
  const capitalGains = Math.max(0, expectedSalePrice - bidPrice - capitalGainsExpenses);

  // 양도소득세율 자동 판정 (보유기간 연동)
  let capitalGainsTaxRate = 0.24; // 24개월 이상 기본세율 가정
  if (holdingMonths < 12) {
    capitalGainsTaxRate = 0.70; // 1년 미만 70%
  } else if (holdingMonths < 24) {
    capitalGainsTaxRate = 0.60; // 2년 미만 60%
  }

  const capitalGainsTax = Math.round(capitalGains * capitalGainsTaxRate);
  const localIncomeTax = Math.round(capitalGainsTax * localIncomeTaxRate);
  const totalTax = capitalGainsTax + localIncomeTax;

  const depositRefund = !isDepositInherited ? rentalDeposit : 0;

  // ----------------------------------------------------
  // ⑦ 최종 손익 및 ROI (임대수익 · 보증금 반영)
  // ----------------------------------------------------
  const totalInvestedCost = bidPrice + acquisitionCostTotal + totalLoanInterest;
  const totalSaleExpense = brokerageFee + totalTax;

  // 최종 순수익
  const netProfit = (expectedSalePrice - totalInvestedCost - totalSaleExpense - depositRefund) + netRentalIncome;

  // 단순 자기자본 대비 ROI
  const roiInitial = initialCash > 0 ? ((netProfit / initialCash) * 100) : 0;

  // 실질 자기자본 대비 ROI
  let roiReal = 0;
  let roiRealText = '';
  if (isPlusFee) {
    roiRealText = '무피/플러스피 (순이익 ' + formatKRW(netProfit) + ')';
    roiReal = 999;
  } else {
    roiReal = (netProfit / realCashNeeded) * 100;
    roiRealText = roiReal.toFixed(1) + '%';
  }

  // 연환산 ROI
  let annualizedROI = null;
  if (!isPlusFee && realCashNeeded > 0 && holdingMonths > 0) {
    const rawAnnual = (Math.pow(1 + (netProfit / realCashNeeded), 12 / holdingMonths) - 1) * 100;
    annualizedROI = isFinite(rawAnnual) ? rawAnnual.toFixed(1) + '%' : null;
  }

  // 내 가용자금(예: 2,000만원) 대비 입찰 가능 여부
  const availableCash = Number(profile.availableCash || 20000000);
  const isBudgetOk = cashOnClosing <= availableCash;
  const budgetGap = availableCash - cashOnClosing;

  return {
    appraisalPrice,
    minPrice,
    bidPrice,
    expectedSalePrice,
    baseMarketPrice,
    marketPriceType,
    holdingMonths,
    rentalDeposit,
    monthlyRent,
    isDepositInherited,
    
    // 대출 & 자기자본
    loanLimit,
    loanLimitAppraisal,
    loanLimitBid,
    initialCash,
    cashOnClosing,     // [핵심] 잔금일 필요 현금
    realCashNeeded,    // [핵심] 세입자 세팅 후 실투자금
    isPlusFee,
    
    // 비용 & 세금
    acquisitionTax,
    acquisitionCostTotal,
    totalLoanInterest,
    totalRentIncome,
    rentalIncomeTax,
    netRentalIncome,
    brokerageFee,
    capitalGainsExpenses,
    capitalGains,
    capitalGainsTaxRate,
    capitalGainsTax,
    localIncomeTax,
    totalTax,
    totalInvestedCost,
    totalSaleExpense,

    // 최종 결과
    netProfit,
    roiInitial: roiInitial.toFixed(1) + '%',
    roiReal: roiRealText,
    roiRealNum: isPlusFee ? 999 : roiReal,
    annualizedROI,
    
    // 예산 판별
    availableCash,
    isBudgetOk,
    budgetGap,
  };
}

/**
 * 금액 포맷터 (원 단위 ➡️ 억/만 원 포맷)
 */
function formatKRW(val) {
  if (val === null || val === undefined || isNaN(val)) return '-';
  const isNeg = val < 0;
  const absVal = Math.abs(val);
  
  if (absVal === 0) return '0원';
  
  const eok = Math.floor(absVal / 100000000);
  const man = Math.round((absVal % 100000000) / 10000);
  
  let res = '';
  if (eok > 0) {
    res += eok + '억 ';
  }
  if (man > 0 || eok === 0) {
    res += man.toLocaleString() + '만원';
  }
  return (isNeg ? '-' : '') + res.trim();
}

/**
 * 숫자 콤마 포맷터
 */
function formatNum(val) {
  if (val === null || val === undefined || isNaN(val)) return '0';
  return Math.round(val).toLocaleString();
}

// 전역 내보내기 (브라우저 환경)
if (typeof window !== 'undefined') {
  window.DEFAULT_PROFILE = DEFAULT_PROFILE;
  window.calculateAuctionROI = calculateAuctionROI;
  window.formatKRW = formatKRW;
  window.formatNum = formatNum;
}

// 모듈 환경
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_PROFILE,
    calculateAuctionROI,
    formatKRW,
    formatNum,
  };
}
