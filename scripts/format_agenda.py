#!/usr/bin/env python3
"""
Turns planner-active-tasks-latest.json (a Task Hub export) into agenda text
for the triweekly staff meeting (Mon 5:30 PM, Wed 5:30 PM, Fri 4:00 PM,
Asia/Bangkok).

This is the portable (cloud-routine-friendly) twin of format-agenda.ps1,
which runs locally on Windows. Keep the bucketing/formatting logic in sync
between the two.

Usage:
  python format_agenda.py <json_path> <next_meeting_date YYYY-MM-DD> <meeting_label> [--stale-warning "text"]
"""
import json
import sys
from datetime import datetime, date

PRIORITY_RANK = {"urgent": 0, "high": 1, "medium": 2, "low": 3}


def parse_due(task):
    due = task.get("due")
    if not due:
        return None
    try:
        return datetime.strptime(due, "%Y-%m-%d").date()
    except ValueError:
        return None


def remaining_subtasks(task):
    subtasks = task.get("subtasks") or []
    return sum(1 for s in subtasks if not s.get("completed"))


def format_line(task):
    due = parse_due(task)
    due_str = f"{due.strftime('%b')} {due.day}" if due else "no due date"
    project = task.get("project") or "General"
    remaining = remaining_subtasks(task)
    subtask_note = ""
    if remaining > 0:
        subtask_note = f" ({remaining} open sub-task{'s' if remaining != 1 else ''})"
    overdue_flag = " [OVERDUE]" if task.get("overdue") else ""
    email_note = " [source email linked]" if task.get("emailLink") else ""
    return (
        f"- {task.get('title')} [{project}] - due {due_str}, "
        f"{task.get('priority')} priority{subtask_note}{overdue_flag}{email_note}"
    )


def sort_key(task):
    due = parse_due(task) or date.max
    return (due, PRIORITY_RANK.get(task.get("priority"), 99))


def build_agenda(tasks, next_meeting, meeting_label, stale_warning=None):
    overdue_or_due_soon = [
        t for t in tasks
        if t.get("overdue") is True or ((d := parse_due(t)) and d <= next_meeting)
    ]
    overdue_titles = {t.get("title") for t in overdue_or_due_soon}

    delegate_items = [
        t for t in tasks
        if t.get("category") == "DELEGATE" and t.get("title") not in overdue_titles
    ]
    delegate_titles = {t.get("title") for t in delegate_items}

    other_active = [
        t for t in tasks
        if t.get("title") not in overdue_titles and t.get("title") not in delegate_titles
    ]

    lines = []
    lines.append(f"# Staff Meeting Agenda -- {meeting_label}")
    lines.append(
        f"_Generated from Task Hub export; next meeting: "
        f"{next_meeting.strftime('%A, %b')} {next_meeting.day}, {next_meeting.year}_"
    )
    if stale_warning:
        lines.append("")
        lines.append(f"> ⚠️ {stale_warning}")
    lines.append("")

    if overdue_or_due_soon:
        lines.append("## Needs attention -- overdue or due before this meeting")
        for t in sorted(overdue_or_due_soon, key=sort_key):
            lines.append(format_line(t))
        lines.append("")

    if delegate_items:
        lines.append("## For the team -- delegated items")
        for t in sorted(delegate_items, key=sort_key):
            lines.append(format_line(t))
        lines.append("")

    if other_active:
        lines.append("## Status updates -- other active work")
        for t in sorted(other_active, key=sort_key):
            lines.append(format_line(t))
        lines.append("")

    return "\n".join(lines)


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)

    json_path, next_meeting_str, meeting_label = sys.argv[1:4]
    stale_warning = None
    if "--stale-warning" in sys.argv:
        idx = sys.argv.index("--stale-warning")
        stale_warning = sys.argv[idx + 1]

    with open(json_path, "r", encoding="utf-8") as f:
        tasks = json.load(f)

    next_meeting = datetime.strptime(next_meeting_str, "%Y-%m-%d").date()
    print(build_agenda(tasks, next_meeting, meeting_label, stale_warning))


if __name__ == "__main__":
    main()
