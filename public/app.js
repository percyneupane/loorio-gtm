// Loorio GTM dashboard — plain ES module, no build step. All server text is escaped via esc().

const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ago = (iso) => {
  if (!iso) return '';
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 0) return `in ${fmtDur(-s)}`;
  return s < 60 ? 'just now' : `${fmtDur(s)} ago`;
};
const fmtDur = (s) => (s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined || opts.method ? { 'content-type': 'application/json' } : {},
    body: opts.body !== undefined ? JSON.stringify(opts.body) : opts.method ? '{}' : undefined,
  });
  const json = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  if (!json.success) throw new Error(json.error ?? 'Request failed');
  return json.data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    await refresh();
  } catch (e) {
    toast(`⚠️ ${e.message}`);
  }
}

const STATUS_TONE = {
  replied: 'good', in_sequence: '', drafted: '', completed: '', new: '',
  no_email: 'warn', rejected: 'warn', error: 'bad', opted_out: 'bad', bounced: 'bad',
  active: 'good', pending_approval: 'warn', stopped: '', creator_reply: 'good', opt_out: 'bad', bounce: 'bad',
};
const pill = (s) => `<span class="pill ${STATUS_TONE[s] ?? ''}">${esc(String(s).replace(/_/g, ' '))}</span>`;

