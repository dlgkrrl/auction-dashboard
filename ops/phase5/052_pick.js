// 052 · 재수집 대상: 진행중(숨김·지분·일괄 제외) 중 아직 시세가 없는 물건(054 국토부로도 못 채운 것 포함) → 상세번호(uid)
const list = ($input.first().json.list) || [];
const targets = list
  .filter((it) => !it.is_hidden && !it.is_share && !it.is_bulk && !(Number(it.market_price) > 0) && !/실거래 표에 매매 없음/.test(String(it.market_basis || '')))
  .map((it) => {
    const m = String(it.court_url || '').match(/\/view\/(\d+)|idx=(\d+)/);
    return { Id: it.Id, uid: m ? (m[1] || m[2]) : '', complex_name: it.complex_name, area_m2: it.area_m2, doc_spec_text: it.doc_spec_text };
  })
  .filter((t) => t.uid);
return [{ json: { targets, uids: targets.map((t) => t.uid) } }];
