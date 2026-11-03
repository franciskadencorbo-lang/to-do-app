// ---------- Ask Claude (✦ on cards and sub-task rows) ----------
// Sends a prompt about a task to Claude Code running on the user's PC. The
// browser only writes a job file to the PRIVATE to-do-data repo (same token
// as cloud sync); the PC watcher (C:\Claude\Task Hub Jobs\watcher.py) picks
// it up, runs Claude, and writes the result back. Job files move through:
//   jobs/inbox/<taskId>__<jobId>[__<subtaskId>].json    queued
//   jobs/running/<taskId>__<jobId>[__<subtaskId>].json  Claude is working
//   jobs/done/<taskId>__<jobId>[__<subtaskId>].json     finished (status: done | failed)
// File names carry the task (and sub-task) id so three directory listings
// give the state of every request, from any device, without reading files.
// Claude only drafts: it never sends anything and never changes a task.

const ASK_JOBS_API = `https://api.github.com/repos/${SYNC_REPO}/contents/jobs`;
const ASK_PENDING_KEY = 'todo.askClaude.pending.v1';
const ASK_SEEN_KEY = 'todo.askClaude.seen.v1';
const ASK_POLL_MS = 60000;
const ASK_STATE_ICON = { inbox: '⏳', running: '✦', done: '✓', failed: '⚠' };
// When a task has several requests, the card chip shows the most pressing one.
const ASK_STATE_RANK = { running: 4, inbox: 3, failed: 2, done: 1 };
const ASK_STAGES = ['inbox', 'running', 'done'];
const ASK_STAGE_LABEL = { inbox: 'Queued', running: 'Running', done: 'Done', failed: 'Failed' };

const askOverlay = document.getElementById('askClaudeModalOverlay');
const askForm = document.getElementById('askClaudeForm');
const askTargetEl = document.getElementById('askClaudeTarget');
const askPromptEl = document.getElementById('askClaudePrompt');
const askContextEl = document.getElementById('askClaudeIncludeContext');
const askStatusEl = document.getElementById('askClaudeStatus');
const askSendBtn = document.getElementById('askClaudeSendBtn');
const askHistoryEl = document.getElementById('askClaudeHistory');
const askPresetsEl = document.getElementById('askClaudePresets');
const askNoticeEl = document.getElementById('askClaudeNotice');

let askTarget = null; // { taskId, subtaskId }
let askPreset = 'do';

function parseAskName(name) {
  const [taskId, jobId, subtaskId] = name.replace(/\.json$/, '').split('__');
  return { taskId, jobId, subtaskId: subtaskId || null };
}

function askJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadAskPending() {
  try {
    return JSON.parse(localStorage.getItem(ASK_PENDING_KEY)) || [];
  } catch {
    return [];
  }
}

function saveAskPending(list) {
  localStorage.setItem(ASK_PENDING_KEY, JSON.stringify(list));
}

function subtaskContext(s) {
  const assignee = s.assignee ? getAssignee(s.assignee) : null;
  return { id: s.id, title: s.title, date: s.date || null, minutes: s.minutes || 0,
    delegated: !!s.delegated, assignee: s.assignee || null,
    assigneeEmail: (assignee && assignee.email) || null, ai: !!s.ai };
}

// Outlook on the web's compose deep link, as the ✉ button on sub-tasks uses:
// opens a new message, which Outlook keeps in Drafts. Nothing is sent.
function askOutlookUrl(email) {
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[;,]\s*/)).filter(Boolean).join(';');
  const params = [
    ['to', list(email.to)], ['cc', list(email.cc)], ['subject', email.subject || ''],
    ['body', String(email.body || '').replace(/\r?\n/g, '\r\n')],
  ].filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `https://outlook.office.com/mail/deeplink/compose?${params}`;
}

