# cron-last-due

**When was this cron job last due?** Timezone-aware previous-fire-time and
missed-run detection, for watchdogs rather than schedulers. No dependencies.

```bash
npm install cron-last-due
```

## The problem it solves

The tempting health check is *"no execution in N hours means broken"*. It is
wrong for every job that does not run continuously.

A Monday-to-Friday job is legitimately silent for 60 hours every weekend. A
monthly job is silent for weeks. A blanket rule flags both. And if the watchdog
also repairs what it flags, it will restart healthy systems on a schedule of
its own.

```ts
import { hasMissedRun } from "cron-last-due";

// Sunday morning. The job last ran on Friday, over 60 hours ago.
hasMissedRun("0 7 * * 1-5", lastRun, new Date(), "Europe/Berlin");
// -> false. It was not due in between.
```

## API

### `hasMissedRun(expression, lastRun, now, timeZone, options?)`

The question a monitor actually asks. Returns `true` only when the job was due
and the last run is older than that due time, minus a tolerance.

```ts
hasMissedRun(
  "*/15 * * * *",
  new Date("2026-07-15T09:58:00Z"),
  new Date("2026-07-15T10:30:00Z"),
  "UTC",
); // -> true, 10:00 and 10:15 both passed
```

| Option | Default | Why |
| --- | --- | --- |
| `toleranceMs` | 5 min | A job that fires at :00 and takes four minutes has not missed its slot at :03 |
| `lookbackMs` | 7 days | How far back to search. Widen it for monthly or yearly schedules |

Returns `false` when nothing was due inside the lookback window: a job that was
never due cannot have missed anything.

### `lastDueBefore(expression, before, timeZone, options?)`

The most recent instant the expression was due, **strictly** before `before`.

```ts
lastDueBefore("0 7 * * 1-5", new Date("2026-07-12T09:00:00Z"), "Europe/Berlin");
// -> 2026-07-10T05:00:00.000Z  (Friday 07:00 Berlin, in summer time)
```

Strictly before matters: at exactly 10:00, a job firing right now would
otherwise be reported as its own due time and look overdue.

Returns `null` for an unparseable expression, and also when nothing was due in
the window. Those are the same value on purpose, because both mean "no answer";
widen `lookbackMs` for sparse schedules.

### `parseCron(expression)` and `cronMatches(cron, date, timeZone)`

The pieces underneath, exported for when you need the sets themselves. Parsing
returns `null` rather than throwing, because the caller is usually iterating
over jobs it does not control.

## What it handles

**Time zones.** Every function takes an IANA zone and evaluates the expression
in it, through `Intl.DateTimeFormat`. Daylight saving is therefore the
platform's problem, not this package's, and there is no zone database to keep
up to date.

```ts
const c = parseCron("0 7 * * *")!;
cronMatches(c, new Date("2026-07-01T05:00:00Z"), "Europe/Berlin"); // summer, true
cronMatches(c, new Date("2026-01-15T06:00:00Z"), "Europe/Berlin"); // winter, true
```

**Six-field expressions.** A leading seconds field is accepted and dropped.
Several schedulers, n8n among them, emit that form.

**The day-of-month / day-of-week rule.** When *both* fields are restricted,
standard cron matches on **either**. `0 0 1 * 1` fires on the first of the
month *and* on every Monday, not on Mondays that happen to be the first. This
is the part most reimplementations get wrong.

**Step values.** `*/15` and the less common `5/10`, which means "from 5, then
every 10".

## What it does not do

- No next-fire-time. Use a scheduler for that; this package looks backwards.
- No `L`, `W`, `#` or `?`. Quartz extensions are out of scope.
- No named months or weekdays (`JAN`, `MON`). Numbers only.
- No parsing of `@daily` and friends.

An expression it does not understand returns `null` rather than matching
nothing, so a monitor can tell "not due" apart from "cannot tell".

## Cost

The search walks backwards minute by minute. Seven days is 10.080 iterations of
a cheap comparison. A yearly schedule with a matching lookback window is around
half a million, which is still milliseconds, but worth knowing before you set
`lookbackMs` to a year in a loop over a thousand jobs.

## Where it comes from

A production watchdog with a blanket "no execution in 36 hours" rule. It
false-positived every weekend on Monday-to-Friday jobs, the auto-repair
attached to it restarted the scheduler each time, and the repair cycling
eventually took the scheduler out. The outage then looked exactly like the
condition the rule was meant to detect.

The rule was replaced with this computation. If you are building the same
thing, the other two lessons from that incident were: give auto-repair a
cooldown and a hard daily cap, and alert on every intervention including the
successful ones.

## Licence

MIT. See [LICENSE](LICENSE).
