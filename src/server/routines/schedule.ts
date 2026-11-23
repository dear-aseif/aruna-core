/**
 * Routine scheduling (task 10.1, design §2.11): pure functions that decide, for one tenant, what
 * its local date and time are and whether its briefing is due. No I/O; the engine supplies `now`.
 */
/** Applied when the Playbook has no `schedule.briefingTime` ("early morning", design §2.11). */
export const DEFAULT_BRIEFING_TIME = "06:00";

export interface LocalMoment {
  /** The tenant's local calendar date, YYYY-MM-DD: the briefing's schedule date. */
  date: string;
  /** The tenant's local time of day, HH:MM (24 hour). */
  time: string;
}

/** The instant `now` as a wall-clock date and time in an IANA timezone. Throws RangeError for an unknown timezone. */
export function localMoment(now: Date, timeZone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** The calendar date before `date` (YYYY-MM-DD): the briefing's "yesterday". */
export function previousDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export interface BriefingDecision extends LocalMoment {
  /** True from the briefing time onward on the local date (a late cron run still catches up the same day). */
  due: boolean;
  briefingTime: string;
}

/**
 * A tenant is due once its local time reaches the briefing time, and not before. Whether the
 * briefing for that date has already run is a separate question (the run record), answered by the engine.
 */
export function decideBriefing(now: Date, timeZone: string, briefingTime: string | undefined): BriefingDecision {
  const at = briefingTime ?? DEFAULT_BRIEFING_TIME;
  const local = localMoment(now, timeZone);
  // Both are zero-padded HH:MM, so string order is time order.
  return { ...local, due: local.time >= at, briefingTime: at };
}
