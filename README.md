# Task Planner

A drag-and-drop day planner for Obsidian that schedules real notes.

Every task is a note in one folder, surfaced through one **Base**. You drag a row
from that Base onto a calendar grid and it becomes a scheduled block. No checkbox
lines, no `- [ ] 09:00 - 10:00` strings scattered across a hundred daily notes —
the note's frontmatter is the only source of truth, and the grid is just a view
of it.

> Requires Obsidian **1.9.0+** (Bases). Desktop only.

---

## Why this exists

Most Obsidian task workflows spread state across the vault: a checkbox here, a
`⏳ 2026-03-04` there, a daily-note time block somewhere else. Reschedule
something and you are hand-editing three files and hoping the regexes agree.

Task Planner inverts that. One folder of task notes. One Base to filter and sort
them. One grid to place them on. Move a block and the plugin rewrites two
frontmatter fields — that is the entire write path, so it is always
round-trippable and never mangles your prose.

---

## Features

- **Drag from a Base onto the grid.** Any Bases row that resolves to a note
  becomes draggable; drop it on a time slot to schedule it.
- **Drag, resize, and move blocks** already on the grid, with configurable snap
  (default 15 minutes).
- **Drag on empty space to create** a brand-new task note — or search-and-attach
  an existing unscheduled one from the same dialog.
- **Day / 3-day / work-week / week** views, zoom, and a fit-the-day-to-the-window
  toggle.
- **Read-only ICS calendar feeds** (Google Calendar, Fastmail, anything that
  serves iCal) painted behind your tasks, so you plan around meetings you
  already have.
- **Alarms** with a lead time, a custom sound, and optional system
  notifications — they fire whether or not the planner view is open.
- **Category colours** from a palette validated for contrast in both light and
  dark themes, including colour-vision-deficient pairs.
- **Right-click a block** to open the note, mark it done, change duration, push
  it to tomorrow/next week, or unschedule it entirely.
- **Auto status.** Scheduling sets a status; ticking a block writes `done` and a
  completion date.

---

## Install

### From a release (recommended)

