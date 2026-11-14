// 045 · 11-14 실행에서 잘못 교정된 행 되돌리기 (한 번만 의미 있음, 다시 실행해도 같은 값)
// Id 37 (2026타경57): 다른 물건(1537818, 최저가율 170%) 값이 들어감 → 상세번호 복구, 최저가 비움, 유찰 수 의심 표시
// Id 88 (2025타경805 2층): 17층 물건(1500939) 상세번호로 바뀌어 Id 82와 중복 → 상세번호 복구
// 2025타경805 물건들(82·83·85·88·90): 같은 낙찰가·응찰자 기록 문제로 유찰 수 의심 표시 유지
return [{ json: { rows: [
  { Id: 37, detail_uid: '1499165', item_no: null, min_price: null, min_price_rate: null, loss_count_suspect: true },
  { Id: 88, detail_uid: '1500947', item_no: null, loss_count_suspect: true },
  { Id: 82, loss_count_suspect: true },
  { Id: 83, loss_count_suspect: true },
  { Id: 85, loss_count_suspect: true },
  { Id: 90, loss_count_suspect: true },
] } }];
