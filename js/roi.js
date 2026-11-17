// 수익 계산 엔진: 세금·취득비용·순익 (currentProfile은 app.js에서 정의, 호출 시점에만 참조)
// ─────────────────────────────────────────────────────
// 🏛️ ROI Calculation Engine (Embedded)
// ─────────────────────────────────────────────────────
const DEFAULT_PROFILE = {
  investorType: "no_house",
  acquisitionTaxRate: 0.011,
  availableCash: 20000000,
  appraisalDiscountRate: 0.85,
  loanInterestRate: 0.05,
  legalFee: 500000,
  evictionFee: 2000000,
  repairFee: 2000000,
  defaultHoldingMonths: 24,
  brokerageRate: 0.005,
  rentalIncomeTaxRate: 0.154,
  localIncomeTaxRate: 0.10,
};

// ─────────────────────────────────────────────────────
// 세금 (2026 기준 개략치 — 투자 판단 참고용, 정확한 세액은 세무사 확인)
// ─────────────────────────────────────────────────────
// 취득세: 주택 수(취득 후 기준)와 가격으로 계산. 창원·김해·양산은 비조정대상지역 기준.
function calcAcquisitionTaxRate(investorType, price, areaM2) {
  const farmTax = Number(areaM2) > 85 ? 0.002 : 0;              // 농어촌특별세 (85㎡ 초과)
  if (investorType === 'corporate') return 0.12 + 0.004 + (farmTax ? 0.01 : 0);
  if (investorType === 'multi_house') return 0.08 + 0.004 + (farmTax ? 0.006 : 0); // 3주택째 이상
  // 무주택·1주택(→2주택, 비조정 일반세율): 6억 이하 1%, 6~9억 비례, 9억 초과 3%
  let base;
  if (price <= 600000000) base = 0.01;
  else if (price <= 900000000) base = (price / 100000000 * 2 / 3 - 3) / 100;
  else base = 0.03;
  return base + base * 0.1 + farmTax;                            // + 지방교육세(취득세의 10%)
}

// 양도소득세 기본세율 (과세표준 기준, 누진공제 방식)
function progressiveIncomeTax(base) {
  const B = [
    [14000000, 0.06, 0], [50000000, 0.15, 1260000], [88000000, 0.24, 5760000],
    [150000000, 0.35, 15440000], [300000000, 0.38, 19940000], [500000000, 0.40, 25940000],
    [1000000000, 0.42, 35940000], [Infinity, 0.45, 65940000],
  ];
  if (base <= 0) return 0;
  const [, rate, deduction] = B.find(([limit]) => base <= limit);
  return Math.max(0, Math.round(base * rate - deduction));
}

// 주택 양도세: 단기 70%/60%, 2년 이상 기본세율 + 장기보유특별공제(3년~) + 기본공제 250만.
// 무주택자가 산 1주택을 2년 이상 보유 후 12억 이하로 팔면 1세대1주택 비과세(비조정지역은 거주요건 없음).
function calcCapitalGainsTax(investorType, gain, holdingMonths, salePrice) {
  if (gain <= 0) return { tax: 0, rateLabel: '차익 없음' };
  if (investorType === 'corporate') {
    // 법인: 법인세(2억 이하 9% 가정) + 주택 추가과세 20%
    return { tax: Math.round(gain * 0.29), rateLabel: '법인 29%(추정)' };
  }
  if (holdingMonths < 12) return { tax: Math.round(gain * 0.70), rateLabel: '단기 70%' };
  if (holdingMonths < 24) return { tax: Math.round(gain * 0.60), rateLabel: '단기 60%' };
  if (investorType === 'no_house' && salePrice <= 1200000000) {
    return { tax: 0, rateLabel: '1세대1주택 비과세' };
  }
  const years = Math.floor(holdingMonths / 12);
  const ltRate = years >= 3 ? Math.min(0.30, 0.06 + 0.02 * (years - 3)) : 0;
  const base = Math.max(0, Math.round(gain * (1 - ltRate)) - 2500000);
  const tax = progressiveIncomeTax(base);
  return { tax, rateLabel: `기본세율${ltRate ? ` (장특 ${Math.round(ltRate * 100)}%)` : ''}` };
}

