# Requirements — Sub-Task Scheduling & Delegate Ownership Flag

**Repository:** `franciskadencorbo-lang/to-do-app`
**Target files:** `app.js`, `index.html`, `style.css`
**Author:** Francis Kaden-Corbo
**Date:** 2026-08-13

## Context

Two gaps in the current Calendar View and Delegate workflow:

1. Tasks worked on over multiple days only show their remaining time on the Due Date in Calendar View. Sub-tasks have no date of their own, so multi-day work cannot be spread across the calendar without duplicating the task.
2. A DELEGATE task always shows 0 remaining minutes on the calendar, even if some of its sub-tasks are actually being done by me, not the delegate.

Both are fixed by adding two new optional fields to the sub-task object and updating the calendar/remaining-time logic to read them. No new tasks, no task duplication, no breaking down of tasks required.

---

## Requirement 1 — Per-Sub-Task Work Date

### 1.1 Data model

Add an optional field to every sub-task object:

```js
{
  id: string,
  title: string,
  completed: boolean,
  minutes: number,
  ai: boolean,
  date: string | null   // NEW — 'YYYY-MM-DD', optional
}
```

- ~~`date` is independent of the parent task's `due`.~~ **Superseded — see "Amendment: Due Date roll-up" at the end of this document.**
- `date` is optional. If left blank, the sub-task keeps its current behavior (counted on the task's Due Date).
- ~~No change to task-level `due` or `startDate` behavior is required by this ticket — leave `startDate` as-is (currently force-synced to `due` in `normalizeTasks()`). Do not repurpose it.~~ **Superseded — see the amendment below.**

### 1.2 UI — Add Task modal & Edit Task modal

- Next to each sub-task row in the sub-task draft list (`subtaskDraftList` / `editSubtaskDraftList`), add an optional date input.
- Add a date input alongside the existing title/minutes/AI inputs used to create a new sub-task entry (`subtaskInput`, `subtaskMinutesInput`, `subtaskAiInput` and their edit-modal equivalents).
- If left blank, `date` is stored as `null`.
- Sub-task chips in `buildSubtaskDraftHtml()` should show the date (short format, e.g. "Aug 20") when set, similar to how `minutes` is shown as a chip badge today.
- Existing sub-task rows on the task card / expanded sub-task list (`subtaskRowsHtml()`) should also display the date when set (small badge, consistent styling with the existing time badge).

### 1.3 Calendar bucketing logic

Rework `computeCalTasksByDay()` (`app.js` ~line 1979) so that:

- A task **with no sub-tasks** continues to be bucketed under `task.due`, unchanged.
- A task **with sub-tasks** is bucketed per sub-task:
  - Each sub-task with a `date` set is placed under that date.
  - Each sub-task with no `date` set is placed under the task's `due`.
  - The same task can therefore appear on multiple calendar days, but each day only carries the sub-tasks relevant to it (per your confirmation: **only the sub-task's own minutes count on that day, not the full task's remaining time**).
- The task must still appear only once in the Board/List views — this change affects Calendar View only.

### 1.4 Remaining-time calculation on the calendar

- Per confirmed requirement: **Calendar day totals count only the minutes of the sub-tasks scheduled on that day** (i.e., sub-tasks whose `date` matches that day, or whose `date` is blank and the day is the task's Due Date). Do not sum the task's full remaining time on every day it appears.
- Completed sub-tasks continue to be excluded from the minute total (existing behavior via `!s.completed`).
- The "View Tasks" popover for a given day should list only the sub-tasks scheduled for that day (not the whole task's sub-task list), but should make clear which parent task each sub-task belongs to (task title should still be visible/clickable to open the Edit panel).
- `taskRemainingMinutes(task)` (used elsewhere — e.g. task card badges, list view) is NOT part of this change and should keep summing across ALL incomplete sub-tasks regardless of date. Date-based partitioning applies only inside the calendar day-bucketing logic, not to the task-level "remaining time" badge shown on the Board/List views.

### 1.5 Non-goals

- No automatic spreading/splitting of a sub-task's minutes across a date range. One sub-task = one date, or no date at all.
- No change to how DELEGATE tasks are excluded from the daily time total (see Requirement 2 for the interaction between these two features).

### 1.6 Acceptance criteria

- [ ] I can set an optional date on any sub-task, independent of the task's Due Date.
- [ ] A task with 3 sub-tasks dated across 3 different days appears on all 3 calendar days, without appearing as 3 separate tasks anywhere else in the app.
- [ ] Each of those 3 days shows only that day's sub-task minutes in the "Estimated Time" summary — not the task's total remaining time.
- [ ] Sub-tasks left without a date still show up on the task's Due Date, exactly as today.
- [ ] Board/List view task cards are unaffected — they still show total remaining time and total sub-task count as before.

---

## Requirement 2 — Sub-Task Delegation Flag

### 2.1 Data model

Add a second optional field to the sub-task object:

```js
{
  id: string,
  title: string,
  completed: boolean,
  minutes: number,
  ai: boolean,
  date: string | null,
  delegated: boolean   // NEW — default false
}
```

- `delegated: true` means "this specific sub-task is being done by the delegate, not by me."
- `delegated: false` (default) means "this specific sub-task is mine to do," even if the parent task's category is DELEGATE.

### 2.2 UI — Add Task modal & Edit Task modal

- Add a checkbox/toggle per sub-task row (similar placement/style to the existing `ai` checkbox) labeled something like "Delegated" or "Not mine."
- This control should only be meaningfully exposed when the parent task's category is DELEGATE (it can be hidden or disabled for DO/PLAN/NOT URGENT tasks, since delegation-tracking is only relevant there — confirm hide vs. disable during implementation, hide is preferable to reduce clutter).
- Default value for new sub-tasks: `delegated: false` (i.e., assume it's yours unless flagged otherwise) — this preserves current behavior for tasks that don't use this feature at all... **except see 2.3**, since the parent-task-level DELEGATE default currently zeroes everything. Confirm the default explicitly during implementation: since most existing DELEGATE-task sub-tasks are, in practice, actually delegated, consider defaulting new sub-tasks on a DELEGATE task to `delegated: true`, and letting me uncheck the ones I'm personally doing. Flag this default choice back to me before finalizing — do not assume silently.

### 2.3 Remaining-time calculation

This is the core fix. Update the calendar's per-day minute calculation (`app.js` ~line 2010-2018, inside `renderCalendarView`) so DELEGATE is no longer an all-or-nothing switch:

- Current behavior: `const mins = isDelegate ? 0 : taskRemainingMinutes(t);` — a DELEGATE task always contributes 0 minutes.
- New behavior:
  - If the task is DELEGATE and has no sub-tasks: contributes 0 minutes (unchanged — there's nothing to attribute to me).
  - If the task is DELEGATE and has sub-tasks: contributes the sum of minutes for incomplete sub-tasks where `delegated !== true` (i.e., the ones I'm doing myself). Sub-tasks flagged `delegated: true` contribute 0.
  - Non-DELEGATE tasks are unaffected — continue to count all incomplete sub-task minutes regardless of the `delegated` flag (that field is only meaningful in the DELEGATE context, but do not silently ignore it if set elsewhere — just document that it has no effect outside DELEGATE tasks).
- This must compose correctly with Requirement 1: on a given calendar day, only the sub-tasks scheduled for that day count, AND only the ones not flagged `delegated: true` count. Both filters apply together.
- Task-level `estimatedMinutes` stays forced to 0 for DELEGATE tasks (existing behavior in the Add/Edit forms) — this requirement does not change the task-level estimate field, only the sub-task-driven calendar/remaining-time math.
- Update `taskRemainingMinutes()` similarly so the task-card badge (Board/List views) reflects the same logic: for a DELEGATE task with sub-tasks, sum only the non-delegated, incomplete sub-tasks' minutes, instead of returning the full sub-task sum unmodified. Confirm this is desired for Board/List view too, not just Calendar View, since it changes what the badge on a DELEGATE task card shows today (today it shows the pre-existing sub-task sum via the general `taskRemainingMinutes` path — the "isDelegate ? 0" override is applied only at the calendar layer currently, so this is a slight behavior change worth flagging).

### 2.4 Visual treatment

- Sub-task rows already show a "done" strikethrough style. Add a visual cue for `delegated: true` sub-tasks (e.g., italic + the existing DELEGATE teal color `#00A9A3`, consistent with how DELEGATE tasks are already styled in the calendar) so it's visually obvious at a glance which sub-tasks are not yours.
- Sub-task count badges (`subtaskCountBadgeHtml`, `subtaskProgressHtml`) are unaffected — they continue to reflect completion, not delegation.

### 2.5 Acceptance criteria

- [ ] I can flag individual sub-tasks on a DELEGATE task as "delegated" or "mine."
- [ ] A DELEGATE task with 90% of sub-task minutes flagged as delegated and 10% flagged as mine shows only that 10% in the calendar day's Estimated Time total, on the day(s) those specific sub-tasks are scheduled.
- [ ] A fully-delegated task (no sub-tasks flagged as mine, or no sub-tasks at all) still shows 0 minutes on the calendar, exactly as today.
- [ ] Non-DELEGATE tasks are visually and functionally unaffected by this change.
- [ ] Delegated sub-tasks are visually distinguishable from ones I own, wherever sub-tasks are listed.

---

## Combined interaction to test explicitly

A DELEGATE task with 4 sub-tasks:

| Sub-task | Date | Delegated | Minutes |
|---|---|---|---|
| A | Aug 18 | true | 60 |
| B | Aug 19 | false | 30 |
| C | Aug 20 | true | 45 |
| D | (blank → task Due = Aug 21) | false | 20 |

Expected calendar result:
- Aug 18: 0 min contributed by this task (A is delegated).
- Aug 19: 30 min contributed (B is mine).
- Aug 20: 0 min contributed (C is delegated).
- Aug 21 (task's Due Date): 20 min contributed (D is mine, undated).
- Task appears on the calendar on Aug 18, 19, 20, and 21 — once, not duplicated as separate tasks.

---

## Out of scope for this ticket

- Any change to `startDate` handling.
- Automatic minute-spreading across a date range.
- Delegation tracking at the task level for non-DELEGATE categories.
- Notification/reminder features tied to sub-task dates.

## Open questions for implementer to confirm with Francis before/while building

1. Default value of `delegated` for newly added sub-tasks on a DELEGATE task — default to `true` (assume delegated unless unchecked) or `false` (assume mine unless checked)? See §2.2.
2. Should `taskRemainingMinutes()` (used on Board/List view task cards) apply the same delegated-sub-task exclusion as the calendar, or should Board/List view keep showing full sub-task time regardless of delegation, with only Calendar View applying the filter? See §2.3.

---

## Amendment: Due Date roll-up (supersedes §1.1)

Shipped after the above. Sub-task `date` is no longer independent of the parent task's `due`, and it
is now understood as a **Sub-Task Due Date** rather than only a work day.

### Rule

> A Task's Due Date is always the latest of its own Due Date and its Sub-Tasks' Due Dates.
> With no Sub-Tasks — or no dated Sub-Tasks — it is simply the Task's own Due Date.

A task cannot be finished before its last sub-task, so the old independence let `due` under-report
completion, which in turn corrupted Overdue detection, the This Week view, due-date sorting and the
calendar.

### Data model

A third field joins `date` / `delegated` on the **task** object:

```
baseDue: string | null   // 'YYYY-MM-DD' — the date entered at Task level
```

- `due` now stores the **effective (rolled-up)** date, so every existing reader — sorting, Overdue,
  This Week, List view, calendar bucketing — is correct without change.
- `baseDue` stores the date the user actually typed at Task level, which keeps the roll-up
  reversible: remove the late sub-task and `due` falls back to `baseDue` instead of being stranded
  on an orphaned sub-task's date.
- `startDate` now tracks `baseDue` rather than being force-synced to `due`, so a task spans from the
  date you set to the date its last sub-task lands on.

### Semantics

- Sub-tasks with no `date` are ignored by the roll-up.
- Completed sub-tasks still count — the work landed on that day either way.
- A task with no `baseDue` but dated sub-tasks takes the latest sub-task date as its `due`.
- Two levels only (Task → Sub-Task). There is no deeper nesting to roll up.
- Dates are `YYYY-MM-DD` strings throughout, so string comparison is date comparison.

### Implementation

`applyDueRollup(task)` in `app.js` is the single write point for `due` / `startDate`; nothing else
assigns them. It is called from every path that changes a task's own date or its sub-task list:
Add Task submit, Edit Task submit, the board card's date-pill popover, backup import, and
`normalizeTasks()` — which also backfills `baseDue` onto pre-existing tasks and corrects any task
whose sub-task already outran its `due`. Because it runs on every load, the rule is self-healing.

### UI

While a sub-task is due later than the task's own date, the task-level Due Date input is **disabled**
and displays the derived date, in both modals and in the date-pill popover, with a "⤴ from sub-task"
hint. The typed base date is parked in `addBaseDue` / `editBaseDue` rather than in the input, so
removing the late sub-task restores it immediately. Board cards mark a derived date with `⤴`.

### Calendar exception

`computeCalTasksByDay()` buckets an **undated** sub-task on `task.baseDue`, not `task.due`. Using
`due` there would drag undated sub-tasks forward onto whatever date a *different* sub-task pushed the
roll-up out to, breaking §1.3's rule that undated sub-tasks show on the task's own Due Date.
