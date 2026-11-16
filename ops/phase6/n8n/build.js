// 6단계 · 058(서류 재수집)·059(AI 재분석) 워크플로 SDK 코드 만들기
//   node ops/phase6/n8n/build.js  → 058_doc_refetch.sdk.js, 059_ai_reanalyze.sdk.js
const fs = require('fs');
const path = require('path');
const here = __dirname;
const read = (f) => fs.readFileSync(path.join(here, f), 'utf8');
const marketPrice = fs.readFileSync(path.join(here, '../../phase5/market_price.js'), 'utf8')
  .replace(/\nif \(typeof module[^\n]*\n?/, '\n');

const NOCO = 'http://nocodb_app:8080/api/v1/db/data/noco/pwmyhpb0tu3b4m6/mfim9xo11ob6gp9';
const NOCO_BULK = 'http://nocodb_app:8080/api/v1/db/data/bulk/noco/pwmyhpb0tu3b4m6/mfim9xo11ob6gp9';
const nocoCred = `{ nocoDbApiToken: { id: "lh3tnFIzojQ5Uqea", name: "NocoDB account" } }`;
const DOCF = 'doc_spec_text,doc_survey_text,doc_appraisal_text,doc_registry_text,doc_ledger_text,real_trade_history';
const J = JSON.stringify;

const pick058 = read('058_pick.logic.js').replace(
  "return [{ json: { marks,",
  "if (!marks.length) return [];\nreturn [{ json: { marks,");
const apply058 = read('clean_doc_text.from010.js') + '\n' + marketPrice + '\n' + read('058_apply.logic.js');

const w058 = `import { workflow, node, trigger, expr, ifElse } from "@n8n/workflow-sdk";

const start = trigger({ type: "n8n-nodes-base.scheduleTrigger", version: 1.2, config: { name: "매일 02:15",
  parameters: { rule: { interval: [{ field: "cronExpression", expression: "15 2 * * *" }] } } } });

const fetchItems = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "재수집 요청 조회",
  parameters: { method: "GET", url: ${J(NOCO)},
    authentication: "predefinedCredentialType", nodeCredentialType: "nocoDbApiToken",
    sendQuery: true, queryParameters: { parameters: [
      { name: "where", value: "(refetch_status,like,대기%)~or(refetch_status,like,수집중%)" },
      { name: "fields", value: ${J('Id,court_url,complex_name,area_m2,refetch_status,' + DOCF)} },
      { name: "limit", value: "200" } ] }, options: {} },
  credentials: ${nocoCred} } });

const pick = node({ type: "n8n-nodes-base.code", version: 2, config: { name: "대상 고르기", parameters: { jsCode: ${J(pick058)} } } });

const markPatch = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "수집중 표시",
  parameters: { method: "PATCH", url: ${J(NOCO_BULK)},
    authentication: "predefinedCredentialType", nodeCredentialType: "nocoDbApiToken",
    sendBody: true, specifyBody: "json", jsonBody: expr("{{ JSON.stringify($json.marks) }}"), options: {} },
  credentials: ${nocoCred} } });

const hasTargets = ifElse({ version: 2.2, config: { name: "수집할 물건 있음?", parameters: { conditions: {
  options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
  conditions: [{ leftValue: expr("{{ $('대상 고르기').first().json.uids.length }}"), operator: { type: "number", operation: "gt" }, rightValue: 0 }],
  combinator: "and" } } } });

const crawl = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "크롤러 지정 물건 수집",
  onError: "continueRegularOutput",
  parameters: { method: "POST", url: "http://auction-crawler:5001/crawl", sendBody: true, specifyBody: "json",
    jsonBody: expr("{{ JSON.stringify({ uids: $('대상 고르기').first().json.uids }) }}"), options: { timeout: 1800000 } } } });

const apply = node({ type: "n8n-nodes-base.code", version: 2, config: { name: "결과 반영", parameters: { jsCode: ${J(apply058)} } } });

const rowsPatch = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "서류 저장",
  parameters: { method: "PATCH", url: ${J(NOCO_BULK)},
    authentication: "predefinedCredentialType", nodeCredentialType: "nocoDbApiToken",
    sendBody: true, specifyBody: "json", jsonBody: expr("{{ JSON.stringify($json.rows) }}"), options: {} },
  credentials: ${nocoCred} } });

export default workflow("auction-phase6-doc-refetch", "058.[DAILY] 경매 서류 재수집 (대시보드 요청, 02:15)")
  .add(start).to(fetchItems).to(pick).to(markPatch)
  .to(hasTargets.onTrue(crawl.to(apply).to(rowsPatch)));
`;

const w059 = `import { workflow, node, trigger, expr } from "@n8n/workflow-sdk";

const start = trigger({ type: "n8n-nodes-base.scheduleTrigger", version: 1.2, config: { name: "10분마다",
  parameters: { rule: { interval: [{ field: "cronExpression", expression: "*/10 * * * *" }] } } } });

const fetchItems = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "재분석 요청 조회",
  parameters: { method: "GET", url: ${J(NOCO)},
    authentication: "predefinedCredentialType", nodeCredentialType: "nocoDbApiToken",
    sendQuery: true, queryParameters: { parameters: [
      { name: "where", value: "(ai_reanalyze_status,like,대기%)" },
      { name: "fields", value: ${J('Id,case_no,ai_reanalyze_status,' + DOCF)} },
      { name: "limit", value: "3" } ] }, options: {} },
  credentials: ${nocoCred} } });

const pick = node({ type: "n8n-nodes-base.code", version: 2, config: { name: "대상 고르기", parameters: { jsCode: ${J(read('059_pick.logic.js'))} } } });

const dify = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "Dify 재분석",
  onError: "continueRegularOutput",
  parameters: { method: "POST", url: "http://dify_api:5001/v1/chat-messages",
    authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth",
    sendBody: true, specifyBody: "json",
    jsonBody: expr("{{ JSON.stringify({ inputs: $json.inputs, query: '사건번호 ' + $json.case_no + '의 권리분석을 시작해', response_mode: 'blocking', user: 'auction-bot' }) }}"),
    options: { timeout: 180000 } },
  credentials: { httpHeaderAuth: { id: "dcwG43puGTbHStOO", name: "Dify - 경매 권리분석" } } } });

const parse = node({ type: "n8n-nodes-base.code", version: 2, config: { name: "결과 파싱", parameters: { jsCode: ${J(read('059_parse.logic.js'))} } } });

const save = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "분석 저장",
  parameters: { method: "PATCH", url: ${J(NOCO_BULK)},
    authentication: "predefinedCredentialType", nodeCredentialType: "nocoDbApiToken",
    sendBody: true, specifyBody: "json", jsonBody: expr("{{ JSON.stringify($json.rows) }}"), options: {} },
  credentials: ${nocoCred} } });

export default workflow("auction-phase6-ai-reanalyze", "059.[POLL] 경매 AI 권리분석 재요청 (대시보드, 10분마다)")
  .add(start).to(fetchItems).to(pick).to(dify).to(parse).to(save);
`;

fs.writeFileSync(path.join(here, '058_doc_refetch.sdk.js'), w058);
fs.writeFileSync(path.join(here, '059_ai_reanalyze.sdk.js'), w059);
console.log('ok', w058.length, w059.length);
