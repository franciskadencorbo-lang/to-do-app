const STORAGE_KEY = 'todo.tasks.v1';
const PROJECTS_KEY = 'todo.projects.v1';
const LABELS_KEY = 'todo.labels.v1';
// Deliberately its own key/array, never merged with STORAGE_KEY. The Triage
// Log is a staging area Claude writes to and the user reviews — it must
// never be able to touch or replace the real task list.
const TRIAGE_STORAGE_KEY = 'todo.triageLog.v1';
const COLLAPSED_COLUMNS_KEY = 'todo.collapsedColumns.v1';

const CATEGORY_COLORS = {
  DO: '#2f5fed',
  PLAN: '#88B917',
  DELEGATE: '#00A9A3',
  'TO ALLOCATE': '#FCDCBD',
};
const CATEGORIES = Object.keys(CATEGORY_COLORS);

// Category is derived from Effort × Impact (a simple Eisenhower-style matrix),
// not chosen directly — "TO ALLOCATE" is reserved for tasks that haven't been
// triaged with an Effort/Impact yet (e.g. Quick Add captures).
function computeCategory(effort, impact) {
  if (effort === 'high' && impact === 'high') return 'PLAN';
  if (effort === 'high' && impact === 'low') return 'DO';
  if (effort === 'low' && impact === 'high') return 'DO';
  if (effort === 'low' && impact === 'low') return 'DELEGATE';
  return null;
}

// A task's status is never set directly — it starts "Not started" and moves
// to "In Progress" the moment any sub-task is completed (and back if none remain).
function recalcStatus(task) {
  const subtasks = task.subtasks || [];
  task.status = subtasks.some((s) => s.completed) ? 'in_progress' : 'not_started';
}

// Category names can contain spaces ("To Allocate"), which are invalid in the
// middle of an element id lookup pattern — strip them for id-building only.
function categorySlug(cat) {
  return cat.replace(/\s+/g, '');
}

// Seed labels for first-time users — from here on, labels are user-editable
// (see `labels` / Manage Labels) and colors are assigned by cycling through
// COLOR_CYCLE based on each label's position in the list, not a fixed map.
const DEFAULT_LABELS = ['M&A', 'Financing', 'YOKO', 'Vietnam', 'Thailand', 'Philippines', 'Help', 'Reporting'];
const COLOR_CYCLE = ['#E03131', '#B8860B', '#2F9E44', '#0C8599', '#1971C2', '#66A80F', '#9C36B5', '#8B5E3C'];

function labelColor(name) {
  const idx = labels.indexOf(name);
  return COLOR_CYCLE[(idx < 0 ? 0 : idx) % COLOR_CYCLE.length];
}

const PRIORITY_ICON = '⚑';
const STATUS_LABELS = { not_started: 'Not started', in_progress: 'In Progress', completed: 'Completed' };

// Custom orange starburst — not a reproduction of Anthropic's Claude logo, just a
// generic "AI-assisted" sparkle marker (an 8-ray asterisk) tinted with --ai-color.
const AI_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
  <g stroke="currentColor" stroke-width="3" stroke-linecap="round">
    <line x1="12" y1="3" x2="12" y2="9"/>
    <line x1="12" y1="15" x2="12" y2="21"/>
    <line x1="3" y1="12" x2="9" y2="12"/>
    <line x1="15" y1="12" x2="21" y2="12"/>
    <line x1="5.5" y1="5.5" x2="9.5" y2="9.5"/>
    <line x1="14.5" y1="14.5" x2="18.5" y2="18.5"/>
    <line x1="18.5" y1="5.5" x2="14.5" y2="9.5"/>
    <line x1="9.5" y1="14.5" x2="5.5" y2="18.5"/>
  </g>
</svg>`;

function aiIconHtml(extraClass = '') {
  return `<span class="ai-badge ${extraClass}" title="AI-assisted">${AI_ICON_SVG}</span>`;
}

// Creation form elements
const taskForm = document.getElementById('taskForm');
const taskTitle = document.getElementById('taskTitle');
const taskEffort = document.getElementById('taskEffort');
const taskImpact = document.getElementById('taskImpact');
const taskCategoryPreview = document.getElementById('taskCategoryPreview');
const taskProject = document.getElementById('taskProject');
const taskStartDate = document.getElementById('taskStartDate');
const taskDue = document.getElementById('taskDue');
const taskPriority = document.getElementById('taskPriority');
const taskEstimatedTime = document.getElementById('taskEstimatedTime');
const taskAiCheckbox = document.getElementById('taskAiCheckbox');
const labelPicker = document.getElementById('labelPicker');
const subtaskInput = document.getElementById('subtaskInput');
const subtaskMinutesInput = document.getElementById('subtaskMinutesInput');
const subtaskAiInput = document.getElementById('subtaskAiInput');
const subtaskDraftList = document.getElementById('subtaskDraftList');
const emailLinkInput = document.getElementById('emailLinkInput');
const taskNotes = document.getElementById('taskNotes');

// Add Task modal
const addTaskModalOverlay = document.getElementById('addTaskModalOverlay');
const addTaskBtn = document.getElementById('topbarAddTaskBtn');
const exportSummaryBtn = document.getElementById('exportSummaryBtn');
const addTaskModalClose = document.getElementById('addTaskModalClose');
const addTaskCancelBtn = document.getElementById('addTaskCancelBtn');

// Projects (shared "manage projects" popover, opened from either form)
const newProjectInput = document.getElementById('newProjectInput');
const addProjectBtn = document.getElementById('addProjectBtn');
const projectListUl = document.getElementById('projectListUl');
const projectManagePopover = document.getElementById('projectManagePopover');
const taskProjectManageBtn = document.getElementById('taskProjectManageBtn');
const editProjectManageBtn = document.getElementById('editProjectManageBtn');
const manageProjectsBtn = document.getElementById('manageProjectsBtn');

// Labels (manage-labels popover, opened from the settings gear)
const newLabelInput = document.getElementById('newLabelInput');
const addLabelBtn = document.getElementById('addLabelBtn');
const labelListUl = document.getElementById('labelListUl');
const labelManagePopover = document.getElementById('labelManagePopover');
const manageLabelsBtn = document.getElementById('manageLabelsBtn');

// Pill bars (project + label quick-filters)
const labelPillBar = document.getElementById('labelPillBar');
const labelQuickFilterBar = document.getElementById('labelQuickFilterBar');
const resultsCount = document.getElementById('resultsCount');

// Settings popover (Export/Import)
const settingsBtn = document.getElementById('settingsBtn');
const settingsPopover = document.getElementById('settingsPopover');

// Subtask hover preview (shared popover)
const subtaskHoverPreview = document.getElementById('subtaskHoverPreview');

// Edit modal elements
const editModalOverlay = document.getElementById('editModalOverlay');
const editForm = document.getElementById('editForm');
const editTitle = document.getElementById('editTitle');
const editEffort = document.getElementById('editEffort');
const editImpact = document.getElementById('editImpact');
const editCategoryPreview = document.getElementById('editCategoryPreview');
const editProject = document.getElementById('editProject');
const editStartDate = document.getElementById('editStartDate');
const editDue = document.getElementById('editDue');
const editPriority = document.getElementById('editPriority');
const editEstimatedTime = document.getElementById('editEstimatedTime');
const editAiCheckbox = document.getElementById('editAiCheckbox');
const editLabelPicker = document.getElementById('editLabelPicker');
const editSubtaskInput = document.getElementById('editSubtaskInput');
const editSubtaskMinutesInput = document.getElementById('editSubtaskMinutesInput');
const editSubtaskAiInput = document.getElementById('editSubtaskAiInput');
const editSubtaskDraftList = document.getElementById('editSubtaskDraftList');
const editEmailLinkInput = document.getElementById('editEmailLinkInput');
const editNotes = document.getElementById('editNotes');
const editCancelBtn = document.getElementById('editCancelBtn');
const editModalClose = document.getElementById('editModalClose');

// Filter / board elements
const categoryFilter = document.getElementById('categoryFilter');
const projectFilter = document.getElementById('projectFilter');
const labelFilter = document.getElementById('labelFilter');
const sortBy = document.getElementById('sortBy');
const statusFilters = document.getElementById('statusFilters');
const board = document.getElementById('board');
const emptyState = document.getElementById('emptyState');
const countLabel = document.getElementById('countLabel');
const clearCompletedBtn = document.getElementById('clearCompleted');

// View tabs
const viewTabs = document.getElementById('viewTabs');
const boardView = document.getElementById('boardView');
const listView = document.getElementById('listView');
const weekView = document.getElementById('weekView');
const overdueView = document.getElementById('overdueView');
const calendarView = document.getElementById('calendarView');

// List elements
const listTableBody = document.getElementById('listTableBody');
const listEmptyState = document.getElementById('listEmptyState');

// This Week elements
const weekRangeLabel = document.getElementById('weekRangeLabel');
const weekTableBody = document.getElementById('weekTableBody');
const weekEmptyState = document.getElementById('weekEmptyState');

// Overdue elements
const overdueTableBody = document.getElementById('overdueTableBody');
const overdueEmptyState = document.getElementById('overdueEmptyState');

// Calendar elements
const calendarPrev = document.getElementById('calendarPrev');
const calendarNext = document.getElementById('calendarNext');
const calendarMonthLabel = document.getElementById('calendarMonthLabel');
const calendarGrid = document.getElementById('calendarGrid');

// Triage Log elements
const triageView = document.getElementById('triageView');
const triageLogTableBody = document.getElementById('triageLogTableBody');
const triageEmptyState = document.getElementById('triageEmptyState');
const triageCount = document.getElementById('triageCount');
const importTriageLogFile = document.getElementById('importTriageLogFile');
const promoteSelectedBtn = document.getElementById('promoteSelectedBtn');

// Board card date-edit popover (shared, positioned near whichever date pill was clicked)
const dateEditPopover = document.getElementById('dateEditPopover');
const dateEditStart = document.getElementById('dateEditStart');
const dateEditDue = document.getElementById('dateEditDue');

// Board card notes popover (shared, read-only, positioned near whichever notes icon was clicked)
const notesPopover = document.getElementById('notesPopover');

// Calendar day "View Tasks" popover (shared, positioned near whichever day's link was clicked)
const calTasksPopover = document.getElementById('calTasksPopover');

// One-time migration: old category names -> the new Effort/Impact-derived
// set, and the DECIDE column's tasks specifically move to PLAN.
const CATEGORY_MIGRATION = { Do: 'DO', Decide: 'PLAN', Delegate: 'DELEGATE', 'To Allocate': 'TO ALLOCATE' };
function migrateCategories(list) {
  let changed = false;
  list.forEach((t) => {
    if (CATEGORY_MIGRATION[t.category]) {
      t.category = CATEGORY_MIGRATION[t.category];
      changed = true;
    }
  });
  return changed;
}

let tasks = loadTasks();
if (migrateCategories(tasks)) saveTasks();
let projects = loadProjects();
let labels = loadLabels();
let triageLog = loadTriageLog();
let currentStatus = 'all';
let currentView = 'board';
let calendarViewDate = new Date();

let selectedLabels = new Set();
let subtaskDraft = [];

let editingTaskId = null;
let editSelectedLabels = new Set();
let editSubtaskDraft = [];

let expandedSubtaskIds = new Set();
let openSubtaskAddIds = new Set();
let dateEditTaskId = null;
let calTasksDayKey = null;
let collapsedColumns = loadCollapsedColumns();

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function loadProjects() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveProjects() {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

function loadLabels() {
  try {
    const raw = localStorage.getItem(LABELS_KEY);
    return raw ? JSON.parse(raw) : [...DEFAULT_LABELS];
  } catch {
    return [...DEFAULT_LABELS];
  }
}

function saveLabels() {
  localStorage.setItem(LABELS_KEY, JSON.stringify(labels));
}

function loadTriageLog() {
  try {
    const raw = localStorage.getItem(TRIAGE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTriageLog() {
  localStorage.setItem(TRIAGE_STORAGE_KEY, JSON.stringify(triageLog));
}

function loadCollapsedColumns() {
  try {
    const raw = localStorage.getItem(COLLAPSED_COLUMNS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveCollapsedColumns() {
  localStorage.setItem(COLLAPSED_COLUMNS_KEY, JSON.stringify([...collapsedColumns]));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Email attachment storage (legacy) ----------
// Task creation/editing now only accepts an Outlook Web link — uploading new
// .eml files is no longer offered. This IndexedDB read/delete plumbing is kept
// so tasks that already have a file attached (from before this change) can
// still be opened and cleaned up.

const EMAIL_DB_NAME = 'todoAppFiles';
const EMAIL_STORE = 'emails';

function openEmailDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(EMAIL_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(EMAIL_STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getEmailFile(id) {
  const db = await openEmailDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(EMAIL_STORE, 'readonly').objectStore(EMAIL_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteEmailFile(id) {
  const db = await openEmailDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMAIL_STORE, 'readwrite');
    tx.objectStore(EMAIL_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function openEmailAttachment(emailId, fallbackFilename) {
  let record;
  try {
    record = await getEmailFile(emailId);
  } catch {
    record = null;
  }
  if (!record) {
    alert('This email attachment could not be found — it may have been cleared from browser storage.');
    return;
  }
  const url = URL.createObjectURL(record.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = record.filename || fallbackFilename || 'email.eml';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Outlook Web hands out several equivalent URL shapes for the same message
// (outlook.office.com/mail/inbox/id/..., outlook.cloud.microsoft/mail/inbox/id/..., etc.)
// but only the .../mail/deeplink/read/{id}?popoutv2=1 form reliably opens the
// message directly instead of just navigating into the inbox. Reconstruct that
// canonical form from whatever Outlook link gets pasted in. Deliberately excludes
// the `version=` param some copied links carry — that's an OWA build number that
// changes on every Outlook update, so hardcoding it would go stale.
function normalizeEmailLink(url) {
  if (!url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!/outlook/i.test(parsed.hostname)) return url;
  const match = parsed.pathname.match(/\/(?:id|deeplink\/read)\/([^/?#]+)/i);
  if (!match) return url;
  return `https://outlook.office.com/mail/deeplink/read/${match[1]}?popoutv2=1`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getContrastText(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? '#1c1e21' : '#ffffff';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getTaskById(id) {
  return tasks.find((t) => t.id === id);
}