// ---------- Overview ----------
let status;
async function renderOverview() {
  status = await api('/api/status');
  const c = status.capabilities;
  const steps = [
    [c.gmail, 'Google OAuth client in .env', 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET'],
    [status.gmail.connected, status.gmail.connected ? `Gmail connected: ${status.gmail.account}` : 'Connect Gmail', status.gmail.connected ? '' : '<a href="/api/auth/google"><button class="primary">Connect Gmail</button></a>'],
    [c.ai, 'Anthropic API key', 'ANTHROPIC_API_KEY — needed to qualify creators, draft emails and replies'],
    [c.youtube, 'YouTube Data API key', 'YOUTUBE_API_KEY — needed for automatic discovery'],
    [c.push, 'Phone notifications', 'NTFY_TOPIC — install the free ntfy app and subscribe to your topic'],
  ];
  const allDone = steps.every(([d]) => d);
  $('#setup').innerHTML = `
    <div class="row between"><h2>${allDone ? 'All set ✅' : 'Setup'}</h2>
      <div class="row">${c.push ? '<button id="test-notify">Send test notification</button>' : ''}
      ${status.gmail.connected ? '<button id="disconnect" class="danger">Disconnect Gmail</button>' : ''}</div></div>
    ${steps.map(([done, label, hint]) => `<div class="setup-step"><span class="check ${done ? 'done' : ''}"></span><div><div>${esc(label)}</div>${done ? '' : `<div class="muted">${hint.startsWith('<') ? hint : esc(hint)}</div>`}</div></div>`).join('')}`;
  $('#test-notify')?.addEventListener('click', () => act(() => api('/api/notify/test', { method: 'POST' }), 'Test notification sent'));
  $('#disconnect')?.addEventListener('click', () => confirm('Disconnect Gmail? Sending and inbox monitoring will stop.') && act(() => api('/api/auth/disconnect', { method: 'POST' }), 'Disconnected'));

  const n = status.counts;
  const sum = (...keys) => keys.reduce((a, k) => a + (n[k] ?? 0), 0);
  const stats = [
    ['Creators found', sum(...Object.keys(n))],
    ['Waiting to enrich', sum('new')],
    ['Awaiting approval', status.pendingApprovals],
    ['In sequence', sum('in_sequence')],
    ['Replied', sum('replied')],
    ['Sent today', `${status.sentToday}/${status.dailyLimit}`],
  ];
  $('#stats').innerHTML = stats.map(([l, v]) => `<div class="stat"><div class="n">${esc(v)}</div><div class="l">${esc(l)}</div></div>`).join('');
  $('#window').textContent = `Sends ${status.sendWindow} · follow-ups day ${status.followUpDays.join('/')} · notify: ${status.notifyLevel}`;

  const labels = { inbox: 'Check inbox', send: 'Send next email', enrich: 'Find emails + draft (5)', discover: 'Discover on YouTube' };
  $('#jobs').innerHTML = Object.entries(status.jobs).map(([name, j]) => `
    <div class="job"><div class="row between"><h3>${esc(labels[name])}</h3><button data-job="${name}" ${j.running ? 'disabled' : ''}>${j.running ? 'Running…' : 'Run now'}</button></div>
    <div class="r">${j.lastError ? `<span class="pill bad">error</span> ${esc(j.lastError)}` : esc(j.lastResult ?? 'not run yet')} ${j.lastRunAt ? `· ${ago(j.lastRunAt)}` : ''}</div></div>`).join('');
  document.querySelectorAll('[data-job]').forEach((b) =>
    b.addEventListener('click', () => {
      b.disabled = true;
      b.textContent = 'Running…';
      act(() => api(`/api/jobs/${b.dataset.job}/run`, { method: 'POST' }), (r) => r.result);
    }),
  );

  const badge = $('#badge-approvals');
  badge.hidden = status.pendingApprovals === 0;
  badge.textContent = status.pendingApprovals;

  const activity = await api('/api/activity');
  $('#activity').innerHTML = activity.length
    ? activity.map((a) => `<li><time>${esc(ago(a.created_at))}</time><span>${a.kind === 'error' ? pill('error') + ' ' : ''}${esc(a.message)}</span></li>`).join('')
    : '<li class="muted">Nothing yet.</li>';
}

// ---------- Sequences (approvals + all) ----------
function sequenceCard(seq, editable) {
  const c = seq.creator;
  const steps = seq.steps.map((st) => {
    const when = st.step_index === 0 ? 'First email' : `Follow-up ${st.step_index} · day ${st.delay_days}`;
    const state = st.status === 'sent' ? `sent ${ago(st.sent_at)}` : st.status === 'scheduled' ? `due ${ago(st.due_at)}` : st.status;
    if (editable && (st.status === 'draft' || st.status === 'scheduled')) {
      return `<div class="step"><label>${esc(when)}</label>
        ${st.step_index === 0 ? `<input data-subject="${st.id}" value="${esc(st.subject)}">` : ''}
        <textarea data-body="${st.id}" rows="${Math.min(10, st.body.split('\n').length + 2)}">${esc(st.body)}</textarea>
        <button data-save="${st.id}" data-subj="${esc(st.subject)}">Save edit</button></div>`;
    }
    return `<div class="step"><label>${esc(when)} · ${esc(state)}</label>${st.step_index === 0 ? `<h3>${esc(st.subject)}</h3>` : ''}<pre>${esc(st.body)}</pre></div>`;
  });
  return `<div class="seq">
    <div class="row between"><h3>${esc(c.name || c.handle)} ${pill(seq.status)}</h3>
      <div class="row">${seq.status === 'pending_approval'
        ? `<button data-reject="${seq.id}" class="danger">Skip</button><button data-approve="${seq.id}" class="primary">Approve</button>`
        : seq.status === 'active' ? `<button data-stop="${seq.id}" class="danger">Stop</button>` : ''}</div></div>
    <div class="meta">${esc(c.platform)} · <a href="${esc(c.url)}" target="_blank" rel="noopener">@${esc(c.handle)}</a> · ${esc(c.followers?.toLocaleString() ?? '?')} followers · fit ${esc(c.fit_score ?? '?')} — ${esc(c.fit_reason ?? '')}<br>
      To <b>${esc(c.email)}</b> · found in ${esc(c.email_source ?? '')}${seq.stop_reason ? ` · stopped: ${esc(seq.stop_reason)}` : ''}</div>
    ${steps.join('')}</div>`;
}

function wireSequenceButtons(root) {
  root.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => act(() => api(`/api/sequences/${b.dataset.approve}/approve`, { method: 'POST' }), 'Approved — sends in the next slot')));
  root.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => act(() => api(`/api/sequences/${b.dataset.reject}/reject`, { method: 'POST' }), 'Skipped')));
  root.querySelectorAll('[data-stop]').forEach((b) => b.addEventListener('click', () => confirm('Stop this sequence? Remaining follow-ups will not send.') && act(() => api(`/api/sequences/${b.dataset.stop}/stop`, { method: 'POST' }), 'Stopped')));
  root.querySelectorAll('[data-save]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.save;
      const subject = root.querySelector(`[data-subject="${id}"]`)?.value ?? b.dataset.subj;
      const body = root.querySelector(`[data-body="${id}"]`).value;
      act(() => api(`/api/steps/${id}`, { method: 'PUT', body: { subject, body } }), 'Saved');
    }),
  );
}

