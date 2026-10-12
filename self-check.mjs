/**
 * Runnable check for the parts of Notible Habits that can be wrong silently:
 * the local-day arithmetic, the schedules, the streak, and the props round
 * trip that stands between an imported or synced habit and the database.
 *
 * node plugins/notible-habits/self-check.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import plugin, {
  HABIT_TYPE,
  cellState,
  countIn,
  dayFromKey,
  dayKey,
  daysBetween,
  heatmapGrid,
  isDueOn,
  lastDueOnOrBefore,
  monthLabels,
  parseHabit,
  parseSchedule,
  previousDue,
  scheduleLabel,
  scheduleStats,
  serializeHabit,
  shiftDay,
  streakOf,
  toggleDay,
  weekProgress,
  weekStart,
  weekdayIndex,
  weekdayLabel,
  pluralText,
  LAST_WEEKS,
} from "./main.js";

// --- identity
// Core loads plugin.json, shows it to the user, then refuses the entry module
// if it claims to be something else. Forgetting `manifest` on the export fails
// with "Cannot read properties of undefined (reading 'id')", which says
// nothing about the cause — so assert it here instead.
const declared = JSON.parse(readFileSync(new URL("./plugin.json", import.meta.url), "utf8"));
assert.ok(plugin.manifest, "the entry module must export a manifest, not just onload");
for (const field of ["id", "name", "version", "apiVersion", "description", "author"]) {
  assert.equal(plugin.manifest[field], declared[field], `${field} must match plugin.json`);
}
assert.deepEqual(plugin.manifest.permissions, declared.permissions);
assert.equal(typeof plugin.onload, "function");
assert.equal(typeof plugin.onunload, "function");

// The plugin CALLS `ui.openView`, which arrived in API 1.8. Declaring 1.7
// would still be accepted by a 1.8 host — same major, host minor at least the
// plugin's — and would also be accepted by a 1.7 host, where the method does
// not exist and the command dies on `undefined is not a function`. The
// declared version is the only thing that stops that, so assert it.
assert.equal(declared.apiVersion, "1.8", "openView is 1.8; a plugin that calls it must say so");

// The plugin writes objects and draws UI. Advertising less than it uses gets
// it refused at runtime; advertising more makes the install screen a lie.
assert.deepEqual([...declared.permissions].sort(), ["data.read", "data.write", "workspace.ui"]);
assert.ok(!declared.permissions.includes("network"), "habits never leave the machine on their own");

// --- days are LOCAL, and that is the whole point
// toISOString() would report the wrong day for half of every day in any
// timezone off Greenwich: the user ticks tonight and the streak counts a miss.
assert.equal(dayKey(new Date(2026, 7, 21, 1, 0)), "2026-08-21", "01:00 local is still today");
assert.equal(dayKey(new Date(2026, 7, 21, 23, 30)), "2026-08-21", "23:30 local is still today");
assert.equal(dayKey(new Date(2026, 0, 1)), "2026-01-01", "months and days are zero-padded");

assert.ok(dayFromKey("2026-08-21"));
assert.equal(dayFromKey("2026-02-30"), null, "Date rolls this forward silently; we must not");
assert.equal(dayFromKey("2026-8-21"), null, "unpadded is not the format we write");
assert.equal(dayFromKey("not a day"), null);
assert.equal(dayFromKey(null), null);
assert.equal(dayFromKey({ toString: () => "2026-08-21" }), null, "objects are not day keys");

assert.equal(shiftDay("2026-08-21", 1), "2026-08-22");
assert.equal(shiftDay("2026-01-01", -1), "2025-12-31", "across a year boundary");
assert.equal(shiftDay("2026-03-01", -1), "2026-02-28", "and a month boundary");
// DST: counting in calendar days rather than in 86_400_000ms blocks is what
// keeps the day either side of a clock change from being skipped or repeated.
assert.equal(shiftDay("2026-03-29", -1), "2026-03-28", "the European spring-forward night");
assert.equal(shiftDay("2026-10-25", -1), "2026-10-24", "and the autumn one");

// daysBetween is the same promise in the other direction, and it is what an
// every-N-days schedule counts on. Subtracting local timestamps would give 23
// or 25 hours across a clock change and round an interval onto the wrong day.
assert.equal(daysBetween("2026-08-21", "2026-08-24"), 3);
assert.equal(daysBetween("2026-08-24", "2026-08-21"), -3, "and answers backwards too");
assert.equal(daysBetween("2026-08-21", "2026-08-21"), 0);
assert.equal(daysBetween("2026-03-28", "2026-03-30"), 2, "two days across the spring-forward night");
assert.equal(daysBetween("2026-10-24", "2026-10-26"), 2, "and across the autumn one");
assert.equal(daysBetween("2025-12-31", "2026-01-01"), 1, "across a year boundary");
assert.equal(daysBetween("nonsense", "2026-01-01"), null, "a bad key is null, not NaN");

assert.equal(weekdayIndex("2026-08-17"), 0, "Monday is 0, like the rest of the app");
assert.equal(weekdayIndex("2026-08-23"), 6, "and Sunday is 6");
assert.equal(weekdayIndex("nope"), null);
assert.equal(weekStart("2026-08-21"), "2026-08-17", "a Friday's week starts on the Monday");
assert.equal(weekStart("2026-08-17"), "2026-08-17", "a Monday's week starts on itself");
assert.equal(weekStart("2026-01-01"), "2025-12-29", "and a week may start in the previous year");

// --- schedules
// props.schedule arrives from the same untrusted places props.days does, so
// parseSchedule is the only thing that ever reads a raw one: everything it
// cannot make sense of comes back daily. Daily is the safe failure — a broken
// schedule should keep asking, not quietly stop.
assert.deepEqual(parseSchedule(undefined), { kind: "daily" }, "no schedule at all is daily: that is the whole migration");
assert.deepEqual(parseSchedule({ kind: "daily" }), { kind: "daily" });
assert.deepEqual(parseSchedule({ kind: "weekdays", weekdays: [4, 0, 2, 0] }), { kind: "weekdays", weekdays: [0, 2, 4] }, "deduplicated and sorted");
assert.deepEqual(parseSchedule({ kind: "interval", every: 3, start: "2026-08-03" }), { kind: "interval", every: 3, start: "2026-08-03" });
assert.deepEqual(parseSchedule({ kind: "weekly", target: 3 }), { kind: "weekly", target: 3 });

for (const broken of [
  null,
  "daily",
  42,
  [],
  [{ kind: "weekly", target: 3 }],
  { kind: "lunar" },
  { kind: "weekdays" },
  { kind: "weekdays", weekdays: [] },
  { kind: "weekdays", weekdays: "mon" },
  { kind: "weekdays", weekdays: [7, -1, 1.5, "2"] },
  { kind: "interval", every: 3 },
  { kind: "interval", start: "2026-08-03" },
  { kind: "interval", every: 0, start: "2026-08-03" },
  { kind: "interval", every: 2.5, start: "2026-08-03" },
  { kind: "interval", every: 999, start: "2026-08-03" },
  { kind: "interval", every: 3, start: "2026-02-30" },
  { kind: "weekly", target: 0 },
  { kind: "weekly", target: 8 },
  { kind: "weekly", target: "3" },
]) {
  assert.deepEqual(parseSchedule(broken), { kind: "daily" }, `a malformed schedule degrades to daily: ${JSON.stringify(broken)}`);
}

assert.equal(scheduleLabel({ kind: "weekdays", weekdays: [0, 2, 4] }), "Mon Wed Fri");
assert.equal(scheduleLabel({ kind: "interval", every: 3, start: "2026-08-03" }), "Every 3 days");
assert.equal(scheduleLabel({ kind: "weekly", target: 3 }), "3× a week");
assert.equal(scheduleLabel("rubbish"), "Daily", "even the label degrades rather than throwing");

const mwf = { kind: "weekdays", weekdays: [0, 2, 4] };
const every3 = { kind: "interval", every: 3, start: "2026-08-03" };
const thrice = { kind: "weekly", target: 3 };

assert.equal(isDueOn(undefined, "2026-08-18"), true, "a daily habit is due every day");
assert.equal(isDueOn(mwf, "2026-08-21"), true, "Friday is a Mon/Wed/Fri day");
assert.equal(isDueOn(mwf, "2026-08-18"), false, "Tuesday is not");
assert.equal(isDueOn(every3, "2026-08-21"), true, "18 days after the anchor is on the rhythm");
assert.equal(isDueOn(every3, "2026-08-22"), false);
// Before the anchor the rhythm still holds, so a habit anchored today does not
// draw its whole past as never-scheduled.
assert.equal(isDueOn(every3, "2026-07-31"), true, "three days before the anchor is due too");
assert.equal(isDueOn(thrice, "2026-08-18"), true, "a weekly target asks for a count, so every day is fair game");
assert.equal(isDueOn(mwf, "nonsense"), false, "an unparseable day is not a day anything was due on");
// An interval spanning a clock change lands on the calendar day, not 48 hours
// later: 2026-03-29 is the European spring-forward night.
const dstInterval = { kind: "interval", every: 2, start: "2026-03-27" };
assert.equal(isDueOn(dstInterval, "2026-03-29"), true, "two calendar days across the spring-forward night");
assert.equal(isDueOn(dstInterval, "2026-03-28"), false);
assert.equal(isDueOn(dstInterval, "2026-03-31"), true);

assert.equal(lastDueOnOrBefore(mwf, "2026-08-23"), "2026-08-21", "Sunday's last occurrence was Friday");
assert.equal(lastDueOnOrBefore(mwf, "2026-08-21"), "2026-08-21", "a due day is its own last occurrence");
assert.equal(lastDueOnOrBefore(mwf, "nonsense"), null);
assert.equal(previousDue(mwf, "2026-08-21"), "2026-08-19", "Friday's predecessor is Wednesday");
assert.equal(previousDue(mwf, "2026-08-17"), "2026-08-14", "and Monday's is the Friday before, across the weekend");
assert.equal(previousDue(every3, "2026-08-21"), "2026-08-18");
assert.equal(previousDue(undefined, "2026-01-01"), "2025-12-31", "daily crosses the year like any other day");

const week = weekProgress(["2026-08-17", "2026-08-19", "2026-08-24"], "2026-08-21", thrice);
assert.equal(week.start, "2026-08-17", "the week the day falls in, Monday first");
assert.equal(week.done, 2, "and only the ticks inside it, not the next week's");
assert.equal(week.target, 3);
assert.equal(weekProgress([], "2026-08-21", undefined).target, 0, "a daily habit has no weekly target to report");

// --- props are attacker-influenced input
// A habit arrives by sync from another machine, by import, and from any
// plugin's objects.create. Nothing below may throw inside a render.
const habitOf = (props, title = "Read") => parseHabit({ id: "h1", title, props });
assert.deepEqual(habitOf('{"days":["2026-08-20"]}').days, ["2026-08-20"]);
assert.deepEqual(habitOf("not json").days, [], "broken props degrade to an empty history");
assert.deepEqual(habitOf("").days, []);
assert.deepEqual(habitOf("null").days, []);
assert.deepEqual(habitOf('{"days":"2026-08-20"}').days, [], "days must be an array, not a string");
assert.deepEqual(habitOf('{"days":[1,true,null,{}]}').days, [], "non-days are dropped, not coerced");
assert.deepEqual(habitOf('{"days":["2026-02-30","2026-08-20"]}').days, ["2026-08-20"], "an impossible day is dropped");
assert.deepEqual(habitOf('{"days":["2026-08-20","2026-08-20"]}').days, ["2026-08-20"], "duplicates collapse");
assert.deepEqual(habitOf('{"days":["2026-08-21","2026-08-20"]}').days, ["2026-08-20", "2026-08-21"], "and come back sorted");
assert.equal(parseHabit(undefined).days.length, 0, "even no object at all");
assert.equal(parseHabit({ title: 42 }).name, "", "a non-string title is not drawn as one");
assert.equal(habitOf("{}", "x".repeat(500)).name.length, 200, "a title is capped before it reaches the DOM");

// A habit written before schedules existed has no schedule key at all, and
// reads as daily without anything being rewritten. That IS the migration.
assert.deepEqual(habitOf('{"days":["2026-08-20"]}').schedule, { kind: "daily" }, "an old habit is daily");
assert.deepEqual(habitOf('{"days":[],"schedule":{"kind":"weekly","target":2}}').schedule, { kind: "weekly", target: 2 });
assert.deepEqual(habitOf('{"days":[],"schedule":"every tuesday-ish"}').schedule, { kind: "daily" }, "and a schedule from somewhere else degrades rather than throwing");

// A field a NEWER version of this plugin wrote on the user's other machine
// must survive a tick here, or syncing back and forth deletes it.
const withExtra = habitOf('{"days":["2026-08-20"],"colour":"green"}');
assert.equal(JSON.parse(serializeHabit(withExtra)).colour, "green", "unknown props are kept, not dropped");
assert.deepEqual(JSON.parse(serializeHabit(withExtra)).days, ["2026-08-20"]);
assert.ok(!("undefined" in JSON.parse(serializeHabit(withExtra))), "the extra-field trick leaves no stray key");
assert.ok(!("schedule" in JSON.parse(serializeHabit(withExtra))), "a daily habit writes no schedule key: daily is the absence of one");

// `$` is the reserved cross-plugin namespace notible-graph reads
// `props.$.graphExclude` from. It has to round-trip like any other unknown
// prop — parseHabit's "preserve unknown props" mechanism must not treat it
// specially, or a tick here would silently unhide a habit in the graph.
const withDollar = habitOf('{"days":["2026-08-20"],"$":{"graphExclude":true,"other":1}}');
assert.deepEqual(withDollar.extra.$, { graphExclude: true, other: 1 }, "the $ namespace round-trips whole, not just known keys inside it");
assert.deepEqual(JSON.parse(serializeHabit(withDollar)).$, { graphExclude: true, other: 1 }, "and survives a tick's read-modify-write");
// …including a schedule write, which is a read-modify-write of the same blob.
const scheduled = JSON.parse(serializeHabit({ ...withDollar, schedule: mwf }));
assert.deepEqual(scheduled.$, { graphExclude: true, other: 1 }, "and survives a schedule write untouched");
assert.deepEqual(scheduled.schedule, { kind: "weekdays", weekdays: [0, 2, 4] }, "the schedule is written normalised");
assert.deepEqual(scheduled.days, ["2026-08-20"], "and the ticks are still there");
// Round trip: what serializeHabit writes, parseHabit must read back the same.
for (const plan of [mwf, every3, thrice, { kind: "daily" }]) {
  const round = parseHabit({ id: "h", title: "t", props: serializeHabit({ days: [], extra: {}, schedule: plan }) });
  assert.deepEqual(round.schedule, plan, `${plan.kind} round-trips through props`);
}
// A schedule this version cannot read is not preserved as an unknown prop: it
// is normalised away to daily, deliberately. Keeping it would mean a habit
// that looks daily in the UI and is silently something else on the next
// machine to understand it.
const junkSchedule = JSON.parse(serializeHabit(parseHabit({ props: '{"days":[],"schedule":{"kind":"lunar"}}' })));
assert.ok(!("schedule" in junkSchedule), "an unreadable schedule is written back as daily, not kept as a lie");

// The cap is what keeps a props blob from becoming a payload: it is read and
// rewritten whole on every single tick.
const many = Array.from({ length: 4000 }, (_, index) => shiftDay("2016-01-01", index));
const capped = JSON.parse(serializeHabit({ days: many, extra: {} })).days;
assert.equal(capped.length, 3660, "the history is capped");
assert.equal(capped.at(-1), many.at(-1), "and it is the OLDEST days that go, never the newest");

// --- ticking
assert.deepEqual(toggleDay(["2026-08-20"], "2026-08-21"), ["2026-08-20", "2026-08-21"]);
assert.deepEqual(toggleDay(["2026-08-20", "2026-08-21"], "2026-08-20"), ["2026-08-21"], "a second click unticks");
assert.deepEqual(toggleDay(["2026-08-21", "2026-08-19"], "2026-08-20"), ["2026-08-19", "2026-08-20", "2026-08-21"], "and the result stays sorted");
const before = ["2026-08-20"];
toggleDay(before, "2026-08-21");
assert.deepEqual(before, ["2026-08-20"], "toggleDay never mutates what it was handed");
assert.deepEqual(toggleDay(["2026-08-20"], "nonsense"), ["2026-08-20"], "an unparseable day changes nothing");

// --- the streak, daily
const today = "2026-08-21";
assert.equal(streakOf([], today), 0);
assert.equal(streakOf([today], today), 1);
assert.equal(streakOf(["2026-08-19", "2026-08-20", today], today), 3);
assert.equal(streakOf(["2026-08-18", "2026-08-20", today], today), 2, "a gap ends the count");
// The design decision worth protecting: a streak the user has not got to yet
// this morning still reads as alive. Counting only from today would show every
// habit at zero until it is ticked, turning the number into a nag.
assert.equal(streakOf(["2026-08-19", "2026-08-20"], today), 2, "yesterday keeps the streak alive");
assert.equal(streakOf(["2026-08-18", "2026-08-19"], today), 0, "but the day before yesterday does not");
assert.equal(streakOf(["2026-08-22", today], today), 1, "a day in the future does not extend today's streak");
assert.equal(streakOf(["2026-01-01", "2025-12-31"], "2026-01-01"), 2, "across a year boundary");
assert.equal(streakOf(["2026-08-20", today], today, "rubbish"), 2, "a malformed schedule is counted as daily");
assert.equal(streakOf(["2026-08-20", today], today, { kind: "weekdays", weekdays: [] }), 2, "and so is a weekday set with no days in it");

// --- the streak, chosen weekdays
// Only scheduled days count, so an unticked Tuesday is not a miss — and the
// occurrence that is still open is never a miss either. On Friday that open
// occurrence is Friday itself; on Saturday it is still Friday, because nothing
// has been missed until Monday comes due.
assert.equal(streakOf(["2026-08-17", "2026-08-19", "2026-08-21"], "2026-08-21", mwf), 3, "Mon, Wed and Fri, and no Tuesday held against it");
assert.equal(streakOf(["2026-08-17", "2026-08-19"], "2026-08-21", mwf), 2, "Friday is open: pending is not missed");
assert.equal(streakOf(["2026-08-17", "2026-08-19"], "2026-08-22", mwf), 2, "and Friday stays open across the weekend, when nothing is asked");
assert.equal(streakOf(["2026-08-17", "2026-08-19"], "2026-08-24", mwf), 0, "Monday comes due, and the missed Friday finally counts");
assert.equal(streakOf(["2026-08-17", "2026-08-21"], "2026-08-21", mwf), 1, "a missed Wednesday ends the count");
assert.equal(streakOf(["2026-08-18", "2026-08-20"], "2026-08-21", mwf), 0, "ticks on days it never asked for do not build a streak");
// Boundary: a week that crosses the year, and a spring-forward night.
assert.equal(streakOf(["2025-12-29", "2025-12-31", "2026-01-02"], "2026-01-02", mwf), 3, "Mon 29 Dec through Fri 2 Jan, across the year");
assert.equal(streakOf(["2026-03-25", "2026-03-27", "2026-03-30"], "2026-03-30", mwf), 3, "Fri to Mon across the spring-forward night");

// --- the streak, every N days
assert.equal(streakOf(["2026-08-15", "2026-08-18", "2026-08-21"], "2026-08-21", every3), 3, "three due days in a row");
assert.equal(streakOf(["2026-08-15", "2026-08-18"], "2026-08-21", every3), 2, "today's is open, so pending is not missed");
assert.equal(streakOf(["2026-08-15", "2026-08-18"], "2026-08-23", every3), 2, "and stays open until the next one falls due");
assert.equal(streakOf(["2026-08-15", "2026-08-18"], "2026-08-24", every3), 0, "the 24th is due, so the 21st is finally a miss");
assert.equal(streakOf(["2026-08-16", "2026-08-17", "2026-08-19"], "2026-08-21", every3), 0, "ticks off the rhythm build nothing");
// Boundary: across a month and a year, and across the autumn clock change.
const everyTwoDec = { kind: "interval", every: 2, start: "2025-12-28" };
assert.equal(streakOf(["2025-12-28", "2025-12-30", "2026-01-01"], "2026-01-01", everyTwoDec), 3, "across the year boundary");
assert.equal(streakOf(["2026-10-23", "2026-10-25", "2026-10-27"], "2026-10-27", { kind: "interval", every: 2, start: "2026-10-23" }), 3, "across the autumn clock change");

// --- the streak, a weekly target
// The unit is the week: a week is held if it met the target, and the current
// week is the open occurrence — it adds to the streak once met, and does not
// break it before then.
const twoFullWeeks = ["2026-08-10", "2026-08-12", "2026-08-14", "2026-08-03", "2026-08-05", "2026-08-07"];
assert.equal(streakOf(twoFullWeeks, "2026-08-21", thrice), 2, "two met weeks, with this week still open");
assert.equal(streakOf([...twoFullWeeks, "2026-08-17", "2026-08-19", "2026-08-21"], "2026-08-21", thrice), 3, "and three once this week is met too");
assert.equal(streakOf([...twoFullWeeks, "2026-08-17"], "2026-08-21", thrice), 2, "one tick this week is not the target, but does not break it either");
assert.equal(streakOf(["2026-08-10", "2026-08-12", "2026-08-14", "2026-08-03"], "2026-08-21", thrice), 1, "a week that missed the target ends the count");
assert.equal(streakOf(["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"], "2026-08-21", thrice), 1, "four in one week is still one week");
// Boundary: a week that starts in the old year, and one containing the DST
// night — the week is seven calendar days either way.
assert.equal(streakOf(["2025-12-29", "2025-12-31", "2026-01-02"], "2026-01-02", thrice), 1, "a week may straddle the year boundary");
assert.equal(streakOf(["2026-03-23", "2026-03-27", "2026-03-29"], "2026-03-29", { kind: "weekly", target: 3 }), 1, "the week containing the spring-forward night is still seven days");

// --- the recent-record line
// "of the last 30" is a lie about a Mon/Wed/Fri habit: it can never exceed 13,
// so a perfect record would read as a failing one.
assert.equal(countIn(["2026-08-21", "2026-08-01", "2026-07-01"], today, 30), 2, "the window is inclusive of today");
assert.equal(countIn(["2026-07-23"], today, 30), 1, "and reaches exactly 30 days back");
assert.equal(countIn(["2026-07-22"], today, 30), 0, "but no further");

const dailyStats = scheduleStats(["2026-08-20", today], today, undefined, 30);
assert.deepEqual(dailyStats, { done: 2, expected: 30, unit: "scheduled" }, "a daily habit still reads as N of 30");
const mwfStats = scheduleStats(["2026-08-17", "2026-08-19", "2026-08-21", "2026-08-18"], today, mwf, 30);
assert.equal(mwfStats.unit, "scheduled");
assert.equal(mwfStats.expected, 13, "thirty days hold thirteen Mon/Wed/Fri occurrences here");
assert.equal(mwfStats.done, 3, "and a tick on a day it never asked for is not one of them");
const intervalStats = scheduleStats(["2026-08-21", "2026-08-18"], today, every3, 30);
assert.equal(intervalStats.expected, 10, "thirty days hold ten every-third-day occurrences");
assert.equal(intervalStats.done, 2);
// A weekly target is not counted in days at all, and the OPEN week is left
// out: counting it would report every Monday morning as a week already lost.
const weeklyStats = scheduleStats([...twoFullWeeks, "2026-08-17"], today, thrice, 30);
assert.deepEqual(weeklyStats, { done: 2, expected: 4, unit: "weeks" }, "four completed weeks, two of them met");
assert.equal(scheduleStats([], "nonsense", mwf).expected, 0, "an unparseable today counts nothing rather than throwing");

// --- the heatmap
const grid = heatmapGrid(["2026-08-20"], today, 4);
assert.equal(grid.length, 4, "one column per week");
assert.ok(grid.every((week) => week.length === 7), "seven days in each");
assert.equal(grid[0][0].key, shiftDay(today, -3 * 7 - 4), "weeks start Monday, like the rest of the app");
assert.equal(new Date(`${grid[0][0].key}T00:00:00`).getDay(), 1, "and that really is a Monday");
const flat = grid.flat();
assert.equal(flat.filter((cell) => cell.ticked).length, 1);
assert.ok(flat.find((cell) => cell.key === "2026-08-20").ticked);
// Friday 2026-08-21 means Saturday and Sunday of this week are still ahead.
assert.deepEqual(flat.filter((cell) => cell.future).map((cell) => cell.key), ["2026-08-22", "2026-08-23"]);
assert.ok(flat.every((cell) => cell.key <= "2026-08-23"), "nothing beyond the current week is drawn");
assert.deepEqual(heatmapGrid([], "nonsense"), [], "an unparseable today draws nothing rather than throwing");
assert.ok(flat.every((cell) => cell.scheduled), "a daily habit asked for every square");

// A day the schedule never asked for must not be drawn like a day the user
// missed, or the grid tells the reader their record is worse than it is.
const mwfGrid = heatmapGrid(["2026-08-19", "2026-08-18"], today, 2, mwf).flat();
const stateOf = (key) => cellState(mwfGrid.find((cell) => cell.key === key));
assert.equal(stateOf("2026-08-19"), "on", "a ticked scheduled day");
assert.equal(stateOf("2026-08-17"), "off", "a scheduled day that was missed");
assert.equal(stateOf("2026-08-20"), "skip", "a Thursday this habit never asked for");
assert.equal(stateOf("2026-08-18"), "bonus", "a tick on a day it never asked for is a bonus, not a scheduled hit");
assert.equal(stateOf("2026-08-22"), "future", "and the weekend ahead is still ahead");
assert.equal(cellState(undefined), "skip", "a missing cell does not throw");

// --- heatmap labels
// Detecting the month change is the easy half; the hard half is that 53
// columns of a 12px grid cannot hold twelve labels wherever they happen to
// fall, and "AugSep" printed on top of itself is what the user was looking at.
const janToFeb = heatmapGrid(["2026-08-20"], "2026-02-10", 6);
const janFebLabels = monthLabels(janToFeb);
assert.equal(janFebLabels[0], "Jan", "a month with room to its right is labelled at its first column");
assert.ok(janFebLabels.includes("Feb"), "a month change gets its own label");
assert.equal(janFebLabels.filter((label) => label === "Feb").length, 1, "a month is labelled once, on its first column");
// Year boundary: December into January is a month-number change (12 -> 1)
// even though the two Mondays are less than a week apart.
const yearBoundary = heatmapGrid([], "2026-01-05", 3);
const yearLabels = monthLabels(yearBoundary, 1);
assert.ok(yearLabels.includes("Dec") && yearLabels.includes("Jan"), "December into January is still two months, not one");
// …and with room to draw them in, the two-column December stub is dropped
// rather than printed on top of January.
assert.deepEqual(monthLabels(yearBoundary), [null, null, "Jan"], "a stub month with a label right behind it is skipped, not overprinted");
const fullYear = monthLabels(heatmapGrid([], today, 53));
const drawn = fullYear.map((label, index) => (label ? index : -1)).filter((index) => index >= 0);
assert.ok(drawn.every((index, position) => position === 0 || index - drawn[position - 1] >= 3), "no two labels land within three columns of each other");
assert.equal(fullYear.at(-1) ?? null, null, "the trailing stub is not labelled over the month before it");
assert.ok(fullYear.filter(Boolean).length >= 10, "and suppression does not eat the year: ten months or more still named");
assert.deepEqual(monthLabels([]), [], "an empty grid draws no labels");
assert.deepEqual(monthLabels([[{ key: null }]]), [null], "a column with no Monday key is skipped, not thrown on");

assert.equal(weekdayLabel(0), "Mon");
assert.equal(weekdayLabel(2), "Wed");
assert.equal(weekdayLabel(4), "Fri");
assert.equal(weekdayLabel(1), "", "unlabelled rows still return a value, just an empty one");
assert.equal(weekdayLabel(6), "", "Sunday is unlabelled too");
assert.equal(weekdayLabel(99), "", "out of range does not throw");

// --- no markup is ever built from a string
// Habit names come from sync and import like any other object title. CSP would
// stop an injected script, but style-src 'unsafe-inline' would still let
// injected markup cover the workspace, so this is checked mechanically.
const source = readFileSync(new URL("./main.js", import.meta.url), "utf8");
for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
  assert.ok(!source.includes(banned), `${banned} must not appear: habit names are untrusted text`);
}
// The surface is a registered view. CoreOnlyApp reads `views.register` off the
// extension-host snapshot and gives each view its own nav entry and a
// full-width pane — and `mount` is the whole of the contract, because a
// registration without one shows the nav entry and then reports that the view
// supplied nothing to draw. So the shape is asserted, not merely the call.
assert.ok(source.includes("context.views.register("), "the habit surface is a view of its own, not a dialog the user has to go looking for");
assert.ok(/context\.views\.register\(\{[\s\S]{0,400}?mount:/.test(source), "a view registered without a mount draws nothing at all");
assert.ok(/context\.views\.register\(\{[\s\S]{0,400}?title: (?:t\()?"Habits"/.test(source), "`title` is the nav label, verbatim");

// Core disposes the view on navigate-away, disable, reload and uninstall and
// clears the container, but a listener the plugin added is the plugin's to
// remove: a leaked one redraws a detached tree on every tick for the rest of
// the session.
const surfaceSource = source.slice(source.indexOf("function mountSurface"), source.indexOf("function openHabitsModal"));
assert.ok(surfaceSource.includes("const stop = habits.onChange(render)"), "the surface redraws when a habit changes under it");
assert.ok(/dispose:\s*\(\)\s*=>\s*\{\s*stop\(\);/.test(surfaceSource), "and the disposer Core calls unsubscribes it");

// The command goes to that view rather than straight to a dialog. The modal
// survives as the fallback for a host with nowhere to render a view — the one
// thing `openView` resolves false for — and it is reached through a single
// helper, so a second entry point cannot arrive with its own copy of the
// fallback. None of this can be exercised under plain node, so it is asserted
// against the source, the way the surfaces above already are.
assert.ok(source.includes('context.ui.openView("surface")'), "the command opens the registered view, by the id registered above");
assert.ok(/openView\("surface"\)[\s\S]{0,200}if \(!shown\) openHabitsModal\(habits\)/.test(source), "false means the host renders no views at all — that, and only that, is what the modal is for");
assert.ok(source.includes("function openHabitsModal(habits)"), "so the modal has to still exist");
assert.ok(!/openHabitsModal\(habits\)/.test(source.slice(source.indexOf("onload(context)"))), "and nothing registers the modal as a destination any more");
// A rejection inside a synchronous command handler is invisible. openView
// rejects for a view id this plugin never registered — a bug, not an
// environment — so it must be said rather than papered over with the modal.
assert.ok(/\.catch\(\(cause\) => \{[\s\S]{0,220}ui\.notice\(/.test(source), "a rejected openView must surface as a notice, not vanish into the console");
// The command's name described a link the sidebar no longer has; the surface
// it opens is the habit list, the year, the schedule editor and the add field.
assert.ok(!/name: "Habits: open the heatmap"/.test(source), "the command opens the whole surface, not a heatmap");
assert.ok(/name: (?:t\()?"Habits: open every habit"/.test(source), "and its name says so");

assert.ok(source.includes('registerSlot("workspace.sidebar"'), "today's ticks belong in the sidebar");
// …and nothing else does. The heatmap link and the add-habit field are what
// made the sidebar a strip of small print instead of a row of checkboxes.
const sidebarSource = source.slice(source.indexOf("function mountSidebar"), source.indexOf("function habitPicker"));
assert.ok(!sidebarSource.includes("addField("), "adding a habit belongs with the habit list in the view");
assert.ok(!sidebarSource.includes("Heatmap"), "the heatmap is a nav entry now, not a link in the sidebar");
// Whatever the sidebar gave up has to be reachable in the view: the list of
// every habit, and the field that adds one.
assert.ok(surfaceSource.includes("habitPicker(") && surfaceSource.includes("addField(habits)"), "the view carries the whole habit list and the add field");
// Adding a habit lives where habits are used. It used to be a settings
// section, which left the empty sidebar pointing at a screen three clicks away.
assert.ok(!source.includes('registerSlot("settings.section"'), "adding a habit belongs next to the habits");
// Core validates `content` as JSON, so content: "" made every create fail —
// invisibly, because the list just stayed empty.
// (The trailing comma or brace keeps this off the stylesheet's `content: "";`,
// which is a CSS pseudo-element and nothing to do with an object's body.)
assert.ok(!/content:\s*""\s*[,}]/.test(source), 'content: "" is rejected by require_json in Core');
assert.equal(HABIT_TYPE, "habit");

// The plugin's CSS paints only through the public token contract. A literal is
// invisible to the theme: it stays the same colour in night mode and under
// every theme a third party ships. Same rule scripts/plugin-css-token-check.mjs
// applies to the .css files, checked here because this stylesheet is a
// template string inside main.js.
const stylesheet = source.slice(source.indexOf("const styles = `"), source.lastIndexOf("`;"));
for (const [, , property, value] of stylesheet.matchAll(/(^|[;{])\s*(color|background|background-color|border(?:-\w+)?-color|border|outline-color|accent-color|fill|stroke)\s*:([^;}]*)/gi)) {
  assert.ok(!/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i.test(value), `${property} paints with a colour literal: ${value.trim()}`);
}
// The done row used to carry an accent ribbon down its left edge and a filled
// accent pill for the streak. Three pieces of accent for one boolean, on a
// surface built out of warm paper — it read as decoration bolted on.
assert.ok(!/data-done="yes"\][^{]*\{[^}]*border-left-color/.test(stylesheet), "no coloured ribbon on the done row");
assert.ok(!/nhab-today__streak--active/.test(source), "the streak is type, not a filled badge");

// A habit is not a note: notible-graph (or any future workspace-graph reader)
// is told so via the shared `props.$.graphExclude` convention, set on every
// new habit and patched into any habit that predates it.
assert.ok(source.includes("graphExclude: true"), "a new habit must be created with the graph-exclusion flag already set");
assert.ok(source.includes("_healExclusion"), "a habit made before this convention existed must self-heal on load");

// I18N (Hive #55): one table by count. English: one / other. Polish: one / few / other.
// A locale without the translation, or an old Core whose t returns the key, must show English.
{
  const strings = JSON.parse(readFileSync(new URL("./locales/pl.json", import.meta.url), "utf8")).strings;
  const translate = (language) => (key, values) => {
    const text = language === "pl" && strings[key] !== undefined ? strings[key] : key;
    return values ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole)) : text;
  };
  const show = (text, count) => text.replace("{count}", String(count));
  for (const count of [1, 2, 5, 22]) {
    assert.equal(pluralText(translate("en"), LAST_WEEKS, count, "en", { count }), show(count === 1 ? "of the last {count} week" : "of the last {count} weeks", count), `English for ${count}`);
    assert.equal(pluralText(translate("pl"), LAST_WEEKS, count, "pl", { count }), show(count === 1 ? "z ostatniego tygodnia" : count === 5 ? "z ostatnich {count} tygodni" : "z ostatnich {count} tygodni", count), `Polish for ${count}`);
  }
  assert.equal(pluralText(translate("cs"), LAST_WEEKS, 2, "cs", { count: 2 }), show("of the last {count} weeks", 2), "a locale with no translation shows English");
  assert.equal(pluralText(translate("en"), LAST_WEEKS, 2, "pl", { count: 2 }), show("of the last {count} weeks", 2), "an old Core (t returns the key) shows English");
}

console.log("Notible Habits self-check passed.");
