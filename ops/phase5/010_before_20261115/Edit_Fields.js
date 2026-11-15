// NocoDB 저장 완료 후, 원래 파이프라인의 전체 데이터(AI 분석 및 입찰가 계산 결과 포함)를 복원합니다.
// NocoDB 응답에는 DB 컬럼명만 있으므로, 텔레그램 알림을 위해 NocoDB 저장 직전 노드의 데이터를 참조합니다.
const orig = $('입찰가 엔진 및 GAP SCORE 계산').item.json;

// is_new: 원본 데이터에서 복원
const is_new = orig.is_new === true;

return [{
  json: {
    ...orig,
    is_new: is_new,
    // NocoDB에서 방금 저장된 auction_history ID (참고용)
    _history_case_no: $json.case_no || orig.사건번호 || ''
  }
}];