// Dates are stored as 'YYYY-MM-DD' strings (native <input type="date"> format).
// Always parse/format via local Y-M-D components — never `new Date(dateString)`,
// which parses date-only strings as UTC and can shift the displayed day near timezone boundaries.
function fromDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------- Label picker (shared by create + edit forms) ----------

function buildLabelPickerHtml(selectedSet) {
  return labels.map((label) => `
    <button type="button" class="label-chip ${selectedSet.has(label) ? 'selected' : ''}" data-label="${escapeHtml(label)}"
      style="--chip-color: ${labelColor(label)}; --chip-bg: ${hexToRgba(labelColor(label), 0.15)};">
      ${escapeHtml(label)}
    </button>
  `).join('');
}

function wireLabelPicker(container, selectedSet) {
  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.label-chip');
    if (!chip) return;
    const label = chip.dataset.label;
    if (selectedSet.has(label)) {
      selectedSet.delete(label);
      chip.classList.remove('selected');
    } else {
      selectedSet.add(label);
      chip.classList.add('selected');
    }
  });
}

wireLabelPicker(labelPicker, selectedLabels);
wireLabelPicker(editLabelPicker, editSelectedLabels);

function initLabelFilter() {
  labelFilter.innerHTML = '<option value="all">All labels</option>'
    + labels.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join('');
}

// ---------- Project quick-filter pill bar ----------
// A faster, always-visible alternative to the "All projects" dropdown —
// clicking a pill sets the same projectFilter value, so both stay in sync.
// Driven by the live `projects` list, so it's re-rendered whenever projects
// are added/removed (see renderProjectOptions), not just once at init.

function renderProjectPillBar() {
  labelPillBar.innerHTML = `<button type="button" class="pill-btn" data-project="all">All Projects</button>`
    + projects.map((p, i) => `
      <button type="button" class="pill-btn" data-project="${escapeHtml(p)}" style="--pill-color: ${COLOR_CYCLE[i % COLOR_CYCLE.length]};">
        <span class="pill-dot"></span>${escapeHtml(p)}
      </button>
    `).join('');
  updateProjectPillBarActive();
}

function updateProjectPillBarActive() {
  const active = projectFilter.value || 'all';
  [...labelPillBar.children].forEach((btn) => btn.classList.toggle('active', btn.dataset.project === active));
}

labelPillBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.pill-btn');
  if (!btn) return;
  projectFilter.value = btn.dataset.project;
  updateProjectPillBarActive();
  render();
});

// ---------- Label quick-filter pill bar ----------
// Same pattern as the project pill bar above, driven by the user-editable
// `labels` array (see renderLabelOptions).

function renderLabelPillBar() {
  labelQuickFilterBar.innerHTML = `<button type="button" class="pill-btn" data-label-filter="all">All Labels</button>`
    + labels.map((l) => `
      <button type="button" class="pill-btn" data-label-filter="${escapeHtml(l)}" style="--pill-color: ${labelColor(l)};">
        <span class="pill-dot"></span>${escapeHtml(l)}
      </button>
    `).join('');
  updateLabelPillBarActive();
}

function updateLabelPillBarActive() {
  const active = labelFilter.value || 'all';
  [...labelQuickFilterBar.children].forEach((btn) => btn.classList.toggle('active', btn.dataset.labelFilter === active));
}

labelQuickFilterBar.addEventListener('click', (e) => {
  const btn = e.target.closest('.pill-btn');
  if (!btn) return;
  labelFilter.value = btn.dataset.labelFilter;
  updateLabelPillBarActive();
  render();
});

// ---------- Sub-task draft list (shared pattern by create + edit forms) ----------

function buildSubtaskDraftHtml(draft) {
  return draft.map((s) => `
    <li class="draft-chip">${s.ai ? aiIconHtml('ai-badge-sm') : ''}${escapeHtml(s.title)}${s.minutes ? `<span class="draft-chip-time">${formatMinutes(s.minutes)}</span>` : ''}<button type="button" class="remove-draft-btn" data-id="${s.id}">×</button></li>
  `).join('');
}

function addSubtaskDraftEntry() {
  const title = subtaskInput.value.trim();
  if (!title) return;
  const minutes = Number(subtaskMinutesInput.value) || 0;
  const ai = subtaskAiInput.checked;
  subtaskDraft.push({ id: uid(), title, completed: false, minutes, ai });
  subtaskInput.value = '';
  subtaskMinutesInput.value = '';
  subtaskAiInput.checked = false;
  subtaskDraftList.innerHTML = buildSubtaskDraftHtml(subtaskDraft);
  subtaskInput.focus();
}

subtaskInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addSubtaskDraftEntry();
});

subtaskMinutesInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addSubtaskDraftEntry();
});

subtaskDraftList.addEventListener('click', (e) => {
  const btn = e.target.closest('.remove-draft-btn');
  if (!btn) return;
  subtaskDraft = subtaskDraft.filter((s) => s.id !== btn.dataset.id);
  subtaskDraftList.innerHTML = buildSubtaskDraftHtml(subtaskDraft);
});

function addEditSubtaskDraftEntry() {
  const title = editSubtaskInput.value.trim();
  if (!title) return;
  const minutes = Number(editSubtaskMinutesInput.value) || 0;
  const ai = editSubtaskAiInput.checked;
  editSubtaskDraft.push({ id: uid(), title, completed: false, minutes, ai });
  editSubtaskInput.value = '';
  editSubtaskMinutesInput.value = '';
  editSubtaskAiInput.checked = false;
  editSubtaskDraftList.innerHTML = buildSubtaskDraftHtml(editSubtaskDraft);
  editSubtaskInput.focus();
}

editSubtaskInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addEditSubtaskDraftEntry();
});

editSubtaskMinutesInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addEditSubtaskDraftEntry();
});

editSubtaskDraftList.addEventListener('click', (e) => {
  const btn = e.target.closest('.remove-draft-btn');
  if (!btn) return;
  editSubtaskDraft = editSubtaskDraft.filter((s) => s.id !== btn.dataset.id);
  editSubtaskDraftList.innerHTML = buildSubtaskDraftHtml(editSubtaskDraft);
});

// ---------- Outlook Web URL (create + edit forms) ----------

emailLinkInput.addEventListener('blur', () => {
  emailLinkInput.value = normalizeEmailLink(emailLinkInput.value.trim());
});

editEmailLinkInput.addEventListener('blur', () => {
  editEmailLinkInput.value = normalizeEmailLink(editEmailLinkInput.value.trim());
});

// ---------- Projects ----------

function renderProjectOptions() {
  const prevTaskVal = taskProject.value;
  const prevEditVal = editProject.value;
  const prevFilterVal = projectFilter.value;

  const optionsHtml = '<option value="">No project</option>'
    + projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');

  taskProject.innerHTML = optionsHtml;
  editProject.innerHTML = optionsHtml;
  if (projects.includes(prevTaskVal)) taskProject.value = prevTaskVal;
  if (projects.includes(prevEditVal)) editProject.value = prevEditVal;

  projectFilter.innerHTML = '<option value="all">All projects</option>'
    + projects.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  if (prevFilterVal === 'all' || projects.includes(prevFilterVal)) projectFilter.value = prevFilterVal;

  projectListUl.innerHTML = projects.length
    ? projects.map((p) => `<li class="draft-chip" data-project="${escapeHtml(p)}">
        <span class="draft-chip-label">${escapeHtml(p)}</span>
        <button type="button" class="edit-draft-btn" data-project="${escapeHtml(p)}" title="Rename project">✎</button>
        <button type="button" class="remove-draft-btn" data-project="${escapeHtml(p)}" title="Delete project">×</button>
      </li>`).join('')
    : '<li class="hint-text">No projects yet.</li>';

  renderProjectPillBar();
}

