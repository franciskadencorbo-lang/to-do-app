// ---------- Cloud sync (private GitHub repo) ----------
// Keeps this browser's tasks in step with a JSON file in a PRIVATE repo, so
// every device opens the latest list. The app still works from localStorage;
// this file only pulls on open / focus and pushes after each save.
// Needs a fine-grained token limited to the data repo with Contents: Read and
// write — kept in this browser's localStorage, never in the repo. The same
// token is used by "Send to GitHub" (see GITHUB_TOKEN_KEY in app.js).

const SYNC_REPO = 'franciskadencorbo-lang/to-do-data';
const SYNC_API = `https://api.github.com/repos/${SYNC_REPO}/contents/taskhub-data.json`;
const SYNC_STATE_KEY = 'todo.cloudSync.v1';
const SYNC_DEVICE_KEY = 'todo.cloudSync.device.v1';
const SYNC_PUSH_DELAY_MS = 2000;
const SYNC_PULL_MIN_GAP_MS = 30000;
const SYNC_POLL_MS = 120000;

const syncStatusEl = document.getElementById('cloudSyncStatus');
const syncBtn = document.getElementById('cloudSyncBtn');

let syncState = loadSyncState();
let syncPushTimer = null;
let syncBusy = false;
let syncLastPullAt = 0;

function loadSyncState() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_STATE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveSyncState() {
  localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(syncState));
}

function syncDeviceName() {
  let name = localStorage.getItem(SYNC_DEVICE_KEY);
  if (!name) {
    name = /Mobi|Android|iPhone|iPad/.test(navigator.userAgent) ? 'Phone' : 'Computer';
    localStorage.setItem(SYNC_DEVICE_KEY, name);
  }
  return name;
}

function syncToken() {
  return localStorage.getItem(GITHUB_TOKEN_KEY);
}

function syncHeaders() {
  return {
    Authorization: `Bearer ${syncToken()}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function setSyncUi(text, title) {
  if (!syncStatusEl) return;
  syncStatusEl.textContent = text;
  syncStatusEl.title = title || '';
}

function syncTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// The synced lists, in a stable shape so two identical lists compare equal.
function buildSyncPayload() {
  return {
    tasks: JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'),
    projects: JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]'),
    labels: JSON.parse(localStorage.getItem(LABELS_KEY) || '[]'),
    assignees: JSON.parse(localStorage.getItem(ASSIGNEES_KEY) || '[]'),
  };
}

function payloadText(payload) {
  return JSON.stringify(payload);
}

// atob() returns Latin-1; decode the bytes as UTF-8 (the twin of toBase64Utf8).
function fromBase64Utf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function localChangedSinceSync() {
  return payloadText(buildSyncPayload()) !== syncState.lastSyncedText;
}

// Replaces this browser's lists with the cloud copy and redraws, the same way
// the Import button does. The replaced lists are kept under a backup key.
function applyRemotePayload(payload) {
  localStorage.setItem(`todo.backup.cloudSync.${new Date().toISOString().slice(0, 10)}`,
    payloadText(buildSyncPayload()));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload.tasks || []));
  if (Array.isArray(payload.projects)) localStorage.setItem(PROJECTS_KEY, JSON.stringify(payload.projects));
  if (Array.isArray(payload.labels)) localStorage.setItem(LABELS_KEY, JSON.stringify(payload.labels));
  if (Array.isArray(payload.assignees)) localStorage.setItem(ASSIGNEES_KEY, JSON.stringify(payload.assignees));
  reloadFromStorage();
}

// Re-reads the lists from localStorage into memory and redraws.
function reloadFromStorage() {
  tasks = loadTasks();
  projects = loadProjects();
  labels = loadLabels();
  assignees = loadAssignees();
  renderProjectOptions();
  renderLabelOptions();
  renderAssigneeOptions();
  render();
}

async function fetchRemote() {
  const res = await fetch(`${SYNC_API}?ref=main`, { headers: syncHeaders(), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`GitHub returned ${res.status}`), { status: res.status });
  const file = await res.json();
  const doc = JSON.parse(fromBase64Utf8(file.content));
  return { sha: file.sha, doc };
}

async function pushLocal(sha) {
  const payload = buildSyncPayload();
  const doc = { ...payload, updatedAt: new Date().toISOString(), device: syncDeviceName() };
  const res = await fetch(SYNC_API, {
    method: 'PUT',
    headers: { ...syncHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Task Hub sync - ${doc.device} - ${snapshotTimestamp()}`,
      content: toBase64Utf8(JSON.stringify(doc, null, 1)),
      branch: 'main',
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.status === 409 || res.status === 422) return { conflict: true };
  if (!res.ok) throw Object.assign(new Error(`GitHub returned ${res.status}`), { status: res.status });
  const out = await res.json();
  syncState = { sha: out.content.sha, lastSyncedText: payloadText(payload), syncedAt: doc.updatedAt };
  saveSyncState();
  return { conflict: false };
}