function calculateAuctionROI(item, customOverrides = {}, profileSettings = null) {
  const profile = profileSettings || currentProfile;
  const appraisalPrice = Number(item.appraisal_price || 0);
  const minPrice = Number(item.min_price || 0);
  const targetBid = Number(item.bid_target || minPrice || 0);
  const bidPrice = Number(customOverrides.bidPrice ?? (targetBid > 0 ? targetBid : minPrice));
  const investorType = profile.investorType || 'no_house';

  let baseMarketPrice = 0;
  let marketPriceType = "real_trade";

  if (customOverrides.expectedSalePrice && Number(customOverrides.expectedSalePrice) > 0) {
    baseMarketPrice = Number(customOverrides.expectedSalePrice);
    marketPriceType = "manual";
  } else if (Number(item.market_price) > 0) {
    // 5단계: 코드로 계산한 시세(같은 단지·전용 ±10% 실거래 중앙값)
    baseMarketPrice = Number(item.market_price);
    marketPriceType = "market";
  } else if (item.real_trade_3m_avg && Number(item.real_trade_3m_avg) > 0) {
    baseMarketPrice = Number(item.real_trade_3m_avg);
    marketPriceType = "real_trade_3m";
  } else if (item.real_trade_6m_avg && Number(item.real_trade_6m_avg) > 0) {
    baseMarketPrice = Number(item.real_trade_6m_avg);
    marketPriceType = "real_trade_6m";
  } else if (item.real_trade_12m_avg && Number(item.real_trade_12m_avg) > 0) {
    baseMarketPrice = Number(item.real_trade_12m_avg);
    marketPriceType = "real_trade_12m";
  } else {
    baseMarketPrice = Math.round(appraisalPrice * (profile.appraisalDiscountRate || 0.85));
    marketPriceType = "appraisal_discount";
  }

  const expectedSalePrice = Number(customOverrides.expectedSalePrice ?? baseMarketPrice);
  const holdingMonths = Number(customOverrides.holdingMonths ?? profile.defaultHoldingMonths ?? 24);
  const rentalDeposit = Number(customOverrides.rentalDeposit ?? (customOverrides.isJeonse ? (Number(item.jeonse_median) > 0 ? Number(item.jeonse_median) : Math.round(expectedSalePrice * 0.65)) : 0));
  const monthlyRent = Number(customOverrides.monthlyRent ?? 0);
  const isDepositInherited = Number(customOverrides.isDepositInherited ?? 1);

  // 인수금액(대항력 있는 임차인 보증금 등): 낙찰가와 별도로 매수인이 떠안는 돈. -1 = AI가 판단 못함
  const rawInherited = Number(item.inherited_amount);
  const inheritedUnknown = rawInherited === -1;
  const inheritedAmount = Number(customOverrides.inheritedAmount ?? (rawInherited > 0 ? rawInherited : 0));

  const acquisitionTaxRate = Number(customOverrides.acquisitionTaxRate ?? calcAcquisitionTaxRate(investorType, bidPrice, item.area_m2));
  const legalFee = Number(customOverrides.legalFee ?? profile.legalFee ?? 500000);
  const evictionFee = Number(customOverrides.evictionFee ?? profile.evictionFee ?? 2000000);
  const repairFee = Number(customOverrides.repairFee ?? profile.repairFee ?? 2000000);
  const loanInterestRate = Number(customOverrides.loanInterestRate ?? profile.loanInterestRate ?? 0.05);
  const brokerageRate = Number(profile.brokerageRate ?? 0.005);
  const rentalIncomeTaxRate = Number(profile.rentalIncomeTaxRate ?? 0.154);
  const localIncomeTaxRate = Number(profile.localIncomeTaxRate ?? 0.10);

  const loanLimitAppraisal = Math.round(appraisalPrice * 0.60);
  const loanLimitBid = Math.round(bidPrice * 0.80);
  const loanLimit = Math.max(0, Math.min(loanLimitAppraisal, loanLimitBid));
  const initialCash = Math.max(0, bidPrice - loanLimit);

  // 취득세 과세표준은 낙찰가 + 인수한 보증금
  const acquisitionTax = Math.round((bidPrice + inheritedAmount) * acquisitionTaxRate);
  const acquisitionCostTotal = acquisitionTax + legalFee + evictionFee + repairFee + inheritedAmount;
  const cashOnClosing = initialCash + acquisitionCostTotal;
  const realCashNeeded = cashOnClosing - (isDepositInherited ? rentalDeposit : 0);
  const isPlusFee = realCashNeeded <= 0;

  const totalLoanInterest = Math.round(loanLimit * (loanInterestRate / 12) * holdingMonths);
  const totalRentIncome = Math.round(monthlyRent * holdingMonths);
  const rentalIncomeTax = Math.round(totalRentIncome * rentalIncomeTaxRate);
  const netRentalIncome = totalRentIncome - rentalIncomeTax;

  const brokerageFee = Math.round(expectedSalePrice * brokerageRate);
  // 양도차익: 양도가 - 취득가액(낙찰가 + 인수금액) - 필요경비(취득세·법무·수리·중개)
  const capitalGainsExpenses = acquisitionTax + legalFee + repairFee + brokerageFee;
  const capitalGains = Math.max(0, expectedSalePrice - bidPrice - inheritedAmount - capitalGainsExpenses);

  const cgt = calcCapitalGainsTax(investorType, capitalGains, holdingMonths, expectedSalePrice);
  const capitalGainsTax = cgt.tax;
  const capitalGainsTaxRate = capitalGains > 0 ? capitalGainsTax / capitalGains : 0; // 실효세율
  const capitalGainsTaxLabel = cgt.rateLabel;
  const localIncomeTax = Math.round(capitalGainsTax * localIncomeTaxRate);
  const totalTax = capitalGainsTax + localIncomeTax;
  const depositRefund = !isDepositInherited ? rentalDeposit : 0;

  const totalInvestedCost = bidPrice + acquisitionCostTotal + totalLoanInterest;
  const totalSaleExpense = brokerageFee + totalTax;
  const netProfit = (expectedSalePrice - totalInvestedCost - totalSaleExpense - depositRefund) + netRentalIncome;

  const roiInitial = initialCash > 0 ? ((netProfit / initialCash) * 100) : 0;
  let roiReal = 0;
  let roiRealText = "";
  if (isPlusFee) {
    roiRealText = "무피/플러스피";
    roiReal = 999;
  } else {
    roiReal = (netProfit / realCashNeeded) * 100;
    roiRealText = roiReal.toFixed(1) + "%";
  }

  let annualizedROI = null;
  if (!isPlusFee && realCashNeeded > 0 && holdingMonths > 0) {
    const rawAnnual = (Math.pow(1 + (netProfit / realCashNeeded), 12 / holdingMonths) - 1) * 100;
    annualizedROI = isFinite(rawAnnual) ? rawAnnual.toFixed(1) + "%" : null;
  }

  const availableCash = Number(profile.availableCash || 20000000);
  const isBudgetOk = cashOnClosing <= availableCash;
  const budgetGap = availableCash - cashOnClosing;

  return {
    appraisalPrice, minPrice, bidPrice, expectedSalePrice, baseMarketPrice, marketPriceType,
    holdingMonths, rentalDeposit, monthlyRent, isDepositInherited,
    inheritedAmount, inheritedUnknown, acquisitionTaxRate,
    loanLimit, initialCash, cashOnClosing, realCashNeeded, isPlusFee,
    acquisitionTax, acquisitionCostTotal, totalLoanInterest, totalRentIncome, rentalIncomeTax,
    netRentalIncome, brokerageFee, capitalGainsExpenses, capitalGains, capitalGainsTaxRate, capitalGainsTaxLabel,
    capitalGainsTax, localIncomeTax, totalTax, totalInvestedCost, totalSaleExpense,
    netProfit, roiInitial: roiInitial.toFixed(1) + "%", roiReal: roiRealText, roiRealNum: isPlusFee ? 999 : roiReal,
    annualizedROI, availableCash, isBudgetOk, budgetGap
  };
}