1. Download `main.js`, `manifest.json`, and `styles.css` from the
   [latest release](https://github.com/spencerframe/obsidian-task-planner/releases/latest).
2. Drop them into `<your vault>/.obsidian/plugins/task-planner/`.
3. In Obsidian: **Settings → Community plugins → Reload**, then enable
   **Task Planner**.

### With BRAT

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then
**Add beta plugin** → `spencerframe/obsidian-task-planner`.

### From source

There is no build step — the plugin is plain JavaScript.

```bash
git clone https://github.com/spencerframe/obsidian-task-planner \
  "<your vault>/.obsidian/plugins/task-planner"
```

---

## Quick start

### 1. Make a task folder

Create a folder — `tasks/` by default — and put one note in it per task. The
filename is the task title.

### 2. Give task notes this frontmatter

```yaml
---
task start:
task end:
category:
  - Deep work
status:
  - open
priority: 3
estimate: 90
---
```

Leave `task start` and `task end` empty. The plugin fills them when you drop the
task on the grid.

| Property     | Type              | What it does                                                                 |
| ------------ | ----------------- | ---------------------------------------------------------------------------- |
| `task start` | date-time         | **The one field that matters.** A task with a parseable start is scheduled.    |
| `task end`   | date-time         | End of the block. Falls back to `estimate`, then to the default duration.      |
| `estimate`   | number (minutes)  | Used as the block length when there is no `task end`.                          |
| `category`   | text or list      | Drives the block colour and groups your Base.                                  |
| `status`     | text or list      | `done` anywhere in it hides or dims the task, depending on your settings.      |
| `priority`   | number 1–5        | Shown as `P1`–`P5` on the block; handy for sorting the Base.                   |
| `completed`  | date              | Written automatically when you tick a block.                                   |

Accepted date-time shapes: `YYYY-MM-DD HH:mm`, `YYYY-MM-DDTHH:mm`, with optional
seconds, plus bare `YYYY-MM-DD`. Every property name is configurable in settings
if your vault already uses different keys.

### 3. Create the Base

Make a `.base` file anywhere in the vault. A minimal one:

```yaml
filters:
  and:
    - file.inFolder("tasks")
views:
  - type: table
    name: Unscheduled
    filters:
      and:
        - note["task start"].isEmpty()
        - status.contains("done") == false
    order:
      - priority
      - file.name
      - category
      - estimate
  - type: table
    name: Scheduled
    filters:
      and:
        - note["task start"].isEmpty() == false
    order:
      - file.name
      - task start
      - task end
      - category
```

An **Unscheduled** view is the one to keep open next to the planner — it is your
drag source, and rows disappear from it as you place them.

### 4. Open the planner and drag

Click the calendar-clock ribbon icon, or run **Task Planner: Open calendar** from
the command palette. Put the Base in one pane and the planner in another, then
drag rows across.

---

## Using the grid

| Gesture                          | Result                                                         |
| -------------------------------- | -------------------------------------------------------------- |
| Drag a Base row onto a slot      | Schedules that note at the drop time                            |
| Drag on empty grid space         | Opens the new-task dialog with that span pre-filled             |
| Drag a block                     | Moves it; snaps to the configured interval                      |
| Drag a block's top/bottom edge   | Resizes the start or end                                        |
| Click the tick circle            | Marks done and stamps the completion date                       |
| Right-click a block              | Open note · mark done · duration · move to · unschedule         |
| `‹` `›` / **Today**              | Navigate; the step follows the current view mode                |
| `−` `+` / fit button             | Zoom the hour height, or fit the whole day to the pane          |

In the new-task dialog you can either type a title to create a note, or search
for an existing unscheduled task and attach it to the span you just drew.

---

## Calendar feeds

**Settings → Task Planner → Calendars → Feeds → Add.** Paste an ICS URL and pick
a colour, or map the feed to a category so it inherits that category's colour.

In Google Calendar the URL you want is under
**Settings → the calendar → "Secret address in iCal format"**. Treat that URL
like a password — anyone with it can read the calendar. It is stored in the
plugin's `data.json`, which is why this repo's `.gitignore` excludes that file;
do the same if you sync your vault to a public remote.

Feeds are refreshed every 10 minutes, or on demand with the `⟳` button and the
**Refresh calendars** command.

---

## Alarms

Alarms run from the plugin, not the view, so closing the planner does not silence
them. Configure the lead time, volume, a custom sound file, and whether alarms
fire for calendar events, scheduled tasks, or both. **Test the alarm sound** in
the command palette plays one without waiting.

---

## Settings reference

| Group          | Settings                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------- |
| **Tasks**      | Task folder · property names · use estimate as duration · default duration · auto status · show completed |
| **Grid**       | Day start/end hour · snap minutes · row height (px per hour) · fit to window · first day of week |
| **Categories** | Per-category colours, rescan categories                                                       |
| **Alarms**     | Enable · lead time · events/tasks · volume · custom sound · system notification               |
| **Calendars**  | Show events · feeds (name, ICS URL, colour or category)                                        |

---

## Commands

| Command                  | What it does                                       |
| ------------------------ | -------------------------------------------------- |
| `Open calendar`          | Opens or focuses the planner view                  |
| `Refresh calendars`      | Force-refetches every enabled ICS feed             |
| `Test the alarm sound`   | Fires a dummy alarm                                |
| `Diagnose drag and drop` | Writes `task-planner-diagnostics.md` for bug reports |

---

## Troubleshooting

**Bases rows will not drag.** Bases' internal markup changes between Obsidian
releases and the plugin matches a family of row selectors. Run
**Diagnose drag and drop** and open the report it writes — it lists which
selectors matched and which other drag-related plugins are active. Attach it to
an issue.

**A drop lands on the wrong day.** Check that `task start` parses: it must begin
with `YYYY-MM-DD`. A bare number in that field is rejected on purpose rather than
being silently read as a year.

**Tasks do not appear at all.** Confirm the note is inside the configured task
folder and that its `task start` is non-empty. Notes without a start are
unscheduled by definition and only show up in your Base.

**Changes are not sticking.** The plugin verifies every frontmatter write and
raises a notice if the re-read disagrees. If you see one, another plugin is
probably writing the same file — check for conflicting task or frontmatter
automations.

---

## Contributing

Issues and PRs welcome. The plugin is a single `main.js` with no build step and
no dependencies beyond Obsidian's own API, so the loop is: edit, reload Obsidian
(`Ctrl/Cmd+R`), retry.

Please do not commit `data.json` — it holds private calendar URLs.

## License

[MIT](LICENSE)
