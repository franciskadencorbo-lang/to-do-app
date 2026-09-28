#!/usr/bin/env python3
"""
HTML twin of format_agenda.py, laid out for copy/paste into Microsoft Loop.

One table per section, one row per open sub-task:
    Task | Project | Open sub-task | Assignee | Due date
A task's title and project appear on its first row only; the rows for its
other sub-tasks leave those cells blank so the sub-tasks read as a group
under the task. No merged cells (rowspan) — Loop breaks pasted tables that
use them. A task with no open sub-tasks gets a single row.

Loop keeps headings, bold, italics and tables from a rich-text paste but
drops most CSS, so the markup is plain semantic HTML; the <style> block is
only there to make the page readable in a browser before copying.

Usage:
  python format_agenda_html.py <json_path> <next_meeting_date YYYY-MM-DD> <meeting_label> [--stale-warning "text"] [--out path.html]
"""
import html
import json
import sys
from datetime import datetime

from format_agenda import parse_due, sort_key

MY_NAME = "Francis"


def esc(text):
    return html.escape(str(text), quote=True)


def parse_ymd(value):
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError:
        return None


def fmt_date(d):
    return f"{d.strftime('%a %b')} {d.day}" if d else "—"


def due_cell(d, next_meeting):
    """Bold + 'overdue' for anything dated before the meeting day."""
    if not d:
        return "—"
    text = fmt_date(d)
    return f"<strong>{text} · overdue</strong>" if d < next_meeting else text


def subtask_assignee(sub, is_delegate):
    """Who holds a sub-task: the assignee on delegated sub-tasks, otherwise me."""
    if is_delegate and sub.get("delegated"):
        return sub.get("assignee") or "Unassigned"
    return MY_NAME


def task_title_cell(task):
    title = f"<strong>{esc(task.get('title', ''))}</strong>"
    if task.get("notes"):
        title += " 📝"
    if task.get("emailLink"):
        title += f' <a href="{esc(task["emailLink"])}">✉</a>'
    return title


def task_rows(task, next_meeting):
    is_delegate = task.get("category") == "DELEGATE"
    task_due = parse_due(task)
    open_subs = [s for s in task.get("subtasks") or [] if not s.get("completed")]

    if not open_subs:
        assignee = "Unassigned" if is_delegate else MY_NAME
        return [(
            task_title_cell(task), esc(task.get("project") or "—"), "—",
            esc(assignee), due_cell(task_due, next_meeting),
        )]

    # Earliest-dated sub-task first; undated ones (which sit on the task's own
    # date) after the dated ones.
    def sub_key(s):
        d = parse_ymd(s.get("date"))
        return (0, d) if d else (1, task_due or datetime.max.date())

    rows = []
    for i, s in enumerate(sorted(open_subs, key=sub_key)):
        label = esc(s.get("title", ""))
        if s.get("minutes"):
            label += f" <span class=\"mins\">({s['minutes']} min)</span>"
        d = parse_ymd(s.get("date")) or task_due
        rows.append((
            task_title_cell(task) if i == 0 else "",
            esc(task.get("project") or "—") if i == 0 else "",
            "☐ " + label,
            esc(subtask_assignee(s, is_delegate)),
            due_cell(d, next_meeting),
        ))
    return rows


def section(title, tasks, next_meeting):
    if not tasks:
        return ""
    rows_html = []
    for t in sorted(tasks, key=sort_key):
        for i, cells in enumerate(task_rows(t, next_meeting)):
            cls = ' class="first"' if i == 0 else ""
            rows_html.append(f"<tr{cls}>" + "".join(f"<td>{c}</td>" for c in cells) + "</tr>")
    return f"""
<h2>{esc(title)}</h2>
<table>
  <thead>
    <tr><th>Task</th><th>Project</th><th>Open sub-task</th><th>Assignee</th><th>Due date</th></tr>
  </thead>
  <tbody>
{chr(10).join(rows_html)}
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
  tr.first td {{ border-top: 2px solid #9aa3b4; }}
  td:nth-child(4), td:nth-child(5) {{ white-space: nowrap; }}
  .mins {{ color: #666; }}
  .howto {{ color: #666; font-size: 12.5px; margin-top: 28px; }}
</style>
</head>
<body>
<h1>Staff Meeting Agenda — {esc(meeting_label)}</h1>
<p class="meta">Next meeting: {next_meeting.strftime('%A')}, {next_meeting.strftime('%b')} {next_meeting.day}, {next_meeting.year} · generated from the Task Hub export</p>
{warning}
{body}
<p class="howto">To paste into Loop: click anywhere on this page, Ctrl+A, Ctrl+C, then paste into the Loop page. ☐ marks an open sub-task.</p>
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
