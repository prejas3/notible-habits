/**
 * Notible Habits — habits kept as ordinary workspace objects.
 *
 * One ES module, no build step, no dependencies, no network. Its home is a
 * registered view: CoreOnlyApp reads `views.register` off the extension-host
 * snapshot and gives each view its own nav entry and a full-width pane, so the
 * habit list, the year heatmap and the schedule editor sit beside Notes as a
 * peer rather than squeezed into the bottom of the sidebar. What is left in
 * `workspace.sidebar` is one day's worth of it: the checkboxes for what is due
 * today, and nothing else. The command goes to that same view through
 * `ui.openView` (API 1.8); `ui.modal` is what a host with nowhere to render a
 * view falls back to, which is the one case `openView` answers `false` to. One
 * builder serves both envelopes rather than two that drift apart.
 *
 * A habit is not necessarily daily: it carries a schedule (daily, specific
 * weekdays, every N days, or a weekly target), and every count below is read
 * through that schedule rather than against the calendar.
 *
 * The pure functions below are exported by name so `self-check.mjs` can run
 * them under plain node; the plugin itself is the default export.
 */

// I18N (Hive #28): every UI string goes through t(); Polish is in
// locales/pl.json (checked by scripts/plugin-locale-check.mjs). English until
// onload() hands t over to Core's translator, which also follows a language
// change. tr() only marks a module-level label that is passed to t() later.
let t = (key, values) => (values ? key.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : key);
const tr = (key) => key;

// I18N (Hive #55): text for a count. An `extra` key ("...#few", "...#one") exists
// only in locale files, so English never shows it; an untranslated one falls back.
export const pluralText = (t, forms, count, locale, values) => {
  const category = new Intl.PluralRules(locale || "en").select(count);
  const extra = forms.extra?.[category];
  return t(extra && t(extra) !== extra ? extra : category === "one" ? forms.one : forms.other, values);
};
export const LAST_WEEKS = { one: tr("of the last {count} week"), other: tr("of the last {count} weeks") };
const DAY_STREAK = { one: tr("day streak"), other: tr("day streak"), extra: { one: tr("day streak#one") } };
const WEEK_STREAK = { one: tr("week streak"), other: tr("week streak"), extra: { one: tr("week streak#one"), few: tr("week streak#few") } };
const SCHEDULED = { one: tr("of {count} scheduled"), other: tr("of {count} scheduled"), extra: { one: tr("of {count} scheduled#one") } };

/** Habits are objects, not plugin storage. `context.storage` is a per-plugin
 * key/value bag: it does not sync between machines, does not appear in search
 * or export, and is readable by every other installed plugin. A habit the user
 * keeps for a year belongs in their workspace, where the sync plugin, backup
 * and export already carry it. */
export const HABIT_TYPE = "habit";

/** Ten years of ticks. A props blob is read and re-written whole on every
 * tick, so this is the point where an imported or synced habit stops being a
 * document and starts being a payload.
 * ponytail: one flat cap; nobody needs a per-year rollup at this size. */
const MAX_DAYS = 3660;
/** How much of the past the heatmap draws. A year plus the ragged first week. */
const HEATMAP_WEEKS = 53;
const NAME_LIMIT = 200;
/** An interval longer than this is not a habit any more, and a `start` anchor
 * that far off would make `previousDue` walk for a very long time. */
const MAX_INTERVAL = 365;

/** Short month names for the heatmap's month row. Not `toLocaleDateString`:
 * that depends on the runtime's locale data, which self-check must not, and a
 * plugin panel that silently switches to another language mid-grid would be
 * a stranger bug than a hardcoded English abbreviation. */
const MONTH_ABBR = [tr("Jan"), tr("Feb"), tr("Mar"), tr("Apr"), tr("May"), tr("Jun"), tr("Jul"), tr("Aug"), tr("Sep"), tr("Oct"), tr("Nov"), tr("Dec")];
/** Weekday row labels down the left of the heatmap, GitHub-contribution-graph
 * style: every row would crowd a grid this narrow, so only every other one is
 * labelled. Index matches `heatmapGrid`'s day order, Monday=0 … Sunday=6. */
const WEEKDAY_ABBR = [tr("Mon"), "", tr("Wed"), "", tr("Fri"), "", ""];
/** Full set for the schedule editor's day toggles, same Monday=0 order. */
const WEEKDAY_NAMES = [tr("Mon"), tr("Tue"), tr("Wed"), tr("Thu"), tr("Fri"), tr("Sat"), tr("Sun")];

// ------------------------------------------------------------------ days
//
// Every date here is a LOCAL calendar day, never UTC. `toISOString()` would be
// one line shorter and wrong for half the day in every timezone east or west
// of Greenwich: at 01:00 in Warsaw it reports yesterday, so the user ticks
// today and the streak counts it as a day they missed.