async function renderApprovals() {
  const seqs = await api('/api/sequences?status=pending_approval');
  const root = $('#approvals');
  root.innerHTML = seqs.length ? seqs.map((s) => sequenceCard(s, true)).join('') : '<div class="empty">Nothing waiting. New drafts appear here as creators are enriched.</div>';
  $('#approve-all').disabled = seqs.length === 0;
  wireSequenceButtons(root);
}

let seqFilter = 'active';
async function renderSequences() {
  const filters = ['active', 'completed', 'stopped', 'rejected'];
  $('#sequence-filters').innerHTML = filters.map((f) => `<button data-sf="${f}" class="${f === seqFilter ? 'active' : ''}">${esc(f)}</button>`).join('');
  document.querySelectorAll('[data-sf]').forEach((b) => b.addEventListener('click', () => { seqFilter = b.dataset.sf; renderSequences(); }));
  const seqs = await api(`/api/sequences?status=${seqFilter}`);
  const root = $('#sequences');
  root.innerHTML = seqs.length ? seqs.map((s) => sequenceCard(s, seqFilter === 'active')).join('') : '<div class="empty">None.</div>';
  wireSequenceButtons(root);
}

// ---------- Creators ----------
let creatorFilter = '';
async function renderCreators() {
  const filters = ['', 'new', 'drafted', 'in_sequence', 'replied', 'no_email', 'rejected', 'error'];
  $('#creator-filters').innerHTML = filters.map((f) => `<button data-cf="${f}" class="${f === creatorFilter ? 'active' : ''}">${esc(f ? f.replace(/_/g, ' ') : 'all')}</button>`).join('');
  document.querySelectorAll('[data-cf]').forEach((b) => b.addEventListener('click', () => { creatorFilter = b.dataset.cf; renderCreators(); }));
  const creators = await api(`/api/creators${creatorFilter ? `?status=${creatorFilter}` : ''}`);
  $('#creators').innerHTML = creators.length
    ? `<div class="list">${creators.map((c) => `<div class="item" data-creator="${c.id}">
        <div><b>${esc(c.name || c.handle)}</b> <span class="muted">${esc(c.platform)} @${esc(c.handle)}</span>
        <div class="sub">${esc(c.email ?? '')} ${c.fit_score != null ? `· fit ${esc(c.fit_score)}` : ''} ${c.error ? `· ${esc(c.error)}` : ''}</div></div>
        <div>${pill(c.status)}</div></div>`).join('')}</div>`
    : '<div class="empty">No creators yet. Import some above or run discovery.</div>';
  document.querySelectorAll('[data-creator]').forEach((el) => el.addEventListener('click', () => openCreator(el.dataset.creator)));
}