function addProject() {
  const name = newProjectInput.value.trim();
  newProjectInput.value = '';
  if (!name || projects.includes(name)) return;
  projects.push(name);
  saveProjects();
  renderProjectOptions();
}

function removeProject(name) {
  projects = projects.filter((p) => p !== name);
  saveProjects();
  tasks.forEach((t) => {
    if (t.project === name) t.project = null;
  });
  saveTasks();
  renderProjectOptions();
  render();
}

function renameProject(oldName, newName) {
  newName = (newName || '').trim();
  if (!newName || newName === oldName || projects.includes(newName)) {
    renderProjectOptions();
    return;
  }
  const idx = projects.indexOf(oldName);
  if (idx === -1) return;
  projects[idx] = newName;
  saveProjects();
  tasks.forEach((t) => {
    if (t.project === oldName) t.project = newName;
  });
  saveTasks();
  renderProjectOptions();
  render();
}

function startEditProject(li, name) {
  li.innerHTML = `<input type="text" class="draft-chip-edit-input" value="${escapeHtml(name)}">
    <button type="button" class="save-edit-btn" title="Save">✓</button>
    <button type="button" class="cancel-edit-btn" title="Cancel">×</button>`;
  const input = li.querySelector('.draft-chip-edit-input');
  input.focus();
  input.select();
  const commit = () => renameProject(name, input.value);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); renderProjectOptions(); }
  });
  li.querySelector('.save-edit-btn').addEventListener('click', commit);
  li.querySelector('.cancel-edit-btn').addEventListener('click', () => renderProjectOptions());
}

addProjectBtn.addEventListener('click', addProject);
newProjectInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addProject();
});
projectListUl.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.remove-draft-btn');
  if (removeBtn) { removeProject(removeBtn.dataset.project); return; }
  const editBtn = e.target.closest('.edit-draft-btn');
  if (editBtn) { startEditProject(editBtn.closest('.draft-chip'), editBtn.dataset.project); }
});

// ---------- Manage-projects popover (shared, opened from either form's "+" button) ----------

function openProjectManagePopover(anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const popoverWidth = 280; // matches .project-manage-popover max-width
  projectManagePopover.style.top = `${rect.bottom + 6}px`;
  if (rect.left + popoverWidth > window.innerWidth) {
    projectManagePopover.style.left = 'auto';
    projectManagePopover.style.right = `${window.innerWidth - rect.right}px`;
  } else {
    projectManagePopover.style.left = `${rect.left}px`;
    projectManagePopover.style.right = 'auto';
  }
  projectManagePopover.classList.remove('hidden');
  newProjectInput.focus();
}

function closeProjectManagePopover() {
  projectManagePopover.classList.add('hidden');
}

[taskProjectManageBtn, editProjectManageBtn].forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const alreadyOpen = !projectManagePopover.classList.contains('hidden');
    document.querySelectorAll('.dropdown-panel').forEach((p) => { if (p !== projectManagePopover) p.classList.add('hidden'); });
    if (alreadyOpen) closeProjectManagePopover();
    else openProjectManagePopover(btn);
  });
});
projectManagePopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeProjectManagePopover());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeProjectManagePopover();
});

// ---------- Labels ----------

function renderLabelOptions() {
  initLabelFilter();
  renderLabelPillBar();
  labelPicker.innerHTML = buildLabelPickerHtml(selectedLabels);
  editLabelPicker.innerHTML = buildLabelPickerHtml(editSelectedLabels);

  labelListUl.innerHTML = labels.length
    ? labels.map((l) => `<li class="draft-chip" data-label="${escapeHtml(l)}">
        <span class="label-swatch" style="background: ${labelColor(l)};"></span>
        <span class="draft-chip-label">${escapeHtml(l)}</span>
        <button type="button" class="edit-draft-btn" data-label="${escapeHtml(l)}" title="Rename label">✎</button>
        <button type="button" class="remove-draft-btn" data-label="${escapeHtml(l)}" title="Delete label">×</button>
      </li>`).join('')
    : '<li class="hint-text">No labels yet.</li>';
}

function addLabel() {
  const name = newLabelInput.value.trim();
  newLabelInput.value = '';
  if (!name || labels.includes(name)) return;
  labels.push(name);
  saveLabels();
  renderLabelOptions();
}

function removeLabel(name) {
  labels = labels.filter((l) => l !== name);
  saveLabels();
  tasks.forEach((t) => {
    if (t.labels) t.labels = t.labels.filter((l) => l !== name);
  });
  saveTasks();
  renderLabelOptions();
  render();
}

function renameLabel(oldName, newName) {
  newName = (newName || '').trim();
  if (!newName || newName === oldName || labels.includes(newName)) {
    renderLabelOptions();
    return;
  }
  const idx = labels.indexOf(oldName);
  if (idx === -1) return;
  labels[idx] = newName;
  saveLabels();
  tasks.forEach((t) => {
    if (t.labels) t.labels = t.labels.map((l) => (l === oldName ? newName : l));
  });
  saveTasks();
  renderLabelOptions();
  render();
}

function startEditLabel(li, name) {
  li.innerHTML = `<input type="text" class="draft-chip-edit-input" value="${escapeHtml(name)}">
    <button type="button" class="save-edit-btn" title="Save">✓</button>
    <button type="button" class="cancel-edit-btn" title="Cancel">×</button>`;
  const input = li.querySelector('.draft-chip-edit-input');
  input.focus();
  input.select();
  const commit = () => renameLabel(name, input.value);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); renderLabelOptions(); }
  });
  li.querySelector('.save-edit-btn').addEventListener('click', commit);
  li.querySelector('.cancel-edit-btn').addEventListener('click', () => renderLabelOptions());
}

addLabelBtn.addEventListener('click', addLabel);
newLabelInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addLabel();
});
labelListUl.addEventListener('click', (e) => {
  const removeBtn = e.target.closest('.remove-draft-btn');
  if (removeBtn) { removeLabel(removeBtn.dataset.label); return; }
  const editBtn = e.target.closest('.edit-draft-btn');
  if (editBtn) { startEditLabel(editBtn.closest('.draft-chip'), editBtn.dataset.label); }
});

// ---------- Manage-labels popover (opened from the settings gear) ----------

function openLabelManagePopover(anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const popoverWidth = 280; // matches .label-manage-popover max-width
  labelManagePopover.style.top = `${rect.bottom + 6}px`;
  if (rect.left + popoverWidth > window.innerWidth) {
    labelManagePopover.style.left = 'auto';
    labelManagePopover.style.right = `${window.innerWidth - rect.right}px`;
  } else {
    labelManagePopover.style.left = `${rect.left}px`;
    labelManagePopover.style.right = 'auto';
  }
  labelManagePopover.classList.remove('hidden');
  newLabelInput.focus();
}

function closeLabelManagePopover() {
  labelManagePopover.classList.add('hidden');
}

labelManagePopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeLabelManagePopover());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLabelManagePopover();
});

// ---------- Settings popover (Export / Import, opened from the gear icon) ----------

function openSettingsPopover() {
  const rect = settingsBtn.getBoundingClientRect();
  settingsPopover.style.top = `${rect.bottom + 6}px`;
  settingsPopover.style.right = `${window.innerWidth - rect.right}px`;
  settingsPopover.style.left = 'auto';
  settingsPopover.classList.remove('hidden');
}

function closeSettingsPopover() {
  settingsPopover.classList.add('hidden');
}

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const alreadyOpen = !settingsPopover.classList.contains('hidden');
  document.querySelectorAll('.dropdown-panel').forEach((p) => { if (p !== settingsPopover) p.classList.add('hidden'); });
  if (alreadyOpen) closeSettingsPopover();
  else openSettingsPopover();
});
settingsPopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeSettingsPopover());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettingsPopover();
});

manageProjectsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeSettingsPopover();
  document.querySelectorAll('.dropdown-panel').forEach((p) => { if (p !== projectManagePopover) p.classList.add('hidden'); });
  openProjectManagePopover(settingsBtn);
});

manageLabelsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeSettingsPopover();
  document.querySelectorAll('.dropdown-panel').forEach((p) => { if (p !== labelManagePopover) p.classList.add('hidden'); });
  openLabelManagePopover(settingsBtn);
});

// ---------- Effort/Impact -> Category preview (create + edit forms) ----------

function updateCategoryPreview(effortEl, impactEl, previewEl) {
  const cat = computeCategory(effortEl.value, impactEl.value);
  if (!cat) {
    previewEl.textContent = '';
    previewEl.style.removeProperty('--chip-color');
    return;
  }
  previewEl.textContent = cat;
  previewEl.style.setProperty('--chip-color', CATEGORY_COLORS[cat]);
}

taskEffort.addEventListener('change', () => updateCategoryPreview(taskEffort, taskImpact, taskCategoryPreview));
taskImpact.addEventListener('change', () => updateCategoryPreview(taskEffort, taskImpact, taskCategoryPreview));
editEffort.addEventListener('change', () => updateCategoryPreview(editEffort, editImpact, editCategoryPreview));
editImpact.addEventListener('change', () => updateCategoryPreview(editEffort, editImpact, editCategoryPreview));

// ---------- Create task (Add Task modal) ----------

function resetTaskForm() {
  taskForm.reset();
  taskPriority.value = 'medium';
  taskCategoryPreview.textContent = '';
  taskCategoryPreview.style.removeProperty('--chip-color');

  selectedLabels.clear();
  labelPicker.innerHTML = buildLabelPickerHtml(selectedLabels);

  subtaskDraft = [];
  subtaskDraftList.innerHTML = '';
}

function openAddTaskModal() {
  resetTaskForm();
  addTaskModalOverlay.classList.remove('hidden');
  taskTitle.focus();
}

function closeAddTaskModal() {
  addTaskModalOverlay.classList.add('hidden');
}

addTaskBtn.addEventListener('click', openAddTaskModal);
addTaskCancelBtn.addEventListener('click', closeAddTaskModal);
addTaskModalClose.addEventListener('click', closeAddTaskModal);
addTaskModalOverlay.addEventListener('click', (e) => {
  if (e.target === addTaskModalOverlay) closeAddTaskModal();
});

taskForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = taskTitle.value.trim();
  const category = computeCategory(taskEffort.value, taskImpact.value);
  if (!title || !category) return;

  const linkValue = normalizeEmailLink(emailLinkInput.value.trim()) || null;

  const task = {
    id: uid(),
    title,
    category,
    effort: taskEffort.value,
    impact: taskImpact.value,
    project: taskProject.value || null,
    labels: [...selectedLabels],
    subtasks: subtaskDraft,
    estimatedMinutes: Number(taskEstimatedTime.value) || 0,
    ai: taskAiCheckbox.checked,
    email: linkValue ? { link: linkValue } : null,
    notes: taskNotes.value.trim() || null,
    startDate: taskStartDate.value || null,
    due: taskDue.value || null,
    priority: taskPriority.value,
    completed: false,
    createdAt: Date.now(),
  };
  recalcStatus(task);
  tasks.push(task);

  saveTasks();
  closeAddTaskModal();
  render();
});

// ---------- Edit task modal ----------

function openEditModal(id) {
  const task = getTaskById(id);
  if (!task) return;

  editingTaskId = id;
  editTitle.value = task.title;
  editEffort.value = task.effort || '';
  editImpact.value = task.impact || '';
  updateCategoryPreview(editEffort, editImpact, editCategoryPreview);
  editProject.value = task.project || '';
  editStartDate.value = task.startDate || '';
  editDue.value = task.due || '';
  editPriority.value = task.priority;
  editEstimatedTime.value = task.estimatedMinutes || '';
  editAiCheckbox.checked = !!task.ai;

  editSelectedLabels.clear();
  (task.labels || []).forEach((l) => editSelectedLabels.add(l));
  editLabelPicker.innerHTML = buildLabelPickerHtml(editSelectedLabels);

  editSubtaskDraft = (task.subtasks || []).map((s) => ({ ...s }));
  editSubtaskDraftList.innerHTML = buildSubtaskDraftHtml(editSubtaskDraft);

  editEmailLinkInput.value = (task.email && task.email.link) || '';
  editNotes.value = task.notes || '';

  editModalOverlay.classList.remove('hidden');
}

function closeEditModal() {
  editModalOverlay.classList.add('hidden');
  editingTaskId = null;
}

editCancelBtn.addEventListener('click', closeEditModal);
editModalClose.addEventListener('click', closeEditModal);
editModalOverlay.addEventListener('click', (e) => {
  if (e.target === editModalOverlay) closeEditModal();
});

editForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const title = editTitle.value.trim();
  const category = computeCategory(editEffort.value, editImpact.value);
  if (!title || !category || !editingTaskId) return;

  const task = getTaskById(editingTaskId);
  if (!task) return;

  // Only the link is editable here; any pre-existing file attachment (from
  // before upload was removed) is preserved untouched, not manageable via this form.
  const linkValue = normalizeEmailLink(editEmailLinkInput.value.trim()) || null;
  const previousEmail = task.email || null;
  const fileFields = previousEmail && previousEmail.id
    ? { id: previousEmail.id, filename: previousEmail.filename, subject: previousEmail.subject, from: previousEmail.from, date: previousEmail.date }
    : null;
  task.email = (fileFields || linkValue) ? { ...(fileFields || {}), link: linkValue } : null;

  task.title = title;
  task.category = category;
  task.effort = editEffort.value;
  task.impact = editImpact.value;
  task.project = editProject.value || null;
  task.startDate = editStartDate.value || null;
  task.due = editDue.value || null;
  task.priority = editPriority.value;
  task.estimatedMinutes = Number(editEstimatedTime.value) || 0;
  task.ai = editAiCheckbox.checked;
  task.labels = [...editSelectedLabels];
  task.subtasks = editSubtaskDraft;
  recalcStatus(task);
  task.notes = editNotes.value.trim() || null;

  saveTasks();
  closeEditModal();
  render();
});

// ---------- Filters, sort, status ----------

statusFilters.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  currentStatus = btn.dataset.status;
  [...statusFilters.children].forEach((b) => b.classList.toggle('active', b === btn));
  render();
});

categoryFilter.addEventListener('change', render);
projectFilter.addEventListener('change', () => { updateProjectPillBarActive(); render(); });
labelFilter.addEventListener('change', () => { updateLabelPillBarActive(); render(); });
sortBy.addEventListener('change', render);

clearCompletedBtn.addEventListener('click', () => {
  tasks = tasks.filter((t) => !t.completed);
  saveTasks();
  render();
});

// ---------- Task list interactions (shared by board + this-week table) ----------

function handleTaskListClick(e) {
  const item = e.target.closest('.task-item');
  if (!item) return;
  const id = item.dataset.id;

  if (e.target.closest('.email-badge')) {
    const task = getTaskById(id);
    if (task && task.email) {
      if (task.email.link) {
        window.open(task.email.link, '_blank', 'noopener');
      } else if (task.email.id) {
        openEmailAttachment(task.email.id, task.email.filename);
      }
    }
    return;
  }

  if (e.target.closest('.date-pill')) {
    e.stopPropagation();
    openDateEditPopover(id, e.target.closest('.date-pill'));
    return;
  }

  if (e.target.closest('[data-notes-toggle]')) {
    e.stopPropagation();
    openNotesPopover(id, e.target.closest('[data-notes-toggle]'));
    return;
  }

  if (e.target.closest('[data-toggle-subtasks]')) {
    e.stopPropagation();
    const toggleId = e.target.closest('[data-toggle-subtasks]').dataset.toggleSubtasks;
    if (expandedSubtaskIds.has(toggleId)) expandedSubtaskIds.delete(toggleId);
    else expandedSubtaskIds.add(toggleId);
    render();
    return;
  }

  if (e.target.closest('[data-add-subtask-toggle]')) {
    const toggleId = e.target.closest('[data-add-subtask-toggle]').dataset.addSubtaskToggle;
    if (openSubtaskAddIds.has(toggleId)) openSubtaskAddIds.delete(toggleId);
    else openSubtaskAddIds.add(toggleId);
    render();
    if (openSubtaskAddIds.has(toggleId)) {
      requestAnimationFrame(() => {
        const input = document.querySelector(`.subtask-add-form[data-task-id="${toggleId}"] .subtask-add-input`);
        if (input) input.focus();
      });
    }
    return;
  }

  if (e.target.closest('.mark-complete-btn')) {
    const task = getTaskById(id);
    if (task) {
      task.completed = !task.completed;
      saveTasks();
      render();
    }
    return;
  }

  if (e.target.classList.contains('subtask-checkbox')) {
    const task = getTaskById(id);
    const subtask = task && (task.subtasks || []).find((s) => s.id === e.target.dataset.subtaskId);
    if (subtask) {
      subtask.completed = e.target.checked;
      recalcStatus(task);
      saveTasks();
      render();
    }
    return;
  }

  if (e.target.classList.contains('task-checkbox')) {
    const task = getTaskById(id);
    if (task) {
      task.completed = e.target.checked;
      saveTasks();
      render();
    }
    return;
  }

  if (e.target.closest('.delete-btn')) {
    const task = getTaskById(id);
    if (task && task.email && task.email.id) deleteEmailFile(task.email.id);
    expandedSubtaskIds.delete(id);
    openSubtaskAddIds.delete(id);
    if (dateEditTaskId === id) closeDateEditPopover();
    tasks = tasks.filter((t) => t.id !== id);
    tasks.forEach((t) => {
      t.dependsOn = (t.dependsOn || []).filter((depId) => depId !== id);
    });
    saveTasks();
    render();
    return;
  }

  if (e.target.closest('.edit-btn')) {
    openEditModal(id);
    return;
  }

  // Fallback: clicking anywhere else on a Matrix Grid card (not a table row)
  // opens the edit modal. Excludes the inline sub-task add form and the
  // sub-task rows themselves, whose label text would otherwise both toggle
  // the checkbox (via the native <label>/<input> association) and open the modal.
  if (item.tagName === 'LI' && !e.target.closest('.subtask-add-form') && !e.target.closest('.subtask-row')) {
    openEditModal(id);
  }
}

function handleSubtaskAddSubmit(e) {
  const form = e.target.closest('.subtask-add-form');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('.subtask-add-input');
  const minutesInput = form.querySelector('.subtask-add-minutes-input');
  const aiInput = form.querySelector('.subtask-add-ai-input');
  const title = input.value.trim();
  if (!title) return;
  const minutes = Number(minutesInput.value) || 0;
  const ai = aiInput.checked;
  const taskId = form.dataset.taskId;
  const task = getTaskById(taskId);
  if (task) {
    task.subtasks = task.subtasks || [];
    task.subtasks.push({ id: uid(), title, completed: false, minutes, ai });
    saveTasks();
    render();
    // Keep the add form open and focused so several sub-tasks can be typed in a row.
    requestAnimationFrame(() => {
      const newInput = document.querySelector(`.subtask-add-form[data-task-id="${taskId}"] .subtask-add-input`);
      if (newInput) newInput.focus();
    });
  }
}

board.addEventListener('click', handleTaskListClick);

board.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-collapse-toggle]');
  if (!btn) return;
  const cat = btn.dataset.collapseToggle;
  if (collapsedColumns.has(cat)) collapsedColumns.delete(cat);
  else collapsedColumns.add(cat);
  saveCollapsedColumns();
  render();
});
board.addEventListener('submit', handleSubtaskAddSubmit);
listTableBody.addEventListener('click', handleTaskListClick);
weekTableBody.addEventListener('click', handleTaskListClick);
overdueTableBody.addEventListener('click', handleTaskListClick);

// ---------- Sub-task hover preview (Matrix Grid cards) ----------
// A quick read-only glance at a card's sub-tasks on hover, without needing to
// click the arrow and expand them in place.

function openSubtaskHoverPreview(taskId, anchorEl) {
  const task = getTaskById(taskId);
  const subtasks = (task && task.subtasks) || [];
  if (!subtasks.length) return;
  subtaskHoverPreview.innerHTML = subtasks.map((s) => `
    <div class="subtask-preview-row ${s.completed ? 'subtask-done' : ''}">
      <span>${s.completed ? '✓' : '○'} ${s.ai ? aiIconHtml('ai-badge-sm ai-badge-before') : ''}${escapeHtml(s.title)}</span>
      ${s.minutes ? `<span class="time-badge subtask-time-badge">${formatMinutesBadge(s.minutes)}</span>` : ''}
    </div>
  `).join('');
  subtaskHoverPreview.dataset.taskId = taskId;
  const rect = anchorEl.getBoundingClientRect();
  subtaskHoverPreview.style.top = `${rect.bottom + 6}px`;
  subtaskHoverPreview.style.left = `${rect.left}px`;
  subtaskHoverPreview.classList.remove('hidden');
}

function closeSubtaskHoverPreview() {
  clearTimeout(subtaskHoverCloseTimer);
  subtaskHoverPreview.classList.add('hidden');
  delete subtaskHoverPreview.dataset.taskId;
}

// The popover renders outside .board (it's a shared fixed-position overlay),
// so crossing the gap between the trigger and the popover briefly leaves both
// elements — a plain mouseout would close it mid-crossing. Instead, closing
// is delayed a beat and cancelled if the pointer lands on either the trigger
// or the popover itself, so it survives the hop between them.
let subtaskHoverCloseTimer = null;

