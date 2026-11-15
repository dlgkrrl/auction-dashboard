// 5단계 · 시세 계산 (2026-11-15)
// 입력: 물건의 real_trade_history (마이옥션 실거래 표 텍스트: 헤더 '계약일\t기준\t…' + 탭 구분 행, 매매·전월세 두 표)
//       또는 국토부 API에서 만든 같은 모양의 행 목록
// 출력: market_price(매매 중앙값), p25·p75, 표본 수, 기준·기간, 전세·월세 중앙값
// 원칙: AI가 아니라 코드로 계산 → 같은 입력이면 같은 값, 근거(표본·기간·면적 기준)를 같이 남긴다.
// 같은 코드를 n8n 010(신규)·051(백필) Code 노드와 로컬 시험에서 함께 쓴다.

const MarketPrice = (() => {
  const toNum = (s) => Number(String(s ?? '').replace(/[^0-9.\-]/g, '')) || 0;
  const median = (a) => { if (!a.length) return null; const v = [...a].sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
  const quant = (a, p) => { if (!a.length) return null; const v = [...a].sort((x, y) => x - y); const i = (v.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return v[lo] + (v[hi] - v[lo]) * (i - lo); };
  const normName = (s) => String(s || '').replace(/\s+/g, '').replace(/(아파트|APT|apt)$/,'').replace(/[()\-·.]/g, '');

  // 표 텍스트 → [{date, kind:'매매'|'전세'|'월세', name, floor, area, price, deposit, monthly, year}]
  function parseHistory(text) {
    const rows = [];
    let cols = null;
    for (const line of String(text || '').split('\n')) {
      const cells = line.split('\t').map((c) => c.trim());
      if (cells[0] === '계약일') { cols = cells; continue; }
      if (!cols || !/^\d{4}[.\-]\d{2}[.\-]\d{2}$/.test(cells[0])) continue;
      const get = (name) => { const i = cols.indexOf(name); return i >= 0 ? cells[i] : ''; };
      const kind = get('기준');
      const r = {
        date: cells[0].replace(/\./g, '-'), kind,
        name: get('아파트명') || get('건물명칭') || get('단지명') || '',
        floor: toNum(get('층')), area: toNum(get('전용면적')), year: toNum(get('건축년도')),
      };
      if (cols.includes('거래금액')) r.price = toNum(get('거래금액')) * 10000;
      if (cols.includes('보증금')) { r.deposit = toNum(get('보증금')) * 10000; r.monthly = toNum(get('월세')) * 10000; }
      if (r.area > 0) rows.push(r);
    }
    return rows;
  }

  // 전용면적 (11-15 확인: area_m2 에는 대지권 면적이 들어간 물건이 많음)
  //   1) 매각물건명세서 '전유부분의 건물의 표시 … NN.NN㎡'
  //   2) 건축물대장 칸(등기부 표제부 '전유부분의 건물의 표시 … ㎡' 또는 대장 전유부 '…층 / 구조 / 아파트 / NN.NN')
  //   3) 감정평가서 구분건물 표 '전유면적 … 용도' 다음 첫 숫자
  function exclusiveArea(item) {
    const ok = (v) => (v >= 10 && v <= 400 ? v : 0);
    const num = (m, i = 1) => (m ? Number(String(m[i]).replace(/,/g, '')) : 0);
    const spec = String(item.doc_spec_text || ''), ledger = String(item.doc_ledger_text || ''), appr = String(item.doc_appraisal_text || '');
    const reg = /전유부분의\s*건물의\s*표시\s*\)?[\s\S]{0,300}?([\d,]+\.\d+)\s*㎡/;
    return ok(num(spec.match(reg)))
      || ok(num(ledger.match(reg)))
      || ok(num(ledger.match(/\n\s*\d+층\s*\n[^\n]*\n\s*(?:아파트|다세대주택|연립주택|오피스텔|다세대|공동주택|도시형생활주택|주택)\s*\n\s*(\d{2,3}\.\d+)\s*\n/)))
      || ok(num(appr.match(/전유면적[\s\S]{0,250}?용도\s*\n\s*\n?\s*(\d{2,3}\.\d+)\s*\n/)));
  }

  const monthsAgo = (ref, m) => { const d = new Date(ref); d.setMonth(d.getMonth() - m); return d.toISOString().slice(0, 10); };

  // 비교 거래 고르기: 같은 단지(이름이 맞는 행이 있으면) → 면적 ±10% → 최근 3·6·12·24개월 중 표본 minN건 이상인 가장 짧은 기간
  function pick(rows, item, { minN = 3, ref, periods = [3, 6, 12, 24] } = {}) {
    let pool = rows;
    const cx = normName(item.complex_name);
    let nameMatched = false;
    if (cx.length >= 2) {
      const same = rows.filter((r) => { const n = normName(r.name); return n && (n.includes(cx) || cx.includes(n)); });
      if (same.length) { pool = same; nameMatched = true; }
    }
    const area = exclusiveArea(item) || Number(item.area_m2) || 0;
    let areaNote;
    const near = area >= 10 ? pool.filter((r) => Math.abs(r.area / area - 1) <= 0.1) : [];
    if (near.length) { pool = near; areaNote = `전용 ${area}㎡ ±10%`; }
    else {
      // 물건 면적이 비었거나 표와 안 맞음(대지권 면적이 들어간 경우 등) → 가장 거래가 많은 면적대(±10%)로
      const groups = new Map();
      for (const r of pool) { const k = Math.round(r.area); groups.set(k, (groups.get(k) || 0) + 1); }
      const best = [...groups.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best) { const a0 = best[0]; pool = pool.filter((r) => Math.abs(r.area / a0 - 1) <= 0.1); areaNote = `면적 불일치(물건 ${area || '?'}㎡) → 거래 많은 ${a0}㎡대`; }
    }
    for (const m of periods) {
      const from = monthsAgo(ref, m);
      const sel = pool.filter((r) => r.date >= from && r.date <= ref);
      if (sel.length >= minN) return { sel, months: m, areaNote, nameMatched, areaMismatch: !near.length };
    }
    const from = monthsAgo(ref, periods[periods.length - 1]);
    const sel = pool.filter((r) => r.date >= from && r.date <= ref);
    return { sel, months: periods[periods.length - 1], areaNote, nameMatched, areaMismatch: !near.length };
  }

  // 메인: 물건 → 시세 필드
  function compute(item, { ref = new Date().toISOString().slice(0, 10), rows: givenRows, source = '마이옥션 실거래' } = {}) {
    const rows = givenRows || parseHistory(item.real_trade_history);
    const sales = rows.filter((r) => r.kind === '매매' && r.price > 0);
    const out = { market_price: null, market_price_p25: null, market_price_p75: null, market_sample_count: 0,
      market_basis: '', market_period: '', market_price_date: null,
      jeonse_median: null, rent_deposit_median: null, rent_monthly_median: null };
    if (sales.length) {
      const p = pick(sales, item, { ref });
      if (p.sel.length) {
        const prices = p.sel.map((r) => r.price);
        out.market_price = Math.round(median(prices));
        out.market_price_p25 = Math.round(quant(prices, 0.25));
        out.market_price_p75 = Math.round(quant(prices, 0.75));
        out.market_sample_count = p.sel.length;
        out.market_period = `최근 ${p.months}개월`;
        out.market_price_date = p.sel.map((r) => r.date).sort().pop();
        out.market_basis = `${source} · ${p.nameMatched ? '같은 단지' : '표 전체'} · ${p.areaNote}${p.sel.length < 3 ? ' · 표본 부족' : ''}`;
      }
    }
    const jeonse = rows.filter((r) => r.kind === '전세' && r.deposit > 0);
    if (jeonse.length) { const p = pick(jeonse, item, { ref, minN: 2 }); if (p.sel.length) out.jeonse_median = Math.round(median(p.sel.map((r) => r.deposit))); }
    const rent = rows.filter((r) => r.kind === '월세' && r.monthly > 0);
    if (rent.length) {
      const p = pick(rent, item, { ref, minN: 2 });
      if (p.sel.length) { out.rent_deposit_median = Math.round(median(p.sel.map((r) => r.deposit))); out.rent_monthly_median = Math.round(median(p.sel.map((r) => r.monthly))); }
    }
    return out;
  }

  // 기존 필드 호환: real_trade_3m/6m/12m_avg 를 같은 비교 거래의 기간별 중앙값으로 (Dify 값 대신)
  function legacyAverages(item, { ref = new Date().toISOString().slice(0, 10), rows: givenRows } = {}) {
    const rows = (givenRows || parseHistory(item.real_trade_history)).filter((r) => r.kind === '매매' && r.price > 0);
    const res = { real_trade_3m_avg: 0, real_trade_6m_avg: 0, real_trade_12m_avg: 0, real_trade_sample_count: 0 };
    if (!rows.length) return res;
    const base = pick(rows, item, { ref, minN: 1, periods: [24] });
    for (const m of [3, 6, 12]) {
      const from = monthsAgo(ref, m);
      const sel = base.sel.filter((r) => r.date >= from);
      if (sel.length) res[`real_trade_${m}m_avg`] = Math.round(median(sel.map((r) => r.price)));
    }
    res.real_trade_sample_count = base.sel.filter((r) => r.date >= monthsAgo(ref, 12)).length;
    return res;
  }

  return { parseHistory, exclusiveArea, pick, compute, legacyAverages, median, quant };
})();


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
