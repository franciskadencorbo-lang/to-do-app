// ---------- Update Daily Brief (after Send to GitHub) ----------
// Once the task snapshot has reached GitHub, asks whether the Daily Brief should follow:
//   N/A      nothing else happens
//   Refresh  the PC updates load, meetings and the task list; the plan itself is kept
//   Replan   the PC runs the Chief of Staff planning again
// The browser only writes brief_request.json to the PRIVATE to-do-data repo. The PC watcher
// (C:\Claude\Task Hub Jobs\watcher.py) runs it and records the outcome in the same file.
// One file means one request at a time. The request holds a fixed kind and no free text.

const BRIEF_REQUEST_API = `https://api.github.com/repos/${SYNC_REPO}/contents/brief_request.json`;
const BRIEF_ACTIVE_KEY = 'todo.briefUpdate.active.v1';
const BRIEF_POLL_MS = window.BRIEF_POLL_MS || 15000;
const BRIEF_PENDING_MAX_MS = 30 * 60000;
const BRIEF_LABEL = { refresh: 'Refresh', replan: 'Replan' };

const briefOverlay = document.getElementById('briefUpdateOverlay');
const briefSummary = document.getElementById('briefUpdateSummary');
const briefPill = document.getElementById('briefUpdatePill');
const briefPillText = document.getElementById('briefUpdatePillText');
let briefPollTimer = null;

function closeBriefDialog() {
  briefOverlay.classList.add('hidden');
}

function openBriefUpdateDialog(sentCount) {
  briefSummary.textContent = `${sentCount} active tasks sent to GitHub.`;
  briefOverlay.classList.remove('hidden');
  document.getElementById('briefUpdateNA').focus();
}

function showBriefPill(text) {
  briefPillText.textContent = text;
  briefPill.hidden = false;
}

async function briefReadRequest() {
  const res = await fetch(`${BRIEF_REQUEST_API}?ref=main`, { headers: syncHeaders(), cache: 'no-store' });
  if (res.status === 404) return { sha: undefined, doc: null };
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const file = await res.json();
  return { sha: file.sha, doc: JSON.parse(fromBase64Utf8(file.content)) };
}

function briefIsPending(doc) {
  return !!doc && (doc.status === 'queued' || doc.status === 'running')
    && Date.now() - new Date(doc.requestedAt).getTime() < BRIEF_PENDING_MAX_MS;
}

function briefStopPolling() {
  clearTimeout(briefPollTimer);
  briefPollTimer = null;
  localStorage.removeItem(BRIEF_ACTIVE_KEY);
}

function briefShowState(doc) {
  const label = BRIEF_LABEL[doc.kind] || 'Update';
  if (doc.status === 'done') showBriefPill(`Daily Brief updated. ${doc.message || ''}`.trim());
  else if (doc.status === 'failed') showBriefPill(`Daily Brief ${label} failed. ${doc.message || ''}`.trim());
  else if (doc.status === 'running') showBriefPill(`Daily Brief: ${label} running on your PC…`);
  else showBriefPill(`Daily Brief: ${label} queued…`);
}

async function briefPoll(id) {
  let doc = null;
  try {
    ({ doc } = await briefReadRequest());
  } catch {
    briefPollTimer = setTimeout(() => briefPoll(id), BRIEF_POLL_MS); // a network blip: keep waiting
    return;
  }
  if (!doc || doc.id !== id) { briefStopPolling(); return; }
  briefShowState(doc);
  if (briefIsPending(doc)) {
    briefPollTimer = setTimeout(() => briefPoll(id), BRIEF_POLL_MS);
    return;
  }
  if (doc.status === 'queued' || doc.status === 'running') showBriefPill('Daily Brief: no answer from your PC. Is it on?');
  briefStopPolling();
}

function briefWatch(id) {
  localStorage.setItem(BRIEF_ACTIVE_KEY, id);
  clearTimeout(briefPollTimer);
  briefPollTimer = setTimeout(() => briefPoll(id), BRIEF_POLL_MS);
}

async function requestBriefUpdate(kind) {
  closeBriefDialog();
  showBriefPill(`Daily Brief: asking for ${BRIEF_LABEL[kind]}…`);
  try {
    const { sha, doc } = await briefReadRequest();
    if (briefIsPending(doc)) { // never start a second run on top of the first
      briefShowState(doc);
      briefWatch(doc.id);
      return;
    }
    const request = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      kind, status: 'queued', requestedAt: new Date().toISOString(),
    };
    const res = await fetch(BRIEF_REQUEST_API, {
      method: 'PUT',
      headers: { ...syncHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Daily Brief ${kind} requested`,
        content: toBase64Utf8(JSON.stringify(request, null, 1)),
        branch: 'main',
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.status === 409 || res.status === 422) { showBriefPill('Daily Brief: another request has just started. Try again in a moment.'); return; }
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    briefShowState(request);
    briefWatch(request.id);
  } catch (err) {
    showBriefPill(`Daily Brief request failed: ${err.message}`);
  }
}

document.getElementById('briefUpdateNA').addEventListener('click', closeBriefDialog);
document.getElementById('briefUpdateClose').addEventListener('click', closeBriefDialog);
document.getElementById('briefUpdateRefresh').addEventListener('click', () => requestBriefUpdate('refresh'));
document.getElementById('briefUpdateReplan').addEventListener('click', () => requestBriefUpdate('replan'));
document.getElementById('briefUpdatePillClose').addEventListener('click', () => { briefPill.hidden = true; });
briefOverlay.addEventListener('click', (e) => { if (e.target === briefOverlay) closeBriefDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !briefOverlay.classList.contains('hidden')) closeBriefDialog(); });

// A request made before this page was reloaded is still followed.
if (localStorage.getItem(BRIEF_ACTIVE_KEY)) briefPoll(localStorage.getItem(BRIEF_ACTIVE_KEY));
