// ---------- Ask Claude (✦ on cards and sub-task rows) ----------
// Sends a prompt about a task to Claude Code running on the user's PC. The
// browser only writes a job file to the PRIVATE to-do-data repo (same token
// as cloud sync); the PC watcher (C:\Claude\Task Hub Jobs\watcher.py) picks
// it up, runs Claude, and writes the result back. Job files move through:
//   jobs/inbox/<taskId>__<jobId>.json    queued
//   jobs/running/<taskId>__<jobId>.json  Claude is working
//   jobs/done/<taskId>__<jobId>.json     finished (status: done | failed)
// File names start with the task id so one directory listing shows every
// request for a task, from any device. Claude only drafts: it never sends
// anything and never changes a task.

const ASK_JOBS_API = `https://api.github.com/repos/${SYNC_REPO}/contents/jobs`;
const ASK_PENDING_KEY = 'todo.askClaude.pending.v1';
const ASK_POLL_MS = 60000;
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
  return { id: s.id, title: s.title, date: s.date || null, minutes: s.minutes || 0,
    delegated: !!s.delegated, assignee: s.assignee || null, ai: !!s.ai };
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
        if (f.name.startsWith(`${taskId}__`)) rows.push({ stage, path: f.path, jobId: f.name.slice(taskId.length + 2, -5) });
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
      ${f.content != null ? `<pre class="diag-pre">${escapeHtml(f.content)}</pre>` : `<p class="hint-text">On your PC: ${escapeHtml(f.path || '')}</p>`}
    </details>`).join('');
  const body = status === 'done' ? `
      <pre class="diag-pre ask-claude-result">${escapeHtml(job.result || '(no summary)')}</pre>
      ${files}
      <div class="ask-claude-actions">
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
  const name = `${task.id}__${jobId}.json`;
  const job = {
    id: jobId, createdAt: new Date().toISOString(), device: syncDeviceName(),
    preset: askPreset, prompt, ...buildAskTaskContext(task, subtask, askContextEl.checked),
  };
  askSendBtn.disabled = true;
  askStatusEl.textContent = 'Sending…';
  try {
    await askWriteJob(name, job);
    saveAskPending([...loadAskPending(), { name, taskId: task.id, title: subtask ? subtask.title : task.title }]);
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
  const f = done.find((x) => x.name === `${askTarget.taskId}__${jobId}.json`);
  return f ? askReadFile(f.path) : null;
}

askHistoryEl.addEventListener('click', async (e) => {
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
  const btn = e.target.closest('.ask-claude-btn, .ask-claude-sub-btn');
  if (!btn) return;
  const item = btn.closest('li.task-item');
  if (!item) return;
  e.preventDefault();
  e.stopPropagation();
  openAskClaudeModal(item.dataset.id, btn.dataset.askSubtaskId || null);
}, true);

// ---------- Finished-job notice ----------
// Requests sent from this browser are checked every minute; when one is done
// a notice appears, and clicking it opens the task's results.

function showAskNotice(text, taskId) {
  askNoticeEl.textContent = text;
  askNoticeEl.dataset.taskId = taskId;
  askNoticeEl.classList.remove('hidden');
}

askNoticeEl.addEventListener('click', () => {
  askNoticeEl.classList.add('hidden');
  if (getTaskById(askNoticeEl.dataset.taskId)) openAskClaudeModal(askNoticeEl.dataset.taskId, null);
});

async function pollAskPending() {
  const pending = loadAskPending();
  if (!pending.length || !syncToken() || document.hidden) return;
  try {
    const done = new Set((await askListStage('done')).map((f) => f.name));
    const finished = pending.filter((p) => done.has(p.name));
    if (!finished.length) return;
    saveAskPending(pending.filter((p) => !done.has(p.name)));
    const last = finished[finished.length - 1];
    showAskNotice(`✦ Claude finished: ${last.title}${finished.length > 1 ? ` (+${finished.length - 1} more)` : ''}`, last.taskId);
    if (askTarget) renderAskHistory();
  } catch {
    // Offline or token refused: try again at the next poll.
  }
}

setInterval(pollAskPending, ASK_POLL_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollAskPending(); });
pollAskPending();