// The watcher copies each job's output to OneDrive and records its web address
// (webUrl on a file, outputFolderUrl on the job). Browsers refuse file:// links
// from this page, so these are the only links that can open the output.
const ASK_OFFICE_APPS = {
  doc: ['ms-word', 'Word'], docx: ['ms-word', 'Word'],
  xls: ['ms-excel', 'Excel'], xlsx: ['ms-excel', 'Excel'], xlsm: ['ms-excel', 'Excel'],
  ppt: ['ms-powerpoint', 'PowerPoint'], pptx: ['ms-powerpoint', 'PowerPoint'],
};
const ASK_UPLOAD_HINT = 'If it does not open yet, OneDrive may still be uploading it: try again in a minute.';

// Job files are written by the watcher, but a link is only ever a SharePoint one.
function askWebUrl(url) {
  return /^https:\/\/[a-z0-9-]+\.sharepoint\.com\//i.test(url || '') ? url : '';
}

// escapeHtml leaves double quotes alone, which an attribute value cannot.
function askAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function askBrowserUrl(url) {
  return `${url}${url.includes('?') ? '&' : '?'}web=1`;
}

function askFileLinksHtml(f) {
  const url = askWebUrl(f.webUrl);
  const app = ASK_OFFICE_APPS[String(f.name || '').split('.').pop().toLowerCase()];
  const links = [];
  if (url && app) links.push(`<a class="link-btn" href="${askAttr(`${app[0]}:ofe|u|${url}`)}" title="${ASK_UPLOAD_HINT}">Open in ${app[1]}</a>`);
  if (url) links.push(`<a class="link-btn" href="${askAttr(askBrowserUrl(url))}" target="_blank" rel="noopener" title="${ASK_UPLOAD_HINT}">Open in browser</a>`);
  if (f.path) links.push(`<button type="button" class="link-btn" data-ask-copy-path="${askAttr(f.path)}">Copy path</button>`);
  return links.length ? `<div class="ask-claude-file-links">${links.join('')}</div>` : '';
}

// What Claude gets to know about the task. Notes and other sub-tasks only
// when the box is ticked; the task title, project and dates always.
function buildAskTaskContext(task, subtask, includeContext) {
  const ctx = {
    id: task.id, title: task.title, project: task.project || null, due: task.due || null,
    priority: task.priority || null, category: task.category || null, labels: task.labels || [],
  };
  if (task.email && task.email.link) ctx.emailLink = task.email.link;
  if (includeContext) {
    ctx.notes = task.notes || '';
    ctx.openSubtasks = (task.subtasks || []).filter((s) => !s.completed).map(subtaskContext);
  }
  return { task: ctx, subtask: subtask ? subtaskContext(subtask) : null };
}

async function askListStage(stage) {
  const res = await fetch(`${ASK_JOBS_API}/${stage}?ref=main`, { headers: syncHeaders(), cache: 'no-store' });
  if (res.status === 404) return [];
  if (!res.ok) throw Object.assign(new Error(`GitHub returned ${res.status}`), { status: res.status });
  return (await res.json()).filter((f) => f.type === 'file' && f.name.endsWith('.json'));
}

async function askReadFile(path) {
  const res = await fetch(`https://api.github.com/repos/${SYNC_REPO}/contents/${path}?ref=main`,
    { headers: syncHeaders(), cache: 'no-store' });
  if (!res.ok) return null;
  const file = await res.json();
  return JSON.parse(fromBase64Utf8(file.content));
}

