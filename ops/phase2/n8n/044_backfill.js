// 044 · 결과 테이블 기존 행 보정 (2단계, 일회성)
// 결과 행을 물건 테이블과 사건번호로 연결해 빈 칸만 채운다. 이미 값이 있으면 덮어쓰지 않음.
// 유찰 횟수는 여기서 고치지 않고 '의심' 표시만 (045가 크롤러 기일표로 교정).
const results = $('결과 조회').first().json.list || [];
const items = $input.first().json.list || [];

const uidOf = (u) => { const m = String(u || '').match(/\/view\/(\d+)|idx=(\d+)/); return m ? (m[1] || m[2]) : ''; };
const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const empty = (v) => v === null || v === undefined || v === '';

function splitAddress(addr) {
  const t = String(addr || '').split(/\s+/);
  let sgg = '', emd = '';
  if (t.length >= 2) {
    sgg = t[1];
    let rest = t.slice(2);
    if (rest[0] && /구$/.test(rest[0])) { sgg += ' ' + rest[0]; rest = rest.slice(1); }
    const e = rest.find((x) => /(동|읍|면|가)$/.test(x) && !/^\d/.test(x));
    if (e) emd = e;
  }
  return { sgg, emd };
}

// 주소 → 관할 법원 (경남·양산). 012가 실제 값을 넣은 행은 건드리지 않고, 옛 기본값 '창원지방법원'/빈값만 교정
function jurisdiction(addr) {
  const a = String(addr || '');
  if (/양산시/.test(a)) return '울산지방법원';
  if (/마산합포구|마산회원구|함안군|의령군/.test(a)) return '창원지방법원 마산지원';
  if (/통영시|거제시|고성군/.test(a)) return '창원지방법원 통영지원';
  if (/진주시|사천시|남해군|하동군|산청군/.test(a)) return '창원지방법원 진주지원';
  if (/밀양시|창녕군/.test(a)) return '창원지방법원 밀양지원';
  if (/거창군|함양군|합천군/.test(a)) return '창원지방법원 거창지원';
  if (/경상남도/.test(a)) return '창원지방법원';
  return '';
}

const byCase = {};
for (const it of items) if (it.case_no) (byCase[it.case_no.trim()] = byCase[it.case_no.trim()] || []).push(it);

function pickItem(r) {
  const cands = byCase[String(r.case_no || '').trim()] || [];
  if (cands.length <= 1) return cands[0] || null;
  const uid = r.detail_uid ? String(r.detail_uid) : '';
  return (uid && cands.find((c) => uidOf(c.court_url) === uid))
    || cands.find((c) => r.item_no && String(c.item_no) === String(r.item_no))
    || cands.find((c) => Number(c.area_m2) === Number(r.area_m2) && String(c.floor || '') === String(r.floor || ''))
    || cands.find((c) => c.status === '낙찰')
    || cands[0];
}

const patches = [];
const stat = { rows: results.length, linked: 0, unlinked: 0, outlier: 0, suspect: 0 };
for (const r of results) {
  const it = pickItem(r);
  const p = {};
  const set = (k, v) => { if (empty(r[k]) && !empty(v)) p[k] = v; };
  if (it) {
    stat.linked++;
    set('court', it.court);
    set('location', it.location);
    set('item_no', it.item_no);
    set('usage', it.usage);
    set('detail_uid', uidOf(it.court_url));
    set('item_ref', it.Id);
    set('ai_risk', it.ai_risk);
    if (n(it.tenant_count) >= 0) set('tenant_count', n(it.tenant_count));
    if (n(it.inherited_amount) !== null) set('inherited_amount', n(it.inherited_amount));
    if (it.is_share) set('is_share', true);
    if (n(it.real_trade_3m_avg) > 0) set('market_price', n(it.real_trade_3m_avg));
    if (it.status === '낙찰' && n(it.min_price) > 0) set('min_price', n(it.min_price)); // 낙찰 후 물건 최저가 = 낙찰 회차 최저가
  } else {
    stat.unlinked++;
  }
  const loc = p.location || r.location || '';
  const jur = jurisdiction(loc);
  const curCourt = p.court || r.court || '';
  if (jur && (curCourt === '' || curCourt === '창원지방법원') && jur !== curCourt) p.court = jur;
  const sa = splitAddress(loc);
  set('sgg', sa.sgg);
  set('emd', sa.emd);
  set('source', 'tracked');
  set('result_type', '매각');

  const appraisal = n(r.appraisal_price);
  const minPrice = n(p.min_price ?? r.min_price);
  if (appraisal > 0 && minPrice > 0) set('min_price_rate', Math.round(minPrice / appraisal * 1000) / 10);

  const rate = n(r.actual_bid_rate);
  const outlier = (rate !== null && (rate < 5 || rate > 200)) || (appraisal > 0 && minPrice > appraisal * 1.05);
  if (outlier && !r.is_outlier) { p.is_outlier = true; stat.outlier++; }

  const loss = n(r.loss_count);
  if ((loss === null || loss >= 8) && !r.loss_count_suspect) { p.loss_count_suspect = true; stat.suspect++; }

  if (Object.keys(p).length) patches.push({ Id: r.Id, ...p });
}

const chunks = [];
for (let i = 0; i < patches.length; i += 100) chunks.push({ json: { rows: patches.slice(i, i + 100), stat } });
return chunks.length ? chunks : [{ json: { rows: [], stat } }];
