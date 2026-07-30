import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import JSZip from 'https://esm.sh/jszip@3.10.1';
import * as mammoth from 'https://esm.sh/mammoth@1.9.0/mammoth.browser.js';

const SUPABASE_URL = 'https://zacpesqqihxjqecewakd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Lw7fX1onkJOT-nGWw9oCdw_N78VbWiu';
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce' },
});

const app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const RISK_ORDER = { high: 0, caution: 1, ok: 2 };
const PRIO_ORDER = { red: 0, orange: 1, yellow: 2, green: 3 };
const PRIO_LABEL = { red: 'Critical', orange: 'High', yellow: 'Suggested', green: 'Safe' };
// priority of a finding; falls back to mapping the old 3-level risk for legacy reviews
const prio = (f) => (f.priority || ({ high: 'red', caution: 'yellow', ok: 'green' }[f.risk]) || 'orange').toLowerCase();
const legendHtml = (findings) => (findings && findings.length) ? `<div class="legend">
    <span class="grp"><span class="dot p-red"></span><span class="dot p-orange"></span><b>Red &amp; Orange</b>: change these, top priority</span>
    <span class="grp"><span class="dot p-yellow"></span><span class="dot p-green"></span><b>Yellow &amp; Green</b>: suggested but safe</span>
  </div>` : '';
let state = { user: null, isAdmin: false, view: 'review' };

// ---------- boot ----------
(async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin();
  state.user = session.user;
  const { data: member } = await sb.from('rg_invites').select('role')
    .eq('email', (state.user.email || '').toLowerCase()).maybeSingle();
  if (!member) return renderDenied();
  state.isAdmin = member.role === 'admin';
  renderView('review');
})();

// ---------- auth views ----------
function renderLogin() {
  app.innerHTML = `<div class="center">
    <div class="logo" style="width:44px;height:44px;font-size:20px">M</div>
    <div><h1 style="margin:0">Martal Redline Guard</h1>
    <p style="color:var(--muted);max-width:400px">Reviews client contract redlines against Martal's standards. Access is by invite - sign in with your <b>@martalgroup.com</b> Google account.</p></div>
    <button class="gbtn" id="signin">Sign in with Google</button>
    <div id="loginerr"></div></div>`;
  document.getElementById('signin').onclick = async () => {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + window.location.pathname,
        queryParams: { hd: 'martalgroup.com', prompt: 'select_account' },
      },
    });
    if (error) document.getElementById('loginerr').innerHTML = `<div class="err">${esc(error.message)}</div>`;
  };
}

function renderDenied() {
  app.innerHTML = `<div class="center">
    <div class="logo" style="width:44px;height:44px;font-size:20px">M</div>
    <h1 style="margin:0">Access not enabled</h1>
    <p style="color:var(--muted);max-width:420px">Your account isn't on the Redline Guard invite list yet. Ask an admin (Edd) to invite your @martalgroup.com address, then sign in again.</p>
    <button class="ghost" id="out">Back to sign in</button></div>`;
  document.getElementById('out').onclick = async () => { await sb.auth.signOut(); renderLogin(); };
}

// ---------- shell ----------
function shell(inner) {
  app.innerHTML = `
  <div class="topbar">
    <div class="logo">M</div>
    <div><h1>Martal Redline Guard</h1><div class="sub">Contract redline risk review · ${esc(state.user.email)}</div></div>
    <div class="nav">
      <a data-v="review" class="${state.view === 'review' ? 'active' : ''}">Review</a>
      <a data-v="history" class="${state.view === 'history' ? 'active' : ''}">History</a>
      ${state.isAdmin ? `<a data-v="admin" class="${state.view === 'admin' ? 'active' : ''}">Team</a>` : ''}
      <button id="signout">Sign out</button>
    </div>
  </div><main id="main">${inner}</main>`;
  app.querySelectorAll('.nav a[data-v]').forEach((a) => (a.onclick = () => renderView(a.dataset.v)));
  document.getElementById('signout').onclick = async () => { await sb.auth.signOut(); renderLogin(); };
}

function renderView(v) {
  state.view = v;
  if (v === 'review') renderReview();
  else if (v === 'history') renderHistory();
  else if (v === 'admin') renderAdmin();
}

