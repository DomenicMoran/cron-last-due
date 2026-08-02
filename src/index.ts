/**
 * When was this cron job last due?
 *
 * Written for a watchdog, not for a scheduler. The question a monitor has to
 * answer is not "when does it run next" but "should it already have run, and
 * did it?". A blanket rule such as "no execution in 36 hours means broken"
 * gets that wrong for every job that does not run continuously: a Monday to
 * Friday job is legitimately silent for 60 hours every weekend.
 *
 * Time zones are the second half of the problem. Schedulers usually run in a
 * local zone while their API reports execution times in UTC. Every function
 * here therefore takes an IANA zone and evaluates the expression in it, using
 * `Intl.DateTimeFormat` rather than a zone database of its own. That keeps the
 * package free of dependencies and correct across daylight saving changes,
 * because the platform already knows the offsets.
 */

/** A parsed five-field cron expression. */
export type ParsedCron = {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** True when the day-of-month field is anything other than `*`. */
  dayOfMonthRestricted: boolean;
  /** True when the day-of-week field is anything other than `*`. */
  dayOfWeekRestricted: boolean;
};

/**
 * Expands one field into the set of values it matches.
 * Returns null on anything it does not understand, so a malformed expression
 * fails loudly instead of silently matching nothing.
 */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();

  for (const part of field.split(",")) {
    const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!m) return null;

    const step = m[2] ? Number.parseInt(m[2], 10) : 1;
    if (step < 1) return null;

    let lo: number;
    let hi: number;

    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else if (m[1].includes("-")) {
      const [a, b] = m[1].split("-").map((n) => Number.parseInt(n, 10));
      lo = a;
      hi = b;
    } else {
      lo = Number.parseInt(m[1], 10);
      hi = lo;
      // "5/10" means "from 5, every 10", so the upper bound opens up.
      if (m[2]) hi = max;
    }

    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  return out.size > 0 ? out : null;
}

/**
 * Parses a cron expression.
 *
 * Accepts five fields (`minute hour day-of-month month day-of-week`) and also
 * six, in which case the leading field is treated as seconds and dropped.
 * Several schedulers, n8n among them, emit the six-field form.
 *
 * Returns null for anything unparseable rather than throwing, because the
 * caller is usually a monitor iterating over jobs it does not control.
 */
export function parseCron(expression: string): ParsedCron | null {
  let fields = expression.trim().split(/\s+/);
  if (fields.length === 6) fields = fields.slice(1);
  if (fields.length !== 5) return null;

  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dowRaw = parseField(fields[4], 0, 7);

  if (!minute || !hour || !dayOfMonth || !month || !dowRaw) return null;

  // Cron allows both 0 and 7 for Sunday.
  const dayOfWeek = new Set<number>([...dowRaw].map((d) => (d === 7 ? 0 : d)));

  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOfMonthRestricted: fields[2] !== "*",
    dayOfWeekRestricted: fields[4] !== "*",
  };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Does the expression match this instant, read in the given zone?
 *
 * @param timeZone IANA zone name, for example "Europe/Berlin".
 */
export function cronMatches(
  cron: ParsedCron,
  date: Date,
  timeZone: string,
): boolean {
  const parts = zoneFormatter(timeZone).formatToParts(date);

  let minute = -1;
  let hour = -1;
  let dayOfMonth = -1;
  let month = -1;
  let dayOfWeek = -1;

  for (const p of parts) {
    if (p.type === "minute") minute = Number.parseInt(p.value, 10);
    else if (p.type === "hour") hour = Number.parseInt(p.value, 10);
    else if (p.type === "day") dayOfMonth = Number.parseInt(p.value, 10);
    else if (p.type === "month") month = Number.parseInt(p.value, 10);
    else if (p.type === "weekday") dayOfWeek = WEEKDAYS[p.value] ?? -1;
  }

  if (!cron.minute.has(minute)) return false;
  if (!cron.hour.has(hour)) return false;
  if (!cron.month.has(month)) return false;

  // Standard cron semantics, and the part most reimplementations get wrong:
  // when BOTH the day-of-month and the day-of-week field are restricted, a
  // match on either one is enough. "0 0 1 * 1" fires on the first of the month
  // AND on every Monday, not on Mondays that fall on the first.
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) {
    return cron.dayOfMonth.has(dayOfMonth) || cron.dayOfWeek.has(dayOfWeek);
  }

  return cron.dayOfMonth.has(dayOfMonth) && cron.dayOfWeek.has(dayOfWeek);
}

export type LastDueOptions = {
  /**
   * How far back to look, in milliseconds. Default seven days.
   *
   * The search walks minute by minute, so the window is also the cost: seven
   * days is 10,080 iterations of a cheap comparison. Raise it for monthly jobs,
   * and be aware that a yearly cron means half a million iterations.
   */
  lookbackMs?: number;
};

/**
 * The most recent instant the cron was due, strictly before `before`.
 *
 * Returns null when the expression is invalid, or when it was not due at any
 * point inside the lookback window. A null therefore means "no answer", not
 * "never due": widen `lookbackMs` for sparse schedules.
 *
 * @example
 * // Did a Monday-to-Friday 07:00 Berlin job miss its slot?
 * const due = lastDueBefore("0 7 * * 1-5", new Date(), "Europe/Berlin");
 * const missed = due !== null && lastRun < due.getTime() - 5 * 60_000;
 */
export function lastDueBefore(
  expression: string,
  before: Date,
  timeZone: string,
  options: LastDueOptions = {},
): Date | null {
  const cron = parseCron(expression);
  if (!cron) return null;

  const lookbackMs = options.lookbackMs ?? 7 * 24 * 3600_000;

  // Start one whole minute before `before`: "strictly before" is what a
  // watchdog wants, otherwise a job that is firing right now looks overdue.
  const start = Math.floor(before.getTime() / 60_000) * 60_000 - 60_000;
  const floor = before.getTime() - lookbackMs;

  for (let t = start; t >= floor; t -= 60_000) {
    const d = new Date(t);
    if (cronMatches(cron, d, timeZone)) return d;
  }

  return null;
}

export type MissedOptions = LastDueOptions & {
  /**
   * How late a run may be before it counts as missed. Default five minutes.
   *
   * A job that fires at :00 and takes four minutes has not missed its slot at
   * :03. Without a margin, every slow job looks broken.
   */
  toleranceMs?: number;
};

/**
 * Did the job miss its last due slot?
 *
 * This is the question a watchdog actually asks. Returns false when the job
 * was not due inside the lookback window, because a job that was never due
 * cannot have missed anything.
 *
 * Throws on an expression it cannot parse, and that is deliberate. Returning
 * false would be the friendlier-looking choice and the dangerous one: a typo
 * in a cron string would read as "nothing missed", the watchdog would stay
 * quiet forever, and the silence would be indistinguishable from health. A
 * monitor that cannot tell has to say so. Use parseCron when you want to
 * check an expression without an exception.
 */
export function hasMissedRun(
  expression: string,
  lastRun: Date | null,
  now: Date,
  timeZone: string,
  options: MissedOptions = {},
): boolean {
  if (!parseCron(expression)) {
    throw new Error(
      `cron-last-due: cannot parse "${expression}". A watchdog must not treat ` +
        `an unreadable schedule as healthy. See the README for the supported subset.`,
    );
  }

  const due = lastDueBefore(expression, now, timeZone, options);
  if (!due) return false;

  const tolerance = options.toleranceMs ?? 5 * 60_000;
  if (!lastRun) return true;

  return lastRun.getTime() < due.getTime() - tolerance;
}
