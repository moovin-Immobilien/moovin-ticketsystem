// SLA: Antwort am gleichen Werktag. Eingang Werktag vor 16:00 → 18:00 desselben Tages, sonst nächster Werktag 12:00 (Europe/Berlin).
const TZ = "Europe/Berlin";

function berlinParts(d: Date) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, wd: p.weekday as string };
}

function berlinToUtc(y: number, m: number, d: number, h: number): Date {
  // Offset von Europe/Berlin zum gewünschten Zeitpunkt ermitteln (Sommer-/Winterzeit-sicher)
  const asUtc = Date.UTC(y, m - 1, d, h, 0, 0);
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" });
  const name = f.formatToParts(new Date(asUtc)).find((p) => p.type === "timeZoneName")?.value ?? "GMT+01:00";
  const mm = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  const offsetMin = mm ? (mm[1] === "-" ? -1 : 1) * (+mm[2] * 60 + +mm[3]) : 60;
  return new Date(asUtc - offsetMin * 60_000);
}

const isWeekend = (wd: string) => wd === "Sat" || wd === "Sun";

export function dueDate(received: Date): Date {
  const p = berlinParts(received);
  if (!isWeekend(p.wd) && p.h < 16) return berlinToUtc(p.y, p.m, p.d, 18);
  let cursor = new Date(Date.UTC(p.y, p.m - 1, p.d, 12));
  for (let i = 0; i < 7; i++) {
    cursor = new Date(cursor.getTime() + 24 * 3600_000);
    const c = berlinParts(cursor);
    if (!isWeekend(c.wd)) return berlinToUtc(c.y, c.m, c.d, 12);
  }
  return new Date(received.getTime() + 24 * 3600_000);
}
