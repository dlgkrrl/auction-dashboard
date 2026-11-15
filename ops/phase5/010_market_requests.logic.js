// ── 010 · 신규 물건 시세 요청 (5단계, 11-15) ──
// 'Dify 결과 파싱' 한 건 → 국토부 실거래 요청(최근 12개월 × 매매·전월세). 주소·종류를 못 읽으면 건너뛰기 표시 1건(흐름 유지용)
const d = $input.first().json;
const di = d.dify_inputs || {};
const item = { location: d.소재지, complex_name: d.단지명, doc_spec_text: di.sale_spec };
const a = Molit.parseAddr(item.location), t = Molit.typeOf(item);
const kst = new Date(Date.now() + 9 * 3600e3);
const out = [];
if (a.lawd && t) {
  for (let k = 0; k < 12; k++) {
    const dt = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - k, 1));
    const ymd = `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    for (const kind of ['trade', 'rent']) { const svc = Molit.SVC[t][kind]; if (svc) out.push({ json: { svc, lawd: a.lawd, kind, ymd } }); }
  }
}
return out.length ? out : [{ json: { skip: true, svc: 'RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade', lawd: '', kind: 'trade', ymd: '' } }];