/** Local calendar day of `date`, as `YYYY-MM-DD`. */
export function dayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parse `YYYY-MM-DD` as a local midnight, or null if it is not one. */
export function dayFromKey(key) {
  if (typeof key !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  // Rejects 2026-02-30 and friends, which Date silently rolls forward.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/** `offset` days from `key`, still a local calendar day. Handles DST because
 * it counts in calendar days rather than in 86_400_000 millisecond blocks. */
export function shiftDay(key, offset) {
  const date = dayFromKey(key);
  if (!date) return null;
  date.setDate(date.getDate() + offset);
  return dayKey(date);
}

/**
 * Whole calendar days from `from` to `to`, negative if `to` is earlier, or
 * null if either is not a day key. The subtraction happens on `Date.UTC` of
 * the LOCAL year/month/day — not on the local timestamps, whose difference is
 * 23 or 25 hours across a daylight-saving night and would round an interval
 * habit onto the wrong day twice a year.
 */
export function daysBetween(from, to) {
  const start = dayFromKey(from);
  const end = dayFromKey(to);
  if (!start || !end) return null;
  const utc = (date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((utc(end) - utc(start)) / 86400000);
}

/** Monday=0 … Sunday=6, the week order the rest of the app uses. */
export function weekdayIndex(key) {
  const date = dayFromKey(key);
  if (!date) return null;
  return (date.getDay() + 6) % 7;
}

/** The Monday of `key`'s week, as a day key. */
export function weekStart(key) {
  const index = weekdayIndex(key);
  return index === null ? null : shiftDay(key, -index);
}

// -------------------------------------------------------------- schedule
//
// A habit is daily unless its props say otherwise, and "otherwise" arrives
// from the same untrusted places `days` does. So the normaliser below is the
// only thing that ever reads a raw schedule: everything downstream takes its
// output, and anything it cannot make sense of comes back as daily. That is
// also the whole of the migration — a habit written before schedules existed
// has no `schedule` key, reads as daily, and is never rewritten for it.

/** The daily schedule, which is also what anything unrecognised degrades to. */
const DAILY = { kind: "daily" };

/**
 * Normalise whatever `props.schedule` held into one of exactly four shapes:
 *
 *   { kind: "daily" }
 *   { kind: "weekdays", weekdays: [0..6] }        Monday=0, at least one day
 *   { kind: "interval", every: 1..365, start: "YYYY-MM-DD" }
 *   { kind: "weekly", target: 1..7 }
 *
 * Never throws, never returns anything else. A schedule with no weekdays
 * selected, an interval with no anchor, a weekly target of zero and a kind
 * this version has never heard of are all daily: the failure mode of a broken
 * schedule should be "asks you every day", not "quietly stops asking".
 */
export function parseSchedule(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DAILY;
  if (raw.kind === "weekdays") {
    const weekdays = Array.isArray(raw.weekdays)
      ? [...new Set(raw.weekdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b)
      : [];
    return weekdays.length > 0 ? { kind: "weekdays", weekdays } : DAILY;
  }
  if (raw.kind === "interval") {
    const every = Number.isInteger(raw.every) && raw.every >= 1 && raw.every <= MAX_INTERVAL ? raw.every : null;
    const start = dayFromKey(raw.start) ? raw.start : null;
    return every && start ? { kind: "interval", every, start } : DAILY;
  }
  if (raw.kind === "weekly") {
    const target = Number.isInteger(raw.target) && raw.target >= 1 && raw.target <= 7 ? raw.target : null;
    return target ? { kind: "weekly", target } : DAILY;
  }
  return DAILY;
}

/** A short human line for the schedule, for a row in the habit list and for
 * the editor under the grid. */
export function scheduleLabel(schedule) {
  const plan = parseSchedule(schedule);
  if (plan.kind === "weekdays") return plan.weekdays.map((day) => t(WEEKDAY_NAMES[day])).join(" ");
  if (plan.kind === "interval") return plan.every === 1 ? t("Daily") : t("Every {count} days", { count: plan.every });
  if (plan.kind === "weekly") return plan.target === 1 ? t("Once a week") : t("{count}× a week", { count: plan.target });
  return t("Daily");
}

/**
 * Is `key` a day this schedule asks for? A weekly-target habit answers yes to
 * every day — it asks for a count, not for particular days — so callers that
 * want "is there anything left to do today" use `weekProgress` as well.
 * Anything unparseable answers no rather than throwing; a bad day key is not
 * a day the habit was due on.
 */
export function isDueOn(schedule, key) {
  if (!dayFromKey(key)) return false;
  const plan = parseSchedule(schedule);
  if (plan.kind === "weekdays") return plan.weekdays.includes(weekdayIndex(key));
  if (plan.kind === "interval") {
    const offset = daysBetween(plan.start, key);
    if (offset === null) return false;
    // Modulo both ways: a day BEFORE the anchor is still on the rhythm, so a
    // habit anchored today does not draw its whole past as never-scheduled.
    return ((offset % plan.every) + plan.every) % plan.every === 0;
  }
  return true;
}

/** The latest day on or before `key` this schedule asked for, or null. */
export function lastDueOnOrBefore(schedule, key) {
  const plan = parseSchedule(schedule);
  let cursor = dayFromKey(key) ? key : null;
  // A weekday set has a gap of at most 7 and an interval of at most 365; one
  // extra day covers the search starting the day after a due day.
  for (let step = 0; cursor && step <= MAX_INTERVAL + 1; step += 1) {
    if (isDueOn(plan, cursor)) return cursor;
    cursor = shiftDay(cursor, -1);
  }
  return null;
}

/** The previous day this schedule asked for, strictly before `key`. */
export function previousDue(schedule, key) {
  return lastDueOnOrBefore(schedule, shiftDay(key, -1));
}

/** Ticks inside the Mon–Sun week containing `key`, and the target to beat. */
export function weekProgress(days, key = dayKey(), schedule) {
  const plan = parseSchedule(schedule);
  const monday = weekStart(key);
  const target = plan.kind === "weekly" ? plan.target : 0;
  if (!monday) return { start: null, done: 0, target };
  const set = new Set(days);
  let done = 0;
  for (let day = 0; day < 7; day += 1) {
    if (set.has(shiftDay(monday, day))) done += 1;
  }
  return { start: monday, done, target };
}

// ------------------------------------------------------------- the habit
//
// Trust boundary: `props` is a string that arrived from the database, and the
// database is fed by import, by sync from another machine, and by any plugin's
// `objects.create`. So nothing below trusts its shape, and a habit whose props
// are broken degrades to an empty history and a daily schedule instead of
// throwing inside a render.

/** Read one object into a habit, tolerating anything its props may contain. */
export function parseHabit(object) {
  let parsed = null;
  try {
    parsed = JSON.parse(object?.props || "{}");
  } catch {
    parsed = null;
  }
  const raw = Array.isArray(parsed?.days) ? parsed.days : [];
  const days = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!dayFromKey(entry) || seen.has(entry)) continue;
    seen.add(entry);
    days.push(entry);
    if (days.length >= MAX_DAYS) break;
  }
  days.sort();
  return {
    id: object?.id ?? null,
    name: typeof object?.title === "string" ? object.title.slice(0, NAME_LIMIT) : "",
    days,
    schedule: parseSchedule(parsed?.schedule),
    // Anything else the props carried is kept and written back untouched. A
    // newer version of this plugin on the user's other machine may have added
    // a field, and dropping it here would delete it on every tick from here.
    // `days` and `schedule` are the two this version owns, so they are lifted
    // out and written back from their own normalised values.
    extra: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed, days: undefined, schedule: undefined } : {},
  };
}

/** Ticked days and the schedule back into props, dropping the oldest ticks
 * past the cap. A daily habit writes NO `schedule` key: daily is the absence
 * of one, so a habit that never leaves the default keeps the exact props shape
 * it had before schedules existed, and nothing has to be migrated. */
export function serializeHabit(habit) {
  const days = [...new Set(habit.days.filter((key) => dayFromKey(key)))].sort();
  const kept = days.slice(Math.max(0, days.length - MAX_DAYS));
  const schedule = parseSchedule(habit.schedule);
  const props = { ...habit.extra, days: kept };
  if (schedule.kind === "daily") delete props.schedule;
  else props.schedule = schedule;
  delete props.undefined;
  return JSON.stringify(props);
}

/** Tick or untick one day. Returns a new array; never mutates. */
export function toggleDay(days, key) {
  if (!dayFromKey(key)) return days;
  return days.includes(key) ? days.filter((day) => day !== key) : [...days, key].sort();
}

/**
 * The streak, in the unit the schedule is kept in: consecutive scheduled
 * occurrences not missed, or for a weekly target, consecutive weeks that met
 * it.
 *
 * One rule covers all four kinds: **the most recent occurrence is still open,
 * and an open occurrence is never a miss.** For a daily habit the open
 * occurrence is today, which is exactly the old kindness — a streak the user
 * has not got to yet this morning still reads as alive rather than dropping to
 * zero every day before breakfast. For weekdays and for every-N-days the same
 * sentence says something slightly larger: Friday's tick on a Mon/Wed/Fri
 * habit stays open through the weekend, because nothing has been missed until
 * Monday comes due. For a weekly target the open occurrence is this week.
 *
 * The alternative — forgiving exactly one calendar day for every kind — would
 * mean a Mon/Wed/Fri habit's Friday goes cold on Sunday morning while nothing
 * was asked of the user on Saturday, which is the sort of arithmetic that
 * teaches people to stop trusting the number.
 */
export function streakOf(days, today = dayKey(), schedule) {
  const plan = parseSchedule(schedule);
  if (!dayFromKey(today)) return 0;
  const set = new Set(days);
  if (plan.kind === "weekly") return weeklyStreak(set, today, plan.target);

  let cursor = lastDueOnOrBefore(plan, today);
  if (!cursor) return 0;
  // The open occurrence: pending is not missed. Ticked, it counts like any
  // other, so ticking today grows the number the moment it is clicked.
  if (!set.has(cursor)) cursor = previousDue(plan, cursor);
  let count = 0;
  while (cursor && set.has(cursor) && count < MAX_DAYS) {
    count += 1;
    cursor = previousDue(plan, cursor);
  }
  return count;
}

/** Consecutive weeks that met the target, counting back from this one. The
 * current week is the open occurrence: it adds to the streak once it is met,
 * and does not break it before then. */
function weeklyStreak(set, today, target) {
  const met = (monday) => {
    if (!monday) return false;
    let done = 0;
    for (let day = 0; day < 7; day += 1) if (set.has(shiftDay(monday, day))) done += 1;
    return done >= target;
  };
  let monday = weekStart(today);
  let count = 0;
  if (met(monday)) count += 1;
  monday = shiftDay(monday, -7);
  while (met(monday) && count < MAX_DAYS) {
    count += 1;
    monday = shiftDay(monday, -7);
  }
  return count;
}

/** Ticked days in the last `windowDays`, regardless of schedule. Kept because
 * "how many days did I do this at all" is still a true sentence; the line the
 * surface draws is `scheduleStats`, which counts against what was asked. */
export function countIn(days, today = dayKey(), windowDays = 30) {
  const first = shiftDay(today, -(windowDays - 1));
  if (!first) return 0;
  return days.filter((day) => day >= first && day <= today).length;
}

/**
 * The recent-record line, in whatever unit the schedule makes meaningful:
 *
 *   { done, expected, unit: "scheduled" }  — days asked for in the window
 *   { done, expected: 4, unit: "weeks" }   — weeks that met a weekly target
 *
 * A raw "23 of the last 30" is a lie about a Mon/Wed/Fri habit: it can never
 * exceed 13, so a perfect record reads as a failing one. For a weekly target
 * the day is not the unit at all, so the window is the four COMPLETED weeks
 * before this one — counting the open week would report every Monday as a
 * week already half lost.
 */
export function scheduleStats(days, today = dayKey(), schedule, windowDays = 30) {
  const plan = parseSchedule(schedule);
  if (!dayFromKey(today)) return { done: 0, expected: 0, unit: "scheduled" };
  const set = new Set(days);
  if (plan.kind === "weekly") {
    let monday = shiftDay(weekStart(today), -7);
    let done = 0;
    for (let week = 0; week < 4 && monday; week += 1) {
      let ticks = 0;
      for (let day = 0; day < 7; day += 1) if (set.has(shiftDay(monday, day))) ticks += 1;
      if (ticks >= plan.target) done += 1;
      monday = shiftDay(monday, -7);
    }
    return { done, expected: 4, unit: "weeks" };
  }
  let done = 0;
  let expected = 0;
  let cursor = shiftDay(today, -(windowDays - 1));
  for (let step = 0; step < windowDays && cursor; step += 1) {
    if (isDueOn(plan, cursor)) {
      expected += 1;
      if (set.has(cursor)) done += 1;
    }
    cursor = shiftDay(cursor, 1);
  }
  return { done, expected, unit: "scheduled" };
}

/**
 * The heatmap as weeks of seven local days, oldest week first, each week
 * starting Monday — the same week start the rest of the app uses. The last
 * column ends on `today`, so the grid always finishes where the user is.
 *
 * `scheduled` is what keeps the grid from lying: a Tuesday on a Mon/Wed/Fri
 * habit was never asked for, and drawing it the same as a Wednesday the user
 * missed would turn a perfect record into a wall of failure.
 */
export function heatmapGrid(days, today = dayKey(), weeks = HEATMAP_WEEKS, schedule) {
  const end = dayFromKey(today);
  if (!end) return [];
  const plan = parseSchedule(schedule);
  const ticked = new Set(days);
  // Monday=0 … Sunday=6, so the current week is filled up to today and the
  // remaining slots of this week are drawn as "not yet".
  const weekday = (end.getDay() + 6) % 7;
  const lastMonday = shiftDay(today, -weekday);
  const grid = [];
  for (let week = weeks - 1; week >= 0; week -= 1) {
    const monday = shiftDay(lastMonday, -week * 7);
    const column = [];
    for (let day = 0; day < 7; day += 1) {
      const key = shiftDay(monday, day);
      column.push({ key, ticked: ticked.has(key), future: key > today, scheduled: isDueOn(plan, key) });
    }
    grid.push(column);
  }
  return grid;
}

/** The five states a heatmap cell can be drawn in, kept here rather than in
 * the DOM code so the self-check can assert them: a day that was never asked
 * for must not look like one that was asked for and missed, and a tick on a
 * day nobody asked for is a bonus, not a scheduled hit. */
export function cellState(cell) {
  if (!cell) return "skip";
  if (cell.future) return "future";
  if (cell.ticked) return cell.scheduled === false ? "bonus" : "on";
  return cell.scheduled === false ? "skip" : "off";
}

/**
 * One label per week column of `heatmapGrid`'s output, or `null` where no
 * label is drawn. A column starts a new month when its Monday (`week[0].key`)
 * falls in a different month than the previous column's Monday — including
 * across a year boundary, where the month number alone (12 → 1) is already
 * enough to tell them apart.
 *
 * Detecting the month change is the easy half. The hard half is that a
 * 53-column grid has a stub month at each end and about four columns per month
 * in between, so labelling every change draws "AugSep" on top of itself. Two
 * rules, both about room rather than about font size:
 *
 *   - a label is skipped if it would land within `minGap` columns of the last
 *     one actually drawn, and
 *   - a month gets a label only if it spans at least `minGap` columns, unless
 *     it is the last month in the grid, which has the right-hand edge to
 *     itself.
 *
 * The ragged month the grid opens in is therefore usually unlabelled, which is
 * the right trade: it is two columns of a month the next label already names,
 * and it was the collision the user was looking at.
 */
export function monthLabels(grid, minGap = 3) {
  const starts = [];
  let previousMonth = null;
  grid.forEach((week, index) => {
    const key = week?.[0]?.key;
    if (!key) return;
    const month = Number(key.slice(5, 7));
    if (month !== previousMonth) starts.push({ index, month });
    previousMonth = month;
  });
  const labels = grid.map(() => null);
  let lastDrawn = -Infinity;
  starts.forEach((start, position) => {
    const nextIndex = starts[position + 1]?.index ?? grid.length;
    const span = nextIndex - start.index;
    const isLast = position === starts.length - 1;
    if (start.index - lastDrawn < minGap) return;
    if (span < minGap && !isLast) return;
    labels[start.index] = MONTH_ABBR[start.month - 1] ?? null;
    lastDrawn = start.index;
  });
  return labels;
}

/** The label for heatmap grid row `index` (0 = Monday … 6 = Sunday), or "" for
 * an unlabelled row kept only so the column still lines up. */
export function weekdayLabel(index) {
  return WEEKDAY_ABBR[index] ?? "";
}

// ------------------------------------------------------------------- DOM

function element(tag, properties = {}, children = []) {
  const node = Object.assign(document.createElement(tag), properties);
  for (const child of children) node.append(child);
  return node;
}

/**
 * Every string drawn below reaches the DOM through `textContent`, never
 * through markup composed from a string. Habit names arrive from sync and
 * import like any other object title; CSP would stop an injected script, but
 * `style-src 'unsafe-inline'` would still let injected markup cover the
 * workspace. `self-check.mjs` greps this file for the markup-assigning
 * properties and fails the build if one appears.
 */
function text(tag, value, className) {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
}

class Habits {
  constructor(context) {
    this.context = context;
    this.habits = [];
    this.listeners = new Set();
    this.loading = true;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  announce() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A broken surface must not stop the others from redrawing.
      }
    }
  }

  async load() {
    try {
      const objects = await this.context.data.objects.query({ type: HABIT_TYPE, limit: 200 });
      this.habits = objects.map(parseHabit).sort((a, b) => a.name.localeCompare(b.name));
      this.error = null;
      // Best-effort, never awaited into the load path: a habit created before
      // this version shipped is missing `props.$.graphExclude`, and self-heals
      // it in place the next time it is loaded. A failed patch here must not
      // stop the sidebar from showing the habit list it already has. Note that
      // a missing `schedule` is NOT healed: absent means daily, which is what
      // the habit already behaves as, so there is nothing to write.
      void this._healExclusion(objects);
    } catch (cause) {
      // invoke rejects with strings, not Errors, so `cause.message` is often
      // undefined. Show what came back rather than "undefined".
      this.error = String(cause?.message ?? cause);
    } finally {
      this.loading = false;
      this.announce();
    }
  }

  /** Patch `props.$.graphExclude = true` into any loaded habit that does not
   * already carry it — a habit made under an older version of this plugin,
   * before notible-graph's opt-out convention existed. One write per habit
   * that needs it, each independently caught: one bad patch must not stop the
   * others from healing. */
  async _healExclusion(objects) {
    for (const object of objects) {
      const habit = parseHabit(object);
      const namespace = habit.extra?.$;
      const alreadySet = namespace && typeof namespace === "object" && !Array.isArray(namespace) && namespace.graphExclude === true;
      if (alreadySet) continue;
      const clean = namespace && typeof namespace === "object" && !Array.isArray(namespace) ? namespace : {};
      const extra = { ...habit.extra, $: { ...clean, graphExclude: true } };
      try {
        await this.context.data.objects.update(object.id, { props: serializeHabit({ ...habit, extra }) });
      } catch {
        // Best-effort: it will be offered again next load.
      }
    }
  }

  async create(name) {
    const title = String(name ?? "").trim().slice(0, NAME_LIMIT);
    if (!title) return;
    // No `content`: Core runs require_json over it, and "" is not JSON, so the
    // whole create was rejected and the habit silently never appeared.
    // `$.graphExclude` tells notible-graph (or any future workspace-graph
    // reader) this is not a note: a habit has no business appearing as a card
    // "filed under nothing".
    // No `schedule` either: a new habit is daily, and daily is the absence of
    // the key. The schedule is set afterwards, beside the habit's own grid in
    // the view, so that adding a habit stays one field and one Enter.
    await this.run(() => this.context.data.objects.create({ type: HABIT_TYPE, title, props: JSON.stringify({ $: { graphExclude: true }, days: [] }) }));
  }

  /** Run a write, tell the user if it failed, reload either way. A swallowed
   * rejection here is invisible: the list simply stays empty. */
  async run(action) {
    try {
      await action();
    } catch (cause) {
      this.context.ui.notice(String(cause?.message ?? cause));
    }
    await this.load();
  }

  async rename(habit, name) {
    const title = String(name ?? "").trim().slice(0, NAME_LIMIT);
    if (!title || title === habit.name) return;
    await this.run(() => this.context.data.objects.update(habit.id, { title }));
  }

  async remove(habit) {
    // Trash, not delete: Core has a trash the user can walk back out of, and
    // a year of ticks is not something a plugin should be able to end.
    await this.run(() => this.context.data.objects.trash(habit.id));
  }

  /** Write a new schedule, leaving the ticks — and every prop this version
   * does not own, `$` included — exactly where they were. */
  async setSchedule(habit, schedule) {
    const plan = parseSchedule(schedule);
    habit.schedule = plan;
    this.announce();
    await this.run(() => this.context.data.objects.update(habit.id, { props: serializeHabit({ ...habit, schedule: plan }) }));
  }

  async toggle(habit, key) {
    const days = toggleDay(habit.days, key);
    // Optimistic: the checkbox has to answer the click, not the round trip.
    habit.days = days;
    this.announce();
    try {
      await this.context.data.objects.update(habit.id, { props: serializeHabit({ ...habit, days }) });
    } catch (cause) {
      this.context.ui.notice(t("Could not save that tick: {reason}", { reason: String(cause?.message ?? cause) }));
      await this.load();
    }
  }
}

