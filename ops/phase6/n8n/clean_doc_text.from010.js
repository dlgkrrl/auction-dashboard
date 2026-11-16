function cleanDocText(raw, docType) {
  if (!raw || typeof raw !== 'string') return '정보 없음';
  let text = raw;
  // 1. 연속 구분선 제거
  text = text.replace(/[-─=*]{5,}/g, '');
  // 2. 3줄 이상 빈줄 → 1줄
  text = text.replace(/\n{3,}/g, '\n\n');
  // 3. Page : N 단독행 제거
  text = text.replace(/^\s*Page\s*:\s*\d+\s*$/gm, '');
  // 4. 감정평가서 면책고지문 제거
  text = text.replace(/이\s*(?:감정평가서|명세서|서류|사항)는\s+[^\n]{0,80}(?:사용할\s*수\s*없|목적\s*외)[^\n]*/g, '');
  // 5. 출력일시·고유번호·접수번호 단독행 제거
  text = text.replace(/^(?:출력일시|고유번호|접수번호|등기번호)\s*[:\：]\s*.+$/gm, '');
  // 6. 페이지 번호 단독행 제거
  text = text.replace(/^\s*-?\s*\d+\s*-?\s*$/gm, '');
  // 7. 우편번호 단독행 제거
  text = text.replace(/^\s*\[우\]\s*\d{5,6}\s*$/gm, '');
  // 8. 전화번호·FAX 단독행 제거
  text = text.replace(/^\s*(?:Tel\.?|전화|FAX|팩스)?\s*\d{2,4}[-\s]\d{3,4}[-\s]\d{4}\s*$/gm, '');
  if (docType === 'appraisal') {
    // 감정평가서: 사진용지 섹션 제거
    text = text.replace(/사\s*진\s*용\s*지[\s\S]{0,500}?(?=\n\n|$)/g, '');
    // 감정평가법인 주소/서명 단독행 제거
    text = text.replace(/^.*감정평가(?:법인|사무소).*$/gm, '');
    text = text.replace(/^대표이사\s*[:\：].*$/gm, '');
    // 구분건물 감정평가요항표 헤더행 제거
    text = text.replace(/^\s*\(\d+\)\s*위치 및 주위환경[^\n]*$/gm, '');
  }
  if (docType === 'status_survey') {
    // 현황조사서: 마이옥션 네비게이션 메뉴 텍스트 제거
    const navItems = ['close','인쇄','등기부\\(건물\\)','건축물대장','감정평가서','물건사진','현황조사서','매각물건명세서','문건접수내역','송달처리내역','부동산표시','전자지도','로드뷰','위성지도','지적도','네이버지도','씨:리얼지도','도시계획지도','네이버부동산'];
    const navRe = new RegExp('^(' + navItems.join('|') + ')\\s*$', 'gm');
    text = text.replace(navRe, '');
    text = text.replace(/본\s*정보는\s*참고용으로[^\n]*/g, '');
  }
  if (docType === 'registry') {
    text = text.replace(/^\s*이\s*기\s*재\s*사\s*항\s*$/gm, '[이기재사항]');
  }
  // 최종 연속 빈줄 정리
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim() || '정보 없음';
}