// ---------- review ----------
let R = { mode: 'file', file: null, result: null, reviewId: null, decisions: {} };
function renderReview() {
  R = { mode: 'file', file: null, result: null, reviewId: null, decisions: {} };
  shell(`
    <div class="tabs">
      <div class="tab active" data-m="file">Upload .docx / PDF</div>
      <div class="tab" data-m="gdoc">Google Doc link</div>
      <div class="tab" data-m="text">Paste text</div>
    </div>
    <div class="card">
      <input type="text" id="client" placeholder="Client / counterparty name (optional)" style="margin-bottom:12px" />
      <div id="pane"></div>
      <div class="row"><button class="go" id="run">Review</button><span id="status" style="color:var(--muted);font-size:13px"></span></div>
    </div>
    <div id="err"></div><div id="results"></div>`);
  app.querySelectorAll('.tab[data-m]').forEach((t) => (t.onclick = () => {
    app.querySelectorAll('.tab[data-m]').forEach((x) => x.classList.remove('active'));
    t.classList.add('active'); R.mode = t.dataset.m; paintPane();
  }));
  document.getElementById('run').onclick = runReview;
  paintPane();
}

function paintPane() {
  const pane = document.getElementById('pane');
  if (R.mode === 'file') {
    pane.innerHTML = `<label class="drop"><input type="file" id="file" accept=".docx,.pdf,.txt,.md" style="display:none" />
      <strong>Click to choose a file</strong> or drag it here - <b>.docx</b> (best: carries redpen comments &amp; tracked changes) or PDF
      <div id="fname" style="color:var(--accent);margin-top:8px;font-weight:600"></div></label>
      <div class="hint">Reviewing a Google Doc with comments? In Docs use <b>File &rarr; Download &rarr; .docx</b> and upload that - it brings the suggestions and margin comments with it.</div>`;
    const input = document.getElementById('file');
    const drop = pane.querySelector('.drop');
    input.onchange = () => pick(input.files[0]);
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
    drop.ondrop = (e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); };
  } else if (R.mode === 'gdoc') {
    pane.innerHTML = `<input type="url" id="gdoc" placeholder="https://docs.google.com/document/d/.../edit" />
      <div class="hint">Link-sharing must be on. A link brings the <b>text only</b> - to review the redpen comments/suggestions, download as .docx and upload.</div>`;
  } else {
    pane.innerHTML = `<textarea id="text" placeholder="Paste the clause, redline, or full agreement text..."></textarea>
      <div class="hint">Paste anything from a single clause to a whole agreement.</div>`;
  }
}

function pick(f) {
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) return showErr('File is over 8 MB - compress it or paste the text.');
  R.file = f;
  const el = document.getElementById('fname');
  if (el) el.textContent = '✓ ' + f.name;
}

function showErr(m) { document.getElementById('err').innerHTML = `<div class="err">${esc(m)}</div>`; }

async function runReview() {
  document.getElementById('err').innerHTML = '';
  document.getElementById('results').innerHTML = '';
  const clientName = document.getElementById('client').value.trim();
  const body = {};
  let docName = 'Pasted text', sourceType = R.mode;
  try {
    if (R.mode === 'text') {
      const t = document.getElementById('text').value.trim();
      if (t.length < 10) return showErr('Paste at least a clause or two.');
      body.content = t;
    } else if (R.mode === 'gdoc') {
      const u = document.getElementById('gdoc').value.trim();
      if (!u) return showErr('Paste a Google Doc URL.');
      body.gdocUrl = u; docName = 'Google Doc';
    } else {
      if (!R.file) return showErr('Choose a file first.');
      docName = R.file.name;
      const buf = await R.file.arrayBuffer();
      const name = R.file.name.toLowerCase();
      if (name.endsWith('.pdf') || R.file.type === 'application/pdf') {
        body.pdfBase64 = await toBase64(R.file);
      } else if (name.endsWith('.docx')) {
        body.content = await extractDocx(buf);
      } else {
        body.content = new TextDecoder().decode(buf);
      }
    }
  } catch (e) { return showErr('Could not read that file: ' + e.message); }

  setStatus('Reviewing against Martal standards + precedents... (up to a minute)');
  try {
    const { data, error } = await sb.functions.invoke('rg-review', { body });
    if (error) {
      let msg = error.message;
      try { const ctx = await error.context?.json?.(); if (ctx?.error) msg = ctx.error; } catch (_) {}
      throw new Error(msg);
    }
    if (data?.error) throw new Error(data.error);
    R.result = data.review; R.result._meta = { precedentsUsed: data.precedentsUsed };
    // persist the review (RLS: invited members only)
    const { data: saved } = await sb.from('rg_reviews').insert({
      created_by: state.user.id, created_by_email: state.user.email,
      doc_name: docName, client_name: clientName || R.result.client_name || null,
      source_type: sourceType, document_type: R.result.document_type || null,
      overall_risk: R.result.overall_risk || null, summary: R.result.summary || null,
      findings: R.result.findings || [],
    }).select('id').single();
    R.reviewId = saved?.id || null;
    paintResults();
  } catch (e) { showErr(e.message); }
  finally { setStatus(''); }
}

