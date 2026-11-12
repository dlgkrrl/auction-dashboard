import { workflow, node, trigger, expr } from '@n8n/workflow-sdk';

const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start' } });

const defineCols = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: '추가할 컬럼', parameters: { jsCode: "const P = 'mfim9xo11ob6gp9'; // auction_items\nconst R = 'mprok558sdzbp7k'; // auction_results\nreturn [\n  [P, 'item_no', 'SingleLineText'], [P, 'usage', 'SingleLineText'],\n  [P, 'is_share', 'Checkbox'], [P, 'is_bulk', 'Checkbox'],\n  [R, 'court', 'SingleLineText'], [R, 'item_no', 'SingleLineText'], [R, 'location', 'SingleLineText'],\n  [R, 'usage', 'SingleLineText'], [R, 'result_type', 'SingleLineText'], [R, 'min_price', 'Number'],\n].map(([tableId, column_name, uidt]) => ({ json: { tableId, column_name, uidt } }));" } } });

const addCol = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {
  name: '컬럼 추가', onError: 'continueRegularOutput',
  parameters: { method: 'POST', url: expr('http://nocodb_app:8080/api/v1/db/meta/tables/{{ $json.tableId }}/columns'),
    authentication: 'predefinedCredentialType', nodeCredentialType: 'nocoDbApiToken',
    sendBody: true, specifyBody: 'json',
    jsonBody: expr('{{ JSON.stringify({ column_name: $json.column_name, title: $json.column_name, uidt: $json.uidt }) }}'), options: {} },
  credentials: { nocoDbApiToken: { id: 'lh3tnFIzojQ5Uqea', name: 'NocoDB account' } } } });

const fetchItems = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {
  name: '진행중 물건 조회', executeOnce: true,
  parameters: { method: 'GET', url: 'http://nocodb_app:8080/api/v1/db/data/noco/pwmyhpb0tu3b4m6/mfim9xo11ob6gp9',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'nocoDbApiToken',
    sendQuery: true, queryParameters: { parameters: [
      { name: 'where', value: '(status,eq,진행중)~or(status,eq,유찰)' },
      { name: 'fields', value: 'Id,case_no,court,location,complex_name,status,is_share,is_bulk,is_hidden,usage,doc_spec_text' },
      { name: 'limit', value: '1000' } ] }, options: {} },
  credentials: { nocoDbApiToken: { id: 'lh3tnFIzojQ5Uqea', name: 'NocoDB account' } } } });

const compute = node({ type: 'n8n-nodes-base.code', version: 2, config: { name: '보정값 계산', parameters: { jsCode: "// 0단계 일회성 보정: 진행중 물건의 법원(매각물건명세서 첫머리 기준) · 지분 · 여러 호수 일괄 표시\n// 입력: NocoDB 목록 { list: [...] } / 출력: 바꿀 행만 [{ Id, ...변경필드 }]\nconst list = ($input.first().json.list) || [];\nconst SHARE_RE = /지분\\s*매각|공유\\s*지분|매각\\s*지분/;\nconst BULK_RE = /일괄\\s*매각/;\nconst MULTI_UNIT_ADDR_RE = /외\\s*\\d+\\s*개?\\s*호/;\nconst UNIT_TYPES_RE = /아파트|다세대|빌라|연립|오피스텔|도시형/;\n\nfunction courtFromSpec(spec) {\n  const head = String(spec || '').slice(0, 400).replace(/\\s+/g, '');\n  const m = head.match(/([가-힣]{2})지방법원([가-힣]{2}지원)?/);\n  if (!m) return '';\n  return m[2] ? `${m[1]}지방법원 ${m[2]}` : `${m[1]}지방법원`;\n}\n\nconst patches = [];\nfor (const it of list) {\n  const spec = String(it.doc_spec_text || '');\n  const loc = String(it.location || '');\n  const patch = {};\n\n  let court = courtFromSpec(spec);\n  if (!court && /양산시/.test(loc)) court = '울산지방법원';\n  if (court && court !== it.court) patch.court = court;\n\n  const isShare = SHARE_RE.test(spec.replace(/[ \\t]+/g, ' '));\n  const units = new Set((spec.match(/제?\\s*\\d{1,4}\\s*호/g) || []).map((s) => s.replace(/\\D/g, '')));\n  const isUnitType = UNIT_TYPES_RE.test(String(it.usage || '') + ' ' + String(it.complex_name || '')) || /\\d+\\s*호/.test(loc);\n  const isBulk = MULTI_UNIT_ADDR_RE.test(loc) || (BULK_RE.test(spec) && isUnitType && units.size >= 2);\n\n  if (isShare && !it.is_share) patch.is_share = true;\n  if (isBulk && !it.is_bulk) patch.is_bulk = true;\n  if ((isShare || isBulk) && !it.is_hidden) patch.is_hidden = true; // status는 선택형(제외 옵션 없음) → 숨김 처리\n\n  if (Object.keys(patch).length) patches.push({ Id: it.Id, ...patch, __case: it.case_no });\n}\n// NocoDB 일괄 수정은 100행씩\nconst rows = patches.map(({ __case, ...rest }) => rest);\nconst chunks = [];\nfor (let i = 0; i < rows.length; i += 100) chunks.push({ json: { rows: rows.slice(i, i + 100), cases: patches.slice(i, i + 100).map((p) => p.__case) } });\nreturn chunks;\n" } } });

const bulkPatch = node({ type: 'n8n-nodes-base.httpRequest', version: 4.2, config: {
  name: '일괄 수정',
  parameters: { method: 'PATCH', url: 'http://nocodb_app:8080/api/v1/db/data/bulk/noco/pwmyhpb0tu3b4m6/mfim9xo11ob6gp9',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'nocoDbApiToken',
    sendBody: true, specifyBody: 'json', jsonBody: expr('{{ JSON.stringify($json.rows) }}'), options: {} },
  credentials: { nocoDbApiToken: { id: 'lh3tnFIzojQ5Uqea', name: 'NocoDB account' } } } });

export default workflow('auction-phase0-migration', '041.[ONCE] 경매 0단계 데이터 보정 (2026-11-12)')
  .add(start).to(defineCols).to(addCol).to(fetchItems).to(compute).to(bulkPatch);
