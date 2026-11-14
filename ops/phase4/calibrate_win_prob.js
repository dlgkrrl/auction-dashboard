// 입찰가 → 낙찰 확률 곡선 검증: node calibrate_win_prob.js <결과 json> ./engine_v4.js
// 사분위 3점 선형 + 꼬리 연장, widen=[아래, 위] 배율별로 예측 확률 구간과 실제 낙찰 비율 비교

const fs=require('fs');const V4=require(process.argv[3]);
const {results}=JSON.parse(fs.readFileSync(process.argv[2]));
const isT=v=>v===true||v===1||v==='1'||v==='true';const d10=v=>String(v||'').replace(/\./g,'-').slice(0,10);
const sold=results.filter(r=>r.result_type==='매각'&&!isT(r.is_outlier)&&!isT(r.is_share)&&!isT(r.is_bulk)&&!isT(r.loss_count_suspect)&&Number(r.actual_bid_rate)>0&&Number(r.min_price_rate)>0).sort((a,b)=>d10(a.bid_date).localeCompare(d10(b.bid_date)));
// P(내 배수 m 이 낙찰가 배수 이상) — 사분위 3점 선형 + 꼬리 같은 기울기 연장
function F(m,q1,med,q3,widen=[1,1]){const c=med;q1=c-(c-q1)*widen[0];q3=c+(q3-c)*widen[1];
 let p; if(m<=q1)p=.25-(q1-m)/(med-q1)*.25; else if(m<=med)p=.25+(m-q1)/(med-q1)*.25; else if(m<=q3)p=.5+(m-med)/(q3-med)*.25; else p=.75+(m-q3)/(q3-med)*.25;
 return Math.min(.95,Math.max(.02,p));}
for(const widen of [[1,1.6],[1.3,1.6],[1,2],[1.3,2],[1.3,2.5]]){
const bins=Array.from({length:10},()=>({n:0,hit:0,ps:0}));let brier=0,N=0;
for(const r of sold){const d=d10(r.bid_date);if(d<'2026-08-15')continue;
 const e=V4.estimate(V4.buildIndex(sold.filter(x=>d10(x.bid_date)<d)),r);if(!e.mult||!e.q1||!e.q3||e.q3<=e.mult||e.q1>=e.mult)continue;
 const act=Number(r.actual_bid_rate)/Number(r.min_price_rate);
 for(const f of [0.85,0.9,0.95,1,1.05,1.1,1.15,1.2]){const m=e.mult*f;const p=F(m,e.q1,e.mult,e.q3,widen);const hit=m>=act?1:0;
  const b=bins[Math.min(9,Math.floor(p*10))];b.n++;b.hit+=hit;b.ps+=p;brier+=(p-hit)**2;N++;}}
console.log('widen',widen,'brier',(brier/N).toFixed(4),bins.map((b,i)=>b.n?`${i*10}%:예측${(b.ps/b.n*100).toFixed(0)}/실제${(b.hit/b.n*100).toFixed(0)}(n${b.n})`:'').filter(Boolean).join('  '));}
