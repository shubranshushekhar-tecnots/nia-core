// Round 2: same as verify-commands.mjs but stamps [Current workflow id: ...]
// on the first message (matching CommandBar.tsx's real behavior), and fixes
// /clean to target the transform node (t1) instead of the source node.
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

async function agentTurn(text, workflowId) {
  const contextualMessage = `[Current workflow id: ${workflowId}]\n${text}`;
  const res = await api('POST', '/copilot-agent', { messages: [{ role: 'user', content: contextualMessage }] });
  return res;
}

async function main() {
  const projects = await api('GET', '/projects');
  const project = projects.json.find((p) => p.name === 'Canvas E2E Project');
  const projectDetail = await api('GET', `/projects/${project.id}`);
  const workflow = projectDetail.json.workflows?.find((w) => w.name === 'Canvas E2E Workflow');
  const workflowId = workflow.id;
  console.log('workflowId:', workflowId);

  const cmds = [
    { cmd: '/clean', text: 'Propose cleaning for the transform node (t1).' },
    { cmd: '/describe', text: 'Describe the source node (src).' },
    { cmd: '/profile', text: 'Get a data profile for the source node (src).' },
    { cmd: '/explain', text: 'Explain the last error for this workflow.' },
    { cmd: '/status', text: 'What is the status of the most recent run of this workflow?' },
    { cmd: '/cancel', text: 'Cancel the most recent run of this workflow.' },
  ];

  const results = [];
  for (const { cmd, text } of cmds) {
    console.log(`\n=== AGENT ${cmd}: "${text}"`);
    const res = await agentTurn(text, workflowId);
    console.log('status:', res.status);
    console.log('reply:', res.json.reply);
    const toolCalls = (res.json.toolCalls || []).map((t) => ({ name: t.name, summary: t.summary, renderKind: t.render?.kind }));
    console.log('toolCalls:', JSON.stringify(toolCalls, null, 2));
    results.push({ cmd, path: 'agent', status: res.status, reply: res.json.reply, toolCalls });
  }

  console.log('\n=== RAW RESULTS JSON ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
