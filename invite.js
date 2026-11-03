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
// Find a time: writes the request to Task Hub Meetings\Requests, the "Free Busy"
// flow reads the calendars with the user's own sign-in and writes the reply to
// Responses, and this page ranks the slots with slots.js. The reply holds the
// user's own meeting subjects, so it is deleted as soon as it has been read.
//
// Loaded after app.js and uses its functions and data (tasks, saveTasks, render,
// getTaskById, assignees, escapeHtml, fsGet, fsPut, fsSupported, toDateKey…).

const INVITE_TIME_ZONE = 'Asia/Bangkok';
const INVITE_DIRECTORY_FILE = 'contacts-gy.json';
const INVITE_NICKNAMES_FILE = 'nicknames.json';
const INVITE_FOLDER_KEY = 'invite-folder';
const INVITE_STALE_DAYS = 14;
const INVITE_MY_EMAIL_KEY = 'todo.invite.myEmail.v1'; // this browser only, not in the sync payload
const INVITE_REQUESTS_DIR = 'Requests';
const INVITE_RESPONSES_DIR = 'Responses';
const INVITE_POLL_MS = 10000;
const INVITE_TIMEOUT_MS = 5 * 60000;
const INVITE_MAX_LOOKUPS = 20;
const INVITE_NOTICE_HOURS = 12;
const INVITE_WORKING_DAYS = 10;
const INVITE_BUFFER_MIN = 15;
const INVITE_LUNCH = { start: '12:00', end: '13:00' };

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
const inviteFindBtn = document.getElementById('inviteFindBtn');
const inviteFromEl = document.getElementById('inviteFrom');
const inviteToEl = document.getElementById('inviteTo');
const inviteTentativeEl = document.getElementById('inviteTentative');
const inviteMyEmailEl = document.getElementById('inviteMyEmail');
const inviteMyEmailRow = document.getElementById('inviteMyEmailRow');
const inviteFindStatusEl = document.getElementById('inviteFindStatus');
const inviteSlotsEl = document.getElementById('inviteSlots');
const inviteCoverageEl = document.getElementById('inviteCoverage');

let inviteTarget = null;     // { taskId, subtaskId }
let inviteAttendees = [];    // { name, email, kind: staff | external }
let invitePeople = [];       // the directory, in memory only
let inviteNicknames = {};
let inviteFolder = null;
let inviteDirectoryDate = null;
let inviteRestoreRun = 0;
let inviteFindRun = 0;       // a newer search or a closed window makes older results stale

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
  inviteClearFind();
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

// ---------- Find a time ----------

function inviteClearFind() {
  inviteFindRun++;
  inviteFindStatusEl.textContent = '';
  inviteSlotsEl.innerHTML = '';
  inviteCoverageEl.innerHTML = '';
  inviteFindBtn.disabled = false;
}

function inviteNameOf(email) {
  if (email.toLowerCase() === inviteMyEmail().toLowerCase()) return 'You';
  const known = inviteAttendees.find((a) => a.email.toLowerCase() === email.toLowerCase());
  return (known && known.name) || email;
}

function inviteClock(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function inviteMyEmail() {
  try { return localStorage.getItem(INVITE_MY_EMAIL_KEY) || ''; } catch { return ''; }
}

function inviteShowMyEmail() {
  const saved = inviteMyEmail();
  inviteMyEmailEl.value = saved;
  inviteMyEmailRow.classList.toggle('hidden', !!saved);
}

// From the notice period to the 10th working day, or the due date if that comes first.
function inviteSearchWindow() {
  const win = SlotEngine.searchWindow(Date.now(), INVITE_NOTICE_HOURS, INVITE_WORKING_DAYS, INVITE_TIME_ZONE);
  const task = inviteTarget && getTaskById(inviteTarget.taskId);
  const subtask = task && inviteTarget.subtaskId ? (task.subtasks || []).find((s) => s.id === inviteTarget.subtaskId) : null;
  const due = (subtask && subtask.date) || (task && task.due);
  if (!due) return win;
  const dueEnd = InviteCore.meetingTimes(due, '23:30', 29, INVITE_TIME_ZONE).startMs + 29 * 60000;
  // A due date already past or too close cannot limit the search.
  return dueEnd > win.startMs ? { startMs: win.startMs, endMs: Math.min(win.endMs, dueEnd) } : win;
}

async function inviteWriteRequest(id, request) {
  const dir = await inviteFolder.getDirectoryHandle(INVITE_REQUESTS_DIR);
  const handle = await dir.getFileHandle(`${id}.json`, { create: true });
  const out = await handle.createWritable();
  await out.write(JSON.stringify(request));
  await out.close();
}

// A reply that was never read, because the page closed, must not stay in OneDrive.
async function inviteDeleteOldReplies() {
  try {
    const dir = await inviteFolder.getDirectoryHandle(INVITE_RESPONSES_DIR);
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      if (Date.now() - (await handle.getFile()).lastModified > INVITE_TIMEOUT_MS) await dir.removeEntry(name);
    }
  } catch { /* tidying only: a search must not fail because of it */ }
}