function cancelSubtaskHoverClose() {
  clearTimeout(subtaskHoverCloseTimer);
  subtaskHoverCloseTimer = null;
}

function scheduleSubtaskHoverClose() {
  cancelSubtaskHoverClose();
  subtaskHoverCloseTimer = setTimeout(closeSubtaskHoverPreview, 200);
}

board.addEventListener('mouseover', (e) => {
  const trigger = e.target.closest('[data-subtask-hover]');
  if (!trigger) return;
  cancelSubtaskHoverClose();
  if (trigger.dataset.subtaskHover === subtaskHoverPreview.dataset.taskId && !subtaskHoverPreview.classList.contains('hidden')) return;
  openSubtaskHoverPreview(trigger.dataset.subtaskHover, trigger);
});
board.addEventListener('mouseout', (e) => {
  const trigger = e.target.closest('[data-subtask-hover]');
  if (!trigger || (e.relatedTarget && trigger.contains(e.relatedTarget))) return;
  scheduleSubtaskHoverClose();
});
subtaskHoverPreview.addEventListener('mouseenter', cancelSubtaskHoverClose);
subtaskHoverPreview.addEventListener('mouseleave', scheduleSubtaskHoverClose);

// ---------- View tabs ----------

function switchView(view) {
  currentView = view;
  [...viewTabs.children].forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  boardView.classList.toggle('hidden', view !== 'board');
  listView.classList.toggle('hidden', view !== 'list');
  weekView.classList.toggle('hidden', view !== 'week');
  overdueView.classList.toggle('hidden', view !== 'overdue');
  calendarView.classList.toggle('hidden', view !== 'calendar');
  triageView.classList.toggle('hidden', view !== 'triage');
  render();
}

viewTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.view-tab');
  if (!btn) return;
  switchView(btn.dataset.view);
});

// ---------- Calendar navigation ----------

calendarPrev.addEventListener('click', () => {
  calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() - 1, 1);
  renderCalendarView();
});

calendarNext.addEventListener('click', () => {
  calendarViewDate = new Date(calendarViewDate.getFullYear(), calendarViewDate.getMonth() + 1, 1);
  renderCalendarView();
});

// Clicking "View Tasks" also opens the day's task popover (see below) — useful
// on touch devices where hover doesn't apply.
calendarGrid.addEventListener('click', (e) => {
  const trigger = e.target.closest('.cal-view-tasks');
  if (!trigger) return;
  e.stopPropagation();
  const dayKey = trigger.dataset.dayKey;
  const tasksByDay = computeCalTasksByDay();
  openCalTasksPopover(dayKey, trigger, tasksByDay[dayKey] || []);
});

// ---------- Calendar day "View Tasks" popover ----------
// Rendered into a single shared popover outside the calendar grid, same
// pattern as the dependency-edit popover below, so it's never clipped by a
// day cell's overflow. Opens on hover of "View Tasks" and stays open as long
// as the mouse is over the trigger OR the popover — a short grace delay
// before hiding covers the physical gap between the two, so the cursor has
// time to travel from the trigger into the popover without it vanishing
// mid-move.
let calTasksHideTimer = null;

function openCalTasksPopover(dayKey, anchorEl, dayTasks) {
  clearTimeout(calTasksHideTimer);
  calTasksDayKey = dayKey;
  calTasksPopover.innerHTML = buildCalTasksPopoverHtml(dayTasks);

  const rect = anchorEl.getBoundingClientRect();
  calTasksPopover.style.top = `${rect.bottom + 6}px`;
  calTasksPopover.style.left = `${rect.left}px`;
  calTasksPopover.classList.remove('hidden');
}

function closeCalTasksPopover() {
  clearTimeout(calTasksHideTimer);
  calTasksPopover.classList.add('hidden');
  calTasksDayKey = null;
}

function scheduleCloseCalTasksPopover() {
  clearTimeout(calTasksHideTimer);
  calTasksHideTimer = setTimeout(closeCalTasksPopover, 300);
}

calendarGrid.addEventListener('mouseover', (e) => {
  const trigger = e.target.closest('.cal-view-tasks');
  if (!trigger) return;
  const dayKey = trigger.dataset.dayKey;
  const tasksByDay = computeCalTasksByDay();
  openCalTasksPopover(dayKey, trigger, tasksByDay[dayKey] || []);
});

calendarGrid.addEventListener('mouseout', (e) => {
  const trigger = e.target.closest('.cal-view-tasks');
  if (!trigger) return;
  const to = e.relatedTarget;
  if (to && (trigger.contains(to) || calTasksPopover.contains(to))) return;
  scheduleCloseCalTasksPopover();
});

calTasksPopover.addEventListener('mouseenter', () => clearTimeout(calTasksHideTimer));
calTasksPopover.addEventListener('mouseleave', (e) => {
  const to = e.relatedTarget;
  if (to && to.closest && to.closest('.cal-view-tasks')) return;
  scheduleCloseCalTasksPopover();
});

// Clicking a task name still opens the Edit panel directly.
calTasksPopover.addEventListener('click', (e) => {
  e.stopPropagation();
  const nameEl = e.target.closest('[data-cal-edit-task]');
  if (!nameEl) return;
  openEditModal(nameEl.dataset.calEditTask);
  closeCalTasksPopover();
});
document.addEventListener('click', () => closeCalTasksPopover());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCalTasksPopover();
});


// ---------- Board card date-edit popover ----------
// Lets you update just Start/Due from the board card's date pill via native
// <input type="date"> pickers, without opening the full edit modal.

function openDateEditPopover(taskId, anchorEl) {
  const task = getTaskById(taskId);
  if (!task) return;
  dateEditTaskId = taskId;
  dateEditStart.value = task.startDate || '';
  dateEditDue.value = task.due || '';

  const rect = anchorEl.getBoundingClientRect();
  dateEditPopover.style.top = `${rect.bottom + 6}px`;
  dateEditPopover.style.left = `${rect.left}px`;
  dateEditPopover.classList.remove('hidden');
}

function closeDateEditPopover() {
  dateEditPopover.classList.add('hidden');
  dateEditTaskId = null;
}

function saveDateEdit() {
  const task = getTaskById(dateEditTaskId);
  if (!task) return;
  task.startDate = dateEditStart.value || null;
  task.due = dateEditDue.value || null;
  saveTasks();
  render();
}

dateEditStart.addEventListener('change', saveDateEdit);
dateEditDue.addEventListener('change', saveDateEdit);
dateEditPopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeDateEditPopover());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDateEditPopover();
});

// ---------- Board card notes popover ----------
// Read-only — the notes icon shows the full note via native title-tooltip on
// hover, and this popover on click (a native tooltip alone is too easy to
// lose track of / too small for a longer summary).

function openNotesPopover(taskId, anchorEl) {
  const task = getTaskById(taskId);
  if (!task || !task.notes) return;
  notesPopover.textContent = task.notes;

  const rect = anchorEl.getBoundingClientRect();
  notesPopover.style.top = `${rect.bottom + 6}px`;
  notesPopover.style.left = `${rect.left}px`;
  notesPopover.classList.remove('hidden');
}

function closeNotesPopover() {
  notesPopover.classList.add('hidden');
}

notesPopover.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => closeNotesPopover());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeNotesPopover();
});

// ---------- Rendering ----------

function isOverdue(task) {
  if (!task.due || task.completed) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return fromDateKey(task.due) < today;
}

const priorityRank = { urgent: 0, high: 1, medium: 2, low: 3 };

function getFilteredSortedTasks() {
  let list = [...tasks];

  if (currentStatus === 'active') list = list.filter((t) => !t.completed);
  if (currentStatus === 'completed') list = list.filter((t) => t.completed);

  const cat = categoryFilter.value;
  if (cat && cat !== 'all') list = list.filter((t) => t.category === cat);

  const proj = projectFilter.value;
  if (proj && proj !== 'all') list = list.filter((t) => t.project === proj);

  const label = labelFilter.value;
  if (label && label !== 'all') list = list.filter((t) => (t.labels || []).includes(label));

  const sort = sortBy.value;
  if (sort === 'due') {
    list.sort((a, b) => {
      if (!a.due && !b.due) return 0;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due.localeCompare(b.due);
    });
  } else if (sort === 'priority') {
    list.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
  } else {
    list.sort((a, b) => b.createdAt - a.createdAt);
  }

  return list;
}

function formatDue(dateStr) {
  return fromDateKey(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function categoryTag(category) {
  const color = CATEGORY_COLORS[category];
  if (!color) return '';
  return `<span class="badge category-tag" style="--chip-color: ${color}; --chip-text: ${getContrastText(color)};">${escapeHtml(category)}</span>`;
}

// Pale background + solid-colored dot/text, matching the company's status-pill
// style (e.g. "On track", "Blocked") rather than a solid-fill chip.
function labelBadges(task) {
  return (task.labels || []).map((label) => {
    const color = labelColor(label);
    return `<span class="badge label-badge" style="--chip-color: ${color}; --chip-bg: ${hexToRgba(color, 0.15)};">${escapeHtml(label)}</span>`;
  }).join('');
}

function subtaskSectionLabel(task) {
  const subtasks = task.subtasks || [];
  if (!subtasks.length) return 'Sub-tasks';
  const done = subtasks.filter((s) => s.completed).length;
  return `Sub-tasks · ${done}/${subtasks.length}`;
}

// Total estimated time for a task: the sum of its sub-tasks' estimates when it
// has sub-tasks (their estimates roll up into the task), otherwise the
// manually-entered estimate on the task itself.
function taskTotalMinutes(task) {
  const subtasks = task.subtasks || [];
  if (subtasks.length) return subtasks.reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
  return Number(task.estimatedMinutes) || 0;
}

// Remaining estimated time: completed sub-tasks' minutes are deducted from the total.
function taskRemainingMinutes(task) {
  const subtasks = task.subtasks || [];
  if (subtasks.length) {
    return subtasks.filter((s) => !s.completed).reduce((sum, s) => sum + (Number(s.minutes) || 0), 0);
  }
  return Number(task.estimatedMinutes) || 0;
}

// Formats a minute total as e.g. "3h40", "1h", "30 mins", or "—".
function formatMinutes(totalMins) {
  if (!totalMins) return '—';
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h && m) return `${h}h${m}`;
  if (h) return `${h}h`;
  return `${m} mins`;
}

// Formats a minute total for the estimated-time badges: "XX mins" under an
// hour, "XhXX" (zero-padded minutes) once it crosses an hour.
function formatMinutesBadge(totalMins) {
  if (!totalMins) return '—';
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h) return `${h}h${String(m).padStart(2, '0')}`;
  return `${m} mins`;
}

