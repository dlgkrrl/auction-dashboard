let raw = $input.first().json.answer || $input.first().json.text || $input.first().json.body || '';

// Handle SSE Stream formatting if returned as streaming chunks
if (typeof raw === 'string' && raw.includes('data:')) {
  const lines = raw.split('\n');
  let gathered = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) {
      try {
        const jsonStr = trimmed.replace(/^data:\s*/, '').trim();
        const parsed = JSON.parse(jsonStr);
        if (parsed.answer) {
          gathered += parsed.answer;
        }
      } catch (err) {
        // Ignore parser errors for non-message events (e.g. message_end)
      }
    }
  }
  if (gathered) {
    raw = gathered;
  }
}

const prev = $('Split In Batches').item.json;
const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

let ai = null;
let parseOk = false;

try {
  ai = JSON.parse(cleaned);
  parseOk = true;
} catch (_) {
  const DANGER_KW = ['유치권', '대항력', '법정지상권', '인수', '가처분', '위반건축', '공유'];
  const CAUTION_KW = ['임차인', '전세', '점유', '분쟁', '선순위'];
  const fd = DANGER_KW.filter(k => raw.includes(k));
  const fc = CAUTION_KW.filter(k => raw.includes(k));

  ai = fd.length > 0
    ? { risk: '위험', summary: `위험요소: ${fd.join(', ')}`, recommend: '입찰비권고', flags: fd, confidence: '낮음' }
    : fc.length > 0
    ? { risk: '주의', summary: `주의사항: ${fc.join(', ')}`, recommend: '검토필요', flags: fc, confidence: '낮음' }
    : { risk: '안전', summary: 'AI 파싱 실패 — 직접 확인 필요', recommend: '수동확인필요', flags: [], confidence: '낮음' };
}

const safeNum = v => {
  if (v === undefined || v === null || v === '') return -1;
  const num = Number(String(v).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? -1 : num;
};

const formatPrice = val => {
  if (!val || val <= 0) return '0원';
  const eok = Math.floor(val/100000000);
  const remainder = Math.round((val%100000000)/10000);
  return eok > 0 ? (remainder > 0 ? eok + '억 ' + remainder.toLocaleString() + '만원' : eok + '억') : remainder.toLocaleString() + '만원';
};

const prev_area = safeNum(prev.면적);
const prev_appraisal = safeNum(prev.감정평가액);
const prev_min = safeNum(prev.최저매각가격);
const prev_rate = prev_min > 0 && prev_appraisal > 0 ? Math.round((prev_min / prev_appraisal) * 100) : 100;

return [{
  json: {
    ...prev,
    단지명: ai.complex_name || ai.단지명 || prev.단지명 || '',
    동: ai.dong || ai.동 || prev.동 || '',
    층: ai.floor || ai.층 || prev.층 || '',
    전용면적: safeNum(ai.area_m2 || ai.전용면적) > 0 ? safeNum(ai.area_m2 || ai.전용면적) : (prev_area > 0 ? prev_area : 0),
    감정가_숫자: safeNum(ai.appraisal_price || ai.감정가_숫자) > 0 ? safeNum(ai.appraisal_price || ai.감정가_숫자) : (prev_appraisal > 0 ? prev_appraisal : 0),
    최저가_숫자: safeNum(ai.min_price || ai.최저가_숫자) > 0 ? safeNum(ai.min_price || ai.최저가_숫자) : (prev_min > 0 ? prev_min : 0),
    낙찰가율: safeNum(ai.price_rate || ai.낙찰가율) > 0 ? safeNum(ai.price_rate || ai.낙찰가율) : prev_rate,
    입찰기일: ai.bid_date || ai.입찰기일 || prev.매각기일 || '',
    naver_url: ai.naver_url || prev.naver_url || '',
    ai_risk: ai.risk || '분석실패',
    ai_summary: ai.summary || '',
    ai_recommend: ai.recommend || '수동확인필요',
    ai_flags: (ai.flags || []).join(', '),
    ai_confidence: ai.confidence || '낮음',
    tenant_deposit_total: safeNum(ai.tenant_deposit_total),
    senior_lien_total: safeNum(ai.senior_lien_total),
    cancellation_standard: ai.cancellation_standard || '',
    inherited_amount: safeNum(ai.inherited_amount),
    tenant_count: safeNum(ai.tenant_count),
    pdf_risk_flags: JSON.stringify(ai.pdf_risk_flags || []),
    real_trade_3m_avg: safeNum(ai.real_trade_3m_avg) > 0 ? safeNum(ai.real_trade_3m_avg) : 0,
    real_trade_6m_avg: safeNum(ai.real_trade_6m_avg) > 0 ? safeNum(ai.real_trade_6m_avg) : 0,
    real_trade_12m_avg: safeNum(ai.real_trade_12m_avg) > 0 ? safeNum(ai.real_trade_12m_avg) : 0,
    real_trade_sample_count: safeNum(ai.real_trade_sample_count) > 0 ? safeNum(ai.real_trade_sample_count) : 0,
    real_trade_matched_complex: ai.real_trade_matched_complex || '',
    real_trade_area_range: ai.real_trade_area_range || '',
    parsing_status: parseOk ? 'ok' : 'partial',
    last_parse_error: parseOk ? null : 'Dify JSON 파싱 실패 — 키워드 폴백 사용',
    감정가: formatPrice(prev_appraisal > 0 ? prev_appraisal : (prev.감정평가액 && Number(prev.감정평가액) > 0 ? Number(prev.감정평가액) : 0)),
    최저매각가: formatPrice(prev_min > 0 ? prev_min : (prev.최저매각가격 && Number(prev.최저매각가격) > 0 ? Number(prev.최저매각가격) : 0)),
    court_url: prev.url || ''
  }
}];