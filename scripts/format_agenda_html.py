#!/usr/bin/env python3
"""
HTML twin of format_agenda.py, laid out for copy/paste into Microsoft Loop.

Loop keeps headings, bold and tables from a rich-text paste but drops most
CSS, so the markup is plain semantic HTML: one <h2> + <table> per section,
with the light <style> block only there to make the page readable when it
is opened in a browser before copying.

Usage:
  python format_agenda_html.py <json_path> <next_meeting_date YYYY-MM-DD> <meeting_label> [--stale-warning "text"] [--out path.html]
"""
import html
import sys
from datetime import datetime, date

from format_agenda import parse_due, sort_key

MY_NAME = "Francis"


def esc(text):
    return html.escape(str(text), quote=True)


def fmt_date(d):
    return f"{d.strftime('%a %b')} {d.day}" if d else "—"


def subtask_owner(sub, is_delegate):
    """Who holds a sub-task: the assignee on delegated sub-tasks, otherwise me."""
    if is_delegate and sub.get("delegated"):
        return sub.get("assignee") or "Unassigned"
    return MY_NAME


def task_owners(task):
    """Distinct owners across the task's open sub-tasks, in first-seen order.
    A task with no open sub-tasks is mine unless it is a DELEGATE task."""
    is_delegate = task.get("category") == "DELEGATE"
    owners = []
    for s in task.get("subtasks") or []:
        if s.get("completed"):
            continue
        owner = subtask_owner(s, is_delegate)
        if owner not in owners:
            owners.append(owner)
    if not owners:
        owners = ["Unassigned" if is_delegate else MY_NAME]
    return owners


def open_subtasks_cell(task):
    is_delegate = task.get("category") == "DELEGATE"
    lines = []
    for s in task.get("subtasks") or []:
        if s.get("completed"):
            continue
        bits = [esc(s.get("title", ""))]
        owner = subtask_owner(s, is_delegate)
        if owner != MY_NAME:
            bits.append(f"<em>{esc(owner)}</em>")
        if s.get("minutes"):
            bits.append(f"{s['minutes']} min")
        if s.get("date"):
            try:
                bits.append(fmt_date(datetime.strptime(s["date"], "%Y-%m-%d").date()))
            except ValueError:
                pass
        lines.append("☐ " + " · ".join(bits))
    return "<br>".join(lines) if lines else "—"


def task_row(task, next_meeting):
    due = parse_due(task)
    due_cell = fmt_date(due)
    if task.get("overdue"):
        due_cell = f"<strong>{due_cell} · overdue</strong>"
    project = task.get("project") or "—"
    title = f"<strong>{esc(task.get('title', ''))}</strong>"
    if task.get("notes"):
        title += " 📝"
    if task.get("emailLink"):
        title += f' <a href="{esc(task["emailLink"])}">✉</a>'
    owners = ", ".join(esc(o) for o in task_owners(task))
    priority = esc(task.get("priority", "")).capitalize()
    return (
        "<tr>"
        f"<td>{owners}</td>"
        f"<td>{title}</td>"
        f"<td>{esc(project)}</td>"
        f"<td>{open_subtasks_cell(task)}</td>"
        f"<td>{due_cell}</td>"
        f"<td>{priority}</td>"
        "</tr>"
    )


def section(title, tasks, next_meeting):
    if not tasks:
        return ""
    rows = "\n".join(task_row(t, next_meeting) for t in sorted(tasks, key=sort_key))
    return f"""
<h2>{esc(title)}</h2>
<table>
  <thead>
    <tr><th>Owner</th><th>Task</th><th>Project</th><th>Open sub-tasks</th><th>Due</th><th>Priority</th></tr>
  </thead>
  <tbody>
{rows}
  </tbody>
</table>
"""


def build_html(tasks, next_meeting, meeting_label, stale_warning=None):
    overdue_or_due_soon = [
        t for t in tasks
        if t.get("overdue") is True or ((d := parse_due(t)) and d <= next_meeting)
    ]
    taken = {t.get("title") for t in overdue_or_due_soon}

    automated = [
        t for t in tasks
        if t.get("title") not in taken
        and any(s.get("assignee") == "Claude" and not s.get("completed") for s in t.get("subtasks") or [])
    ]
    taken |= {t.get("title") for t in automated}

    delegated = [t for t in tasks if t.get("category") == "DELEGATE" and t.get("title") not in taken]
    taken |= {t.get("title") for t in delegated}

    other = [t for t in tasks if t.get("title") not in taken]

    warning = f'<p class="warn">⚠️ {esc(stale_warning)}</p>' if stale_warning else ""

    body = "".join([
        section("Needs attention — overdue or due before this meeting", overdue_or_due_soon, next_meeting),
        section("For the team — delegated items", delegated, next_meeting),
        section("Automated — running with Claude", automated, next_meeting),
        section("Status updates — other active work", other, next_meeting),
    ])

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Staff Meeting Agenda — {esc(meeting_label)}</title>
<style>
  body {{ font-family: "Segoe UI", -apple-system, Roboto, Helvetica, Arial, sans-serif; font-size: 14px; color: #222; max-width: 1100px; margin: 24px auto; padding: 0 16px; }}
  h1 {{ font-size: 22px; margin: 0 0 4px; }}
  .meta {{ color: #666; margin: 0 0 20px; }}
  .warn {{ background: #fff4e5; border: 1px solid #f0c27a; padding: 8px 12px; border-radius: 6px; }}
  h2 {{ font-size: 16px; margin: 26px 0 8px; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ border: 1px solid #cfd4dc; padding: 6px 8px; text-align: left; vertical-align: top; }}
  th {{ background: #f1f4fa; }}
  td:nth-child(1) {{ white-space: nowrap; }}
  td:nth-child(5), td:nth-child(6) {{ white-space: nowrap; }}
  .howto {{ color: #666; font-size: 12.5px; margin-top: 28px; }}
</style>
</head>
<body>
<h1>Staff Meeting Agenda — {esc(meeting_label)}</h1>
<p class="meta">Next meeting: {next_meeting.strftime('%A')}, {next_meeting.strftime('%b')} {next_meeting.day}, {next_meeting.year} · generated from the Task Hub export</p>
{warning}
{body}
<p class="howto">To paste into Loop: click anywhere on this page, Ctrl+A, Ctrl+C, then paste into the Loop page. Headings and tables carry over; ☐ marks an open sub-task.</p>
</body>
</html>
"""


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)

    json_path, next_meeting_str, meeting_label = sys.argv[1:4]
    stale_warning = None
    out_path = None
    if "--stale-warning" in sys.argv:
        stale_warning = sys.argv[sys.argv.index("--stale-warning") + 1]
    if "--out" in sys.argv:
        out_path = sys.argv[sys.argv.index("--out") + 1]

    import json
    with open(json_path, "r", encoding="utf-8") as f:
        tasks = json.load(f)

    next_meeting = datetime.strptime(next_meeting_str, "%Y-%m-%d").date()
    output = build_html(tasks, next_meeting, meeting_label, stale_warning)
    if out_path:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(output)
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(output)


if __name__ == "__main__":
    main()
