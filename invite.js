// ---------- Create invite (📅 on cards and sub-task rows) ----------
// Prepares a meeting for a task or sub-task and opens it in Outlook on the web,
// where the user checks it and presses Send. Nothing is sent from here, and
// Task Hub cannot tell whether it was sent, so the task only says "opened".
//
// People come from three places: the directory file a Power Automate flow writes
// to OneDrive\Chief of Staff\Task Hub Meetings\contacts-gy.json, Manage Assignees,
// and addresses typed in. The directory stays in this page's memory and is read
// again each time: never localStorage, never the synced task data, never GitHub.
// A task keeps only the time and attendee names (task.meeting), no addresses.
//
// Loaded after app.js and uses its functions and data (tasks, saveTasks, render,
// getTaskById, assignees, escapeHtml, fsGet, fsPut, fsSupported, toDateKey…).

const INVITE_TIME_ZONE = 'Asia/Bangkok';
const INVITE_DIRECTORY_FILE = 'contacts-gy.json';
const INVITE_NICKNAMES_FILE = 'nicknames.json';
const INVITE_FOLDER_KEY = 'invite-folder';
const INVITE_STALE_DAYS = 14;

const inviteOverlay = document.getElementById('inviteModalOverlay');
const inviteForm = document.getElementById('inviteForm');
const inviteTargetEl = document.getElementById('inviteTarget');
const inviteSubjectEl = document.getElementById('inviteSubject');
const inviteDateEl = document.getElementById('inviteDate');
const inviteTimeEl = document.getElementById('inviteTime');
const inviteDurationEl = document.getElementById('inviteDuration');
const inviteTeamsEl = document.getElementById('inviteTeams');
const inviteSearchEl = document.getElementById('inviteSearch');
const inviteResultsEl = document.getElementById('inviteResults');
const inviteChosenEl = document.getElementById('inviteChosen');
const inviteSuggestedEl = document.getElementById('inviteSuggested');
const inviteDirectoryEl = document.getElementById('inviteDirectoryStatus');
const inviteStatusEl = document.getElementById('inviteStatus');

let inviteTarget = null;     // { taskId, subtaskId }
let inviteAttendees = [];    // { name, email, kind: staff | external }
let invitePeople = [];       // the directory, in memory only
let inviteNicknames = {};
let inviteFolder = null;
let inviteDirectoryDate = null;
let inviteRestoreRun = 0;

function inviteNextWorkingDay() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return toDateKey(d);
}

// ---------- People ----------

function invitePersonFromAddress(email, fallbackName) {
  const found = invitePeople.find((p) => p.email.toLowerCase() === email.toLowerCase());
  return found
    ? { name: found.name, email: found.email, kind: found.kind }
    : { name: fallbackName || '', email, kind: 'external' };
}

function inviteAssigneePeople() {
  return assignees.flatMap((a) => String(a.email || '').split(/[;,]\s*/).filter(InviteCore.isEmail).map((email) => ({
    ...invitePersonFromAddress(email, a.name), fromAssignee: a.name,
  })));
}

function inviteSearchPool() {
  const inDirectory = new Set(invitePeople.map((p) => p.email.toLowerCase()));
  const others = inviteAssigneePeople().filter((p) => !inDirectory.has(p.email.toLowerCase()))
    .map((p) => ({ nickname: p.fromAssignee, title: '', department: '', company: '', city: '', country: '', ...p }));
  return invitePeople.concat(others);
}

function inviteAddAttendee(person) {
  if (inviteAttendees.some((a) => a.email.toLowerCase() === person.email.toLowerCase())) return;
  inviteAttendees.push({ name: person.name, email: person.email, kind: person.kind });
  renderInvitePeople();
}

function inviteKindLabel(kind) {
  return kind === 'staff' ? 'GreenYellow' : 'External';
}

