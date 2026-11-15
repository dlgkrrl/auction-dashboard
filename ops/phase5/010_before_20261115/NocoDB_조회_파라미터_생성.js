const items = $input.all().map(i => i.json);
const caseNos = items.map(i => i.사건번호).filter(Boolean);
return [{
  json: {
    case_numbers: caseNos.length > 0 ? caseNos.join(',') : 'DUMMY_NONE'
  }
}];