function setStatus(s) { const el = document.getElementById('status'); if (el) el.innerHTML = s ? `<span class="spinner"></span>${esc(s)}` : ''; }
const run = () => document.getElementById('run');

function sortedFindings() { return (R.result?.findings || []).slice().sort((a, b) => (PRIO_ORDER[prio(a)] ?? 1) - (PRIO_ORDER[prio(b)] ?? 1)); }

function paintResults() {
  const r = R.result, risk = (r.overall_risk || 'medium').toLowerCase();
  const findings = sortedFindings();
  const bcls = risk === 'high' ? 'b-high' : risk === 'low' ? 'b-low' : 'b-med';
  let html = `<div style="margin-top:26px">
    <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
      <span style="font-weight:700;font-size:17px">${esc(r.document_type || 'Document')}</span>
      <span class="badge ${bcls}">Overall risk: ${risk.toUpperCase()}</span>
      <button class="ghost" id="copyall" style="margin-left:auto">Copy full review</button>
    </div>
    <p style="color:var(--muted);margin:8px 0 6px">${esc(r.summary || '')}</p>
    <div class="hint" style="margin-bottom:12px">${typeof r._meta?.precedentsUsed === 'number' ? r._meta.precedentsUsed + ' precedent(s) informed this review.' : ''}</div>
    ${legendHtml(findings)}`;
  findings.forEach((f, i) => {
    const p = prio(f);
    html += `<div class="finding p-${p}">
      <div class="fhead"><span class="clause">${esc(f.clause)}</span><span class="pill p-${p}">${PRIO_LABEL[p] || p}</span></div>
      ${f.excerpt ? `<div class="excerpt">"${esc(f.excerpt)}"</div>` : ''}
      <div class="field"><div class="label">Risk to Martal</div>${esc(f.issue)}</div>
      <div class="field"><div class="label">Martal standard</div>${esc(f.martal_standard)}</div>
      ${f.precedent_note ? `<div class="field"><div class="label">Precedent applied</div>${esc(f.precedent_note)}</div>` : ''}
      <div class="field"><div class="label">Proposed response</div>
        <div class="proposed"><button class="copy" data-i="${i}">Copy</button>${esc(f.proposed_response)}</div></div>
      <div class="decide"><div class="label">Final call (teaches the tool)</div>
        <div class="opts">
          <span class="opt" data-i="${i}" data-d="accepted">Accept as-is</span>
          <span class="opt" data-i="${i}" data-d="countered">Counter</span>
          <span class="opt" data-i="${i}" data-d="rejected">Reject</span>
        </div>
        <input type="text" data-note="${i}" placeholder="Why (optional) - becomes the precedent's rationale" style="margin-top:4px" />
      </div></div>`;
  });
  if (r.missing_protections?.length) html += `<div class="missing"><h3>⚠ Standard protections missing from this document</h3><ul>${r.missing_protections.map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`;
  html += `<div class="row"><button class="go" id="savedec">Save decisions &amp; teach the tool</button><span id="savemsg"></span></div></div>`;
  document.getElementById('results').innerHTML = html;

  document.querySelectorAll('.proposed .copy').forEach((b) => (b.onclick = () => {
    navigator.clipboard.writeText(findings[+b.dataset.i].proposed_response || '');
    b.textContent = 'Copied ✓'; b.classList.add('done'); setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1500);
  }));
  document.querySelectorAll('.opt').forEach((o) => (o.onclick = () => {
    const i = o.dataset.i;
    document.querySelectorAll(`.opt[data-i="${i}"]`).forEach((x) => x.className = 'opt');
    o.className = 'opt sel-' + o.dataset.d;
    R.decisions[i] = { ...(R.decisions[i] || {}), final_decision: o.dataset.d };
  }));
  document.querySelectorAll('input[data-note]').forEach((inp) => (inp.oninput = () => {
    const i = inp.dataset.note; R.decisions[i] = { ...(R.decisions[i] || {}), rationale: inp.value };
  }));
  document.getElementById('copyall').onclick = () => copyAll(r, findings);
  document.getElementById('savedec').onclick = () => saveDecisions(findings);
}