function renderInvitePeople() {
  inviteChosenEl.innerHTML = inviteAttendees.length
    ? inviteAttendees.map((a, i) => `
      <span class="invite-chip invite-chip-${a.kind}" title="${escapeHtml(a.email)}">
        ${escapeHtml(a.name || a.email)} <small>${inviteKindLabel(a.kind)}</small>
        <button type="button" data-invite-remove="${i}" aria-label="Remove ${escapeHtml(a.name || a.email)}">✕</button>
      </span>`).join('')
    : '<span class="hint-text">Nobody yet.</span>';
  const suggested = inviteSuggestions().filter((s) => !inviteAttendees.some((a) => a.email.toLowerCase() === s.email.toLowerCase()));
  inviteSuggestedEl.innerHTML = suggested.length
    ? `<span class="hint-text">Suggested:</span> ${suggested.map((s) => `<button type="button" class="filter-btn" data-invite-suggest="${escapeHtml(s.email)}" title="${escapeHtml(s.email)}">+ ${escapeHtml(s.name || s.email)}</button>`).join(' ')}`
    : '';
}

// Offered, never added: the user confirms each person.
function inviteSuggestions() {
  const task = inviteTarget && getTaskById(inviteTarget.taskId);
  if (!task) return [];
  const subs = inviteTarget.subtaskId
    ? (task.subtasks || []).filter((s) => s.id === inviteTarget.subtaskId)
    : (task.subtasks || []).filter((s) => !s.completed);
  const seen = new Set();
  return subs.flatMap((s) => {
    const assignee = s.assignee && getAssignee(s.assignee);
    if (!assignee || assignee.kind === 'ai') return [];
    return String(assignee.email || '').split(/[;,]\s*/).filter(InviteCore.isEmail)
      .map((email) => invitePersonFromAddress(email, assignee.name));
  }).filter((p) => {
    const key = p.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderInviteResults() {
  const query = inviteSearchEl.value.trim();
  if (!query) { inviteResultsEl.innerHTML = ''; return; }
  const found = InviteCore.searchPeople(query, inviteSearchPool(), inviteNicknames);
  const typed = InviteCore.isEmail(query) && !found.some((p) => p.email.toLowerCase() === query.toLowerCase());
  const rows = found.map((p) => {
    const detail = [p.title, p.department, p.city || p.country].filter(Boolean).join(' · ');
    return `<button type="button" class="invite-result" data-invite-add="${escapeHtml(p.email)}">
      <span><strong>${escapeHtml(p.name)}</strong> <small class="invite-kind-${p.kind}">${inviteKindLabel(p.kind)}</small></span>
      <span class="hint-text">${escapeHtml(p.email)}${detail ? ` · ${escapeHtml(detail)}` : ''}</span>
    </button>`;
  });
  if (typed) {
    rows.push(`<button type="button" class="invite-result" data-invite-add="${escapeHtml(query)}">
      <span><strong>Add ${escapeHtml(query)}</strong> <small class="invite-kind-external">External</small></span>
    </button>`);
  }
  inviteResultsEl.innerHTML = rows.join('') || '<p class="hint-text">Nobody found. You can type a full email address.</p>';
}

function inviteAddFromResult(email) {
  const person = inviteSearchPool().find((p) => p.email.toLowerCase() === email.toLowerCase())
    || { name: '', email, kind: 'external' };
  inviteAddAttendee(person);
  inviteSearchEl.value = '';
  inviteResultsEl.innerHTML = '';
  inviteSearchEl.focus();
}

// ---------- The directory file ----------

function setInviteDirectoryStatus(html) { inviteDirectoryEl.innerHTML = html; }

const INVITE_CONNECT_BTN = '<button type="button" class="filter-btn" id="inviteConnectBtn">Connect folder</button>';

async function inviteReadJson(folder, name) {
  const handle = await folder.getFileHandle(name);
  const text = await (await handle.getFile()).text();
  return JSON.parse(text.replace(/^﻿/, ''));
}

async function inviteLoadDirectory() {
  try {
    const handle = await inviteFolder.getFileHandle(INVITE_DIRECTORY_FILE);
    const file = await handle.getFile();
    invitePeople = InviteCore.normalizeDirectory(JSON.parse((await file.text()).replace(/^﻿/, '')));
    inviteDirectoryDate = new Date(file.lastModified);
  } catch (err) {
    invitePeople = [];
    const missing = err && err.name === 'NotFoundError';
    setInviteDirectoryStatus(`<span class="invite-warning">${missing
      ? `${INVITE_DIRECTORY_FILE} is not in this folder yet. Run the Contacts Directory flow, or pick the Task Hub Meetings folder.`
      : `The directory file could not be read: ${escapeHtml(err.message)}`}</span> ${INVITE_CONNECT_BTN}`);
    return;
  }
  // The nickname list is optional, so a missing file is normal.
  try { inviteNicknames = await inviteReadJson(inviteFolder, INVITE_NICKNAMES_FILE); } catch { inviteNicknames = {}; }
  const days = Math.floor((Date.now() - inviteDirectoryDate.getTime()) / 86400000);
  const when = inviteDirectoryDate.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  setInviteDirectoryStatus(days > INVITE_STALE_DAYS
    ? `<span class="invite-warning">Directory is ${days} days old (${when}): check the Contacts Directory flow.</span>`
    : `<span class="hint-text">Directory: ${invitePeople.length} people, updated ${when}.</span>`);
  renderInvitePeople();
  renderInviteResults();
}

// On opening: only uses a permission already given. Browsers need a click to ask again.
async function inviteRestoreFolder() {
  if (!fsSupported) {
    setInviteDirectoryStatus('<span class="invite-warning">This browser cannot read OneDrive folders. Use Edge or Chrome on the Work PC, or type addresses.</span>');
    return;
  }
  // Opening the window again while this is still waiting must not be undone by
  // this older run finishing late.
  const run = ++inviteRestoreRun;
  const saved = inviteFolder || await fsGet(INVITE_FOLDER_KEY);
  if (run !== inviteRestoreRun) return;
  inviteFolder = inviteFolder || saved;
  const granted = !!inviteFolder && await inviteFolder.queryPermission({ mode: 'read' }) === 'granted';
  if (run !== inviteRestoreRun) return;
  if (granted) {
    await inviteLoadDirectory();
    return;
  }
  setInviteDirectoryStatus(`<span class="hint-text">Connect OneDrive\\Chief of Staff\\Task Hub Meetings to search the directory. Assignees and typed addresses work without it.</span> ${INVITE_CONNECT_BTN}`);
}

async function inviteConnectFolder() {
  try {
    if (inviteFolder && await inviteFolder.requestPermission({ mode: 'read' }) === 'granted') {
      await inviteLoadDirectory();
      if (invitePeople.length) return;
    }
    inviteFolder = await window.showDirectoryPicker({ id: 'invite-folder', mode: 'read' });
    await fsPut(INVITE_FOLDER_KEY, inviteFolder);
    await inviteLoadDirectory();
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    setInviteDirectoryStatus(`<span class="invite-warning">The folder could not be opened: ${escapeHtml(err.message)}</span> ${INVITE_CONNECT_BTN}`);
  }
}

// ---------- The window ----------

function openInviteModal(taskId, subtaskId) {
  const task = getTaskById(taskId);
  if (!task) return;
  const subtask = subtaskId ? (task.subtasks || []).find((s) => s.id === subtaskId) : null;
  inviteTarget = { taskId, subtaskId: subtask ? subtask.id : null };
  inviteAttendees = [];
  inviteTargetEl.innerHTML = `<div class="ask-claude-task">${escapeHtml(task.title)}${subtask ? ` <span class="ask-claude-arrow">›</span> ${escapeHtml(subtask.title)}` : ''}</div>`;
  inviteSubjectEl.value = subtask ? subtask.title : task.title;
  inviteDateEl.value = inviteNextWorkingDay();
  inviteDateEl.min = toDateKey(new Date());
  inviteTimeEl.value = '10:00';
  inviteDurationEl.value = '30';
  inviteTeamsEl.checked = true;
  inviteSearchEl.value = '';
  inviteResultsEl.innerHTML = '';
  inviteStatusEl.textContent = '';
  renderInvitePeople();
  inviteOverlay.classList.remove('hidden');
  inviteSearchEl.focus();
  inviteRestoreFolder();
}

function closeInviteModal() {
  inviteOverlay.classList.add('hidden');
  inviteTarget = null;
  inviteAttendees = [];
}

function submitInvite(e) {
  e.preventDefault();
  if (!inviteTarget) return;
  const task = getTaskById(inviteTarget.taskId);
  const subtask = inviteTarget.subtaskId && task ? (task.subtasks || []).find((s) => s.id === inviteTarget.subtaskId) : null;
  if (!task) return;
  if (!inviteAttendees.length) {
    inviteStatusEl.textContent = 'Add at least one person first.';
    inviteSearchEl.focus();
    return;
  }
  const minutes = Number(inviteDurationEl.value);
  const times = InviteCore.meetingTimes(inviteDateEl.value, inviteTimeEl.value, minutes, INVITE_TIME_ZONE);
  const url = InviteCore.outlookInviteUrl({
    subject: inviteSubjectEl.value.trim(),
    start: times.start,
    end: times.end,
    emails: inviteAttendees.map((a) => a.email),
    teams: inviteTeamsEl.checked,
  });
  // Opened inside the click, because browsers block a later window.open.
  window.open(url, '_blank', 'noopener');
  (subtask || task).meeting = {
    start: times.start,
    end: times.end,
    openedAt: new Date().toISOString(),
    // Names only. An address with no name is not stored in any form.
    attendeeNames: inviteAttendees.map((a) => a.name || 'External attendee'),
  };
  saveTasks();
  render();
  closeInviteModal();
}

inviteForm.addEventListener('submit', submitInvite);
// Enter in the search box must not submit the form; it adds a typed address.
inviteSearchEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const typed = inviteSearchEl.value.trim();
  if (InviteCore.isEmail(typed)) inviteAddFromResult(typed);
});
inviteSearchEl.addEventListener('input', renderInviteResults);
inviteOverlay.addEventListener('click', (e) => {
  if (e.target === inviteOverlay) { closeInviteModal(); return; }
  const add = e.target.closest('[data-invite-add]');
  if (add) { inviteAddFromResult(add.dataset.inviteAdd); return; }
  const suggest = e.target.closest('[data-invite-suggest]');
  if (suggest) { inviteAddFromResult(suggest.dataset.inviteSuggest); return; }
  const remove = e.target.closest('[data-invite-remove]');
  if (remove) { inviteAttendees.splice(Number(remove.dataset.inviteRemove), 1); renderInvitePeople(); return; }
  if (e.target.closest('#inviteConnectBtn')) inviteConnectFolder();
});
document.getElementById('inviteModalClose').addEventListener('click', closeInviteModal);
document.getElementById('inviteCancelBtn').addEventListener('click', closeInviteModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !inviteOverlay.classList.contains('hidden')) closeInviteModal();
});

// The 📅 buttons sit inside the card (and inside a sub-task's <label>), whose
// own click handlers would open the editor or tick the checkbox — catch the
// click first, in the capture phase.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.invite-btn, .invite-sub-btn, .invite-badge');
  if (!btn) return;
  const item = btn.closest('li.task-item');
  if (!item) return;
  e.preventDefault();
  e.stopPropagation();
  openInviteModal(item.dataset.id, btn.dataset.inviteSubtaskId || null);
}, true);
