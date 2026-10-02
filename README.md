# Notible Habits

Habits, tracked where the work already happens. Tick what is due today from
the sidebar on the way past, and open the Habits card — its own entry in the
navigation, beside Notes — when you want the year, the streaks and the
schedules. A habit can be daily, or on chosen weekdays, or every N days, or a
target of so many times a week.

Nothing leaves the machine. The plugin asks for no `network` permission and
has no account, no server and no timer.

## What it looks like

- **The Habits card** — a navigation entry of its own beside Notes, opening a
  full-width pane, and the plugin's home. Every habit stands in a list down
  the left with today's checkbox where something is due, its schedule and its
  streak; picking one draws it whole on the right — the numbers, a year of
  days as a grid, the schedule editor, and the habit's name with the way to
  remove it. Month labels run along the top of the grid and Mon/Wed/Fri down
  the side, so it reads as a calendar rather than an unlabelled wall of
  squares; a ticked day fills its square solidly in the accent colour, a
  scheduled day that was missed is an empty square, and a day the schedule
  never asked for is a dot with no square at all. Click any past day to
  correct one you forgot to tick. The field under the list adds a habit.
  Setting the schedule, renaming and removing all live here rather than in
  the sidebar: they are things you do to a habit once and then forget, and
  the sidebar is a place you look at every morning.
- **Sidebar** — the checkboxes for the habits due today, with their streaks,
  and nothing else. Ticking today is the one action repeated every morning,
  so it keeps its seat under the note tree; a habit that is not due has
  nothing to ask of you and is not drawn there at all. Everything the sidebar
  used to carry — the habits resting today, the year, the field that adds one
  — is one click away in the card.
- **The command** *Habits: open every habit* takes you to that same card —
  the nav entry and the command are two doors into one screen. It was called
  *open the heatmap* until 0.6.0, which described a link the sidebar used to
  carry rather than the surface it now opens: the year is one panel of it,
  next to the habit list, the streaks, the schedule editor and the field that
  adds one. On a host with nowhere to render a view the command opens the
  surface in a modal instead, wide as the grid and no wider. That is not a
  second implementation: the pane and the dialog are one builder in two
  shapes.

## Where the data lives

Each habit is an ordinary workspace object of type `habit`, with the ticked
days — and one or two more things, below — in its `props`:

```json
{
  "$": { "graphExclude": true },
  "days": ["2026-08-19", "2026-08-20", "2026-08-21"],
  "schedule": { "kind": "weekdays", "weekdays": [0, 2, 4] }
}
```

`days` is a deliberate choice over `context.storage`. Plugin storage is a
per-plugin key/value bag: it does not sync between machines, does not appear
in search or export, and every other installed plugin can read it. As
objects, habits ride along with Notible Sync, workspace export and backup
without this plugin knowing anything about them, and a year of ticks is not
hostage to the plugin staying installed.

`$.graphExclude` is a smaller thing in the same object: `$` is a namespace
inside `props` reserved for signalling between plugins, and Notible Graph
reads `$.graphExclude` to decide what belongs in its picture of the
workspace. A habit is not a note — it has no title anyone wrote as prose, no
parent to be "filed under" — and drawing it as a card floating with "filed
under nothing" underneath would tell the graph's reader something false about
their workspace. Every new habit is created with the flag already set; a
habit made before this version of the plugin is missing it, and gets it
patched in, best-effort, the next time it is loaded.

Removing a habit **trashes** the object rather than deleting it, so a year of
history can be walked back out of the trash.

## The schedule

`props.schedule` is one of exactly four shapes, and `parseSchedule` is the
only thing in the plugin that ever reads a raw one:

```json
{ "kind": "daily" }
{ "kind": "weekdays", "weekdays": [0, 2, 4] }
{ "kind": "interval", "every": 3, "start": "2026-08-03" }
{ "kind": "weekly",   "target": 3 }
```

`weekdays` is Monday=0 … Sunday=6, the week order the rest of the app uses.
`interval` needs an anchor as well as a length, because "every three days"
names a rhythm and not a set of days until you say which three-day grid it
sits on; the anchor is the day the schedule was set, and the rhythm is read
in both directions from it, so switching a year-old habit to every-3-days
does not redraw its whole past as never-scheduled.

