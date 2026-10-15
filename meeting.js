// ---------- Meeting mode (team meeting, Mon / Wed / Fri) ----------
// Run the team meeting from this app, the master list: one near-full-screen
// page, one block per task, edits saved straight into the task list. After the
// meeting, "Export for AI Skill" feeds the M&A and Financing Dashboard, which
// mirrors the team's part one way.
//
// Sections, in meeting order:
//   1. Led by you       — DO, PLAN, NOT URGENT: yours to lead, any sub-task can be handed over
//   2. Needs attention  — DELEGATE tasks with something overdue or due by the next meeting
//   3. For the team     — the other DELEGATE tasks
// Private tasks can be hidden from the meeting (e.g. feedback, recruitment);
// the hidden list is kept in this browser only and never exported.
//
// Loaded after app.js and uses its functions and data (tasks, saveTasks,
// render, recalcStatus, applyDueRollup, computeCategory, uid, assignees…).
// Nothing in app.js is changed except that render() also redraws this view.

const MEETING_HIDDEN_KEY = 'todo.meetingHidden.v1';
const MEETING_DAYS = [1, 3, 5]; // Monday, Wednesday, Friday
const MM = { open: false, showDone: false, showHidden: false, adding: null, armed: null };

function mmLoadHidden() {
  try { const v = JSON.parse(localStorage.getItem(MEETING_HIDDEN_KEY) || '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function mmSaveHidden(list) { try { localStorage.setItem(MEETING_HIDDEN_KEY, JSON.stringify(list)); } catch { /* private window */ } }

// The next meeting after today (Mon / Wed / Fri): "due before the next meeting" uses it.
function mmNextMeetingKey() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  for (let i = 1; i <= 7; i++) {
    const n = new Date(d); n.setDate(d.getDate() + i);
    if (MEETING_DAYS.includes(n.getDay())) return toDateKey(n);
  }
  return toDateKey(d);
}
function mmTodayKey() { return toDateKey(new Date()); }
function mmLongDate(key) { return key ? fromDateKey(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : ''; }
function mmIsLate(dateKey) { return !!dateKey && dateKey < mmTodayKey(); }

// Overdue = open sub-tasks past their date; a task with no open sub-task counts its own due date.
function mmLateCount(task) {
  const open = (task.subtasks || []).filter((s) => !s.completed);
  return open.filter((s) => mmIsLate(s.date)).length + (open.length === 0 && mmIsLate(task.due) ? 1 : 0);
}

function mmSection(task, nextKey) {
  if (!isDelegateTask(task)) return 'own';
  const open = (task.subtasks || []).filter((s) => !s.completed);
  const soon = (k) => !!k && k <= nextKey;
  if (soon(task.due) || open.some((s) => soon(s.date))) return 'attn';
  return 'team';
}

const MM_CAT_ORDER = { DO: 0, PLAN: 1, DELEGATE: 2, 'NOT URGENT': 3 };
function mmSort(a, b) {
  return (MM_CAT_ORDER[a.category] ?? 9) - (MM_CAT_ORDER[b.category] ?? 9)
    || String(a.due || '9999').localeCompare(String(b.due || '9999'))
    || String(a.title).localeCompare(String(b.title));
}

// Assignee choices for a sub-task: "Me" (not delegated), then people, departments, and Claude for AI sub-tasks.
function mmAssigneeOptions(sub) {
  const cur = sub.delegated ? (sub.assignee || '') : '';
  const opt = (v, label) => `<option value="${escapeHtml(v)}"${v === cur ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const people = assignees.filter((a) => a.kind === 'person').map((a) => opt(a.name, a.name)).join('');
  const depts = assignees.filter((a) => a.kind === 'department').map((a) => opt(a.name, a.name)).join('');
  const ai = sub.ai || cur === AI_ASSIGNEE.name ? `<optgroup label="AI">${opt(AI_ASSIGNEE.name, AI_ASSIGNEE.name)}</optgroup>` : '';
  const known = cur === '' || cur === AI_ASSIGNEE.name || assignees.some((a) => a.name === cur);
  return opt('', 'Me') + (known ? '' : opt(cur, cur)) + ai + (people ? `<optgroup label="People">${people}</optgroup>` : '') + (depts ? `<optgroup label="Departments">${depts}</optgroup>` : '');
}

function mmCategoryTag(cat) {
  const color = CATEGORY_COLORS[cat] || '#9aa3b4';
  return `<span class="mm-tag" style="background:${hexToRgba(color, 0.16)};color:${darkenHex(color, 0.35)}">${escapeHtml(cat || '—')}</span>`;
}

function mmSubRow(task, s) {
  const late = !s.completed && mmIsLate(s.date);
  const who = `<select class="mm-input" data-mm="assignee" data-task="${task.id}" data-sub="${s.id}" aria-label="Assignee">${mmAssigneeOptions(s)}</select>`;
  return `<div class="mm-row${s.completed ? ' done' : ''}">
    <input type="checkbox" data-mm="done" data-task="${task.id}" data-sub="${s.id}"${s.completed ? ' checked' : ''} aria-label="Done: ${escapeHtml(s.title)}">
    <input type="text" class="mm-input mm-title" data-mm="title" data-task="${task.id}" data-sub="${s.id}" value="${escapeHtml(s.title)}" aria-label="Sub-task">
    ${who}
    <input type="date" class="mm-input" data-mm="date" data-task="${task.id}" data-sub="${s.id}" value="${s.date || ''}" aria-label="Date">
    <span>${s.completed ? '<span class="mm-flag mm-flag-done">Done</span>' : late ? '<span class="mm-flag mm-flag-late">Overdue</span>' : ''}</span>
  </div>`;
}

function mmBlock(task, sec) {
  const subs = task.subtasks || [];
  const open = subs.filter((s) => !s.completed);
  const shown = MM.showDone ? subs : open;
  const doneCount = subs.length - open.length;
  const late = mmLateCount(task);
  const armedDelegate = MM.armed === 'delegate:' + task.id;
  const armedHide = MM.armed === 'hide:' + task.id;
  let h = `<section class="mm-block mm-${sec}" data-task="${task.id}">
    <div class="mm-head">
      <b class="mm-name">${escapeHtml(task.title)}</b>
      ${mmCategoryTag(task.category)}
      ${task.project ? `<span class="mm-tag mm-tag-project">${escapeHtml(task.project)}</span>` : ''}
      <span class="mm-meta">${open.length} open${doneCount ? ` · ${doneCount} done` : ''}${task.due ? ` · due ${escapeHtml(mmLongDate(task.due))}` : ''}${late ? ` · <span class="mm-late">${late} overdue</span>` : ''}</span>
      <span class="mm-grow"></span>
      ${isDelegateTask(task) ? '' : `<button type="button" class="mm-link" data-mm-act="delegate" data-task="${task.id}" title="Hands the whole task over: moves it to DELEGATE (Low effort, Low impact). To hand over a single sub-task, pick its assignee instead">${armedDelegate ? 'Confirm: move to DELEGATE' : 'Move to DELEGATE'}</button>`}
      <button type="button" class="mm-link" data-mm-act="edit" data-task="${task.id}">Edit</button>
      <button type="button" class="mm-link" data-mm-act="hide" data-task="${task.id}" title="Hide this task from Meeting mode (kept in your list)">${armedHide ? 'Confirm: hide' : 'Hide'}</button>
    </div>`;
  if (!shown.length) h += `<div class="mm-empty">${subs.length ? 'All sub-tasks done.' : 'No sub-task yet.'}</div>`;
  shown.forEach((s) => { h += mmSubRow(task, s); });
  if (MM.adding === task.id) {
    h += `<div class="mm-add">
      <input type="text" class="mm-input" data-mm-new="title" placeholder="New sub-task" aria-label="New sub-task">
      <select class="mm-input" data-mm-new="assignee" aria-label="Assignee">${mmAssigneeOptions({ delegated: false, assignee: null })}</select>
      <input type="date" class="mm-input" data-mm-new="date" aria-label="Date">
      <button type="button" class="btn btn-primary" data-mm-act="save-sub" data-task="${task.id}">Add</button>
      <button type="button" class="btn btn-secondary" data-mm-act="cancel-sub">Cancel</button>
    </div>`;
  }
  h += `<div class="mm-foot"><button type="button" class="mm-link" data-mm-act="add-sub" data-task="${task.id}">+ Sub-task</button>
    <label class="mm-check"><input type="checkbox" data-mm="task-done" data-task="${task.id}"${task.completed ? ' checked' : ''}> Task completed</label></div></section>`;
  return h;
}

function mmRender() {
  const box = document.getElementById('meetingBox');
  if (!box || !MM.open) return;
  const body = document.getElementById('meetingBody');
  const top = body ? body.scrollTop : 0;
  const hidden = mmLoadHidden();
  const nextKey = mmNextMeetingKey();
  const active = tasks.filter((t) => !t.completed && !hidden.includes(t.id)).sort(mmSort);
  const groups = { own: [], attn: [], team: [] };
  active.forEach((t) => groups[mmSection(t, nextKey)].push(t));
  const openSubs = active.reduce((n, t) => n + (t.subtasks || []).filter((s) => !s.completed).length, 0);
  const late = active.reduce((n, t) => n + mmLateCount(t), 0);
  const hiddenTasks = tasks.filter((t) => !t.completed && hidden.includes(t.id));

  let h = `<div class="mm-top">
      <h2>Team Meeting · ${escapeHtml(mmLongDate(mmTodayKey()))}</h2>
      <button type="button" class="btn btn-primary" id="mmAddTask">+ Add Task</button>
      <button type="button" class="btn btn-secondary" id="mmClose" aria-label="Close Meeting mode">Close</button>
    </div>
    <div class="mm-bar">
      <span><b>${active.length}</b> tasks</span><span><b>${openSubs}</b> open sub-tasks</span>
      <span${late ? ' class="mm-late"' : ''}><b>${late}</b> overdue</span>
      <span>Next meeting ${escapeHtml(mmLongDate(nextKey))}</span>
      <span class="mm-grow"></span>
      <button type="button" class="mm-link" id="mmHiddenBtn">${MM.showHidden ? 'Close hidden list' : `Hidden from meeting (${hiddenTasks.length})`}</button>
      <label class="mm-check"><input type="checkbox" id="mmShowDone"${MM.showDone ? ' checked' : ''}> Show done sub-tasks</label>
    </div>
    <div class="mm-body" id="meetingBody">`;
  if (MM.showHidden) {
    h += `<div class="mm-hidden"><b>Hidden from Meeting mode</b> <span class="mm-meta">kept in your list; only this browser remembers the choice</span>` +
      (hiddenTasks.length ? hiddenTasks.map((t) => `<div class="mm-hidden-row">${escapeHtml(t.title)} <button type="button" class="mm-link" data-mm-act="unhide" data-task="${t.id}">Show again</button></div>`).join('') : '<div class="mm-meta">Nothing hidden.</div>') + '</div>';
  }
  const SECTIONS = [
    ['own', 'Led by you', 'DO, PLAN, NOT URGENT: hand over any sub-task the team can take'],
    ['attn', 'Needs attention', `delegated, overdue or due by ${mmLongDate(nextKey)}`],
    ['team', 'For the team', 'other delegated work'],
  ];
  SECTIONS.forEach(([key, title, sub]) => {
    if (!groups[key].length) return;
    h += `<div class="mm-sec">${title} <span class="mm-meta">${escapeHtml(sub)} · ${groups[key].length}</span></div>`;
    groups[key].forEach((t) => { h += mmBlock(t, key); });
  });
  if (!active.length) h += '<div class="mm-empty">No active tasks.</div>';
  h += '</div>';
  box.innerHTML = h;
  const nb = document.getElementById('meetingBody');
  if (nb) nb.scrollTop = top;
  const nt = box.querySelector('[data-mm-new="title"]');
  if (nt) nt.focus();
}

function openMeetingMode() {
  MM.open = true; MM.adding = null; MM.armed = null; MM.showHidden = false;
  document.getElementById('meetingOverlay').classList.remove('hidden');
  document.body.classList.add('mm-noscroll');
  mmRender();
}
function closeMeetingMode() {
  MM.open = false;
  document.getElementById('meetingOverlay').classList.add('hidden');
  document.body.classList.remove('mm-noscroll');
}

function mmFindSub(e) {
  const task = getTaskById(e.dataset.task);
  const sub = task && (task.subtasks || []).find((s) => s.id === e.dataset.sub);
  return { task, sub };
}
function mmCommit() { saveTasks(); render(); }

// Moving a task to DELEGATE uses the app's own rule (Low effort + Low impact,
// priority at least Medium), so the category stays consistent everywhere.
function mmMoveToDelegate(task) {
  task.effort = 'low';
  task.impact = 'low';
  if (!task.priority || task.priority === 'low') task.priority = 'medium';
  task.category = computeCategory(task.effort, task.impact, task.priority) || 'DELEGATE';
  task.estimatedMinutes = 0;
}

function mmWire() {
  const overlay = document.getElementById('meetingOverlay');
  const box = document.getElementById('meetingBox');
  document.getElementById('meetingModeBtn').addEventListener('click', openMeetingMode);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMeetingMode(); });

  box.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'mmShowDone') { MM.showDone = el.checked; mmRender(); return; }
    const kind = el.dataset.mm;
    if (kind === 'task-done') {
      const task = getTaskById(el.dataset.task);
      if (task) { task.completed = el.checked; mmCommit(); }
      return;
    }
    if (!kind) return;
    const { task, sub } = mmFindSub(el);
    if (!task || !sub) return;
    if (kind === 'done') { sub.completed = el.checked; recalcStatus(task); }
    if (kind === 'title') { const v = el.value.trim(); if (!v) { el.value = sub.title; return; } sub.title = v; }
    if (kind === 'date') { sub.date = el.value || null; applyDueRollup(task); }
    if (kind === 'assignee') { sub.assignee = el.value || null; sub.delegated = !!el.value; }
    mmCommit();
  });

  function saveNewSub(taskId) {
    const task = getTaskById(taskId);
    const row = box.querySelector('.mm-add');
    if (!task || !row) return;
    const titleEl = row.querySelector('[data-mm-new="title"]');
    const title = titleEl.value.trim();
    if (!title) { titleEl.focus(); return; }
    const aEl = row.querySelector('[data-mm-new="assignee"]');
    const assignee = aEl ? (aEl.value || null) : null;
    const date = row.querySelector('[data-mm-new="date"]').value || null;
    task.subtasks = task.subtasks || [];
    task.subtasks.push({ id: uid(), title, completed: false, minutes: 0, ai: false, date, delegated: !!assignee, assignee });
    applyDueRollup(task);
    recalcStatus(task);
    MM.adding = null;
    mmCommit();
  }

  box.addEventListener('click', (e) => {
    if (e.target.closest('#mmClose')) { closeMeetingMode(); return; }
    if (e.target.closest('#mmAddTask')) { openAddTaskModal(); return; }
    if (e.target.closest('#mmHiddenBtn')) { MM.showHidden = !MM.showHidden; mmRender(); return; }
    const btn = e.target.closest('[data-mm-act]');
    if (!btn) return;
    const act = btn.dataset.mmAct;
    const task = btn.dataset.task ? getTaskById(btn.dataset.task) : null;
    if (act === 'add-sub') { MM.adding = btn.dataset.task; MM.armed = null; mmRender(); return; }
    if (act === 'cancel-sub') { MM.adding = null; mmRender(); return; }
    if (act === 'save-sub') { saveNewSub(btn.dataset.task); return; }
    if (act === 'edit' && task) { openEditModal(task.id); return; }
    if (act === 'delegate' && task) {
      if (MM.armed !== 'delegate:' + task.id) { MM.armed = 'delegate:' + task.id; mmRender(); return; }
      MM.armed = null; mmMoveToDelegate(task); mmCommit(); return;
    }
    if (act === 'hide' && task) {
      if (MM.armed !== 'hide:' + task.id) { MM.armed = 'hide:' + task.id; mmRender(); return; }
      MM.armed = null; const hidden = mmLoadHidden(); if (!hidden.includes(task.id)) hidden.push(task.id); mmSaveHidden(hidden); mmRender(); return;
    }
    if (act === 'unhide' && task) { mmSaveHidden(mmLoadHidden().filter((id) => id !== task.id)); mmRender(); }
  });

  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const row = e.target.closest('.mm-add');
    if (!row) return;
    e.preventDefault();
    const b = row.querySelector('[data-mm-act="save-sub"]');
    if (b) saveNewSub(b.dataset.task);
  });

  // Esc closes Meeting mode unless one of the app's own windows (Add / Edit task) is open on top.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !MM.open) return;
    if (document.querySelector('.modal-overlay:not(.hidden)')) return;
    closeMeetingMode();
  });

  // Every change the app makes (Add / Edit task windows included) redraws Meeting mode too.
  const appRender = render;
  render = function renderWithMeeting() { appRender(); if (MM.open) mmRender(); };
}

mmWire();