// ------------------------------------------------------------- surfaces

/** Add a habit where habits are used. It lived in Settings, which meant the
 * one thing a new user needs was three screens away from the empty list
 * telling them to go there; it then lived in the sidebar, which is today's
 * ticks and nothing else now. It sits under the habit list in the view, next
 * to the habits it is about to join. One field, still: a new habit is daily,
 * and its schedule is set later, beside its grid. */
function addField(habits) {
  const field = element("input", { type: "text", placeholder: t("New habit"), maxLength: NAME_LIMIT, className: "nhab-input nhab-input--quiet" });
  const submit = () => {
    const name = field.value.trim();
    field.value = "";
    if (name) void habits.create(name);
  };
  field.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    submit();
  });
  // Enter was the only way in: typing a name and clicking anywhere else
  // discarded it silently, which reads as the app ignoring you. Blur commits
  // the same way a note title does, as long as there is something to commit
  // — an empty field losing focus is just the user clicking away, not a
  // habit called "".
  field.addEventListener("blur", () => { if (field.value.trim()) submit(); });
  return field;
}

/** The streak as the sidebar and the view say it: days for the day-shaped
 * schedules, weeks for a weekly target, and an em dash for none yet. */
function streakText(habit, today) {
  const streak = streakOf(habit.days, today, habit.schedule);
  if (streak === 0) return "—";
  return habit.schedule.kind === "weekly" ? `${streak}w` : `${streak}d`;
}