**Daily is the absence of the key.** A habit written before schedules existed
has no `schedule` at all, reads as daily, and is never rewritten for it —
that is the whole migration, and it costs no pass over the user's data. A
daily habit still writes no `schedule` key when it is saved, so the two are
the same habit on disk.

**Anything else degrades to daily.** A schedule can arrive by sync from a
newer version, by import, or from any plugin's `objects.create`, so
`parseSchedule` accepts the four shapes above and returns daily for
everything else: a missing kind, a kind this version has never heard of, a
weekday list with nothing in it, an interval with no anchor or an impossible
one, a weekly target of zero or of nine. Daily is the safe failure. A broken
schedule that kept asking every day is a mild annoyance; one that quietly
stopped asking would cost the user the habit and never say so. The same rule
means an unreadable schedule is normalised away on the next write rather than
preserved as an unknown prop — a habit that looks daily in the UI while
carrying something else in its props is a lie waiting to sync somewhere.

## Things that are easy to get wrong, and how this handles them

**Days are local, never UTC.** `toISOString()` is one line shorter and reports
the wrong day for part of every day in any timezone off Greenwich — at 01:00 in
Warsaw it says yesterday, so a tick lands on the wrong square and the streak
counts a miss. Every date here is a local calendar day, and day arithmetic
counts in calendar days rather than 24-hour blocks, so the nights either side
of a daylight-saving change are neither skipped nor repeated. `daysBetween`,
which is what an every-N-days schedule rides on, subtracts `Date.UTC` of the
*local* year/month/day for the same reason: the difference between two local
timestamps is 23 or 25 hours across a clock change, and rounding that would
put an interval habit on the wrong day twice a year.

**A streak means "did not miss what was asked", and the current occurrence is
still open.** One sentence covers all four kinds: *the most recent occurrence
never counts as a miss while it is still open, and it is open until the next
one falls due.*

- **Daily** — the open occurrence is today, which is the old kindness intact:
  a streak ending yesterday still counts, so the number is not a nag that
  reads zero every morning until the box is ticked. One ending the day before
  yesterday does not.
- **Chosen weekdays** — only scheduled days are counted at all, so an unticked
  Tuesday on a Mon/Wed/Fri habit is not a miss and never breaks anything.
  Friday's tick stays open through Saturday and Sunday and goes cold when
  Monday comes due. The alternative — forgiving exactly one calendar day, the
  same as daily — would let a Friday go cold on Sunday morning over a weekend
  where nothing was asked of the user at all, which is the sort of arithmetic
  that teaches people to stop trusting the number.
- **Every N days** — the same, on the rhythm: only due days are counted, and a
  due day stays open for the whole gap until the next one. On a three-day
  habit that means two days of grace, which is proportionate: the point of
  choosing a longer interval is that the day itself matters less.
- **Weekly target** — the unit is the week, not the day, so the streak counts
  consecutive weeks that met the target and the number is *weeks*. The open
  occurrence is this week: it joins the streak the moment the target is met
  and does not break it before then. Counting the open week as a failure
  would show every Monday morning as a broken streak, which is the same nag
  in a larger size.

**The recent-record line counts against what was asked.** "23 of the last 30"
is a lie about a Mon/Wed/Fri habit: it can never exceed 13, so a perfect
record reads as a failing one. The line is now *N of M scheduled* — how many
of the occurrences in the last thirty days were kept. A weekly target is not
counted in days at all: it reads *N of the last 4 weeks*, over the four
**completed** weeks, because including the week in progress would report every
Monday as a week already half lost.

**The heatmap must not lie about the record.** A day the schedule never asked
for is drawn as a bare dot, distinct both from a scheduled day that was missed
(an empty outlined square) and from a day still ahead (a dashed one). A tick on
a day nothing was scheduled counts as a bonus and is drawn outlined rather than
filled — it happened, but it is not a scheduled occurrence and the streak does
not count it.

