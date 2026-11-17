const http=require('http'),fs=require('fs');
const NAMES=['대방그린빌','창원중동유니시티어반브릭스2단지','가음정 빌라','토월아파트','김해 율하 휴먼시아 7단지','양산 사송 더샵 데시앙 2차','성원','마산 회원 롯데캐슬 프리미어','진해 용원 오션시티 푸르지오','상남동 오피스텔','삼계 두산위브','장유 부영 6단지'];
const items=[1,2,3,4,5,6,7,8,9,10,11,12].map(i=>({Id:i,case_no:`2025타경10${i}`,court:'창원지방법원',location:i%3?`경상남도 창원시 마산회원구 양덕동 ${i}-12 롯데캐슬 101동 120${i}호`:`경상남도 김해시 장유동 ${i}`,complex_name:NAMES[i-1],area_m2:59.9,floor:3+i,
appraisal_price:150000000+i*9.7e7,min_price:105000000+i*7e6,price_rate:70,loss_count:1,bid_date:'2026-12-0'+i,status:'진행중',
ai_risk:['안전','주의','위험','분석실패'][i%4],ai_recommend:'검토필요',ai_summary:'말소기준권리 이하 모두 소멸. 임차인 1명 배당요구.',ai_flags:'임차인',
gap_score:60,gap_score_grade:'B',bid_target:115000000+i*7e6,bid_min:108000000+i*7e6,bid_max:122000000+i*7e6,bid_rate_used:78,bid_strategy_text:'V4 엔진 · 통계',bid_confidence:'보통',
market_price:i===3?0:140000000+i*1e7,market_basis:'마이옥션 실거래 · 같은 단지',market_sample_count:5,market_period:'최근 6개월',jeonse_median:100000000,
inherited_amount:i===2?-1:0,tenant_count:1,tenant_deposit_total:20000000,is_interested:i===1,is_hidden:false,court_url:`https://www.my-auction.co.kr/view/15${i}`,
doc_spec_text:true,doc_survey_text:i===3?'':true,doc_appraisal_text:true,doc_registry_text:i===3?'':true,doc_ledger_text:'',real_trade_history:true,
refetch_status:i===4?'대기 · 11-17 10:00 요청 → 오늘 새벽 02:15 수집 예정':'',ai_reanalyze_status:i===4?'완료 · 11-17 09:10 · 안전':''}));
const results=[];const sggs=['창원시 성산구','김해시','양산시','창원시 의창구'];
for(let d=0;d<200;d++){const date=new Date(Date.UTC(2026,10,15)-d*86400e3).toISOString().slice(0,10);
 for(let k=0;k<2;k++){const g=sggs[(d+k)%4];const hot=d<30?1.08:1;const mr=[100,70,49,34.3][(d+k)%4];const rate=(mr*(1.1+((d*7+k)%10)/50)*hot);
 results.push({case_no:'2025타경'+(9000+d*2+k),item_no:'1',bid_date:date,result_type:(d+k)%5?'매각':'유찰',sgg:g,min_price_rate:mr,actual_bid_rate:rate.toFixed(1),bidder_count:3+((d+k)%4),loss_count:(d+k)%4,
  actual_bid_price:Math.round(1.5e8*rate/100),our_bid_target:d%3===0?Math.round(1.5e8*mr/100*1.18):null,engine_version:d%2?'v4':'v3',source:'tracked'});}}
http.createServer((q,r)=>{const u=new URL(q.url,'http://x');
 const ROOT=process.env.ROOT||require('path').join(__dirname,'../..');
 if(u.pathname==='/'||u.pathname==='/index.html'){r.setHeader('content-type','text/html');return r.end(fs.readFileSync(ROOT+'/index.html'));}
 if(/^\/(styles\.css|js\/[a-z0-9_-]+\.js)$/.test(u.pathname)){const f=ROOT+u.pathname;if(fs.existsSync(f)){r.setHeader('content-type',u.pathname.endsWith('.css')?'text/css':'text/javascript');return r.end(fs.readFileSync(f));}}
 if(u.pathname==='/api/session'){r.setHeader('content-type','application/json');return r.end('{"ok":true,"loggedIn":true}');}
 if(u.pathname.startsWith('/api/')){let b='';q.on('data',c=>b+=c);q.on('end',()=>{r.setHeader('content-type','application/json');
  if(q.method==='PATCH'){return r.end('{}');}
  const t=u.searchParams.get('table');const w=u.searchParams.get('where')||'';
  if(t==='results')return r.end(JSON.stringify({list:results,pageInfo:{isLastPage:true}}));
  if(t&&t!=='items')return r.end('{"list":[],"pageInfo":{"isLastPage":true}}');
  if(/Id,eq,/.test(w)){const id=+w.match(/Id,eq,(\d+)/)[1];return r.end(JSON.stringify({list:[{Id:id,doc_spec_text:'매각물건명세서 본문',doc_survey_text:'현황',doc_appraisal_text:'감정',doc_registry_text:'정보 없음',doc_ledger_text:'',real_trade_history:'계약일\t기준\n'}]}));}
  if(/is_hidden,eq/.test(w))return r.end('{"list":[],"pageInfo":{"isLastPage":true}}');
  r.end(JSON.stringify({list:items,pageInfo:{isLastPage:true}}));});return;}
 r.statusCode=404;r.end();}).listen(+process.env.PORT||8765);
