// Round 3: reseed graph (round1's cleanup wiped it), then retest /clean
// (targeting t1), /describe, /profile with proper workflow-id context stamp.
import { readFileSync } from 'node:fs';

const API = 'http://localhost:4001';
const storageState = JSON.parse(readFileSync('playwright/.auth/canvas-a.json', 'utf8'));
const sessionCookie = storageState.cookies.find((c) => c.name === 'better-auth.session_token');
const cookieHeader = `better-auth.session_token=${sessionCookie.value}`;
const bearerToken = decodeURIComponent(sessionCookie.value);

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: cookieHeader, authorization: `Bearer ${bearerToken}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

async function main() {
  const projects = await api('GET', '/projects');
  const project = projects.json.find((p) => p.name === 'Canvas E2E Project');
  const projectDetail = await api('GET', `/projects/${project.id}`);
  const workflow = projectDetail.json.workflows?.find((w) => w.name === 'Canvas E2E Workflow');
  const workflowId = workflow.id;

  const conns = await api('GET', '/connections');
  const mysqlConn = conns.json.find((c) => c.connectorId === 'mysql');

  const current = await api('GET', `/workflows/${workflowId}/graph`);
  const seedGraph = {
    nodes: [
      { id: 'src', type: 'source', connectionId: mysqlConn.id, manifestId: 'mysql', position: { x: 0, y: 0 },
        config: { operation: 'read', entity: { namespace: 'sandbox', name: 'employees' } } },
      { id: 't1', type: 'transform', position: { x: 250, y: 0 }, config: { steps: [] } },
      { id: 'dest', type: 'destination', connectionId: mysqlConn.id, manifestId: 'mysql', position: { x: 500, y: 0 },
        config: { operation: 'insert' } },
    ],
    edges: [ { id: 'e0', source: 'src', target: 't1' }, { id: 'e1', source: 't1', target: 'dest' } ],
  };
  const seedRes = await api('PUT', `/workflows/${workflowId}/graph`, { graph: seedGraph, expectedVersion: current.json.version });
  console.log('reseeded graph, new version:', seedRes.json.version);

  async function agentTurn(text) {
    const contextualMessage = `[Current workflow id: ${workflowId}]\n${text}`;
    return api('POST', '/copilot-agent', { messages: [{ role: 'user', content: contextualMessage }] });
  }

  const cmds = [
    { cmd: '/clean', text: 'Propose cleaning for the transform node (t1).' },
    { cmd: '/describe', text: 'Describe the source node (src).' },
    { cmd: '/profile', text: 'Get a data profile for the source node (src).' },
  ];

  const results = [];
  for (const { cmd, text } of cmds) {
    console.log(`\n=== AGENT ${cmd}: "${text}"`);
    const res = await agentTurn(text);
    console.log('status:', res.status);
    console.log('reply:', res.json.reply);
    const toolCalls = (res.json.toolCalls || []).map((t) => ({ name: t.name, summary: t.summary, renderKind: t.render?.kind }));
    console.log('toolCalls:', JSON.stringify(toolCalls, null, 2));
    results.push({ cmd, path: 'agent', status: res.status, reply: res.json.reply, toolCalls });
  }

  // cleanup: reset graph back to empty
  const after = await api('GET', `/workflows/${workflowId}/graph`);
  await api('PUT', `/workflows/${workflowId}/graph`, { graph: { nodes: [], edges: [] }, expectedVersion: after.json.version });
  console.log('\ncleaned up graph back to empty.');

  console.log('\n=== RAW RESULTS JSON ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