async function saveDecisions(findings) {
  const rows = findings.map((f, i) => {
    const d = R.decisions[i]; if (!d?.final_decision) return null;
    return { review_id: R.reviewId, created_by_email: state.user.email, clause_type: f.clause_type || 'other',
      clause: f.clause, change_summary: f.excerpt || f.issue, ai_risk: prio(f), human_risk: prio(f),
      final_decision: d.final_decision, rationale: d.rationale || '', proposed_response: f.proposed_response || '' };
  }).filter(Boolean);
  const msg = document.getElementById('savemsg');
  if (!rows.length) { msg.innerHTML = '<span style="color:var(--caution)">Mark at least one final call first.</span>'; return; }
  const { error } = await sb.from('rg_precedents').insert(rows);
  if (error) { msg.innerHTML = `<span style="color:var(--high)">${esc(error.message)}</span>`; return; }
  if (R.reviewId) await sb.from('rg_reviews').update({ status: 'decided' }).eq('id', R.reviewId);
  msg.innerHTML = '<span style="color:var(--ok);font-weight:600">✓ Saved - future reviews will use these precedents.</span>';
}

function copyAll(r, findings) {
  let md = `# Redline review - ${r.document_type || 'Document'}\n**Overall risk: ${(r.overall_risk || '').toUpperCase()}**\n\n${r.summary || ''}\n\n`;
  findings.forEach((f) => {
    md += `## ${f.clause} - [${prio(f).toUpperCase()}]\n`;
    if (f.excerpt) md += `> "${f.excerpt}"\n\n`;
    md += `**Risk:** ${f.issue}\n\n**Martal standard:** ${f.martal_standard}\n\n**Proposed response:** ${f.proposed_response}\n\n`;
  });
  if (r.missing_protections?.length) md += `## Missing protections\n` + r.missing_protections.map((m) => `- ${m}`).join('\n');
  navigator.clipboard.writeText(md);
  const b = document.getElementById('copyall'); b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = 'Copy full review'), 1500);
}

// ---------- docx redpen extraction (browser) ----------
async function extractDocx(buf) {
  const runs = (s) => (s.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map((m) => m.replace(/<[^>]+>/g, '')).join('');
  const dels = (s) => (s.match(/<w:delText[^>]*>([\s\S]*?)<\/w:delText>/g) || []).map((m) => m.replace(/<[^>]+>/g, '')).join('');
  let text = '';
  try { const { value } = await mammoth.extractRawText({ arrayBuffer: buf }); text = value || ''; } catch (_) {}
  const zip = await JSZip.loadAsync(buf);
  const docXml = zip.file('word/document.xml') ? await zip.file('word/document.xml').async('string') : '';
  if (!text && docXml) text = runs(docXml);
  const ins = [], del = [], com = [];
  for (const m of docXml.matchAll(/<w:ins\b[\s\S]*?<\/w:ins>/g)) {
    const added = runs(m[0]).trim(); if (!added) continue;
    const before = runs(docXml.slice(Math.max(0, m.index - 1600), m.index)).slice(-180).trim();
    const author = (m[0].match(/w:author="([^"]+)"/) || [])[1] || '';
    ins.push(`${author ? '(' + author + ') ' : ''}after "...${before}": ADDS "${added}"`);
  }
  for (const m of docXml.matchAll(/<w:del\b[\s\S]*?<\/w:del>/g)) {
    const removed = dels(m[0]).trim(); if (!removed) continue;
    const author = (m[0].match(/w:author="([^"]+)"/) || [])[1] || '';
    del.push(`${author ? '(' + author + ') ' : ''}REMOVES "${removed}"`);
  }
  const cXml = zip.file('word/comments.xml') ? await zip.file('word/comments.xml').async('string') : '';
  if (cXml) for (const m of cXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const author = (m[1].match(/w:author="([^"]+)"/) || [])[1] || '';
    const body = runs(m[2]).trim(); if (body) com.push(`${author ? '(' + author + ') ' : ''}${body}`);
  }
  let out = `----- DOCUMENT TEXT -----\n${text}`;
  if (ins.length) out += `\n\n----- SUGGESTED INSERTIONS (client redpen) -----\n` + ins.map((x, n) => `[${n + 1}] ${x}`).join('\n');
  if (del.length) out += `\n\n----- SUGGESTED DELETIONS (client redpen) -----\n` + del.map((x, n) => `[${n + 1}] ${x}`).join('\n');
  if (com.length) out += `\n\n----- MARGIN COMMENTS -----\n` + com.map((x, n) => `[${n + 1}] ${x}`).join('\n');
  return out;
}

function toBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
}