async function askWriteJob(name, job) {
  const res = await fetch(`${ASK_JOBS_API}/inbox/${name}`, {
    method: 'PUT',
    headers: { ...syncHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Ask Claude - ${job.task.title.slice(0, 60)}`,
      content: toBase64Utf8(JSON.stringify(job, null, 1)),
      branch: 'main',
    }),
  });
  if (!res.ok) throw Object.assign(new Error(`GitHub returned ${res.status}`), { status: res.status });
}

// ---------- Modal ----------

function openAskClaudeModal(taskId, subtaskId) {
  const task = getTaskById(taskId);
  if (!task) return;
  const subtask = subtaskId ? (task.subtasks || []).find((s) => s.id === subtaskId) : null;
  askTarget = { taskId, subtaskId: subtask ? subtask.id : null };
  askTargetEl.innerHTML = `
    <div class="ask-claude-task">${escapeHtml(task.title)}${subtask ? ` <span class="ask-claude-arrow">›</span> ${escapeHtml(subtask.title)}` : ''}</div>
    <div class="hint-text">${[task.project, task.due ? `due ${formatShortDate((subtask && subtask.date) || task.due)}` : ''].filter(Boolean).map(escapeHtml).join(' · ')}</div>`;
  askPromptEl.value = '';
  askContextEl.checked = true;
  setAskPreset('do');
  askStatusEl.textContent = syncToken() ? '' : 'Connect cloud sync first (⚙ → Connect cloud sync).';
  askSendBtn.disabled = !syncToken();
  askOverlay.classList.remove('hidden');
  askPromptEl.focus();
  renderAskHistory();
  markAskSeen(taskId);
}

function closeAskClaudeModal() {
  askOverlay.classList.add('hidden');
  askTarget = null;
}

function setAskPreset(preset) {
  askPreset = preset;
  askPresetsEl.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === preset));
}

async function renderAskHistory() {
  if (!askTarget || !syncToken()) { askHistoryEl.innerHTML = '<p class="hint-text">None yet.</p>'; return; }
  const taskId = askTarget.taskId;
  askHistoryEl.innerHTML = '<p class="hint-text">Loading…</p>';
  try {
    const rows = [];
    for (const stage of ASK_STAGES) {
      for (const f of await askListStage(stage)) {
        const p = parseAskName(f.name);
        if (p.taskId === taskId) rows.push({ stage, path: f.path, jobId: p.jobId });
      }
    }
    if (!askTarget || askTarget.taskId !== taskId) return;
    if (!rows.length) { askHistoryEl.innerHTML = '<p class="hint-text">None yet.</p>'; return; }
    const jobs = await Promise.all(rows.map(async (r) => ({ ...r, job: await askReadFile(r.path) })));
    jobs.sort((a, b) => ((b.job && b.job.createdAt) || '').localeCompare((a.job && a.job.createdAt) || ''));
    askHistoryEl.innerHTML = jobs.map(askHistoryItemHtml).join('');
  } catch (err) {
    askHistoryEl.innerHTML = `<p class="hint-text">Could not load requests: ${escapeHtml(err.message || String(err))}</p>`;
  }
}

function askHistoryItemHtml({ stage, jobId, job }) {
  if (!job) return '';
  const status = stage === 'done' ? (job.status === 'failed' ? 'failed' : 'done') : stage;
  const when = job.createdAt ? new Date(job.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const target = job.subtask ? ` · ${escapeHtml(job.subtask.title)}` : '';
  const files = (job.files || []).map((f) => `
    <details class="ask-claude-file"><summary>📄 ${escapeHtml(f.name)}</summary>
      ${f.content != null ? `<pre class="diag-pre">${escapeHtml(f.content)}</pre>` : `<p class="hint-text">On ${escapeHtml(job.host || 'the PC that ran this request')}: ${escapeHtml(f.path || '')}</p>`}
    </details>
    ${askFileLinksHtml(f)}`).join('');
  const folderUrl = askWebUrl(job.outputFolderUrl);
  const emails = (job.emails || []).map((m, i) => `
    <button type="button" class="filter-btn ask-claude-outlook" data-ask-outlook="${jobId}" data-ask-email-index="${i}"
      title="Open this draft in Outlook on the web (To: ${escapeHtml([].concat(m.to || []).join('; ') || 'empty')})">✉ Open in Outlook: ${escapeHtml(m.subject || '(no subject)')}</button>`).join('');
  const body = status === 'done' ? `
      <pre class="diag-pre ask-claude-result">${escapeHtml(job.result || '(no summary)')}</pre>
      ${emails ? `<div class="ask-claude-emails">${emails}</div>` : ''}
      ${files}
      <div class="ask-claude-actions">
        ${folderUrl ? `<a class="link-btn" href="${askAttr(askBrowserUrl(folderUrl))}" target="_blank" rel="noopener" title="${ASK_UPLOAD_HINT}">Open output folder</a>` : ''}
        <button type="button" class="link-btn" data-ask-copy="${jobId}">Copy result</button>
        <button type="button" class="link-btn" data-ask-note="${jobId}">Add result to task notes</button>
      </div>`
    : status === 'failed' ? `<p class="hint-text">${escapeHtml(job.error || 'Claude could not finish this request.')}</p>` : '';
  return `
    <div class="ask-claude-job" data-job-id="${jobId}">
      <div class="ask-claude-job-head">
        <span class="ask-claude-chip ask-claude-${status}">${ASK_STAGE_LABEL[status]}</span>
        <span class="hint-text">${escapeHtml(when)}${target}</span>
      </div>
      <div class="ask-claude-prompt">${escapeHtml(job.prompt)}</div>
      ${body}
    </div>`;
}

async function sendAskClaude(e) {
  e.preventDefault();
  if (!askTarget) return;
  const task = getTaskById(askTarget.taskId);
  const prompt = askPromptEl.value.trim();
  if (!task || !prompt) return;
  const subtask = askTarget.subtaskId ? (task.subtasks || []).find((s) => s.id === askTarget.subtaskId) : null;
  const jobId = askJobId();
  const name = `${task.id}__${jobId}${subtask ? `__${subtask.id}` : ''}.json`;
  const job = {
    id: jobId, createdAt: new Date().toISOString(), device: syncDeviceName(),
    preset: askPreset, prompt, ...buildAskTaskContext(task, subtask, askContextEl.checked),
  };
  askSendBtn.disabled = true;
  askStatusEl.textContent = 'Sending…';
  try {
    await askWriteJob(name, job);
    saveAskPending([...loadAskPending(), { name, taskId: task.id, title: subtask ? subtask.title : task.title }]);
    askJobStates.set(name, 'inbox');
    decorateAskStates();
    askPromptEl.value = '';
    askStatusEl.textContent = 'Sent. The watcher on your PC picks it up within 2 minutes.';
    renderAskHistory();
  } catch (err) {
    askStatusEl.textContent = err.status === 401 || err.status === 403
      ? 'GitHub refused the token: reconnect cloud sync (⚙).'
      : `Not sent: ${err.message || err}`;
  } finally {
    askSendBtn.disabled = false;
  }
}

async function findAskJob(jobId) {
  if (!askTarget) return null;
  const done = await askListStage('done');
  const f = done.find((x) => {
    const p = parseAskName(x.name);
    return p.taskId === askTarget.taskId && p.jobId === jobId;
  });
  return f ? askReadFile(f.path) : null;
}

askHistoryEl.addEventListener('click', async (e) => {
  const outlookBtn = e.target.closest('[data-ask-outlook]');
  if (outlookBtn) {
    // Open the tab inside the click itself (browsers block a later window.open),
    // then point it at the draft once the job file is read.
    const win = window.open('', '_blank');
    const job = await findAskJob(outlookBtn.dataset.askOutlook);
    let email = job && (job.emails || [])[Number(outlookBtn.dataset.askEmailIndex)];
    // No address found by Claude: use the delegated sub-task's assignee email from Task Hub.
    if (email && ![].concat(email.to || []).length && job.subtask && job.subtask.assignee) {
      const assignee = getAssignee(job.subtask.assignee);
      if (assignee && assignee.email) email = { ...email, to: assignee.email };
    }
    if (win && email) {
      win.opener = null;
      win.location.href = askOutlookUrl(email);
    }
    else if (win) win.close();
    return;
  }
  const pathBtn = e.target.closest('[data-ask-copy-path]');
  if (pathBtn) {
    try {
      await navigator.clipboard.writeText(pathBtn.dataset.askCopyPath);
      pathBtn.textContent = 'Copied';
    } catch {
      pathBtn.textContent = 'Copy failed';
    }
    return;
  }
  const copyBtn = e.target.closest('[data-ask-copy]');
  const noteBtn = e.target.closest('[data-ask-note]');
  if (!copyBtn && !noteBtn) return;
  const job = await findAskJob((copyBtn || noteBtn).dataset.askCopy || (copyBtn || noteBtn).dataset.askNote);
  if (!job) return;
  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(job.result || '');
      copyBtn.textContent = 'Copied';
    } catch {
      copyBtn.textContent = 'Copy failed';
    }
    return;
  }
  const task = getTaskById(askTarget.taskId);
  if (!task) return;
  const stamp = new Date(job.finishedAt || Date.now()).toISOString().slice(0, 10);
  const line = `✦ Claude ${stamp}${job.subtask ? ` (${job.subtask.title})` : ''}: ${(job.result || '').trim()}`;
  task.notes = task.notes ? `${task.notes}\n\n${line}` : line;
  saveTasks();
  render();
  noteBtn.textContent = 'Added to notes';
  noteBtn.disabled = true;
});

askPresetsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-preset]');
  if (btn) setAskPreset(btn.dataset.preset);
});
askForm.addEventListener('submit', sendAskClaude);
document.getElementById('askClaudeModalClose').addEventListener('click', closeAskClaudeModal);
document.getElementById('askClaudeCancelBtn').addEventListener('click', closeAskClaudeModal);
askOverlay.addEventListener('click', (e) => { if (e.target === askOverlay) closeAskClaudeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !askOverlay.classList.contains('hidden')) closeAskClaudeModal();
});

// The ✦ buttons sit inside the card (and inside a sub-task's <label>), whose
// own click handlers would open the editor or tick the checkbox — catch the
// click first, in the capture phase.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.ask-claude-btn, .ask-claude-sub-btn, .ask-claude-state-chip');
  if (!btn) return;
  const item = btn.closest('li.task-item');
  if (!item) return;
  e.preventDefault();
  e.stopPropagation();
  openAskClaudeModal(item.dataset.id, btn.dataset.askSubtaskId || null);
}, true);

// ---------- Request state on cards and sub-task rows ----------
// Every minute the three job folders are listed. A sub-task's ✦ turns into
// its request's state (⏳ queued, pulsing ✦ running, ✓ done, ⚠ failed) and
// the card shows a chip with the most pressing state of all its requests.
// Done and failed show until the task's ✦ modal is opened once in this
// browser ("seen"), then the plain ✦ comes back.

const askJobStates = new Map();  // file name -> inbox | running | done | failed
const askDoneStatus = new Map(); // finished file name -> done | failed, read once

function loadAskSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(ASK_SEEN_KEY)) || []);
  } catch {
    return new Set();
  }
}

function saveAskSeen(seen) {
  localStorage.setItem(ASK_SEEN_KEY, JSON.stringify([...seen]));
}

function isAskFinished(state) {
  return state === 'done' || state === 'failed';
}

function markAskSeen(taskId) {
  const seen = loadAskSeen();
  let changed = false;
  for (const [name, state] of askJobStates) {
    if (isAskFinished(state) && parseAskName(name).taskId === taskId && !seen.has(name)) {
      seen.add(name);
      changed = true;
    }
  }
  if (changed) {
    saveAskSeen(seen);
    decorateAskStates();
  }
}

// The state each task and sub-task shows: live requests and unseen results.
function visibleAskStates() {
  const seen = loadAskSeen();
  const byTask = new Map();
  const bySubtask = new Map();
  const pick = (a, b) => (!a || ASK_STATE_RANK[b] > ASK_STATE_RANK[a] ? b : a);
  for (const [name, state] of askJobStates) {
    if (isAskFinished(state) && seen.has(name)) continue;
    const p = parseAskName(name);
    byTask.set(p.taskId, pick(byTask.get(p.taskId), state));
    if (p.subtaskId) bySubtask.set(p.subtaskId, pick(bySubtask.get(p.subtaskId), state));
  }
  return { byTask, bySubtask };
}

function decorateAskStates() {
  const { byTask, bySubtask } = visibleAskStates();
  document.querySelectorAll('.ask-claude-state-chip').forEach((el) => el.remove());
  document.querySelectorAll('.ask-claude-sub-btn').forEach((btn) => {
    const state = bySubtask.get(btn.dataset.askSubtaskId);
    btn.className = `subtask-email-btn ask-claude-sub-btn${state ? ` ask-state ask-state-${state}` : ''}`;
    btn.textContent = state ? ASK_STATE_ICON[state] : '✦';
    btn.title = state ? `Claude: ${ASK_STAGE_LABEL[state]} — click to see the request` : 'Ask Claude to work on this sub-task';
  });
  document.querySelectorAll('li.task-item').forEach((item) => {
    const state = byTask.get(item.dataset.id);
    const meta = item.querySelector('.card-title-meta');
    if (!state || !meta) return;
    const chip = document.createElement('span');
    chip.className = `ask-claude-state-chip ask-state-${state}`;
    chip.textContent = `${ASK_STATE_ICON[state]} ${ASK_STAGE_LABEL[state]}`;
    chip.title = `Claude: ${ASK_STAGE_LABEL[state]} — click to see the requests`;
    meta.prepend(chip);
  });
}

// app.js redraws the board with render(); redraw the states after it.
// Calls inside app.js resolve to this wrapped version (as in sync.js).
const askOriginalRender = window.render;
window.render = function (...args) {
  const result = askOriginalRender.apply(this, args);
  decorateAskStates();
  return result;
};

async function refreshAskStates() {
  if (!syncToken() || document.hidden) return;
  try {
    const next = new Map();
    for (const stage of ASK_STAGES) {
      for (const f of await askListStage(stage)) next.set(f.name, stage);
    }
    // Only the finished file says whether Claude succeeded: read each unseen one once.
    const seen = loadAskSeen();
    for (const [name, stage] of next) {
      if (stage !== 'done') continue;
      if (!askDoneStatus.has(name) && !seen.has(name)) {
        const job = await askReadFile(`jobs/done/${name}`);
        askDoneStatus.set(name, job && job.status === 'failed' ? 'failed' : 'done');
      }
      next.set(name, askDoneStatus.get(name) || 'done');
    }
    askJobStates.clear();
    next.forEach((state, name) => askJobStates.set(name, state));
    decorateAskStates();
    notifyAskFinished();
  } catch {
    // Offline or token refused: try again at the next poll.
  }
}

// ---------- Finished-job notice ----------
// Requests sent from this browser raise a notice when they finish; clicking
// it opens the task's results.

function notifyAskFinished() {
  const pending = loadAskPending();
  const finished = pending.filter((p) => isAskFinished(askJobStates.get(p.name)));
  if (!finished.length) return;
  saveAskPending(pending.filter((p) => !finished.includes(p)));
  const last = finished[finished.length - 1];
  showAskNotice(`✦ Claude finished: ${last.title}${finished.length > 1 ? ` (+${finished.length - 1} more)` : ''}`, last.taskId);
  if (askTarget) renderAskHistory();
}

function showAskNotice(text, taskId) {
  askNoticeEl.textContent = text;
  askNoticeEl.dataset.taskId = taskId;
  askNoticeEl.classList.remove('hidden');
}

askNoticeEl.addEventListener('click', () => {
  askNoticeEl.classList.add('hidden');
  if (getTaskById(askNoticeEl.dataset.taskId)) openAskClaudeModal(askNoticeEl.dataset.taskId, null);
});

setInterval(refreshAskStates, ASK_POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshAskStates(); });
refreshAskStates();
