import { workflow, node, trigger, expr } from "@n8n/workflow-sdk";

const start = trigger({ type: "n8n-nodes-base.manualTrigger", version: 1, config: { name: "Start" } });

const defineCols = node({ type: "n8n-nodes-base.code", version: 2, config: { name: "추가할 컬럼", parameters: { jsCode: "const P = \"mfim9xo11ob6gp9\"; // auction_items\nreturn [[\"ai_reanalyze_status\",\"SingleLineText\"],[\"refetch_status\",\"SingleLineText\"]].map(([column_name, uidt]) => ({ json: { tableId: P, column_name, uidt } }));" } } });

const addCol = node({ type: "n8n-nodes-base.httpRequest", version: 4.2, config: {
  name: "컬럼 추가", onError: "continueRegularOutput",
  parameters: { method: "POST", url: expr("http://nocodb_app:8080/api/v1/db/meta/tables/{{ $json.tableId }}/columns"),
    authentication: "predefinedCredentialType", nodeCredentialType: "nocoDbApiToken",
    sendBody: true, specifyBody: "json",
    jsonBody: expr("{{ JSON.stringify({ column_name: $json.column_name, title: $json.column_name, uidt: $json.uidt }) }}"), options: {} },
  credentials: { nocoDbApiToken: { id: "lh3tnFIzojQ5Uqea", name: "NocoDB account" } } } });

export default workflow("auction-phase6-add-columns", "060.[ONCE] 경매 6단계 요청 상태 컬럼 추가 (2026-11-17)")
  .add(start).to(defineCols).to(addCol);