// ---------- history ----------
let historyCache = [];
async function renderHistory() {
  shell(`<h2 style="margin-top:0">Review history</h2><div id="h">Loading...</div>`);
  const { data } = await sb.from('rg_reviews')
    .select('id, created_at, doc_name, client_name, document_type, overall_risk, status, created_by_email, summary, findings')
    .order('created_at', { ascending: false }).limit(200);
  historyCache = data || [];
  const wrap = document.getElementById('h');
  if (!historyCache.length) { wrap.innerHTML = '<div class="hint">No reviews yet. Run one from the Review tab.</div>'; return; }
  wrap.innerHTML = `<div class="hint" style="margin-bottom:10px">Click any row to open the full review.</div>
    <table class="list"><thead><tr><th>Date</th><th>Client / Doc</th><th>Type</th><th>Risk</th><th>Findings</th><th>Status</th><th>By</th>${state.isAdmin ? '<th></th>' : ''}</tr></thead><tbody>
    ${historyCache.map((r) => {
      const risk = (r.overall_risk || 'medium').toLowerCase();
      const bcls = risk === 'high' ? 'b-high' : risk === 'low' ? 'b-low' : 'b-med';
      return `<tr data-id="${esc(r.id)}" style="cursor:pointer"><td>${new Date(r.created_at).toLocaleDateString()}</td><td>${esc(r.client_name || r.doc_name || '-')}</td>
        <td>${esc(r.document_type || '-')}</td><td><span class="badge ${bcls}" style="font-size:11px;padding:3px 9px">${risk.toUpperCase()}</span></td>
        <td>${Array.isArray(r.findings) ? r.findings.length : 0}</td>
        <td style="color:${r.status === 'decided' ? 'var(--ok)' : 'var(--muted)'}">${esc(r.status)}</td>
        <td style="color:var(--muted)">${esc((r.created_by_email || '').split('@')[0])}</td>${state.isAdmin ? `<td style="text-align:right"><button class="ghost" data-del="${esc(r.id)}" style="padding:5px 12px">Delete</button></td>` : ''}</tr>`;
    }).join('')}</tbody></table>`;
  document.querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = () => openHistoryDetail(tr.dataset.id)));
  document.querySelectorAll('button[data-del]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); deleteReview(b.dataset.del); }));
}

