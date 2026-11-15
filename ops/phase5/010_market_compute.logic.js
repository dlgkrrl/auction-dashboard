// ── 010 · 신규 물건 시세 계산 (5단계, 11-15) ──
// 1) 크롤러 실거래 표(dify_inputs.real_trade_history)가 있으면 그것으로, 없거나 매매가 없으면 2) 국토부 응답으로
// 전용면적: 명세서 → 건축물대장 → 감정평가서 (기존 '전용면적'에는 대지권 면적이 들어가는 경우가 많았음)
// 근거 약한 값(면적 불일치로 다른 평형 사용, 국토부에서 같은 단지 못 찾음)은 버림 → 시세 없음으로 둔다
// 출력: Dify 결과 파싱 값 + 전용면적 보정 + market_* + real_trade_3m/6m/12m_avg(AI 값 대신 코드 계산)
const d = $('Dify 결과 파싱').first().json;
const di = d.dify_inputs || {};
const reqs = $('시세 요청 만들기').all().map((i) => i.json);
const resps = $input.all().map((i) => i.json);
const ref = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const item = { location: d.소재지, complex_name: d.단지명, area_m2: d.전용면적,
  doc_spec_text: di.sale_spec, doc_ledger_text: di.building_ledger, doc_appraisal_text: di.appraisal, real_trade_history: di.real_trade_history };
const ex = MarketPrice.exclusiveArea(item);
const calc = { ...item, area_m2: ex || item.area_m2 };
const weak = (b) => /면적 불일치|단지 매칭 실패/.test(String(b || ''));

let m = null, legacy = null, source = '';
if (/계약일/.test(String(item.real_trade_history || ''))) {
  const r = MarketPrice.compute(calc, { ref });
  if (r.market_price && !weak(r.market_basis)) { m = r; legacy = MarketPrice.legacyAverages(calc, { ref }); source = 'myauction'; }
  else if (r.jeonse_median || r.rent_monthly_median) m = { ...r, market_price: null };
}
if (!m || !m.market_price) {
  const a = Molit.parseAddr(item.location);
  const rows = [];
  resps.forEach((j, k) => {
    const q = reqs[k];
    if (!q || q.skip) return;
    const body = j && j.response && j.response.body;
    if (!body || (j.response.header && j.response.header.resultCode !== '000')) return;
    let its = body.items && body.items.item; if (!its) return; if (!Array.isArray(its)) its = [its];
    for (const it of its) { const r = Molit.toRow(it, q.kind); if (r) rows.push(r); }
  });
  if (rows.length && a.emd) {
    const site = Molit.sameSite(rows, item, a);
    const r = MarketPrice.compute(calc, { ref, rows: site.rows, source: '국토부 실거래' });
    if (site.scope !== '같은 단지') r.market_basis += ' · 단지 매칭 실패(같은 읍면동)';
    if (r.market_price && !weak(r.market_basis)) { m = r; legacy = MarketPrice.legacyAverages(calc, { ref, rows: site.rows }); source = 'molit'; }
    else {
      m = { ...(m || {}), jeonse_median: (m && m.jeonse_median) || (site.scope === '같은 단지' ? r.jeonse_median : null),
        rent_deposit_median: (m && m.rent_deposit_median) || (site.scope === '같은 단지' ? r.rent_deposit_median : null),
        rent_monthly_median: (m && m.rent_monthly_median) || (site.scope === '같은 단지' ? r.rent_monthly_median : null),
        market_price: null, market_basis: r.market_price ? `근거 약해 제외: ${r.market_basis}` : '실거래 없음' };
    }
  } else if (!m) m = { market_price: null, market_basis: a.lawd ? '실거래 없음' : '주소에서 시군구를 못 읽음' };
}
const out = { ...d, 전용면적: ex || d.전용면적, ...m, market_source: source };
if (legacy) Object.assign(out, legacy);
else Object.assign(out, { real_trade_3m_avg: 0, real_trade_6m_avg: 0, real_trade_12m_avg: 0, real_trade_sample_count: 0 });   // AI가 낸 근거 없는 값 대신 0
return [{ json: out }];