/**
 * Is there anything to ask about today? For the three day-shaped schedules
 * that is the schedule's own answer. A weekly-target habit is due every day
 * until the week's target is met — after that it stops asking, which is the
 * whole point of setting a target rather than a daily tick. A day already
 * ticked stays in the asked group so the tick can be taken back.
 */
function isAskedToday(habit, today) {
  if (habit.days.includes(today)) return true;
  if (habit.schedule.kind === "weekly") {
    const progress = weekProgress(habit.days, today, habit.schedule);
    return progress.done < progress.target;
  }
  return isDueOn(habit.schedule, today);
}

/** One sidebar row: today's checkbox, the habit's name, and the streak. The
 * sidebar is now this and nothing else — a habit that is not due today has
 * nothing to ask of the user, so it is not drawn here at all. Its schedule,
 * its year, its name and its removal are all in the Habits view, which is
 * where a thing you do to a habit rather than with it belongs. */
function sidebarRow(habits, habit, today) {
  const done = habit.days.includes(today);
  const label = element("label", {}, []);
  const box = element("input", { type: "checkbox", checked: done, className: "nhab-check" });
  box.addEventListener("change", () => { void habits.toggle(habit, today); });
  label.append(box);
  label.append(text("span", habit.name || t("Untitled habit"), "nhab-today__name"));
  if (habit.schedule.kind === "weekly") {
    const progress = weekProgress(habit.days, today, habit.schedule);
    label.append(text("small", `${progress.done}/${progress.target}`, "nhab-today__week"));
  }
  const row = element("li", { className: "nhab-today__row" }, [label, text("small", streakText(habit, today), "nhab-today__streak")]);
  row.dataset.done = done ? "yes" : "no";
  row.title = `${habit.name || t("Untitled habit")} · ${scheduleLabel(habit.schedule)}`;
  return row;
}

/**
 * The sidebar: today's ticks, full stop.
 *
 * It used to carry the whole plugin — the habits resting today, a link to the
 * heatmap, a field to add one — which is what made it a strip of small print
 * pinned under the note tree instead of a place to click one box on the way
 * past. Ticking today is worth a permanent seat because it is the one thing
 * done every morning; everything else moved to the view, which has the room
 * for it.
 */
function mountSidebar(habits, container) {
  const root = element("div", { className: "nhab" });
  root.dataset.mode = "side";
  root.append(element("style", { textContent: styles }));
  const shell = element("div", { className: "nhab-side" });
  root.append(shell);

  const render = () => {
    shell.replaceChildren();
    shell.append(element("div", { className: "nhab-side__head" }, [text("span", t("Habits"))]));

    if (habits.loading) {
      shell.append(text("p", t("Loading…"), "nhab-empty"));
      return;
    }
    if (habits.error) {
      shell.append(text("p", habits.error, "nhab-empty"));
      return;
    }

    const today = dayKey();
    const asked = habits.habits.filter((habit) => isAskedToday(habit, today));
    if (asked.length === 0) {
      // Two different silences, and the difference matters: a workspace with
      // no habits in it should say so, or the empty strip reads as broken.
      shell.append(text("p", habits.habits.length === 0 ? t("No habits yet — add one in Habits.") : t("Nothing due today."), "nhab-empty"));
      return;
    }

    const list = element("ul", { className: "nhab-today" });
    for (const habit of asked) list.append(sidebarRow(habits, habit, today));
    shell.append(list);
  };

  const stop = habits.onChange(render);
  render();
  container.append(root);
  return { dispose: () => { stop(); root.remove(); } };
}