async function openCreator(id) {
  const { creator: c, candidates, sequence } = await api(`/api/creators/${id}`);
  $('#detail-body').innerHTML = `
    <h2>${esc(c.name || c.handle)} ${pill(c.status)}</h2>
    <div class="muted"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a> · ${esc(c.followers?.toLocaleString() ?? '?')} followers · source: ${esc(c.source)}</div>
    ${c.fit_score != null ? `<p><b>Fit ${esc(c.fit_score)}</b> — ${esc(c.fit_reason)}</p>` : ''}
    ${c.error ? `<p class="pill bad">${esc(c.error)}</p>` : ''}
    <h3>Emails found (${candidates.length})</h3>
    ${candidates.length ? candidates.map((e) => `<pre><b>${esc(e.email)}</b>${e.email === c.email ? ' ✅ chosen' : ''}\n${esc(e.source_label)} — ${esc(e.source_url)}\n“${esc(e.snippet)}”</pre>`).join('') : '<p class="muted">None.</p>'}
    ${sequence ? `<h3>Sequence ${pill(sequence.status)}</h3>${sequence.steps.map((s) => `<pre>${esc(s.step_index === 0 ? s.subject + '\n\n' : `Follow-up ${s.step_index}: `)}${esc(s.body)}\n— ${esc(s.status)}</pre>`).join('')}` : ''}
    ${['no_email', 'error', 'rejected'].includes(c.status) && !sequence ? `<button id="retry" class="primary">Retry enrichment</button>` : ''}
    <h3>Public context</h3><pre>${esc(c.context || c.bio || '—')}</pre>`;
  $('#retry')?.addEventListener('click', () => act(() => api(`/api/creators/${c.id}/retry`, { method: 'POST' }), 'Queued for enrichment').then(() => $('#detail').close()));
  $('#detail').showModal();
}

// ---------- Inbox ----------
async function renderInbox() {
  const items = await api('/api/inbox');
  $('#inbox').innerHTML = items.length
    ? `<div class="list">${items.map((m) => `<a class="item" href="https://mail.google.com/mail/u/0/#all/${encodeURIComponent(m.thread_id)}" target="_blank" rel="noopener">
        <div><b>${esc(m.from_addr.replace(/\s*<.*>$/, ''))}</b> — ${esc(m.subject)}
        <div class="sub">${esc(m.summary || m.snippet)}${m.draft_id ? ' · ✍️ draft ready' : ''}${m.error ? ` · ⚠️ ${esc(m.error)}` : ''}</div></div>
        <div class="row">${m.needs_reply ? '<span class="pill warn">needs reply</span>' : ''}${pill(m.category)}<span class="muted">${esc(ago(m.received_at))}</span></div></a>`).join('')}</div>`
    : '<div class="empty">No emails processed yet. Monitoring starts once Gmail is connected (new mail only).</div>';
}

// ---------- Tabs + refresh ----------
const renderers = { overview: renderOverview, approvals: renderApprovals, creators: renderCreators, sequences: renderSequences, inbox: renderInbox };
let current = location.hash.slice(1) in renderers ? location.hash.slice(1) : 'overview';

function show(tab) {
  current = tab;
  history.replaceState(null, '', `#${tab}`);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== `tab-${tab}`));
  refresh();
}

async function refresh() {
  try {
    await renderers[current]();
    if (current !== 'overview') {
      const s = await api('/api/status');
      const badge = $('#badge-approvals');
      badge.hidden = s.pendingApprovals === 0;
      badge.textContent = s.pendingApprovals;
    }
  } catch (e) {
    toast(`⚠️ ${e.message}`);
  }
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
$('#approve-all').addEventListener('click', () => confirm('Approve every pending sequence?') && act(() => api('/api/sequences/approve-all', { method: 'POST' }), (r) => `Approved ${r.approved}`));
$('#import').addEventListener('click', () =>
  act(async () => {
    const r = await api('/api/creators/import', { method: 'POST', body: { lines: $('#import-lines').value } });
    $('#import-result').textContent = `Added ${r.added}${r.invalid.length ? ` · couldn't read: ${r.invalid.join(', ')}` : ''}`;
    $('#import-lines').value = '';
    return r;
  }),
);
// Refresh the overview periodically, but never while the user is editing a draft.
setInterval(() => {
  if (current === 'overview' || current === 'inbox') refresh();
}, 15000);
show(current);
