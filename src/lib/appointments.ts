// Welcher Termin ist gemeint? Bewerber können mehrere Bewerbungen mit offenen Terminen haben.
// Die Zuordnung entscheidet der Server, nicht die KI – in dieser Reihenfolge:
//   1. Termin-Referenz „[Termin <id>]“ im Betreff/Text (steht in jeder Einladungs- und Erinnerungsmail von moovin)
//   2. nur ein offener Termin → dieser
//   3. Datum, Inserats-Kennung oder Adresse genau eines Termins in der Mail (auch im zitierten Original)
//   sonst: keine Terminaktion, Mensch bzw. Rückfrage.
import type { ApplicantContext, Appointment, Application } from "./moovin/types";

export type ResolvedAppointment =
  | { id: string; how: "referenz" | "einziger" | "erwaehnt" }
  | { id: null; reason: string };

const REF = /\[Termin\s+([A-Za-z0-9_.-]+)\]/gi;
const STOP = new Set(["zimmer", "wohnung", "apartment", "besichtigung", "treffpunkt", "sammelbesichtigung", "einzelbesichtigung",
  "hauseingang", "eingang", "foyer", "berlin", "hamburg", "potsdam", "münchen", "frankfurt", "köln", "leipzig", "düsseldorf", "straße", "strasse", "allee"]);

export function openAppointments(ctx: ApplicantContext | null, now = new Date()): { app: Application; appt: Appointment }[] {
  return (ctx?.applications ?? [])
    .filter((a) => a.appointment && ["eingeladen", "bestaetigt"].includes(a.appointment.status) && new Date(a.appointment.starts_at) > now)
    .map((a) => ({ app: a, appt: a.appointment! }));
}

function dateTokens(iso: string): string[] {
  const p = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "numeric", month: "numeric" }).formatToParts(new Date(iso));
  const d = p.find((x) => x.type === "day")!.value, m = p.find((x) => x.type === "month")!.value;
  const dd = d.padStart(2, "0"), mm = m.padStart(2, "0");
  return [...new Set([`${dd}.${mm}.`, `${d}.${m}.`, `${dd}.${m}.`, `${d}.${mm}.`])];
}

function words(s: string | null | undefined): string[] {
  return (s ?? "").toLowerCase().split(/[^a-zäöüß0-9]+/).filter((w) => w.length >= 5 && !STOP.has(w) && !/^\d+$/.test(w));
}

export function resolveAppointment(ctx: ApplicantContext | null, mailSubject: string, mailText: string, now = new Date()): ResolvedAppointment {
  const open = openAppointments(ctx, now);
  if (!open.length) return { id: null, reason: "Kein offener Termin gefunden" };

  // 1. Referenz, Betreff zuerst
  for (const src of [mailSubject, mailText]) {
    const refs = [...src.matchAll(REF)].map((m) => m[1].toLowerCase());
    const hit = open.filter((o) => refs.includes(o.appt.id.toLowerCase()));
    if (hit.length === 1) return { id: hit[0].appt.id, how: "referenz" };
  }

  // 2. eindeutig
  if (open.length === 1) return { id: open[0].appt.id, how: "einziger" };

  // 3. Datum / Kennung / Adresse, die nur zu einem Termin passt
  const text = `${mailSubject}\n${mailText}`.toLowerCase();
  const tokens = open.map((o) => ({
    id: o.appt.id,
    dates: dateTokens(o.appt.starts_at),
    listing: o.app.listing_id.toLowerCase(),
    words: new Set([...words(o.app.object_title), ...words(o.appt.meeting_point)]),
  }));
  const mentioned = tokens.filter((t) => {
    const others = tokens.filter((x) => x.id !== t.id);
    const uniqueDate = t.dates.some((d) => text.includes(d) && !others.some((x) => x.dates.includes(d)));
    const uniqueListing = text.includes(t.listing) && !others.some((x) => x.listing === t.listing);
    const uniqueWord = [...t.words].some((w) => text.includes(w) && !others.some((x) => x.words.has(w)));
    return uniqueDate || uniqueListing || uniqueWord;
  });
  if (mentioned.length === 1) return { id: mentioned[0].id, how: "erwaehnt" };
  return { id: null, reason: `Mehrere offene Termine (${open.length}) – aus der Mail nicht eindeutig, welcher gemeint ist` };
}