/** The schedule editor, under the habit's own grid on the surface. Four
 * kinds as one row of pills, and only the chosen kind's controls below it —
 * a schedule is a single choice, so showing all four sets of inputs at once
 * would be four times the surface for the same one decision. */
function scheduleEditor(habits, habit, today) {
  const plan = habit.schedule;
  const block = element("div", { className: "nhab-sched" });
  block.append(text("h4", t("Schedule"), "nhab-sub"));

  const kinds = [
    ["daily", t("Daily")],
    ["weekdays", t("Weekdays")],
    ["interval", t("Every N days")],
    ["weekly", t("Times a week")],
  ];
  const row = element("div", { className: "nhab-chips" });
  for (const [kind, label] of kinds) {
    const chip = element("button", {
      type: "button",
      className: plan.kind === kind ? "is-active" : "",
      textContent: label,
      // Switching kind needs a shape the normaliser will keep, so each carries
      // a sane default: today's weekday, an interval anchored today, three a
      // week. Anything the normaliser rejects would silently land back on
      // daily and the pill would spring back, which reads as a broken button.
      onclick: () => {
        if (kind === plan.kind) return;
        if (kind === "weekdays") return void habits.setSchedule(habit, { kind, weekdays: [weekdayIndex(today) ?? 0] });
        if (kind === "interval") return void habits.setSchedule(habit, { kind, every: 2, start: today });
        if (kind === "weekly") return void habits.setSchedule(habit, { kind, target: 3 });
        return void habits.setSchedule(habit, { kind: "daily" });
      },
    });
    row.append(chip);
  }
  block.append(row);

  if (plan.kind === "weekdays") {
    const days = element("div", { className: "nhab-chips" });
    for (let index = 0; index < 7; index += 1) {
      const on = plan.weekdays.includes(index);
      const chip = element("button", {
        type: "button",
        className: on ? "is-active" : "",
        textContent: t(WEEKDAY_NAMES[index]),
        onclick: () => {
          const next = on ? plan.weekdays.filter((day) => day !== index) : [...plan.weekdays, index];
          // Unticking the last day would normalise straight back to daily,
          // which is not what "clear every day" means to anyone. Refuse it.
          if (next.length === 0) return;
          void habits.setSchedule(habit, { kind: "weekdays", weekdays: next });
        },
      });
      days.append(chip);
    }
    block.append(days);
  }

  if (plan.kind === "interval") {
    const every = element("input", { type: "number", min: "1", max: String(MAX_INTERVAL), value: String(plan.every), className: "nhab-input nhab-input--number" });
    every.addEventListener("change", () => {
      const value = Math.round(Number(every.value));
      if (!Number.isInteger(value) || value < 1 || value > MAX_INTERVAL) {
        every.value = String(plan.every);
        return;
      }
      void habits.setSchedule(habit, { kind: "interval", every: value, start: plan.start });
    });
    const anchor = element("button", {
      type: "button",
      className: "nhab-button nhab-button--quiet",
      textContent: t("Restart today"),
      onclick: () => { void habits.setSchedule(habit, { kind: "interval", every: plan.every, start: today }); },
    });
    block.append(element("div", { className: "nhab-field" }, [
      text("span", t("Every"), "nhab-field__label"),
      every,
      text("span", t("days, counting from {date}", { date: plan.start }), "nhab-field__label"),
      anchor,
    ]));
  }

  if (plan.kind === "weekly") {
    const target = element("input", { type: "number", min: "1", max: "7", value: String(plan.target), className: "nhab-input nhab-input--number" });
    target.addEventListener("change", () => {
      const value = Math.round(Number(target.value));
      if (!Number.isInteger(value) || value < 1 || value > 7) {
        target.value = String(plan.target);
        return;
      }
      void habits.setSchedule(habit, { kind: "weekly", target: value });
    });
    const progress = weekProgress(habit.days, today, plan);
    block.append(element("div", { className: "nhab-field" }, [
      text("span", t("Any"), "nhab-field__label"),
      target,
      text("span", t("days a week · {count} so far this week", { count: progress.done }), "nhab-field__label"),
    ]));
  }

  block.append(text("p", scheduleLabel(plan), "nhab-hint"));
  return block;
}

/**
 * The habit list: every habit, whether or not it is due today, with today's
 * checkbox where there is something to tick.
 *
 * This is the half of the surface the sidebar gave up. Picking a row swaps
 * the detail beside it; the checkbox is the same one-click tick as the
 * sidebar's, because a list of habits the user cannot tick from is a list
 * that sends them somewhere else to do the obvious thing. A habit with
 * nothing due keeps the checkbox's column empty rather than offering a box:
 * ticking a day the schedule never asked for is a correction, and corrections
 * are made on the grid, where the day is visible.
 */
/**
 * Right-click on a picker row: the app's own convention for a per-row action
 * (see the note tree) is a context menu, not an inline icon button sitting on
 * every row whether it is needed or not. "Remove" only sends the habit to the
 * trash — same one-way-recoverable action the detail pane's button takes — so
 * it fires on click rather than arming a second confirm click the menu would
 * have already closed by then.
 */
