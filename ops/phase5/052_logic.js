// ── 052 · 크롤러 /real-trade 결과 → 실거래 표 저장 + 시세 계산 ──
const job = $input.first().json;
if (job.status !== 'done') throw new Error('재수집 작업 실패: ' + (job.error || job.status));
const { targets } = $('대상 고르기').first().json;
const ref = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const rows = [];
const summary = { targets: targets.length, ok: 0, market: 0, statuses: {} };
for (const t of targets) {
  const r = (job.results || {})[t.uid];
  const st = r ? r.status : 'missing';
  summary.statuses[st] = (summary.statuses[st] || 0) + 1;
  if (st === 'ok') {
    summary.ok++;
    const it = { ...t, area_m2: MarketPrice.exclusiveArea(t) || t.area_m2, real_trade_history: r.text };
    const patch = { Id: t.Id, real_trade_history: r.text, ...MarketPrice.compute(it, { ref }), ...MarketPrice.legacyAverages(it, { ref }) };
    if (patch.market_price) summary.market++; else patch.market_basis = '실거래 표에 매매 없음 → 국토부 대상';
    rows.push(patch);
  } else {
    rows.push({ Id: t.Id, market_basis: `마이옥션 실거래 없음(${st}) → 국토부 대상` });
  }
}
const chunks = [];
for (let i = 0; i < rows.length; i += 50) chunks.push({ json: { rows: rows.slice(i, i + 50), summary } });
return chunks.length ? chunks : [{ json: { rows: [], summary } }];
