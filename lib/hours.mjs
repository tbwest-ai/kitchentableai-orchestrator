// SPDX-License-Identifier: AGPL-3.0-only
// Hours, held at the orchestrator in the family's time zone (floor item 2). The clock is the
// container's, never the client's: a kid's device cannot move its own hours by changing its clock.
// The export's hours are local clock times with no zone; the setup supplies the zone.

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_NAMES = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

/** The family's local day, time and date for an instant. */
export function localNow(timeZone, at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const hhmm = `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`;
  const day = parts.weekday.slice(0, 3);
  return {
    day,
    hhmm,
    dateLabel: `${DAY_NAMES[day]}, ${parts.month} ${parts.day}, ${parts.year}`,
  };
}

/** True when the hours allow a message at this local time. "00:00" to "23:59" is the whole day. */
export function inHours(hours, local) {
  const today = hours.find((h) => h.day === local.day);
  if (!today || !today.on) return false;
  if (today.start === "00:00" && today.end === "23:59") return true;
  return local.hhmm >= today.start && local.hhmm < today.end;
}

/** True when the hours never limit anything: every day on, all day. */
export const noLimit = (hours) => hours.every((h) => h.on && h.start === "00:00" && h.end === "23:59");

/** "15:30" -> "3:30pm"; "09:00" -> "9:00am"; "00:00" -> "midnight"; "23:59" -> "midnight". */
function clock(hhmm, end = false) {
  if (hhmm === "00:00" && !end) return "midnight";
  if (hhmm === "23:59" && end) return "midnight";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

const windowOf = (h) => (h.on ? `${clock(h.start)} to ${clock(h.end, true)}` : null);

/**
 * The hours in plain words, consecutive days with the same window grouped:
 * "Monday to Friday 3:30pm to 7:30pm; Saturday and Sunday 9:00am to 7:30pm".
 * A day that is off reads "no AI on Monday".
 */
export function describeHours(hours) {
  if (noLimit(hours)) return "any time, every day";
  const runs = [];
  for (const h of hours) {
    const w = windowOf(h);
    const last = runs[runs.length - 1];
    if (last && last.w === w) last.days.push(h.day);
    else runs.push({ w, days: [h.day] });
  }
  const span = (days) => {
    const names = days.map((d) => DAY_NAMES[d]);
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names[0]} to ${names[names.length - 1]}`;
  };
  return runs.map((r) => (r.w ? `${span(r.days)} ${r.w}` : `no AI on ${span(r.days)}`)).join("; ");
}

/** Today's window in words, for the out-of-hours reply: "3:30pm to 7:30pm today", or null when today is off. */
export function todayWindow(hours, local) {
  const today = hours.find((h) => h.day === local.day);
  return today?.on ? `${clock(today.start)} to ${clock(today.end, true)}` : null;
}

export { DAYS };