// Both sides changed since the last sync: the user picks which list wins.
function resolveConflict(remote) {
  const when = remote.doc.updatedAt ? new Date(remote.doc.updatedAt).toLocaleString() : 'unknown time';
  const useRemote = confirm(
    `Your tasks were changed on another device (${remote.doc.device || 'unknown'}, ${when}) ` +
    'and also in this browser since the last sync.\n\n' +
    'OK = use the other device\'s list (this browser\'s list is kept as a backup).\n' +
    'Cancel = keep this browser\'s list and overwrite the cloud copy.'
  );
  return useRemote ? 'remote' : 'local';
}

async function syncNow({ force = false } = {}) {
  if (!syncToken()) { setSyncUi('☁ Cloud sync off', 'Settings ⚙ → Connect cloud sync'); return; }
  if (syncBusy) return;
  if (!force && Date.now() - syncLastPullAt < SYNC_PULL_MIN_GAP_MS && !localChangedSinceSync()) return;
  syncBusy = true;
  setSyncUi('☁ Syncing…');
  try {
    syncLastPullAt = Date.now();
    const remote = await fetchRemote();
    const localChanged = localChangedSinceSync();

    const localEmpty = (buildSyncPayload().tasks || []).length === 0;

    if (!remote) {
      // First device: the cloud copy starts from this browser — never from an empty list.
      if (localEmpty) { setSyncUi('☁ Cloud copy empty', 'Connect cloud sync from the device that has your tasks first'); return; }
      await pushLocal(undefined);
    } else if (remote.sha === syncState.sha) {
      if (localChanged) await pushLocal(remote.sha);
    } else {
      const remoteText = payloadText({
        tasks: remote.doc.tasks || [], projects: remote.doc.projects || [],
        labels: remote.doc.labels || [], assignees: remote.doc.assignees || [],
      });
      const sameContent = remoteText === payloadText(buildSyncPayload());
      // A browser connecting for the first time counts as changed, so a non-empty
      // list is never replaced without asking.
      const winner = sameContent || !localChanged || localEmpty ? 'remote' : resolveConflict(remote);
      if (winner === 'remote') {
        if (!sameContent) applyRemotePayload(remote.doc);
        syncState = { sha: remote.sha, lastSyncedText: payloadText(buildSyncPayload()), syncedAt: remote.doc.updatedAt };
        saveSyncState();
      } else {
        const out = await pushLocal(remote.sha);
        if (out.conflict) { syncBusy = false; return await syncNow({ force: true }); }
      }
    }
    setSyncUi(`☁ Synced ${syncTime(syncState.syncedAt)}`, `Cloud copy: ${SYNC_REPO}`);
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      setSyncUi('☁ Sync: token refused', 'Settings ⚙ → Connect cloud sync to paste a new token');
    } else {
      setSyncUi('☁ Sync failed — working offline', err && err.message ? err.message : String(err));
    }
  } finally {
    syncBusy = false;
  }
}

function scheduleSyncPush() {
  if (!syncToken()) return;
  clearTimeout(syncPushTimer);
  setSyncUi('☁ Unsynced changes');
  syncPushTimer = setTimeout(() => syncNow({ force: true }), SYNC_PUSH_DELAY_MS);
}

// Every save in app.js goes through these functions; wrap them so each save
// also queues a push. Calls inside app.js resolve to the wrapped versions.
for (const name of ['saveTasks', 'saveProjects', 'saveLabels', 'saveAssignees']) {
  const original = window[name];
  window[name] = function (...args) {
    const result = original.apply(this, args);
    scheduleSyncPush();
    return result;
  };
}

syncBtn.addEventListener('click', () => {
  closeSettingsPopover();
  if (syncToken() && !confirm('Cloud sync is connected. Paste a new token?')) { syncNow({ force: true }); return; }
  const token = (prompt(
    `Paste your GitHub token for cloud sync.\n\nUse a fine-grained token limited to the ${SYNC_REPO} ` +
    'repository with Contents: Read and write. It is saved in this browser only.'
  ) || '').trim();
  if (!token) return;
  localStorage.setItem(GITHUB_TOKEN_KEY, token);
  syncNow({ force: true });
});

// Another tab of this browser saved (or synced) the lists: show them here too,
// so a later save in this tab does not write back the older copy.
window.addEventListener('storage', (e) => {
  if (e.key === SYNC_STATE_KEY) syncState = loadSyncState();
  if ([STORAGE_KEY, PROJECTS_KEY, LABELS_KEY, ASSIGNEES_KEY].includes(e.key)) reloadFromStorage();
});

document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow(); });
window.addEventListener('focus', () => syncNow());
setInterval(() => { if (!document.hidden) syncNow(); }, SYNC_POLL_MS);
syncNow({ force: true });