// Polls until the flow's reply has synced down. A half-synced file reads as bad
// JSON, so that also just means "try again".
async function inviteAwaitReply(id, onWait) {
  const dir = await inviteFolder.getDirectoryHandle(INVITE_RESPONSES_DIR);
  const started = Date.now();
  for (;;) {
    try {
      const handle = await dir.getFileHandle(`${id}.json`);
      const reply = JSON.parse((await (await handle.getFile()).text()).replace(/^\uFEFF/, ''));
      try { await dir.removeEntry(`${id}.json`); } catch { /* tidied by the next search */ }
      return reply;
    } catch (err) {
      if (err.name !== 'NotFoundError' && err.name !== 'SyntaxError') throw err;
    }
    if (Date.now() - started > INVITE_TIMEOUT_MS) {
      throw new Error('No answer after 5 minutes. Check the Task Hub - Free Busy flow in Power Automate. Nothing was booked.');
    }
    onWait(Math.round((Date.now() - started) / 60000));
    await new Promise((resolve) => setTimeout(resolve, INVITE_POLL_MS));
  }
}

function inviteSlotHtml(slot) {
  const format = new Intl.DateTimeFormat('en-GB', { timeZone: INVITE_TIME_ZONE, weekday: 'short', day: 'numeric', month: 'short' });
  const start = SlotEngine.localParts(slot.startMs, INVITE_TIME_ZONE);
  const end = SlotEngine.localParts(slot.endMs, INVITE_TIME_ZONE);
  const notes = [];
  if (slot.outside.length) {
    notes.push(`<span class="invite-warning">Outside working hours: ${slot.outside.map((o) => `${escapeHtml(inviteNameOf(o.email))} (${inviteClock(o.startMinutes)} their time)`).join(', ')}</span>`);
  }
  if (slot.backToBack) notes.push('<span class="invite-warning">Back-to-back with another meeting</span>');
  if (slot.elsewhere.length) notes.push(`<span class="hint-text">Working elsewhere: ${slot.elsewhere.map((e) => escapeHtml(inviteNameOf(e))).join(', ')}</span>`);
  return `<button type="button" class="invite-result invite-slot" data-invite-date="${start.dateKey}" data-invite-time="${inviteClock(start.minutes)}">
    <span><strong>${format.format(new Date(slot.startMs))}, ${inviteClock(start.minutes)}-${inviteClock(end.minutes)}</strong></span>
    ${notes.join('')}
  </button>`;
}

function renderInviteFindResult(people, result, skipped) {
  const notChecked = inviteAttendees.filter((a) => a.kind !== 'staff').map((a) => a.name || a.email);
  const failed = people.filter((p) => !p.ok);
  const lines = [`Checked: ${people.filter((p) => p.ok).map((p) => escapeHtml(inviteNameOf(p.email))).join(', ') || 'nobody'}.`];
  if (notChecked.length) lines.push(`Not checked (external): ${notChecked.map(escapeHtml).join(', ')}.`);
  if (skipped.length) lines.push(`Not checked (limit of ${INVITE_MAX_LOOKUPS} people): ${skipped.map((a) => escapeHtml(a.name || a.email)).join(', ')}.`);
  if (failed.length) lines.push(`<span class="invite-warning">Calendar could not be read, so treat as not checked: ${failed.map((p) => escapeHtml(inviteNameOf(p.email))).join(', ')}.</span>`);
  if (result.hoursUnknown.length) lines.push(`Working hours unknown: ${result.hoursUnknown.map((e) => escapeHtml(inviteNameOf(e))).join(', ')}.`);
  inviteCoverageEl.innerHTML = lines.map((l) => `<div class="hint-text">${l}</div>`).join('');
  inviteSlotsEl.innerHTML = result.slots.map(inviteSlotHtml).join('');

  if (!result.slots.length) {
    inviteFindStatusEl.textContent = 'No free time found in this period. Try a shorter meeting, wider hours or fewer people.';
  } else if (!result.withinHours) {
    inviteFindStatusEl.textContent = result.noSharedHours
      ? 'These people share no working hours in this period, so every slot is outside someone\'s hours.'
      : 'No slot fits everyone\'s working hours and calendars. These are outside someone\'s hours.';
  } else {
    inviteFindStatusEl.textContent = 'Pick a time, then check it in Scheduling Assistant before sending: nothing holds the slot.';
  }
  if (!result.withinHours && result.blockers.length) {
    inviteCoverageEl.innerHTML += `<div class="hint-text">Most often busy in shared hours: ${result.blockers.slice(0, 5).map((b) => escapeHtml(inviteNameOf(b.email))).join(', ')}.</div>`;
  }
}