function openRowMenu(event, habits, habit) {
  event.preventDefault();
  document.querySelector(".nhab-row-menu")?.remove();
  const menu = element("div", { className: "nhab-row-menu" });
  const remove = element("button", { type: "button", textContent: t("Remove"), onclick: () => { void habits.remove(habit); menu.remove(); } });
  menu.append(remove);
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  document.body.append(menu);
  const close = (closeEvent) => {
    if (menu.contains(closeEvent.target)) return;
    menu.remove();
    document.removeEventListener("mousedown", close, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (keyEvent) => { if (keyEvent.key === "Escape") close(keyEvent); };
  // Capture phase, and deferred a tick: the same right-click that opened the
  // menu also bubbles a "mousedown" on some platforms, which would otherwise
  // close the menu in the same breath it opened.
  setTimeout(() => {
    document.addEventListener("mousedown", close, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
}

function habitPicker(habits, today, selectedId, select) {
  const list = element("ul", { className: "nhab-picker__list" });
  for (const habit of habits.habits) {
    const name = habit.name || t("Untitled habit");
    const done = habit.days.includes(today);
    const row = element("li", { className: "nhab-picker__row" });
    row.dataset.active = habit.id === selectedId ? "yes" : "no";
    row.dataset.done = done ? "yes" : "no";
    row.addEventListener("contextmenu", (event) => openRowMenu(event, habits, habit));
    if (isAskedToday(habit, today)) {
      const box = element("input", { type: "checkbox", checked: done, className: "nhab-check" });
      box.setAttribute("aria-label", `${name}: ${today}`);
      box.addEventListener("change", () => { void habits.toggle(habit, today); });
      row.append(box);
    } else {
      row.append(element("span", { className: "nhab-check nhab-check--empty" }));
    }
    const pick = element("button", { type: "button", className: "nhab-picker__pick", onclick: () => select(habit.id) });
    pick.setAttribute("aria-pressed", habit.id === selectedId ? "true" : "false");
    pick.append(text("span", name, "nhab-picker__name"));
    pick.append(text("small", scheduleLabel(habit.schedule), "nhab-picker__meta"));
    row.append(pick, text("small", streakText(habit, today), "nhab-picker__streak"));
    list.append(row);
  }
  return list;
}

/** The selected habit, drawn whole: the numbers, the year, the schedule, the
 * name and the way out. A year of one habit is 371 cells, so one habit is
 * drawn at a time and the rest are a list — several grids at once is a wall
 * nobody reads. */
function habitDetail(habits, habit, today) {
  const detail = element("div", { className: "nhab-detail" });
  detail.append(text("h3", habit.name || t("Untitled habit"), "nhab-detail__title"));

  const streak = streakOf(habit.days, today, habit.schedule);
  const stats = scheduleStats(habit.days, today, habit.schedule, 30);
  // The published sentence. Weeks, not days, when the schedule's unit is the
  // week: a "day streak" on a 3×-a-week habit would name the wrong thing.
  // "of the last N weeks" takes the count's plural form.
  const locale = habits.context.i18n?.locale;
  const span = (phrase) => text("span", ` ${phrase}`);
  detail.append(element("p", { className: "nhab-stats" }, [
    text("strong", String(streak)),
    span(pluralText(t, habit.schedule.kind === "weekly" ? WEEK_STREAK : DAY_STREAK, streak, locale, { count: streak })),
    text("span", " · "),
    text("strong", String(stats.done)),
    // "of the last 30" is only true of a daily habit; anything else is
    // counted against what its schedule actually asked for.
    ...(stats.unit === "weeks"
      ? [span(pluralText(t, LAST_WEEKS, stats.expected, locale, { count: stats.expected }))]
      : [span(pluralText(t, SCHEDULED, stats.expected, locale, { count: stats.expected }))]),
    text("span", " · "),
    text("strong", String(habit.days.length)),
    span(t("all time")),
  ]));

  const weeks = heatmapGrid(habit.days, today, HEATMAP_WEEKS, habit.schedule);
  const heatmap = element("div", { className: "nhab-heatmap" });

  const monthRow = element("div", { className: "nhab-grid__months" });
  for (const label of monthLabels(weeks)) {
    monthRow.append(text("span", label ? t(label) : "", "nhab-grid__month"));
  }
  heatmap.append(monthRow);

  const dayLabels = element("div", { className: "nhab-grid__daylabels" });
  for (let row = 0; row < 7; row += 1) dayLabels.append(text("span", weekdayLabel(row) && t(weekdayLabel(row))));
  heatmap.append(dayLabels);

  const grid = element("div", { className: "nhab-grid" });
  for (const week of weeks) {
    const column = element("div", { className: "nhab-grid__week" });
    for (const cell of week) {
      const state = cellState(cell);
      const button = element("button", { type: "button", className: "nhab-cell" });
      button.dataset.state = state;
      button.disabled = cell.future;
      // The title is the only thing telling the user which day a square
      // is; a heatmap you cannot read a date off is decoration. A day
      // the schedule never asked for says so, or the empty square reads
      // as a day the user let slip.
      button.title = state === "skip" ? t("{date} — not scheduled", { date: cell.key }) : cell.key;
      const suffix = cell.ticked ? t(", done") : state === "skip" ? t(", not scheduled") : "";
      button.setAttribute("aria-label", `${habit.name}: ${cell.key}${suffix}`);
      if (!cell.future) button.addEventListener("click", () => { void habits.toggle(habit, cell.key); });
      column.append(button);
    }
    grid.append(column);
  }
  heatmap.append(grid);
  detail.append(heatmap);

  const legend = element("div", { className: "nhab-legend" });
  for (const [state, label] of [["on", t("done")], ["off", t("scheduled, missed")], ["skip", t("not scheduled")], ["future", t("still ahead")]]) {
    const swatch = element("span", { className: "nhab-cell nhab-cell--legend" });
    swatch.dataset.state = state;
    legend.append(element("span", { className: "nhab-legend__item" }, [swatch, text("span", label)]));
  }
  detail.append(legend);

  // Two columns under the grid: the schedule on the left, the habit's own
  // name and its removal on the right. The grid is 795px wide and the things
  // below it are short, so one narrow column under it would leave the same
  // empty half the modal was criticised for.
  const name = element("input", { type: "text", value: habit.name, maxLength: NAME_LIMIT, className: "nhab-input" });
  name.addEventListener("change", () => { void habits.rename(habit, name.value); });
  const remove = element("button", { type: "button", className: "nhab-button nhab-button--quiet", textContent: t("Remove") });
  // Two clicks, no confirm dialog: a modal confirm blocks the extension host,
  // and this only sends the habit to the trash.
  let armed = false;
  remove.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      remove.textContent = t("Remove — sure?");
      setTimeout(() => { armed = false; remove.textContent = t("Remove"); }, 4000);
      return;
    }
    void habits.remove(habit);
  });
  const identity = element("div", { className: "nhab-ident" }, [
    text("h4", t("This habit"), "nhab-sub"),
    element("div", { className: "nhab-list__row" }, [name, remove]),
    text("p", t("Click any past day in the grid to correct it."), "nhab-hint"),
  ]);

  detail.append(element("div", { className: "nhab-foot" }, [scheduleEditor(habits, habit, today), identity]));
  return detail;
}

/**
 * The plugin's home, built once and mounted in two places.
 *
 * `views.register` is what the shipped Test Host renders as a nav entry of its
 * own next to Notes, opening a full-width pane — which is where a year grid,
 * a schedule editor and a habit's name belong. It is where the command sends
 * the user too, through `ui.openView`. The same builder still serves
 * `ui.modal`, because a host can register views and have nowhere to show one;
 * on such a host the surface still has to open. Two implementations of one
 * surface would have drifted inside a version, so there is one, and `mode` is
 * the only thing that differs.
 *
 * `mode` is a data attribute the stylesheet reads, not a branch in the markup:
 * the pane stands the habit list down the left of the detail, and the modal —
 * as wide as the grid and no wider — lays the same list above it as a row of
 * pills. The pane's root stretches and paints nothing: Core's pane already has
 * the border, the background and the radius, and a card drawn inside a card is
 * the house rule this codebase keeps.
 */
function mountSurface(habits, container, mode) {
  let selectedId = habits.habits[0]?.id ?? null;
  const root = element("div", { className: "nhab" });
  root.dataset.mode = mode;
  root.append(element("style", { textContent: styles }));
  const shell = element("div", { className: "nhab-surface" });
  root.append(shell);

  const render = () => {
    shell.replaceChildren();
    if (habits.loading) {
      shell.append(text("p", t("Loading…"), "nhab-empty"));
      return;
    }
    if (habits.error) {
      shell.append(text("p", habits.error, "nhab-empty"));
      return;
    }

    const today = dayKey();
    if (habits.habits.some((habit) => habit.id === selectedId) === false) selectedId = habits.habits[0]?.id ?? null;

    const picker = element("div", { className: "nhab-picker" });
    if (habits.habits.length > 0) {
      picker.append(habitPicker(habits, today, selectedId, (id) => { selectedId = id; render(); }));
    }
    picker.append(addField(habits));
    shell.append(picker);

    const habit = habits.habits.find((candidate) => candidate.id === selectedId);
    if (!habit) {
      // The one place a first-run message belongs: the surface that owns
      // adding a habit is the surface that has to say there are none.
      shell.append(element("div", { className: "nhab-detail" }, [
        text("p", t("No habits yet. Name one in the field under the list and press Enter."), "nhab-empty"),
      ]));
      return;
    }
    shell.append(habitDetail(habits, habit, today));
  };

  const stop = habits.onChange(render);
  render();
  container.append(root);
  // Core disposes this on navigate-away, disable, reload and uninstall, and
  // clears the container itself. The subscription is the plugin's to drop:
  // a leaked listener would redraw a detached tree on every tick for the rest
  // of the session.
  return { dispose: () => { stop(); root.remove(); } };
}

/** The same surface in a modal — the fallback, and nothing else calls it
 * directly. A host that renders no views at all still has to be able to show
 * the habits, and `ui.modal` is the one envelope every host has. */
function openHabitsModal(habits) {
  habits.context.ui.modal({
    title: t("Habits"),
    mount: ({ container }) => mountSurface(habits, container, "modal"),
  });
}

/**
 * The one way in for anything that opens the whole surface: the view if this
 * host renders views, the modal if it does not.
 *
 * `ui.openView` (API 1.8) resolves the id against this plugin's own
 * registrations — "surface" is the one `onload` registers below, and no
 * argument could name anyone else's screen. It resolves `false` only where
 * there is nowhere to put a view, and that is the only condition the modal
 * exists for. Today the command is the sole caller; it is written as a helper
 * anyway, so a second entry point — a sidebar link back to the surface, say —
 * cannot arrive with its own half-remembered copy of the fallback.
 *
 * The caller is a synchronous command handler, so the promise is handled here
 * or nowhere: an unhandled rejection inside one goes to a console nobody has
 * open, and the command reads as doing nothing at all. A rejection does NOT
 * fall through to the modal. `openView` rejects for a view id this plugin
 * never registered — a programming error, not a property of the host — and
 * opening a working-looking dialog on top of that bug would hide it for as
 * long as anyone cared to look. So it is said out loud, through the same
 * `ui.notice` a failed tick uses.
 */
function openHabits(habits) {
  void habits.context.ui.openView("surface").then((shown) => {
    if (!shown) openHabitsModal(habits);
  }).catch((cause) => {
    // invoke rejects with strings rather than Errors, as everywhere else here.
    habits.context.ui.notice(t("Could not open Habits: {reason}", { reason: String(cause?.message ?? cause) }));
  });
}

// ------------------------------------------------------------------ CSS

/*
 * Written on the PUBLIC token contract (--notible-*) with no colour literals,
 * so `scripts/plugin-css-token-check.mjs` passes and the panel follows the
 * user's theme. House rules: an outline instead of a fill, no coloured ribbon,
 * no card inside a card, and no heading where the host already names the
 * surface.
 *
 * The done row used to carry a 3px accent border down its left edge and an
 * accent-tinted background, and the streak was a filled accent pill. Three
 * pieces of accent colour for one boolean, on a surface whose whole idea is
 * warm paper: it read as a ribbon stuck on the side of the sidebar. What is
 * left is the checkbox's own tick — which is what the user actually looks at —
 * plus a muted name, so a done row is legible as done from across the room
 * without a single filled shape. The streak is now type, not a badge.
 */
const styles = `
.nhab { color: var(--notible-text); font-size: 13px; }
/* Fixed to the workspace sidebar (workspace.sidebar slot), which is a flex
   column with everything below the note tree sized to its content — a habit
   list with no cap of its own grows until it shoves Settings and the import
   buttons below it clean off the screen. Past a handful of rows the list
   scrolls internally instead. */
.nhab-side { display: grid; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--notible-border); max-height: 40vh; overflow-y: auto; }
.nhab-side__head { display: flex; align-items: center; justify-content: space-between; color: var(--notible-muted); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.nhab-today { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.nhab-today__row { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-radius: 7px; padding: 5px 8px; }
.nhab-today__row:hover { background: var(--notible-hover); }
.nhab-today__row label { display: flex; align-items: center; gap: 8px; min-width: 0; }
.nhab-today__row label { cursor: pointer; }
/* Custom square checkbox: empty rounded square -> filled bordo with a white
   tick. Drawn from the native input (kept for keyboard + label behaviour) so
   it reads the same in paper and night and gives a bigger click target. */
.nhab-check { appearance: none; -webkit-appearance: none; flex: none; position: relative; width: 15px; height: 15px; margin: 0; border: 1.5px solid var(--notible-border); border-radius: 4px; background: var(--notible-surface); cursor: pointer; transition: background .1s ease, border-color .1s ease; }
.nhab-check:hover { border-color: var(--notible-accent); }
.nhab-check:checked { border-color: var(--notible-accent); background: var(--notible-accent); }
.nhab-check:checked::after { content: ""; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px; border: solid var(--notible-on-accent); border-width: 0 2px 2px 0; transform: rotate(45deg); }
.nhab-check:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: 2px; }
.nhab-today__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nhab-today__row[data-done="yes"] .nhab-today__name { color: var(--notible-muted); }
.nhab-today__week { color: var(--notible-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.nhab-today__streak { flex: none; color: var(--notible-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.nhab-empty, .nhab-hint { margin: 0; color: var(--notible-muted); font-size: 12px; line-height: 1.5; }
.nhab-sub { margin: 0; color: var(--notible-muted); font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }

/* One surface, two shapes.
   In the pane the list stands to the left of the detail. Core hands a
   registered view the whole main area, and one narrow column floating in all
   that space is precisely the complaint that moved this out of a dialog — so
   the root stretches and paints nothing of its own, because Core's pane
   already draws the border, the background and the radius.
   In the modal the grid still sets the width: 53 columns of 12px plus 3px of
   gap is 795px, so the dialog holds exactly that and the same list lies above
   it as a row of pills rather than a column that would push the grid off the
   edge. */
.nhab[data-mode="view"] { display: flex; flex: 1; min-width: 0; }
.nhab-surface { display: grid; gap: 20px; align-content: start; }
/* The detail column used to be a bare 1fr: on a wide window the heatmap (a
   fixed ~800px grid) sat pinned to the left of a canyon of empty paper. A cap
   plus a hard limit on the grid's own column keeps the two in proportion to
   each other instead of to whatever width the window happens to be. */
.nhab[data-mode="view"] .nhab-surface { flex: 1; min-width: 0; max-width: 1280px; grid-template-columns: minmax(190px, 250px) minmax(0, 1fr); align-items: start; }
.nhab[data-mode="modal"] .nhab-surface { gap: 16px; width: min(824px, calc(100vw - 96px)); }

.nhab-picker { display: grid; gap: 8px; align-content: start; min-width: 0; }
.nhab[data-mode="view"] .nhab-picker { border-right: 1px solid var(--notible-border-subtle); padding-right: 16px; }
.nhab-picker__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.nhab[data-mode="modal"] .nhab-picker__list { display: flex; flex-wrap: wrap; gap: 6px; }
.nhab-picker__row { display: flex; align-items: center; gap: 8px; min-width: 0; border-radius: 7px; padding: 5px 8px; }
.nhab-picker__row:hover { background: var(--notible-hover); }
.nhab-picker__row[data-active="yes"] { background: var(--notible-selected-soft); }
.nhab[data-mode="modal"] .nhab-picker__row { border: 1px solid var(--notible-border); border-radius: 999px; padding: 3px 11px 3px 8px; }
.nhab[data-mode="modal"] .nhab-picker__row[data-active="yes"] { border-color: var(--notible-accent); }
.nhab-picker__pick { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; border: 0; border-radius: 4px; background: none; padding: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.nhab[data-mode="modal"] .nhab-picker__pick { flex: none; flex-direction: row; align-items: baseline; gap: 7px; }
.nhab-picker__pick:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: 2px; }
.nhab-picker__name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nhab-picker__row[data-done="yes"] .nhab-picker__name { color: var(--notible-muted); }
.nhab-picker__meta, .nhab-picker__streak { color: var(--notible-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.nhab-picker__streak { flex: none; margin-left: auto; }
/* The empty half of the checkbox column, so a habit with nothing due today
   still lines its name up with the ones that have a box to tick. */
.nhab-check--empty { display: inline-block; width: 15px; height: 15px; }

.nhab-detail { display: grid; gap: 16px; align-content: start; min-width: 0; }
.nhab-detail__title { margin: 0; font-size: 15px; font-weight: 600; }
.nhab-chips button { border: 1px solid var(--notible-border); border-radius: 999px; background: none; padding: 4px 11px; color: var(--notible-muted); font: inherit; font-size: 12px; cursor: pointer; }
.nhab-chips button.is-active { border-color: var(--notible-accent); color: var(--notible-text); }
.nhab-chips button:hover { border-color: var(--notible-accent); }
.nhab-stats { margin: 0; color: var(--notible-muted); font-variant-numeric: tabular-nums; }
.nhab-stats strong { color: var(--notible-text); }
.nhab-heatmap { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; column-gap: 8px; row-gap: 5px; overflow-x: auto; padding-bottom: 4px; }
.nhab-grid__months { grid-column: 2; grid-row: 1; display: flex; gap: 3px; }
.nhab-grid__month { flex: none; width: 15px; font-size: 10px; color: var(--notible-muted); white-space: nowrap; overflow: visible; }
.nhab-grid__daylabels { grid-column: 1; grid-row: 2; display: grid; grid-template-rows: repeat(7, 15px); gap: 3px; align-items: center; font-size: 10px; color: var(--notible-faint); }
.nhab-grid { grid-column: 2; grid-row: 2; display: flex; gap: 3px; }
.nhab-grid__week { display: grid; grid-template-rows: repeat(7, 15px); gap: 3px; }

/* Five states, and the point of the set is that they are told apart at a
   glance: a scheduled day the user missed is a real filled square, a day the
   schedule never asked for is a dot with no square at all, and a tick is the
   only accent on the grid — a lone ticked day in a year has to be findable
   without hunting. */
.nhab-cell { position: relative; width: 15px; height: 15px; padding: 0; border: 1px solid var(--notible-border-subtle); border-radius: 3px; background: var(--notible-hover); cursor: pointer; transition: transform .08s ease, border-color .08s ease; }
.nhab-cell[data-state="on"] { border-color: var(--notible-accent); background: var(--notible-accent); }
.nhab-cell[data-state="bonus"] { border-color: var(--notible-accent); background: var(--notible-selected); }
.nhab-cell[data-state="skip"] { border-color: transparent; background: none; }
.nhab-cell[data-state="skip"]::after { content: ""; position: absolute; inset: 4px; border-radius: 50%; background: var(--notible-faint); opacity: .5; }
.nhab-cell[data-state="future"] { border-style: dashed; border-color: var(--notible-border); background: none; cursor: default; }
.nhab-cell:not(:disabled):hover { border-color: var(--notible-accent); transform: scale(1.2); }
.nhab-cell:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: 1px; }
.nhab-cell--legend { cursor: default; pointer-events: none; }
.nhab-legend { display: flex; flex-wrap: wrap; gap: 14px; color: var(--notible-muted); font-size: 11px; }
.nhab-legend__item { display: flex; align-items: center; gap: 6px; }

.nhab-foot { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 24px; align-items: start; padding-top: 12px; border-top: 1px solid var(--notible-border-subtle); }
.nhab-sched, .nhab-ident { display: grid; gap: 8px; align-content: start; }
.nhab-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.nhab-field { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.nhab-field__label { color: var(--notible-muted); font-size: 12px; }

.nhab-input { flex: 1; min-width: 0; border: 1px solid var(--notible-border); border-radius: 7px; background: var(--notible-surface); padding: 6px 9px; color: var(--notible-text); font: inherit; }
.nhab-input--number { flex: none; width: 62px; font-variant-numeric: tabular-nums; }
.nhab-input--quiet { border-color: transparent; background: none; padding: 4px 4px; color: var(--notible-muted); }
.nhab-input--quiet:hover, .nhab-input--quiet:focus { border-color: var(--notible-border); color: var(--notible-text); }
.nhab-input:focus-visible { outline: 2px solid var(--notible-accent); outline-offset: 1px; }
.nhab-button { border: 1px solid var(--notible-accent); border-radius: 7px; background: var(--notible-accent); padding: 6px 13px; color: var(--notible-on-accent); font: inherit; cursor: pointer; }
.nhab-button--quiet { border-color: var(--notible-border); background: none; color: var(--notible-muted); font-size: 12px; padding: 5px 11px; }
.nhab-button--quiet:hover { border-color: var(--notible-danger); color: var(--notible-danger); }
.nhab-list__row { display: flex; align-items: center; gap: 10px; }
.nhab-row-menu { position: fixed; z-index: 1000; display: grid; min-width: 120px; border: 1px solid var(--notible-border); border-radius: 8px; background: var(--notible-surface); padding: 4px; box-shadow: 0 6px 20px rgba(0, 0, 0, .18); }
.nhab-row-menu button { border: 0; border-radius: 5px; background: none; padding: 6px 10px; color: var(--notible-danger); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.nhab-row-menu button:hover { background: var(--notible-hover); }
`;

export default {
  // Core reads `plugin.json` first, then refuses an entry module that claims a
  // different identity than the manifest the user was shown on the install
  // screen. `self-check.mjs` asserts the two stay in step.
  manifest: {
    id: "notible.habits",
    name: "Notible Habits",
    version: "0.9.2",
    apiVersion: "1.8",
    description: "Track habits in the sidebar: tick off what is due today, keep a streak, and see a year at a glance. Daily, on chosen weekdays, every few days or a weekly target.",
    author: "Notible",
    permissions: ["data.read", "data.write", "workspace.ui"],
  },

  onload(context) {
    if (context.i18n?.t) t = (key, values) => context.i18n.t(key, values);
    const habits = new Habits(context);
    this._habits = habits;
    this._disposables = [];

    // Register the type so a habit gets an icon and a name in the workspace
    // instead of showing up as an unknown type. Failing this must not take the
    // plugin down with it — the habits still work untyped.
    void context.data.types.upsert(HABIT_TYPE, JSON.stringify({ fields: [] }), "repeat").catch(() => {});
    void habits.load();

    // The home: Core renders a registered view as its own nav entry beside
    // Notes and gives it the full width of the main area. `mount` is what
    // makes it draw at all — a registration without one shows the entry and
    // reports that the view supplied nothing to render. The disposer Core
    // calls on navigate-away, disable, reload and uninstall is returned from
    // `mountSurface`, and it is what drops the `onChange` subscription.
    this._disposables.push(context.views.register({
      id: "surface",
      title: t("Habits"),
      // Opt into a primary nav card (added alongside ViewRegistration.nav):
      // Habits is a whole workspace tool the user opens directly and often,
      // not a settings screen shaped like a view — the case that field
      // exists for.
      nav: true,
      navIcon: "check-square",
      mount: ({ container }) => mountSurface(habits, container, "view"),
    }));

    this._disposables.push(context.ui.registerSlot("workspace.sidebar", {
      id: "habits-today",
      mount: ({ container }) => mountSidebar(habits, container),
    }));

    // The command opens the VIEW registered above, through `openHabits`, and
    // falls back to the modal only where the host cannot render one. It opened
    // the modal outright until 0.6.0, because until API 1.8 nothing navigated
    // the shell to a plugin's own view. Same surface either way —
    // `mountSurface` builds both.
    //
    // The NAME changed with it: it used to say "open the heatmap", which was
    // true when the heatmap was a link in the sidebar and false since the
    // surface grew the habit list, the schedule editor and the add field
    // around it. The ID did not change, and that is deliberate: it is not
    // shown anywhere, a hotkey the user bound is stored against it, and
    // nothing outside this plugin refers to either.
    this._disposables.push(context.commands.register({
      id: "heatmap",
      name: t("Habits: open every habit"),
      description: t("The whole surface: every habit, its streak, a year of days, its schedule, and a way to correct a day you forgot."),
      execute: () => openHabits(habits),
    }));

    // Another surface — or the sync plugin pulling in a peer's snapshot — can
    // change a habit under us. Reload rather than trusting what we hold.
    for (const event of ["object.created", "object.updated", "object.trashed"]) {
      this._disposables.push(context.events.on(event, (payload) => {
        if (payload?.type === HABIT_TYPE) void habits.load();
      }));
    }
  },

  onunload() {
    for (const disposable of this._disposables ?? []) disposable.dispose?.();
    this._disposables = [];
    this._habits = null;
  },
};
