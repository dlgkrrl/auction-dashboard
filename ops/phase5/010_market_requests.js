// 5단계 · 국토부 실거래가 API 보완 (2026-11-15)
// 물건 주소 → 시군구 코드(LAWD_CD)·읍면동·지번, 물건 종류 → API 서비스. 응답 행 → MarketPrice 표준 행.
const Molit = (() => {
  const LAWD = {
    '창원시 의창구': '48121', '창원시 성산구': '48123', '창원시 마산합포구': '48125', '창원시 마산회원구': '48127', '창원시 진해구': '48129',
    '김해시': '48250', '양산시': '48330', '거제시': '48310', '진주시': '48170', '밀양시': '48270', '통영시': '48220', '사천시': '48240',
    '함안군': '48730', '창녕군': '48740', '고성군': '48820', '의령군': '48720', '남해군': '48840', '하동군': '48850', '거창군': '48880', '합천군': '48890',
  };
  const SVC = {
    apt: { trade: 'RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade', rent: 'RTMSDataSvcAptRent/getRTMSDataSvcAptRent' },
    offi: { trade: 'RTMSDataSvcOffiTrade/getRTMSDataSvcOffiTrade', rent: null },
    rh: { trade: 'RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade', rent: 'RTMSDataSvcRHRent/getRTMSDataSvcRHRent' },
    sh: { trade: 'RTMSDataSvcSHTrade/getRTMSDataSvcSHTrade', rent: null },
  };
  const toNum = (s) => Number(String(s ?? '').replace(/[^0-9.\-]/g, '')) || 0;
  const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/\(.*?\)/g, '').replace(/(아파트|APT)$/i, '');

  // 주소 → { sgg, lawd, emd, jibun }  (도로명 주소면 '구) 지번주소' 부분 사용)
  function parseAddr(loc) {
    let s = String(loc || '');
    const old = s.match(/구\)\s*(.+)$/);
    if (old) s = old[1];
    const t = s.split(/\s+/);
    if (t.length < 3) return {};
    let sgg = t[1], i = 2;
    if (/구$/.test(t[2]) && /시$/.test(t[1])) { sgg = `${t[1]} ${t[2]}`; i = 3; }
    let emd = t[i] || '';
    let next = t[i + 1] || '';
    if (/[읍면]$/.test(emd) && /리$/.test(next)) { emd = `${emd} ${next}`; next = t[i + 2] || ''; }
    const jibun = (next.match(/^(산?\d+(-\d+)?)/) || [])[1] || '';
    return { sgg, lawd: LAWD[sgg] || '', emd, jibun };
  }

  // 물건 종류: 명세서·단지명·주소로 판단
  function typeOf(item) {
    const s = `${item.complex_name || ''} ${item.location || ''} ${String(item.doc_spec_text || '').slice(0, 4000)}`;
    if (/오피스텔/.test(s)) return 'offi';
    if (/아파트/.test(s)) return 'apt';
    if (/다세대|연립|빌라|공동주택/.test(s)) return 'rh';
    if (/단독|다가구/.test(s)) return 'sh';
    if (/\d+호/.test(String(item.location || ''))) return 'rh';
    return null;
  }

  // 응답 item → 표준 행
  function toRow(it, kind) {
    const date = `${it.dealYear}-${String(it.dealMonth).padStart(2, '0')}-${String(it.dealDay).padStart(2, '0')}`;
    const name = it.aptNm || it.offiNm || it.mhouseNm || '';
    const area = toNum(it.excluUseAr || it.totalFloorAr);
    const r = { date, name, floor: toNum(it.floor), area, year: toNum(it.buildYear), umd: String(it.umdNm || '').trim(), jibun: String(it.jibun ?? '').trim() };
    if (kind === 'trade') { if (String(it.cdealType || '').trim()) return null; r.kind = '매매'; r.price = toNum(it.dealAmount) * 10000; }
    else { r.deposit = toNum(it.deposit) * 10000; r.monthly = toNum(it.monthlyRent) * 10000; r.kind = r.monthly > 0 ? '월세' : '전세'; }
    return area > 0 ? r : null;
  }

  // 같은 단지(지번 같음 또는 이름 같음) 우선, 없으면 같은 읍면동
  function sameSite(rows, item, addr) {
    const inUmd = rows.filter((r) => r.umd && addr.emd && (r.umd === addr.emd || r.umd.startsWith(addr.emd) || addr.emd.startsWith(r.umd) || r.umd.endsWith(addr.emd) || addr.emd.endsWith(r.umd)));
    const cx = norm(item.complex_name);
    const site = inUmd.filter((r) => (addr.jibun && r.jibun === addr.jibun) || (cx.length >= 2 && norm(r.name) && (norm(r.name).includes(cx) || cx.includes(norm(r.name)))));
    return { rows: site.length ? site : inUmd, scope: site.length ? '같은 단지' : '같은 읍면동' };
  }

  return { LAWD, SVC, parseAddr, typeOf, toRow, sameSite };
})();

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
