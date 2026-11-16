// ── 058 · 크롤러 /crawl {uids} 결과 → 서류 저장(빈 값으로 덮어쓰지 않음) + 시세 다시 계산 + AI 재분석 대기 ──
// 위에 cleanDocText(010 '파싱 및 1차 필터'와 같은 함수)와 MarketPrice(5단계 시세 계산)가 붙는다.
const { targets } = $('대상 고르기').first().json;
const res = $input.first().json || {};
const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
const ref = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const uidOf = (u) => { const m = String(u || '').match(/\/view\/(\d+)|idx=(\d+)/); return m ? (m[1] || m[2]) : ''; };
const DOCS = [
  ['sale_spec', 'doc_spec_text', '명세서'], ['status_survey', 'doc_survey_text', '현황조사'], ['appraisal', 'doc_appraisal_text', '감정평가'],
  ['registry', 'doc_registry_text', '등기부'], ['building_ledger', 'doc_ledger_text', '건축물대장'],
];
const ok = (v) => !!(v && v !== '정보 없음');

const crawlErr = res.error || (res.success === false ? (res.error || '실패') : '');
const byUid = {};
for (const it of (Array.isArray(res.data) ? res.data : [])) byUid[uidOf(it.url)] = it;

const rows = [];
const summary = { targets: targets.length, got: 0, filled: 0 };
for (const t of targets) {
  const it = byUid[t.uid];
  if (!it) {
    rows.push({ Id: t.Id, refetch_status: `실패 · ${stamp} · ${crawlErr ? '크롤러 오류: ' + String(crawlErr).slice(0, 100) : '상세 페이지를 받지 못함'}` });
    continue;
  }
  summary.got++;
  const docs = it.docs || {};
  const patch = { Id: t.Id };
  const got = [], newly = [];
  for (const [src, field, label] of DOCS) {
    const text = cleanDocText(docs[src], src);
    if (!ok(text)) continue;             // 못 받은 서류는 기존 값 유지
    patch[field] = text; got.push(label);
    if (!t.had[field]) newly.push(label);
  }
  const rt = docs.real_trade_history ? cleanDocText(docs.real_trade_history, 'real_trade_history') : '';
  if (ok(rt) && /계약일/.test(rt)) {
    patch.real_trade_history = rt; got.push('실거래');
    if (!t.had.real_trade_history) newly.push('실거래');
    const item = { complex_name: t.complex_name, area_m2: t.area_m2, doc_spec_text: patch.doc_spec_text || '', real_trade_history: rt };
    item.area_m2 = MarketPrice.exclusiveArea(item) || t.area_m2;
    const m = MarketPrice.compute(item, { ref });
    if (m.market_price) Object.assign(patch, m, MarketPrice.legacyAverages(item, { ref }));
  }
  if (newly.length) summary.filled++;
  patch.docs_fetched_at = new Date().toISOString();
  patch.refetch_status = got.length
    ? `완료 · ${stamp} · 받음: ${got.join(', ')}${newly.length ? ` (새로 채움: ${newly.join(', ')})` : ' (새로 채운 서류 없음)'}`
    : `실패 · ${stamp} · 상세 페이지는 열렸지만 서류를 하나도 받지 못함`;
  if (got.length) patch.ai_reanalyze_status = `대기 · ${stamp} 서류 재수집 뒤 자동`;   // 059가 10분 안에 권리분석
  rows.push(patch);
}
return [{ json: { rows, summary } }];
