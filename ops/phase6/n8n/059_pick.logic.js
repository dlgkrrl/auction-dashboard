// 059 · AI 재분석 대기 물건 → Dify 입력 (한 번에 3건, 10분마다)
// 대시보드 [🤖 AI 권리분석 다시] 또는 058 서류 재수집 뒤 ai_reanalyze_status = '대기 · …'
const list = ($input.first().json.list) || [];
const doc = (v) => (v && String(v).trim() ? String(v) : '정보 없음');
return list
  .filter((it) => /^대기/.test(String(it.ai_reanalyze_status || '')))
  .slice(0, 3)
  .map((it) => ({
    json: {
      Id: it.Id,
      case_no: it.case_no || '',
      inputs: {
        doc_spec_text: doc(it.doc_spec_text),
        doc_survey_text: doc(it.doc_survey_text),
        doc_appraisal_text: doc(it.doc_appraisal_text),
        doc_ledger_text: doc(it.doc_ledger_text),
        doc_registry_text: doc(it.doc_registry_text),
        real_trade_history: doc(it.real_trade_history),
      },
    },
  }));
