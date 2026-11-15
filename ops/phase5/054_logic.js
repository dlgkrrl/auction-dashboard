// ── 054 · 국토부 응답 → 물건별 시세 ──
const reqs = $('요청 만들기').all().map((i) => i.json);
const resps = $input.all().map((i) => i.json);
const pool = new Map();   // svc|lawd → 표준 행
const apiStat = { ok: 0, fail: 0, truncated: 0, failSvc: {} };
resps.forEach((j, k) => {
  const q = reqs[k];
  const body = j && j.response && j.response.body;
  if (!body || (j.response.header && j.response.header.resultCode !== '000')) { apiStat.fail++; const s = q.svc.split('/')[0]; apiStat.failSvc[s] = (apiStat.failSvc[s] || 0) + 1; return; }
  apiStat.ok++;
  if (Number(body.totalCount) > Number(body.numOfRows)) apiStat.truncated++;
  let items = body.items && body.items.item; if (!items) return; if (!Array.isArray(items)) items = [items];
  const key = `${q.svc}|${q.lawd}`;
  if (!pool.has(key)) pool.set(key, []);
  for (const it of items) { const r = Molit.toRow(it, q.kind); if (r) pool.get(key).push(r); }
});
const list = $('물건 조회').first().json.list || [];
const ref = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const rows = [];
const summary = { targets: 0, market: 0, jeonse: 0, rent: 0, noAddr: 0, noType: 0, byType: {}, apiStat };
for (const it of list) {
  if (it.is_hidden || it.is_share || it.is_bulk || Number(it.market_price) > 0) continue;
  summary.targets++;
  const a = Molit.parseAddr(it.location), t = Molit.typeOf(it);
  if (!a.lawd) { summary.noAddr++; continue; }
  if (!t) { summary.noType++; continue; }
  const get = (kind) => { const svc = Molit.SVC[t][kind]; return svc ? (pool.get(`${svc}|${a.lawd}`) || []) : []; };
  const site = Molit.sameSite([...get('trade'), ...get('rent')], it, a);
  const calcItem = { ...it, area_m2: MarketPrice.exclusiveArea(it) || it.area_m2 };
  const m = MarketPrice.compute(calcItem, { ref, rows: site.rows, source: '국토부 실거래' });
  for (const k of Object.keys(m)) if (m[k] === null || m[k] === '') delete m[k];   // 빈 값으로 기존 전세·월세를 지우지 않게
  const patch = { Id: it.Id };
  if (m.market_price) { Object.assign(patch, m, MarketPrice.legacyAverages(calcItem, { ref, rows: site.rows }));
    if (site.scope !== '같은 단지') patch.market_basis += ' · 단지 매칭 실패(같은 읍면동)'; summary.market++; summary.byType[t] = (summary.byType[t] || 0) + 1; }
  else { patch.market_basis = `국토부 실거래에도 없음(${t}, ${a.sgg} ${a.emd})`; for (const f of ['jeonse_median', 'rent_deposit_median', 'rent_monthly_median']) if (m[f]) patch[f] = m[f]; }
  if (m.jeonse_median) summary.jeonse++;
  if (m.rent_monthly_median) summary.rent++;
  rows.push(patch);
}
const chunks = [];
for (let i = 0; i < rows.length; i += 50) chunks.push({ json: { rows: rows.slice(i, i + 50), summary } });
return chunks.length ? chunks : [{ json: { rows: [], summary } }];