**Props are untrusted input.** A habit arrives by sync from another machine, by
import, and from any plugin's `objects.create`. Broken JSON, a `days` that is
not an array, an impossible date like `2026-02-30`, duplicates, a schedule of
some shape nobody here recognises — all degrade to an empty or cleaned history
and a daily schedule instead of throwing inside a render. Names are capped and
reach the DOM only through `textContent`; the self-check greps the source for
the markup-assigning properties and fails if one appears.

**The history is capped at ten years of ticks**, oldest first. The blob is read
and rewritten whole on every single tick, so this is where a document would
otherwise quietly become a payload.

**Unknown props are preserved.** A field written by a newer version of this
plugin on another machine survives a tick — and a schedule change — here,
instead of being deleted on every round trip. `$` in particular comes back
whole.

**Month labels are placed by room, not by hope.** Fifty-three columns hold
about four per month with a stub at each end, and labelling every month change
where it falls printed "AugSep" on top of itself. A label is skipped if it
would land within three columns of the last one drawn, and a month is labelled
only if it spans three columns or is the last in the grid — which is why the
ragged month the grid opens in usually goes unnamed. Shrinking the font until
it fits would have been the other way to make the collision go away, and would
have made the labels unreadable instead of absent.

## Surfaces

Three registrations, and the split between them is the whole design:

- `views.register({ id: "surface", title: "Habits", mount })` — the home.
  Core gives a registered view its own nav entry and the full width of the
  main area, keyed `notible.habits:surface`. `mount` is the contract: a
  registration without one shows the nav entry and reports that the view
  supplied nothing to draw. The pane already draws its own border, background
  and radius, so the plugin's root stretches into it and paints none of its
  own — no card inside a card. `mount` returns a `Disposable`, and that is
  where the plugin's `onChange` subscription is dropped; Core calls it on
  navigate-away, disable, reload and uninstall, and clears the container
  itself.
- `ui.registerSlot("workspace.sidebar", …)` — today's ticks, and only those.
- `ui.openView("surface")` — how the command gets the user to that view.
  Added in API 1.8, which is why this plugin declares 1.8 and not 1.7. The id
  is resolved against this plugin's own registrations, so it can only ever
  open the habits' own screen; there is no argument for naming somebody
  else's.
- `ui.modal` — the same surface again, and **still real**. `openView`
  resolves `false` on a host that has nowhere to render a view at all, and on
  one of those the surface still has to open somewhere, so it opens in a
  dialog. Both paths go through one helper, `openHabits`, so the fallback is
  written once — it is the branch no developer's machine takes, and a second
  copy of it would rot unnoticed.

A rejected `openView` is a different thing and is treated as one. It rejects
for a view id this plugin never registered — a typo, a programming error —
rather than for a host that cannot show views, so it surfaces as a notice,
the same channel a failed tick uses. Falling back to the modal there would
hide a bug behind a window that looks like everything working.

This section said until 0.6.0 that no API call puts the user in front of a
plugin's own view. That was true when it was written and is not any more.

An earlier version of this plugin recorded here that it deliberately avoided
`views.register`, because the shipped app builds `build:test-host` →
`CoreOnlyApp` and CoreOnlyApp rendered slots only. That stopped being true:
CoreOnlyApp now reads registered views off the extension-host snapshot and
renders each one as a nav entry. The old claim is worth naming rather than
quietly deleting — a plugin that went on believing it would keep its main
screen in a dialog for no reason at all.

## Permissions

| Permission | Why |
|---|---|
| `data.read` | read the habit objects |
| `data.write` | create, rename, trash a habit, set its schedule, and record a tick |
| `workspace.ui` | the Habits view, opening it, the sidebar's ticks and the fallback modal |

No `network`, no `data.sync`.

## Check

```
node plugins/notible-habits/self-check.mjs
```

Covers the local-day arithmetic including both daylight-saving nights, the
schedule normaliser against a table of malformed input, the surfaces — that
the command reaches the registered view through one `ui.openView` helper whose
`false` branch is the modal and whose rejection is a notice, and that the
manifest declares the 1.8 that call needs — the streak rule for
each of the four kinds — a normal case, a week/month/year rollover, a clock
change, and a broken schedule falling back to daily — the props round trip,
the cap, and the heatmap grid and its labels. Run it after touching anything
in `main.js` — most of what can break here breaks silently and only shows up
as a square on the wrong day.
