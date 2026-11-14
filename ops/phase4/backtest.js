// 4단계 백테스트: 각 낙찰 건을 그 기일 '이전' 결과만으로 예측 (미래 정보 누수 없음)
// V3(운영) = 당시 실제로 낸 목표가(our_bid_target) / 감정가
// V3(규칙) = 고정표 + 리스크·면적 보정, 최저가 이상
// V4 = 그 회차 최저가율 × 계층 축소 추정 배수
const fs = require('fs');
const V4 = require('./engine_v4.js');
const { results } = JSON.parse(fs.readFileSync(process.argv[2]));
const isT = (v) => v === true || v === 1 || v === '1' || v === 'true';
const d10 = (v) => String(v || '').replace(/\./g, '-').slice(0, 10);
const sold = results.filter((r) => r.result_type === '매각' && !isT(r.is_outlier) && !isT(r.is_share) && !isT(r.is_bulk) && !isT(r.loss_count_suspect)
  && Number(r.actual_bid_rate) > 0 && Number(r.min_price_rate) > 0).sort((a, b) => d10(a.bid_date).localeCompare(d10(b.bid_date)));
const START = process.argv[3] || '2026-08-15';
const TABLE = { 0: 82, 1: 76, 2: 70, 3: 65, 4: 60 };
function v3rule(r) {
  const risk = r.ai_risk === '위험' ? -5 : r.ai_risk === '주의' ? -2 : r.ai_risk === '안전' ? 1 : -2;
  const a = Number(r.area_m2) || 0; const area = a < 60 ? 2 : a > 99 ? -2 : 0;
  const rate = Math.max(50, Math.min(100, TABLE[Math.min(Number(r.loss_count) || 0, 4)] + risk + area));
  return Math.max(rate, Number(r.min_price_rate));
}
const rows = [];
for (const r of sold) {
  const d = d10(r.bid_date);
  if (d < START) continue;
  const train = sold.filter((x) => d10(x.bid_date) < d);
  const idx = V4.buildIndex(train);
  const e = V4.estimate(idx, r);
  if (!e.mult) continue;
  const actual = Number(r.actual_bid_rate), mr = Number(r.min_price_rate);
  const v4 = mr * e.mult;
  const v4q3 = e.q3 ? mr * e.q3 : null;
  const prod = Number(r.our_bid_target) > 0 && Number(r.appraisal_price) > 0 ? Number(r.our_bid_target) / Number(r.appraisal_price) * 100 : null;
  rows.push({ d, bin: V4.BIN(r.loss_count), actual, v4, v4q3, rule: v3rule(r), prod, depth: e.used.length, src: r.source });
}
function score(name, f) {
  const xs = rows.map((r) => ({ p: f(r), a: r.actual })).filter((x) => x.p != null);
  const err = xs.map((x) => x.p - x.a), abs = err.map(Math.abs);
  const win = xs.filter((x) => x.p >= x.a);
  const over = win.map((x) => x.p - x.a);
  return { 모델: name, 건수: xs.length, 평균절대오차: +(abs.reduce((s, x) => s + x, 0) / abs.length).toFixed(1), 중앙절대오차: +V4.median(abs).toFixed(1),
    평균편향: +(err.reduce((s, x) => s + x, 0) / err.length).toFixed(1), 낙찰가이상비율: +(win.length / xs.length * 100).toFixed(0),
    이겼을때_더낸폭중앙: over.length ? +V4.median(over).toFixed(1) : null };
}
console.log(`평가 기일 ${START} 이후, 예측 ${rows.length}건`);
console.table([
  score('V3 운영(당시 목표가)', (r) => r.prod),
  score('V3 규칙 재계산', (r) => r.rule),
  score('V4 중앙값', (r) => r.v4),
  score('V4 75% 분위', (r) => r.v4q3),
]);
const byBin = {};
for (const r of rows) (byBin[r.bin] = byBin[r.bin] || []).push(r);
console.table(Object.entries(byBin).map(([b, rs]) => ({ 유찰: b, 건수: rs.length,
  V3운영_MAE: +(rs.filter(r => r.prod != null).reduce((s, r) => s + Math.abs(r.prod - r.actual), 0) / Math.max(1, rs.filter(r => r.prod != null).length)).toFixed(1),
  V4_MAE: +(rs.reduce((s, r) => s + Math.abs(r.v4 - r.actual), 0) / rs.length).toFixed(1) })));
