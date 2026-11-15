// ── 051 · 진행중 물건 시세 백필 (5단계, 1회) ──
// 입력: NocoDB 목록 { list } / 출력: 100행씩 { rows: 수정할 값, before: 바꾸기 전 값, summary }
// - 실거래 표가 있으면 코드로 시세 계산(market_*), 기존 real_trade_3m/6m/12m_avg 도 같은 계산값으로 교체(AI 값 대신)
// - 표에 매매 거래가 없으면 3m/6m/12m_avg = 0 (AI가 지어낸 값 제거)
// - 전용면적: 명세서 '전유부분' 값으로 area_m2 보정(대지권 면적이 들어간 물건)
// - 표가 없으면('정보 없음') market_basis 만 '실거래 없음'으로 표시 → 052(재수집)·국토부 API 대상
const items = $input.all().flatMap((i) => (i.json && i.json.list) || []);
const ref = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const rows = [], before = [];
const summary = { items: items.length, active: 0, table: 0, market: 0, areaFixed: 0, noTable: 0, zeroed: 0 };
for (const it of items) {
  if (it.is_hidden || it.is_share || it.is_bulk) continue;
  summary.active++;
  const patch = {};
  const ex = MarketPrice.exclusiveArea(it);
  if (ex && Math.abs(ex / (Number(it.area_m2) || 1) - 1) > 0.05) { patch.area_m2 = ex; summary.areaFixed++; }
  const calcItem = { ...it, area_m2: ex || it.area_m2 };
  if (/계약일/.test(String(it.real_trade_history || ''))) {
    summary.table++;
    Object.assign(patch, MarketPrice.compute(calcItem, { ref }), MarketPrice.legacyAverages(calcItem, { ref }));
    if (patch.market_price) summary.market++;
    else if (Number(it.real_trade_3m_avg) || Number(it.real_trade_6m_avg) || Number(it.real_trade_12m_avg)) summary.zeroed++;
    if (!patch.market_price) patch.market_basis = '실거래 표에 매매 없음';
  } else {
    summary.noTable++;
    patch.market_basis = '실거래 없음 (재수집 대상)';
  }
  before.push({ Id: it.Id, case_no: it.case_no, area_m2: it.area_m2, real_trade_3m_avg: it.real_trade_3m_avg, real_trade_6m_avg: it.real_trade_6m_avg,
    real_trade_12m_avg: it.real_trade_12m_avg, real_trade_sample_count: it.real_trade_sample_count });
  rows.push({ Id: it.Id, ...patch });
}
const chunks = [];
for (let i = 0; i < rows.length; i += 100) chunks.push({ json: { rows: rows.slice(i, i + 100), before: before.slice(i, i + 100), summary } });
return chunks.length ? chunks : [{ json: { rows: [], before: [], summary } }];
