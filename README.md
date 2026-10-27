# to-do-app
## Cloud sync (private data)

The app's code is public (GitHub Pages). Task data is not: it lives in the
private repo `franciskadencorbo-lang/to-do-data`.

- `taskhub-data.json`: the full list, kept in step by `sync.js`. Each browser
  pulls on open, on focus and every 2 minutes, and pushes 2 seconds after a save.
  If two devices changed the list since the last sync, the app asks which one to keep;
  the replaced list stays in localStorage under `todo.backup.cloudSync.<date>`.
- `planner-active-tasks-latest.json`: the "Send to GitHub" snapshot for the
  staff-meeting agenda routine.

Set-up on each device: Settings ⚙ → "☁ Connect cloud sync", then paste a
fine-grained token limited to `to-do-data` with Contents: Read and write. Connect the
device that holds the tasks first. A device with an empty list never seeds the cloud copy.
