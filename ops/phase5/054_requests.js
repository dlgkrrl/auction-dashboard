// 054 · 국토부 요청 목록: 시세 없는 진행중 물건의 (서비스, 시군구, 최근 12개월) 조합
const list = $input.first().json.list || [];
const kst = new Date(Date.now() + 9 * 3600e3);
const months = [];
for (let k = 0; k < 12; k++) { const d = new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth() - k, 1)); months.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`); }
const need = new Set();
for (const it of list) {
  if (it.is_hidden || it.is_share || it.is_bulk || Number(it.market_price) > 0) continue;
  const a = Molit.parseAddr(it.location), t = Molit.typeOf(it);
  if (!a.lawd || !t) continue;
  for (const kind of ['trade', 'rent']) { const svc = Molit.SVC[t][kind]; if (svc) need.add(`${svc}|${a.lawd}|${kind}`); }
}
const out = [];
for (const key of need) { const [svc, lawd, kind] = key.split('|'); for (const ymd of months) out.push({ json: { svc, lawd, kind, ymd } }); }
return out;