// Shows the task's remaining estimated time in a badge, next to the
// date pill — deducts completed sub-tasks' minutes so it counts down as work finishes.
function estimatedTimeBadgeHtml(task) {
  const total = taskTotalMinutes(task);
  if (!total) return '';
  const remaining = taskRemainingMinutes(task);
  return `<span class="time-badge" title="Estimated time remaining">${formatMinutesBadge(remaining)}</span>`;
}

// Sub-tasks start collapsed to just a count on every card (arrow toggle
// expands them in place for interactive checking); hovering the count shows
// a read-only preview via subtaskHoverPreview without needing to expand.
// The add-subtask form is hidden by default and revealed via the "+" button —
// it stays open across renders (and after adding one) for fast multi-add.
function subtaskSectionHtml(task) {
  const subtasks = task.subtasks || [];
  const hasSubtasks = subtasks.length > 0;
  const collapsed = hasSubtasks && !expandedSubtaskIds.has(task.id);
  const addFormOpen = openSubtaskAddIds.has(task.id);

  const rows = subtasks.map((s) => `
    <label class="subtask-row">
      <input type="checkbox" class="subtask-checkbox" data-subtask-id="${s.id}" ${s.completed ? 'checked' : ''}>
      ${s.ai ? aiIconHtml('ai-badge-sm') : ''}
      <span class="${s.completed ? 'subtask-done' : ''}">${escapeHtml(s.title)}</span>
      ${s.minutes ? `<span class="time-badge subtask-time-badge">${formatMinutesBadge(s.minutes)}</span>` : ''}
    </label>
  `).join('');

  const labelText = hasSubtasks
    ? `<span class="subtask-section-toggle" data-toggle-subtasks="${task.id}" data-subtask-hover="${task.id}"><span class="subtask-toggle-arrow">${collapsed ? '▸' : '▾'}</span>${subtaskSectionLabel(task)}</span>`
    : `<span>${subtaskSectionLabel(task)}</span>`;

  return `
    <div class="card-section-label subtask-label-row">
      ${labelText}
      <button type="button" class="subtask-add-toggle-btn" data-add-subtask-toggle="${task.id}" title="Add sub-task">+</button>
    </div>
    <div class="subtasks">
      <div class="subtask-rows ${collapsed ? 'hidden' : ''}">${rows}</div>
      <form class="subtask-add-form ${addFormOpen ? '' : 'hidden'}" data-task-id="${task.id}">
        <input type="text" class="subtask-add-input" placeholder="Sub-task name">
        <input type="number" class="subtask-add-minutes-input" placeholder="Min" min="0" step="5">
        <label class="ai-checkbox-label" title="AI-assisted sub-task"><input type="checkbox" class="subtask-add-ai-input">AI</label>
      </form>
    </div>
  `;
}

function emailBadgeHtml(task) {
  if (!task.email || (!task.email.link && !task.email.id)) return '';
  const label = task.email.subject || task.email.filename || task.email.link;
  const via = task.email.link ? 'email link' : 'download .eml';
  return `<span class="email-badge outlook-badge" title="Open ${escapeHtml(label)} (${via})">✉</span>`;
}

// Hovering shows the full note via the native title tooltip; clicking opens
// a popover too, since long notes get cut off or disappear too fast in a
// native tooltip to read comfortably.
function notesBadgeHtml(task) {
  if (!task.notes) return '';
  return `<span class="notes-badge" data-notes-toggle="${task.id}" title="${escapeHtml(task.notes)}">📝</span>`;
}

// Empty ring = not started, half-filled = in progress, solid = completed.
// Status is derived automatically from sub-task completion, not editable directly.
function statusCircleHtml(task) {
  const status = task.completed ? 'completed' : (task.status || 'not_started');
  const title = status === 'completed' ? 'Completed' : STATUS_LABELS[status];
  return `<span class="status-circle status-${status}" title="${escapeHtml(title)}"></span>`;
}

function projectTagHtml(task) {
  if (!task.project) return '';
  return `<span class="project-tag">📁 ${escapeHtml(task.project)}</span>`;
}

function dateRangeLabel(task) {
  if (task.startDate && task.due) return `${formatDue(task.startDate)} - ${formatDue(task.due)}`;
  if (task.due) return formatDue(task.due);
  if (task.startDate) return formatDue(task.startDate);
  return null;
}

function taskItemHtml(task) {
  const hasLabels = (task.labels || []).length > 0;
  const dateLabel = dateRangeLabel(task);

  return `
    <li class="task-item ${task.completed ? 'completed' : ''}" data-id="${task.id}" data-priority="${task.priority}" title="Click to edit">
      <div class="card-hover-actions">
        <button class="mark-complete-btn" title="${task.completed ? 'Mark incomplete' : 'Mark complete'}">${task.completed ? '↺' : '✓'}</button>
        <button class="edit-btn" title="Edit">✏️</button>
        <button class="delete-btn" title="Delete">✕</button>
      </div>
      <div class="task-body">
        <div class="card-title-row">
          <span class="priority-tag priority-${task.priority}">${PRIORITY_ICON}</span>
          ${statusCircleHtml(task)}
          <span class="task-title">${escapeHtml(task.title)}${task.ai ? aiIconHtml('ai-badge-after') : ''}</span>
          <span class="card-header-meta">
            ${dateLabel ? `<span class="date-pill ${isOverdue(task) ? 'overdue' : ''}" title="Click to edit dates">📅 ${dateLabel}</span>` : ''}
            ${projectTagHtml(task)}
            ${estimatedTimeBadgeHtml(task)}
            ${emailBadgeHtml(task)}
            ${notesBadgeHtml(task)}
          </span>
        </div>

        ${hasLabels ? `
        <div class="card-sub-row task-meta">${labelBadges(task)}</div>` : ''}

        <div class="card-section card-section-tight">
          ${subtaskSectionHtml(task)}
        </div>
      </div>
    </li>
  `;
}

function initColumnHeaders() {
  CATEGORIES.forEach((cat) => {
    const column = board.querySelector(`.board-column[data-category="${cat}"]`);
    column.style.setProperty('--column-color', CATEGORY_COLORS[cat]);
  });
}

function renderBoard(list) {
  const activeCategory = categoryFilter.value;

  CATEGORIES.forEach((cat) => {
    const slug = categorySlug(cat);
    const column = board.querySelector(`.board-column[data-category="${cat}"]`);
    const listEl = document.getElementById(`list${slug}`);
    const countEl = document.getElementById(`count${slug}`);
    const completedGroupEl = document.getElementById(`completedGroup${slug}`);
    const completedListEl = document.getElementById(`completedList${slug}`);
    const completedCountEl = document.getElementById(`completedCount${slug}`);
    const collapseBtn = column.querySelector('[data-collapse-toggle]');
    const catTasks = list.filter((t) => t.category === cat);
    const activeTasks = catTasks.filter((t) => !t.completed);
    const completedTasks = catTasks.filter((t) => t.completed);

    column.style.display = (activeCategory === 'all' || activeCategory === cat) ? '' : 'none';

    const isCollapsed = collapsedColumns.has(cat);
    column.classList.toggle('collapsed', isCollapsed);
    if (collapseBtn) {
      collapseBtn.textContent = isCollapsed ? '+' : '−';
      collapseBtn.title = isCollapsed ? 'Expand column' : 'Collapse column';
    }

    listEl.innerHTML = activeTasks.length
      ? activeTasks.map(taskItemHtml).join('')
      : (completedTasks.length ? '' : '<li class="column-empty">No tasks</li>');
    countEl.textContent = catTasks.length;

    if (completedTasks.length) {
      completedGroupEl.classList.remove('hidden');
      completedListEl.innerHTML = completedTasks.map(taskItemHtml).join('');
      completedCountEl.textContent = completedTasks.length;
      if (currentStatus === 'completed') completedGroupEl.open = true;
    } else {
      completedGroupEl.classList.add('hidden');
      completedListEl.innerHTML = '';
    }
  });

  emptyState.style.display = list.length === 0 ? 'block' : 'none';
}

// ---------- This Week ----------

function getWeekDateKeys(date = new Date()) {
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diffToMonday);
  const keys = [];
  for (let i = 0; i < 7; i++) {
    keys.push(toDateKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i)));
  }
  return keys;
}

function taskRowHtml(task, { estTimeCol = false } = {}) {
  const subtasks = task.subtasks || [];
  const subtaskSummary = subtasks.length ? `${subtasks.filter((s) => s.completed).length}/${subtasks.length}` : '—';
  const startCell = task.startDate ? `<span class="due-tag">${formatDue(task.startDate)}</span>` : '—';
  const dueCell = task.due
    ? `<span class="due-tag ${isOverdue(task) ? 'overdue' : ''}">${isOverdue(task) ? '⚠ ' : ''}${formatDue(task.due)}</span>`
    : '—';
  const estTimeCell = estTimeCol ? `<td class="centered-col">${formatMinutesBadge(taskTotalMinutes(task))}</td>` : '';

  return `
    <tr class="task-item ${task.completed ? 'completed' : ''}" data-id="${task.id}" data-priority="${task.priority}">
      <td><input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''}></td>
      <td class="week-task-name">${task.ai ? aiIconHtml('ai-badge-sm ai-badge-before') : ''}${escapeHtml(task.title)}</td>
      <td class="email-col">${emailBadgeHtml(task) || '—'}</td>
      <td class="centered-col">${task.project ? escapeHtml(task.project) : '—'}</td>
      <td>${categoryTag(task.category)}</td>
      <td class="centered-col"><span class="priority-tag priority-${task.priority}">${PRIORITY_ICON}</span></td>
      <td class="centered-col">${startCell}</td>
      <td class="centered-col">${dueCell}</td>
      ${estTimeCell}
      <td><div class="task-meta">${labelBadges(task) || '—'}</div></td>
      <td class="centered-col">${subtaskSummary}</td>
      <td class="week-actions">
        <div class="task-actions">
          <button class="edit-btn" title="Edit">✏️</button>
          <button class="delete-btn" title="Delete">🗑️</button>
        </div>
      </td>
    </tr>
  `;
}

// <details>/<summary> can't nest inside a <table>, so table views group completed
// rows into their own <tbody> behind a plain toggle row instead, mirroring the
// board's collapsible "Completed" section.
function renderCompletedGroup(prefix, completedTasks, rowOpts = {}) {
  const toggleBody = document.getElementById(`${prefix}CompletedToggleBody`);
  const completedBody = document.getElementById(`${prefix}CompletedTableBody`);
  const countEl = document.getElementById(`${prefix}CompletedCount`);
  const arrow = toggleBody.querySelector('.completed-toggle-arrow');

  if (completedTasks.length) {
    toggleBody.classList.remove('hidden');
    completedBody.innerHTML = completedTasks.map((t) => taskRowHtml(t, rowOpts)).join('');
    countEl.textContent = completedTasks.length;
    if (currentStatus === 'completed') completedBody.classList.remove('hidden');
  } else {
    toggleBody.classList.add('hidden');
    completedBody.classList.add('hidden');
    completedBody.innerHTML = '';
  }
  arrow.textContent = completedBody.classList.contains('hidden') ? '▸' : '▾';
}