async function inviteFindTime() {
  const myEmail = inviteMyEmailEl.value.trim();
  if (!InviteCore.isEmail(myEmail)) {
    inviteMyEmailRow.classList.remove('hidden');
    inviteFindStatusEl.textContent = 'Enter your own GreenYellow address first.';
    inviteMyEmailEl.focus();
    return;
  }
  if (!inviteAttendees.length) { inviteFindStatusEl.textContent = 'Add at least one person first.'; return; }
  if (!inviteFromEl.value || !inviteToEl.value || inviteFromEl.value >= inviteToEl.value) {
    inviteFindStatusEl.textContent = 'Check the hours: the start must be before the end.';
    return;
  }
  if (!inviteFolder) { inviteFindStatusEl.textContent = 'Connect the Task Hub Meetings folder first.'; return; }
  inviteClearFind();
  const run = inviteFindRun;
  inviteFindBtn.disabled = true;
  try {
    // Asked inside the click: browsers refuse to ask later.
    if (await inviteFolder.requestPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error('Task Hub needs permission to write to the Task Hub Meetings folder.');
    }
    try { localStorage.setItem(INVITE_MY_EMAIL_KEY, myEmail); } catch { /* private window */ }
    inviteMyEmailRow.classList.add('hidden');
    await inviteDeleteOldReplies();

    const staff = inviteAttendees.filter((a) => a.kind === 'staff' && a.email.toLowerCase() !== myEmail.toLowerCase());
    const lookups = staff.slice(0, INVITE_MAX_LOOKUPS - 1);
    const skipped = staff.slice(INVITE_MAX_LOOKUPS - 1);
    const win = inviteSearchWindow();
    const iso = (ms) => ({ dateTime: new Date(ms).toISOString().slice(0, 19), timeZone: 'UTC' });
    const id = `fb-${Date.now()}-${uid()}`;
    await inviteWriteRequest(id, {
      schedules: [myEmail, ...lookups.map((a) => a.email)],
      startTime: iso(win.startMs),
      endTime: iso(win.endMs),
      availabilityViewInterval: 30,
    });
    const say = (text) => { if (run === inviteFindRun) inviteFindStatusEl.textContent = text; };
    say('Reading calendars. This usually takes 1-3 minutes, and you can keep working here.');
    const reply = await inviteAwaitReply(id, (mins) => {
      say(`Reading calendars${mins ? ` (${mins} min so far)` : ''}. This usually takes 1-3 minutes.`);
    });
    if (run !== inviteFindRun) return;
    const people = InviteCore.parseSchedule(reply);
    const result = InviteCore.proposeSlots({
      engine: SlotEngine,
      people,
      myEmail,
      me: { tz: INVITE_TIME_ZONE, label: 'Bangkok', start: inviteFromEl.value, end: inviteToEl.value },
      lunch: INVITE_LUNCH,
      durationMin: Number(inviteDurationEl.value),
      startMs: win.startMs,
      endMs: win.endMs,
      bufferMin: INVITE_BUFFER_MIN,
      tentativeIsBusy: inviteTentativeEl.checked,
      count: 5,
    });
    renderInviteFindResult(people, result, skipped);
  } catch (err) {
    if (run === inviteFindRun) inviteFindStatusEl.textContent = err.message;
  } finally {
    if (run === inviteFindRun) inviteFindBtn.disabled = false;
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
  inviteFromEl.value = '09:00';
  inviteToEl.value = '18:00';
  inviteTentativeEl.checked = true;
  inviteClearFind();
  inviteShowMyEmail();
  renderInvitePeople();
  inviteOverlay.classList.remove('hidden');
  inviteSearchEl.focus();
  inviteRestoreFolder();
}

function closeInviteModal() {
  inviteClearFind();
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
  if (remove) { inviteAttendees.splice(Number(remove.dataset.inviteRemove), 1); inviteClearFind(); renderInvitePeople(); return; }
  const slot = e.target.closest('[data-invite-time]');
  if (slot) {
    inviteDateEl.value = slot.dataset.inviteDate;
    inviteTimeEl.value = slot.dataset.inviteTime;
    inviteSlotsEl.querySelectorAll('.invite-slot').forEach((b) => b.classList.toggle('invite-slot-picked', b === slot));
    return;
  }
  if (e.target.closest('#inviteFindBtn')) { inviteFindTime(); return; }
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
