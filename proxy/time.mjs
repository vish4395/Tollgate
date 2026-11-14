// Day and month boundaries in the gateway's time zone, so "daily" limits reset at local midnight.

/** Minutes the zone is ahead of UTC at the given moment. */
export function zoneOffsetMin(tz, at = new Date()) {
  try {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(at)
        .map((x) => [x.type, x.value]),
    );
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((local - at.getTime()) / 60_000);
  } catch {
    return 0; // unknown zone: fall back to UTC
  }
}

export const validZone = (tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** ISO time (UTC) at which the current local day or month began. */
export function zoneStart(tz, unit = "day", at = new Date()) {
  const off = zoneOffsetMin(tz, at) * 60_000;
  const local = new Date(at.getTime() + off);
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), unit === "month" ? 1 : local.getUTCDate());
  // The offset at the start can differ from now (daylight saving): use the one in force then.
  let start = wall - off;
  start = wall - zoneOffsetMin(tz, new Date(start)) * 60_000;
  return new Date(start).toISOString();
}

/** Local calendar day (YYYY-MM-DD) of an ISO timestamp. */
export const zoneDay = (iso, offsetMin) =>
  new Date(Date.parse(iso) + offsetMin * 60_000).toISOString().slice(0, 10);

/** Local end of a YYYY-MM-DD date, as ISO UTC. Used for "expires on" dates. */
export function zoneEndOfDay(tz, ymd) {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  const guess = new Date(Date.UTC(y, m - 1, d, 12));
  const off = zoneOffsetMin(tz, guess) * 60_000;
  return new Date(Date.UTC(y, m - 1, d + 1) - off - 1000).toISOString();
}