function wireCompletedToggle(prefix) {
  const toggleBody = document.getElementById(`${prefix}CompletedToggleBody`);
  const completedBody = document.getElementById(`${prefix}CompletedTableBody`);
  const arrow = toggleBody.querySelector('.completed-toggle-arrow');
  toggleBody.querySelector('.completed-toggle-row').addEventListener('click', () => {
    completedBody.classList.toggle('hidden');
    arrow.textContent = completedBody.classList.contains('hidden') ? '▸' : '▾';
  });
}

function renderListView(list) {
  const activeTasks = list.filter((t) => !t.completed);
  const completedTasks = list.filter((t) => t.completed);

  listTableBody.innerHTML = activeTasks.map((t) => taskRowHtml(t, { estTimeCol: true })).join('');
  listEmptyState.style.display = list.length === 0 ? 'block' : 'none';
  renderCompletedGroup('list', completedTasks, { estTimeCol: true });
}

function getWeekTasks(list) {
  const weekKeys = getWeekDateKeys();
  return list
    .filter((t) => t.due && weekKeys.includes(t.due))
    .sort((a, b) => a.due.localeCompare(b.due) || priorityRank[a.priority] - priorityRank[b.priority]);
}

function getOverdueTasks(list) {
  // isOverdue() excludes completed tasks by definition (a done task can't be
  // overdue), so this set never has anything to group under "Completed".
  return list
    .filter((t) => isOverdue(t))
    .sort((a, b) => a.due.localeCompare(b.due) || priorityRank[a.priority] - priorityRank[b.priority]);
}

function renderWeekView(weekTasks) {
  const weekKeys = getWeekDateKeys();
  weekRangeLabel.textContent = `${formatDue(weekKeys[0])} – ${formatDue(weekKeys[6])}, ${weekKeys[6].slice(0, 4)}`;

  const activeTasks = weekTasks.filter((t) => !t.completed);
  const completedTasks = weekTasks.filter((t) => t.completed);

  weekTableBody.innerHTML = activeTasks.map(taskRowHtml).join('');
  weekEmptyState.style.display = weekTasks.length === 0 ? 'block' : 'none';
  renderCompletedGroup('week', completedTasks);
}

function renderOverdueView(overdueTasks) {
  overdueTableBody.innerHTML = overdueTasks.map(taskRowHtml).join('');
  overdueEmptyState.style.display = overdueTasks.length === 0 ? 'block' : 'none';
}

// ---------- Calendar ----------

// The calendar always shows all tasks (active + completed) on their due date,
// regardless of the status filter, so progress is always visible.
// Structural filters (category / project / label) are still respected.
// Shared by the month grid render and the "View Tasks" popover (which needs
// the same day's tasks again at click time).
function computeCalTasksByDay() {
  const calTasks = tasks.filter((t) => {
    const cat = categoryFilter.value;
    if (cat && cat !== 'all' && t.category !== cat) return false;
    const proj = projectFilter.value;
    if (proj && proj !== 'all' && t.project !== proj) return false;
    const lbl = labelFilter.value;
    if (lbl && lbl !== 'all' && !(t.labels || []).includes(lbl)) return false;
    return true;
  });

  const tasksByDay = {};
  calTasks.forEach((t) => {
    if (!t.due) return;
    (tasksByDay[t.due] = tasksByDay[t.due] || []).push(t);
  });
  return tasksByDay;
}

// DELEGATE tasks render italicized in the category color with their time
// forced to 0 — that time isn't yours to spend, so it's excluded from the
// day's Estimated Time total too (see renderCalendarView below). Completed
// tasks are struck through and aren't a click target, since there's nothing
// left to rebalance. Everything else is a link that opens the Edit panel
// directly, so a day can be rebalanced without leaving the calendar.
function buildCalTasksPopoverHtml(dayTasks) {
  const activeDayTasks = dayTasks.filter((t) => !t.completed);
  const completedDayTasks = dayTasks.filter((t) => t.completed);

  return [...activeDayTasks, ...completedDayTasks].map((t) => {
    const isDelegate = t.category === 'DELEGATE';
    const mins = isDelegate ? 0 : taskRemainingMinutes(t);
    const timeLabel = isDelegate ? '0 mins' : (mins ? formatMinutes(mins) : null);

    const styleParts = ['font-weight: normal;'];
    if (t.completed) styleParts.push('text-decoration: line-through; cursor: default;');
    else styleParts.push('text-decoration: underline; cursor: pointer;');
    if (isDelegate) styleParts.push(`font-style: italic; color: ${CATEGORY_COLORS.DELEGATE};`);

    const nameAttr = t.completed ? '' : ` data-cal-edit-task="${t.id}"`;

    return `<div class="cal-tooltip-task${t.completed ? ' cal-tooltip-done' : ''}">
      <span class="cal-flag flag-${t.priority}">⚑</span>
      <span class="cal-tooltip-name" style="${styleParts.join(' ')}"${nameAttr}>${escapeHtml(t.title)}</span>
      ${timeLabel ? `<span class="cal-tooltip-time">(${timeLabel})</span>` : ''}
    </div>`;
  }).join('');
}

function renderCalendarView(list = getFilteredSortedTasks()) {
  const year = calendarViewDate.getFullYear();
  const month = calendarViewDate.getMonth();

  calendarMonthLabel.textContent = calendarViewDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay();
  const leadingBlanks = firstWeekday === 0 ? 6 : firstWeekday - 1;
  const totalCells = Math.ceil((leadingBlanks + daysInMonth) / 7) * 7;
  const weekCount = totalCells / 7;

  const tasksByDay = computeCalTasksByDay();

  const todayKey = toDateKey(new Date());

  let html = '';
  for (let w = 0; w < weekCount; w++) {
    const weekStart = w * 7;
    const weekEnd = weekStart + 6;

    let dayCellsHtml = '';
    for (let i = weekStart; i <= weekEnd; i++) {
      const dayNum = i - leadingBlanks + 1;
      if (dayNum < 1 || dayNum > daysInMonth) {
        dayCellsHtml += '<div class="calendar-day empty"></div>';
        continue;
      }
      const dateKey = toDateKey(new Date(year, month, dayNum));
      const dayTasks = tasksByDay[dateKey] || [];
      const activeDayTasks = dayTasks.filter((t) => !t.completed);

      // --- Daily load summary (active tasks only) ---
      // Uses remaining (not total) minutes so completed sub-tasks' time drops
      // off the calendar as soon as they're checked off. DELEGATE tasks are
      // excluded — that time isn't yours to spend, so counting it here would
      // misrepresent your own workload for the day.
      const totalMins = activeDayTasks
        .filter((t) => t.category !== 'DELEGATE')
        .reduce((sum, t) => sum + taskRemainingMinutes(t), 0);
      const subtaskCount = activeDayTasks.reduce((sum, t) => sum + (t.subtasks || []).length, 0);
      const urgentHighCount = activeDayTasks.filter((t) => t.priority === 'urgent' || t.priority === 'high').length;

      // "View Tasks" opens a click-triggered popover (see openCalTasksPopover)
      // instead of a CSS hover tooltip — hover tooltips here used to vanish the
      // moment the mouse moved off the trigger, before you could reach a link
      // inside them.
      const summaryHtml = dayTasks.length ? `
        <div class="cal-day-summary">
          <div class="cal-day-stat">Estimated Time: <strong>${formatMinutes(totalMins)}</strong></div>
          <div class="cal-day-stat"># of Tasks: <strong>${activeDayTasks.length}</strong></div>
          <div class="cal-day-stat"># of Sub-tasks: <strong>${subtaskCount}</strong></div>
          <div class="cal-day-stat"># of Tasks Urgent/High: <strong>${urgentHighCount}</strong></div>
          <div class="cal-view-tasks-wrap">
            <span class="cal-view-tasks" data-day-key="${dateKey}">View Tasks</span>
          </div>
        </div>
      ` : '';

      dayCellsHtml += `
        <div class="calendar-day ${dateKey === todayKey ? 'today' : ''}">
          <div class="calendar-day-number">${dayNum}</div>
          <div class="calendar-day-tasks">
            ${summaryHtml}
          </div>
        </div>
      `;
    }

    html += `
      <div class="calendar-week">
        <div class="calendar-week-days">${dayCellsHtml}</div>
      </div>
    `;
  }
  calendarGrid.innerHTML = html;
}

// The footer count reflects whatever the current tab is actually showing —
// e.g. "Overdue" counts overdue tasks, not the global task list — rather than
// a single global number that stays the same no matter which tab is open.
function updateFooterCount(list, weekTasks, overdueTasks) {
  let scoped = list;
  if (currentView === 'week') scoped = weekTasks;
  else if (currentView === 'overdue') scoped = overdueTasks;

  const activeCount = scoped.filter((t) => !t.completed).length;
  countLabel.textContent = `${activeCount} active / ${scoped.length} total`;
}

function render() {
  closeSubtaskHoverPreview();
  const list = getFilteredSortedTasks();
  const weekTasks = getWeekTasks(list);
  const overdueTasks = getOverdueTasks(list);

  renderBoard(list);
  renderListView(list);
  renderWeekView(weekTasks);
  renderOverdueView(overdueTasks);
  renderCalendarView(list);
  renderTriageView();

  updateFooterCount(list, weekTasks, overdueTasks);
  resultsCount.textContent = `Showing ${list.length} task${list.length === 1 ? '' : 's'}`;
}

// ---------- Export / Import ----------

