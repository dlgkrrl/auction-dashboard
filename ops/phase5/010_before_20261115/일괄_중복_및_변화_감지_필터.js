const originalItems = $('파싱 및 1차 필터').all().map(item => item.json);
const dbResponse = $input.first().json;
const dbRecords = dbResponse.list || [];

// 사건번호 하나에 물건이 여럿일 수 있음 → 상세페이지 번호(/view/{uid}) > 물건번호 > 단일행 순으로 매칭
const byCase = {};
for (const record of dbRecords) {
  if (record.case_no) (byCase[record.case_no.trim()] = byCase[record.case_no.trim()] || []).push(record);
}
const uidOf = (u) => { const m = String(u || '').match(/\/view\/(\d+)|idx=(\d+)/); return m ? (m[1] || m[2]) : ''; };
function findRecord(current) {
  const recs = byCase[current.사건번호.trim()] || [];
  if (recs.length === 0) return null;
  const uid = uidOf(current.url);
  if (uid) { const r = recs.find((x) => uidOf(x.court_url) === uid); if (r) return r; }
  const objNo = String(current.물건번호 || '1');
  const byNo = recs.find((x) => x.item_no && String(x.item_no) === objNo);
  if (byNo) return byNo;
  if (recs.length === 1 && !recs[0].item_no && !uidOf(recs[0].court_url)) return recs[0];
  // 기존 행들이 모두 상세번호를 갖고 있고 어느 것과도 다르면 → 같은 사건의 다른 물건(신규)
  if (uid && recs.every((x) => uidOf(x.court_url))) return null;
  if (recs.length === 1) return recs[0];
  return { __skip: true }; // 판단 불가 → 중복 삽입을 막기 위해 이번에는 건너뜀
}

const results = [];

for (const current of originalItems) {
  if (current.__parseFailed || current.__parseError || !current.사건번호) continue;

  const dbRecord = findRecord(current);
  if (dbRecord && dbRecord.__skip) continue;

  // 1. 신규 물건인 경우
  if (!dbRecord) {
    current.should_analyze = true;
    current.is_new = true;
    current.reason = 'new_item';
    current.price_drop_amt = 0;
    current.price_drop_rate = 0;
    current.prev_loss_count = 0;
    current.prev_min_price = 0;
    current.loss_increased = false;
    results.push({ json: current });
    continue;
  }

  // 2. 기존 물건인 경우 (변화 감지)
  const newLoss = parseInt(current.유찰횟수 || 0);
  const oldLoss = parseInt(dbRecord.loss_count || 0);          // ✅ loss_count 단독 참조
  const newMin = parseInt(current.최저매각가격 || 0);
  const oldMin = parseInt(dbRecord.min_price || 0);            // ✅ [핵심 수정] min_price 단독 참조

  const lossIncreased = (newLoss > oldLoss);
  const priceDropAmt = (oldMin > 0 && newMin > 0) ? Math.max(0, oldMin - newMin) : 0;
  const priceDropRate = oldMin > 0 ? Math.round((priceDropAmt / oldMin) * 100) : 0;
  const priceDropped = priceDropAmt > 0 && priceDropRate >= 1;

  // AI가 이미 정상 분석된 경우 서류 재수집 루프 진입 차단
  const alreadyAnalyzed = !!(dbRecord.ai_risk && dbRecord.ai_risk !== '분석실패' && dbRecord.ai_risk.trim() !== '');

  const pdfCompletedButNotParsed =
    !alreadyAnalyzed &&
    (dbRecord.parsing_status === 'partial' || !dbRecord.parsing_status) &&
    (dbRecord.docs_status === 'fetched' || !!dbRecord.doc_spec_text);

  const shouldAnalyze = lossIncreased || priceDropped || pdfCompletedButNotParsed;

  if (shouldAnalyze) {
    current.should_analyze = true;
    current.is_new = false;
    current.reason = pdfCompletedButNotParsed ? 'pdf_completed' : 'changes_detected';
    current.price_drop_amt = priceDropAmt;
    current.price_drop_rate = priceDropRate;
    current.prev_loss_count = oldLoss;      // ✅ DB 현재값(=비교 기준)을 prev에 저장
    current.prev_min_price = oldMin;        // ✅ DB 현재값(=비교 기준)을 prev에 저장
    current.loss_increased = lossIncreased; // ✅ [신규 추가] 플래그 전달
    current.db_record = dbRecord;
    results.push({ json: current });
  }
}

return results;