async function deleteReview(id) {
  if (!confirm('Delete this review permanently? This also removes any decisions logged from it.')) return;
  await sb.from('rg_precedents').delete().eq('review_id', id);
  const { error } = await sb.from('rg_reviews').delete().eq('id', id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  renderHistory();
}

async function openHistoryDetail(id) {
  const r = historyCache.find((x) => String(x.id) === String(id));
  if (!r) return renderHistory();
  let decisions = [];
  try {
    const { data } = await sb.from('rg_precedents').select('clause, final_decision, rationale').eq('review_id', id);
    decisions = data || [];
  } catch (_) {}
  renderHistoryDetail(r, decisions);
}

function renderHistoryDetail(r, decisions) {
  const risk = (r.overall_risk || 'medium').toLowerCase();
  const bcls = risk === 'high' ? 'b-high' : risk === 'low' ? 'b-low' : 'b-med';
  const findings = (r.findings || []).slice().sort((a, b) => (PRIO_ORDER[prio(a)] ?? 1) - (PRIO_ORDER[prio(b)] ?? 1));
  const decMap = {}; decisions.forEach((d) => { if (d.clause) decMap[d.clause] = d; });
  let html = `<a id="back" style="font-weight:600">&larr; Back to history</a>
    <div style="margin-top:16px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
      <span style="font-weight:700;font-size:18px">${esc(r.client_name || r.doc_name || 'Review')}</span>
      <span class="badge ${bcls}">Overall risk: ${risk.toUpperCase()}</span>
      <button class="ghost" id="copyall" style="margin-left:auto">Copy full review</button>
      ${state.isAdmin ? `<button class="ghost" id="deldetail">Delete</button>` : ''}
    </div>
    <div class="sub" style="margin:8px 0 2px;color:var(--muted)">${esc(r.document_type || 'Document')} · ${new Date(r.created_at).toLocaleString()} · ${esc((r.created_by_email || '').split('@')[0])} · ${esc(r.status || '')}</div>
    <p style="color:var(--muted);margin:10px 0 18px">${esc(r.summary || '')}</p>`;
  if (!findings.length) html += `<div class="hint">This review has no stored findings.</div>`;
  html += legendHtml(findings);
  findings.forEach((f, i) => {
    const p = prio(f);
    const d = decMap[f.clause];
    html += `<div class="finding p-${p}">
      <div class="fhead"><span class="clause">${esc(f.clause)}</span><span class="pill p-${p}">${PRIO_LABEL[p] || p}</span></div>
      ${f.excerpt ? `<div class="excerpt">"${esc(f.excerpt)}"</div>` : ''}
      <div class="field"><div class="label">Risk to Martal</div>${esc(f.issue)}</div>
      <div class="field"><div class="label">Martal standard</div>${esc(f.martal_standard)}</div>
      ${f.precedent_note ? `<div class="field"><div class="label">Precedent applied</div>${esc(f.precedent_note)}</div>` : ''}
      <div class="field"><div class="label">Proposed response</div>
        <div class="proposed"><button class="copy" data-i="${i}">Copy</button>${esc(f.proposed_response)}</div></div>
      ${d?.final_decision ? `<div class="decide"><div class="label">Final call logged</div>
        <span class="opt sel-${esc(d.final_decision)}">${esc(d.final_decision)}</span>${d.rationale ? `<span style="color:var(--muted);margin-left:10px">${esc(d.rationale)}</span>` : ''}</div>` : ''}
    </div>`;
  });
  shell(`<div id="results">${html}</div>`);
  document.getElementById('back').onclick = renderHistory;
  document.querySelectorAll('.proposed .copy').forEach((b) => (b.onclick = () => {
    navigator.clipboard.writeText(findings[+b.dataset.i].proposed_response || '');
    b.textContent = 'Copied ✓'; b.classList.add('done'); setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done'); }, 1500);
  }));
  document.getElementById('copyall').onclick = () => copyAll(r, findings);
  const dd = document.getElementById('deldetail'); if (dd) dd.onclick = () => deleteReview(r.id);
}

// ---------- admin ----------
async function renderAdmin() {
  shell(`<h2 style="margin-top:0">Team access</h2>
    <p style="color:var(--muted);margin-top:0">Only invited @martalgroup.com accounts can sign in.</p>
    <div class="card" style="margin-bottom:18px">
      <div class="label">Invite a teammate (@martalgroup.com)</div>
      <div class="row" style="margin-top:8px">
        <input type="email" id="iemail" placeholder="name@martalgroup.com" style="flex:1;min-width:220px" />
        <select id="irole" style="width:130px"><option value="member">Member</option><option value="admin">Admin</option></select>
        <button class="go" id="invite">Invite</button>
      </div><div id="ierr"></div>
    </div><div id="list">Loading...</div>`);
  document.getElementById('invite').onclick = doInvite;
  loadInvites();
}

async function loadInvites() {
  const { data } = await sb.from('rg_invites').select('email, role').order('email');
  document.getElementById('list').innerHTML = `<table class="list"><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
    ${(data || []).map((u) => `<tr><td>${esc(u.email)}</td><td style="color:${u.role === 'admin' ? 'var(--accent)' : 'var(--muted)'}">${esc(u.role)}</td>
      <td style="text-align:right">${u.email !== 'edward@martalgroup.com' ? `<button class="ghost" data-rm="${esc(u.email)}">Remove</button>` : ''}</td></tr>`).join('')}
    </tbody></table>`;
  document.querySelectorAll('button[data-rm]').forEach((b) => (b.onclick = () => removeInvite(b.dataset.rm)));
}

async function doInvite() {
  const email = document.getElementById('iemail').value.trim().toLowerCase();
  const role = document.getElementById('irole').value;
  const err = document.getElementById('ierr');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err.innerHTML = '<div class="err">Enter a valid email.</div>';
  if (!email.endsWith('@martalgroup.com')) return err.innerHTML = '<div class="err">Only @martalgroup.com addresses can be invited.</div>';
  const { error } = await sb.from('rg_invites').upsert({ email, role, invited_by: state.user.email }, { onConflict: 'email' });
  if (error) return err.innerHTML = `<div class="err">${esc(error.message)}</div>`;
  err.innerHTML = ''; document.getElementById('iemail').value = ''; loadInvites();
}

async function removeInvite(email) {
  if (!confirm('Remove access for ' + email + '?')) return;
  await sb.from('rg_invites').delete().eq('email', email);
  loadInvites();
}