function exportBackupJson() {
  const data = {
    tasks: JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'),
    projects: JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]'),
    labels: JSON.parse(localStorage.getItem(LABELS_KEY) || '[]'),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `planner-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

document.getElementById('exportBtn').addEventListener('click', exportBackupJson);
exportSummaryBtn.addEventListener('click', exportBackupJson);

// Quotes any field containing a comma, quote, or newline, doubling embedded quotes
// per RFC 4180 so Excel (and other CSV importers) parse it back correctly.
function toCsvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  const headers = [
    'Title', 'Category', 'Project', 'Status', 'Priority', 'Start Date', 'Due Date',
    'Estimated Time (min)', 'AI', 'Labels', 'Subtasks', 'Notes', 'Email Link', 'Completed', 'Created At',
  ];

  const rows = tasks.map((task) => {
    const status = task.completed ? 'Completed' : (STATUS_LABELS[task.status] || task.status || '');
    const subtasks = (task.subtasks || [])
      .map((s) => `${s.completed ? '[x]' : '[ ]'}${s.ai ? ' [AI]' : ''} ${s.title}${s.minutes ? ` (${s.minutes}m)` : ''}`).join('; ');

    return [
      task.title,
      task.category,
      task.project || '',
      status,
      task.priority,
      task.startDate || '',
      task.due || '',
      taskTotalMinutes(task) || '',
      task.ai ? 'Yes' : 'No',
      (task.labels || []).join('; '),
      subtasks,
      task.notes || '',
      task.email && task.email.link ? task.email.link : '',
      task.completed ? 'Yes' : 'No',
      task.createdAt ? new Date(task.createdAt).toISOString() : '',
    ].map(toCsvField).join(',');
  });

  // Leading BOM so Excel detects UTF-8 instead of misreading accented characters.
  const csv = '﻿' + [headers.map(toCsvField).join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `planner-tasks-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

// Not Started / In Progress only (i.e. not completed) — dependency ids are
// resolved to titles here since a Claude Skill reading this file has no
// access to the other tasks to look ids up against.
document.getElementById('exportActiveJsonBtn').addEventListener('click', () => {
  const activeTasks = tasks.filter((t) => !t.completed);

  const data = activeTasks.map((task) => ({
    title: task.title,
    status: STATUS_LABELS[task.status] || task.status,
    category: task.category,
    project: task.project || null,
    priority: task.priority,
    startDate: task.startDate || null,
    due: task.due || null,
    overdue: isOverdue(task),
    estimatedMinutes: taskTotalMinutes(task) || null,
    remainingMinutes: taskRemainingMinutes(task) || null,
    aiAssisted: !!task.ai,
    labels: task.labels || [],
    subtasks: (task.subtasks || []).map((s) => ({
      title: s.title,
      completed: s.completed,
      minutes: s.minutes || null,
      aiAssisted: !!s.ai,
    })),
    dependsOn: (task.dependsOn || [])
      .map((depId) => { const dep = getTaskById(depId); return dep ? dep.title : null; })
      .filter(Boolean),
    notes: task.notes || null,
    emailLink: (task.email && task.email.link) || null,
    createdAt: task.createdAt ? new Date(task.createdAt).toISOString() : null,
  }));

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `planner-active-tasks-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

document.getElementById('importFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (!Array.isArray(data.tasks)) { alert('Invalid backup file — missing tasks array.'); return; }
      if (!confirm(`This will replace your current ${tasks.length} task(s) with ${data.tasks.length} task(s) from the backup. Continue?`)) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data.tasks));
      if (Array.isArray(data.projects)) localStorage.setItem(PROJECTS_KEY, JSON.stringify(data.projects));
      if (Array.isArray(data.labels)) localStorage.setItem(LABELS_KEY, JSON.stringify(data.labels));
      tasks = loadTasks();
      projects = loadProjects();
      labels = loadLabels();
      renderProjectOptions();
      renderLabelOptions();
      render();
      alert(`Imported ${data.tasks.length} task(s) successfully.`);
    } catch {
      alert('Could not read the backup file — make sure it is a valid Planner JSON export.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// Rebuilds full task objects from the flattened "Export for AI Skill" format
// (dependsOn as titles, status as a label, no ids). Additive only — appended
// to the existing list, never replaces it, unlike the "Import backup" handler
// above. dependsOn is re-linked by title match once every task in the batch
// has an id, since the export has no ids left to match against.
const importActiveTasksFile = document.getElementById('importActiveTasksFile');
const VALID_IMPORT_PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const STATUS_LABEL_TO_KEY = { 'Not started': 'not_started', 'In Progress': 'in_progress', 'Completed': 'completed' };

importActiveTasksFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.target.result);
    } catch {
      alert('Could not read the file — make sure it is valid JSON.');
      e.target.value = '';
      return;
    }
    if (!Array.isArray(data)) {
      alert('Invalid file — expected an array of tasks (the "Export for AI Skill" format).');
      e.target.value = '';
      return;
    }
    if (!confirm(`This will add ${data.length} task(s) to your current ${tasks.length} task(s). Continue?`)) {
      e.target.value = '';
      return;
    }

    const titleToId = {};
    const newTasks = data.map((entry) => {
      const task = {
        id: uid(),
        title: (entry.title || '').trim(),
        category: CATEGORIES.includes(entry.category) ? entry.category : 'TO ALLOCATE',
        effort: null,
        impact: null,
        project: entry.project || null,
        labels: Array.isArray(entry.labels) ? entry.labels : [],
        subtasks: (entry.subtasks || []).map((s) => ({
          id: uid(),
          title: s.title,
          completed: !!s.completed,
          minutes: s.minutes || null,
        })),
        estimatedMinutes: Number(entry.estimatedMinutes) || 0,
        dependsOn: [],
        email: entry.emailLink ? { link: entry.emailLink } : null,
        notes: entry.notes || null,
        startDate: entry.startDate || null,
        due: entry.due || null,
        priority: VALID_IMPORT_PRIORITIES.includes(entry.priority) ? entry.priority : 'medium',
        completed: entry.status === 'Completed',
        createdAt: entry.createdAt && !isNaN(Date.parse(entry.createdAt)) ? Date.parse(entry.createdAt) : Date.now(),
        status: STATUS_LABEL_TO_KEY[entry.status] || 'not_started',
      };
      if (task.title) titleToId[task.title] = task.id;
      return task;
    });

    data.forEach((entry, i) => {
      newTasks[i].dependsOn = (entry.dependsOn || [])
        .map((depTitle) => titleToId[depTitle])
        .filter(Boolean);
    });

    tasks.push(...newTasks);
    saveTasks();
    render();
    alert(`Imported ${newTasks.length} task(s) successfully.`);
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ---------- Triage Log ----------
// A staging area, deliberately separate from `tasks`/STORAGE_KEY. Claude for
// Chrome writes here via the Import Triage Log file input only — never via
// the "Import backup" control above, which replaces the entire task list.
// Nothing here becomes a real task until the user checks it and clicks
// "Promote Selected", so a bad LLM judgment call can, at worst, sit in this
// list — it can never silently alter DO/PLAN/DELEGATE/TO ALLOCATE.

function triageRowHtml(entry) {
  const emailCell = entry.link
    ? `<a href="${escapeHtml(entry.link)}" target="_blank" rel="noopener" title="Open in Outlook"><span class="email-badge outlook-badge">✉</span></a>`
    : '—';
  return `
    <tr data-id="${entry.id}">
      <td><input type="checkbox" class="task-checkbox triage-checkbox" data-id="${entry.id}"></td>
      <td class="week-task-name">${escapeHtml(entry.title)}</td>
      <td class="email-col">${emailCell}</td>
      <td class="centered-col"><span class="priority-tag priority-${entry.priority}">${PRIORITY_ICON}</span></td>
      <td>${entry.notes ? escapeHtml(entry.notes) : '—'}</td>
      <td class="week-actions">
        <div class="task-actions">
          <button type="button" class="delete-btn triage-dismiss-btn" data-id="${entry.id}" title="Dismiss (no task created)">🗑️</button>
        </div>
      </td>
    </tr>
  `;
}

function renderTriageView() {
  const sorted = [...triageLog].sort((a, b) =>
    priorityRank[a.priority] - priorityRank[b.priority] || b.addedAt - a.addedAt
  );
  triageLogTableBody.innerHTML = sorted.map(triageRowHtml).join('');
  triageEmptyState.style.display = sorted.length === 0 ? 'block' : 'none';
  triageCount.textContent = sorted.length ? `${sorted.length} item(s)` : '';
}

// Dismiss a single entry — removes it from the log without creating a task.
triageLogTableBody.addEventListener('click', (e) => {
  const btn = e.target.closest('.triage-dismiss-btn');
  if (!btn) return;
  triageLog = triageLog.filter((entry) => entry.id !== btn.dataset.id);
  saveTriageLog();
  renderTriageView();
});

// Every link already in use — either still pending in the log, or already
// promoted to a real task — so a re-run of the same Outlook export never
// creates a second entry for something already seen.
function linksAlreadyLogged() {
  const fromLog = triageLog.map((e) => e.link).filter(Boolean);
  const fromTasks = tasks.map((t) => t.email && t.email.link).filter(Boolean);
  return new Set([...fromLog, ...fromTasks]);
}

const VALID_TRIAGE_PRIORITIES = ['urgent', 'high', 'medium', 'low'];

// Additive only. This handler never reads or writes STORAGE_KEY/tasks —
// it is intentionally a separate code path from the "Import backup" handler
// above, which does a full replace.
importTriageLogFile.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    let data;
    try {
      data = JSON.parse(ev.target.result);
    } catch {
      alert('Could not read the Triage Log file — make sure it is valid JSON.');
      e.target.value = '';
      return;
    }

    const entries = Array.isArray(data) ? data : Array.isArray(data.entries) ? data.entries : null;
    if (!entries) {
      alert('Invalid Triage Log file — expected an array, or an object with an "entries" array.');
      e.target.value = '';
      return;
    }

    const seenLinks = linksAlreadyLogged();
    let added = 0;
    let skipped = 0;

    entries.forEach((raw) => {
      const title = (raw.title || '').trim();
      if (!title) { skipped++; return; }

      const link = raw.link ? normalizeEmailLink(String(raw.link).trim()) : null;
      if (link && seenLinks.has(link)) { skipped++; return; }

      const priority = VALID_TRIAGE_PRIORITIES.includes(raw.priority) ? raw.priority : 'medium';

      triageLog.push({
        id: uid(),
        title,
        link,
        notes: raw.notes ? String(raw.notes).trim() : null,
        priority,
        addedAt: Date.now(),
      });
      if (link) seenLinks.add(link);
      added++;
    });

    saveTriageLog();
    renderTriageView();
    alert(`Triage Log updated: ${added} new item(s) added, ${skipped} skipped (already logged, already a task, or missing a title).`);
    e.target.value = '';
  };
  reader.readAsText(file);
});

// The only path from the Triage Log into the real task list — explicit,
// user-triggered, one click. Mirrors Quick Add's task shape exactly, except
// priority carries over from triage instead of defaulting to medium.
promoteSelectedBtn.addEventListener('click', () => {
  const checkedIds = [...triageLogTableBody.querySelectorAll('.triage-checkbox:checked')].map((cb) => cb.dataset.id);
  if (!checkedIds.length) { alert('Select at least one item to promote.'); return; }

  checkedIds.forEach((id) => {
    const entry = triageLog.find((e) => e.id === id);
    if (!entry) return;

    const task = {
      id: uid(),
      title: entry.title,
      category: 'TO ALLOCATE',
      effort: null,
      impact: null,
      project: null,
      labels: [],
      subtasks: [],
      dependsOn: [],
      email: entry.link ? { link: entry.link } : null,
      notes: entry.notes,
      startDate: null,
      due: null,
      priority: entry.priority,
      completed: false,
      createdAt: Date.now(),
    };
    recalcStatus(task);
    tasks.push(task);
  });

  triageLog = triageLog.filter((entry) => !checkedIds.includes(entry.id));

  saveTasks();
  saveTriageLog();
  render();
});

renderLabelOptions();
initColumnHeaders();
renderProjectOptions();
wireCompletedToggle('list');
wireCompletedToggle('week');
render();
