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

- `date` is independent of the parent task's `due`.
- `date` is optional. If left blank, the sub-task keeps its current behavior (counted on the task's Due Date).
- No change to task-level `due` or `startDate` behavior is required by this ticket — leave `startDate` as-is (currently force-synced to `due` in `normalizeTasks()`). Do not repurpose it.

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
