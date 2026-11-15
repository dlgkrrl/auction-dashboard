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
    const area = Number(item.area_m2) || 0;
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

  return { parseHistory, pick, compute, legacyAverages, median, quant };
})();

if (typeof module !== 'undefined') module.exports = MarketPrice;
