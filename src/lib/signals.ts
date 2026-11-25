// Ticket-Intelligenz: Signale bestätigen und die Stufe setzen (siehe claude/ticket-intelligenz.md im Projekt).
// Grundsatz: Priorisiert wird der Vorgang, nie die Person. Kein Signal bewertet Einkommen, Bonität, Herkunft o. Ä.
// Claude liefert nur Hinweise aus dem Mailtext; der Server bestätigt sie mit harten Daten und setzt die Stufe.
// Reine Funktionen (ohne Datenbank), damit sie direkt getestet werden können.
import type { ApplicantContext, Application } from "./moovin/types";

/** Werte, die Claude liefern darf (feste Liste, kein Freitext). */
export const SIGNAL_TYPES = [
  "unterlagen_eingegangen", "zusage_nach_besichtigung", "vertragsphase", "konkurrenz_frist",
  "termin_bald", "rueckzug_spaet", "eskalation", "kein_handlungsbedarf",
] as const;
export type RawSignalType = (typeof SIGNAL_TYPES)[number];
/** Zusätzlich vom Server erkannt (ohne KI). */
export type SignalType = RawSignalType | "nachgehakt";

export type RawSignal = { type: string; evidence?: string; deadline?: string };

export type Signal = {
  type: SignalType;
  /** 1 Abschluss-Chance · 2 zeitkritisch · 3 nur Hinweis · 4 kein Handlungsbedarf */
  stage: 1 | 2 | 3 | 4;
  /** mit Daten bestätigt (moovin, Anhänge, Verlauf) */
  confirmed: boolean;
  /** „mail“: nur laut Mail (z. B. moovin-Anbindung aus) → gestrichelte Markierung */
  basis: "daten" | "mail";
  /** Zeile „Warum oben?“ */
  why: string;
  evidence: string;
  deadline?: string;
  /** Termin, auf den sich das Signal bezieht (für „Slot nachbesetzen“) */
  appointment_at?: string;
};

export const SIGNAL_INFO: Record<SignalType, { label: string; fall: "B" | "C" | "D" | "-"; short: string }> = {
  unterlagen_eingegangen: { label: "Unterlagen eingegangen", fall: "B", short: "Unterlagen" },
  zusage_nach_besichtigung: { label: "Anmietwunsch nach Besichtigung", fall: "C", short: "Will anmieten" },
  vertragsphase: { label: "Vertragsphase", fall: "C", short: "Vertrag" },
  konkurrenz_frist: { label: "Konkurrenzangebot / Entscheidungsfrist", fall: "C", short: "Frist" },
  termin_bald: { label: "Termin in < 48 h", fall: "B", short: "Termin bald" },
  rueckzug_spaet: { label: "Rückzug in später Phase", fall: "B", short: "Abschluss-Risiko" },
  eskalation: { label: "Eskalation", fall: "C", short: "Eskalation" },
  nachgehakt: { label: "Nachgehakt (≥ 2 Mails ohne Antwort)", fall: "-", short: "Nachgehakt" },
  kein_handlungsbedarf: { label: "Kein Handlungsbedarf", fall: "D", short: "Kein Handlungsbedarf" },
};

/** Fall C: Die persönliche Antwort entscheidet über den Abschluss → nie automatisch senden. */
export const AUTO_BLOCKING: SignalType[] = ["zusage_nach_besichtigung", "vertragsphase", "konkurrenz_frist", "eskalation", "kein_handlungsbedarf"];

// ---------- Unterlagenarten (nur Dateinamen und die Liste fehlender Unterlagenarten – nie Inhalte) ----------
const DOC_KINDS: [string, RegExp][] = [
  ["Gehaltsnachweise", /gehalt|lohn|verdienst|einkommensnachweis|bez(ü|ue)ge|payslip|salary|entgelt/i],
  ["SCHUFA", /schufa|bonit|crif|credit/i],
  ["Selbstauskunft", /selbstauskunft|mieterauskunft/i],
  ["Ausweis", /ausweis|personalausweis|reisepass|passport|perso\b|id[-_ ]?card|identit/i],
  ["Mietschuldenfreiheit", /mietschuld|vermieterbescheinigung|vormieter/i],
  ["WBS", /\bwbs\b|wohnberechtigung/i],
];
export function docKind(name: string): string | null {
  return DOC_KINDS.find(([, re]) => re.test(name))?.[0] ?? null;
}

const LATE: Application["status"][] = ["besichtigt", "beim_eigentuemer", "zusage"];
const ACTIVE = (a: Application) => !["absage", "zurueckgezogen"].includes(a.status);

function fmtDay(iso: string) {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit" }).format(new Date(iso));
}
function fmtWhen(iso: string) {
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
const clip = (s: string | undefined, n = 120) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const validDate = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);

export type EvaluateInput = {
  raw: RawSignal[];
  intent: string;
  attachments: { filename: string }[];
  ctx: ApplicantContext | null;
  moovinOn: boolean;
  /** Bewerber-Mails seit unserer letzten Antwort (inkl. der neuen) */
  unansweredInbound: number;
  /** Anzahl vorgeschlagener Aktionen (Fall D nur ohne Aktion) */
  actionCount: number;
  /** System-Benachrichtigung (no-reply, ImmoScout) */
  systemNotice?: boolean;
  /** vom Admin abgeschaltete Signale */
  disabled?: string[];
  /** am Ticket als „passt nicht“ gemeldete Signale */
  rejected?: string[];
  now?: Date;
};

export type Evaluation = { signals: Signal[]; priority: 1 | 2 | 3 | 4; autoBlocked: boolean; deadline: string | null };

export function evaluateSignals(i: EvaluateInput): Evaluation {
  const now = i.now ?? new Date();
  const raw = new Map<string, RawSignal>();
  for (const r of i.raw ?? []) if ((SIGNAL_TYPES as readonly string[]).includes(r.type) && !raw.has(r.type)) raw.set(r.type, r);
  const apps = i.ctx?.applications ?? [];
  const off = !i.moovinOn;
  const out: Signal[] = [];
  const add = (s: Omit<Signal, "evidence"> & { evidence?: string }) => out.push({ ...s, evidence: clip(s.evidence) });

  // Nach der Besichtigung? (Status besichtigt/beim Eigentümer/Zusage oder Termin stattgefunden)
  const viewed = apps.find((a) => ACTIVE(a) && (LATE.includes(a.status) || a.appointment?.status === "stattgefunden"));
  const viewedAt = viewed?.appointment?.status === "stattgefunden" ? ` am ${fmtDay(viewed.appointment.starts_at)}` : "";

  // 1 · Unterlagen: harte Daten = Anhänge (auch ohne Hinweis der KI)
  if (i.attachments.length) {
    const n = i.attachments.length;
    const kinds = [...new Set(i.attachments.map((a) => docKind(a.filename)).filter((k): k is string => !!k))];
    const missing = apps.filter(ACTIVE).flatMap((a) => a.missing_documents);
    const missingKinds = [...new Set(missing.map(docKind).filter((k): k is string => !!k))];
    const covered = missingKinds.filter((k) => kinds.includes(k));
    const complete = missingKinds.length > 0 && covered.length === missingKinds.length;
    const ev = raw.get("unterlagen_eingegangen")?.evidence || i.attachments.map((a) => a.filename).join(", ");
    if (off) add({ type: "unterlagen_eingegangen", stage: 1, confirmed: false, basis: "mail", why: `${n} Unterlage(n) eingegangen – Stand in moovin prüfen`, evidence: ev });
    else if (viewed) add({ type: "unterlagen_eingegangen", stage: 1, confirmed: true, basis: "daten", why: `${n} Unterlage(n) nach Besichtigung${viewedAt}`, evidence: ev });
    else if (complete) add({ type: "unterlagen_eingegangen", stage: 1, confirmed: true, basis: "daten", why: `Fehlten: ${missingKinds.join(", ")} → alle geschickt (Bewerbung evtl. vollständig)`, evidence: ev });
    else add({ type: "unterlagen_eingegangen", stage: 3, confirmed: true, basis: "daten",
      why: covered.length ? `Fehlten: ${missingKinds.join(", ")} → geschickt: ${covered.join(", ")}` : `${n} Unterlage(n) eingegangen`, evidence: ev });
  }

  // 2 · Anmietwunsch nach Besichtigung
  const z = raw.get("zusage_nach_besichtigung");
  if (z) {
    if (off) add({ type: "zusage_nach_besichtigung", stage: 1, confirmed: false, basis: "mail", why: "Will anmieten (laut Mail)", evidence: z.evidence });
    else if (viewed) add({ type: "zusage_nach_besichtigung", stage: 1, confirmed: true, basis: "daten", why: `Will anmieten (Besichtigung${viewedAt || " erfolgt"})`, evidence: z.evidence });
    else add({ type: "zusage_nach_besichtigung", stage: 3, confirmed: false, basis: "daten", why: "Anmietwunsch, aber laut moovin noch keine Besichtigung", evidence: z.evidence });
  }

  // 3 · Vertragsphase
  const v = raw.get("vertragsphase");
  if (v) {
    const late = apps.find((a) => ["beim_eigentuemer", "zusage"].includes(a.status));
    if (off) add({ type: "vertragsphase", stage: 1, confirmed: false, basis: "mail", why: "Vertragsphase (laut Mail)", evidence: v.evidence });
    else if (late) add({ type: "vertragsphase", stage: 1, confirmed: true, basis: "daten", why: `Vertragsphase (${late.status === "zusage" ? "Zusage" : "beim Eigentümer"})`, evidence: v.evidence });
    else add({ type: "vertragsphase", stage: 3, confirmed: false, basis: "daten", why: "Frage zum Vertrag, Bewerbung aber noch nicht beim Eigentümer", evidence: v.evidence });
  }

  // 4 · Konkurrenzangebot / Entscheidungsfrist
  const k = raw.get("konkurrenz_frist");
  let deadline: string | null = null;
  if (k) {
    const d = validDate(k.deadline);
    const when = d ? `Entscheidet bis ${fmtDay(`${d}T12:00:00Z`)}` : "Konkurrenzangebot";
    if (off) { add({ type: "konkurrenz_frist", stage: 1, confirmed: false, basis: "mail", why: `${when} (laut Mail)`, evidence: k.evidence, deadline: d }); deadline = d ?? null; }
    else if (apps.some(ACTIVE)) { add({ type: "konkurrenz_frist", stage: 1, confirmed: true, basis: "daten", why: when, evidence: k.evidence, deadline: d }); deadline = d ?? null; }
    else add({ type: "konkurrenz_frist", stage: 3, confirmed: false, basis: "daten", why: `${when}, aber keine aktive Bewerbung`, evidence: k.evidence, deadline: d });
  }

  // 5 · Termin in < 48 h (Daten: offener Termin in moovin)
  const tb = raw.get("termin_bald");
  const terminIntent = /^termin_|besichtigung_frage/.test(i.intent);
  if (!off) {
    const soon = apps.map((a) => a.appointment).filter((a): a is NonNullable<typeof a> => !!a && ["eingeladen", "bestaetigt"].includes(a.status))
      .filter((a) => { const ms = new Date(a.starts_at).getTime() - now.getTime(); return ms > -2 * 3600_000 && ms < 48 * 3600_000; })
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at))[0];
    if (soon && (tb || terminIntent)) add({ type: "termin_bald", stage: 2, confirmed: true, basis: "daten", why: `Termin ${fmtWhen(soon.starts_at)} (in < 48 h)`, evidence: tb?.evidence, appointment_at: soon.starts_at });
  } else if (tb) add({ type: "termin_bald", stage: 2, confirmed: false, basis: "mail", why: "Termin heute/morgen (laut Mail)", evidence: tb.evidence });

  // 6 · Rückzug in später Phase (Daten: Status besichtigt/beim Eigentümer/Zusage)
  const rs = raw.get("rueckzug_spaet");
  if (!off) {
    const late = apps.find((a) => LATE.includes(a.status));
    if (late && (rs || i.intent === "rueckzug")) add({ type: "rueckzug_spaet", stage: 2, confirmed: true, basis: "daten", why: `Abschluss-Risiko: Rückzug (Status ${late.status === "beim_eigentuemer" ? "beim Eigentümer" : late.status}) – nächsten Kandidaten aktivieren`, evidence: rs?.evidence });
  } else if (rs) add({ type: "rueckzug_spaet", stage: 2, confirmed: false, basis: "mail", why: "Rückzug nach Besichtigung (laut Mail) – nächsten Kandidaten prüfen", evidence: rs.evidence });

  // 7 · Eskalation (Text genügt)
  const e = raw.get("eskalation");
  if (e || i.intent === "beschwerde") add({ type: "eskalation", stage: 2, confirmed: true, basis: "mail", why: "Eskalation – Teamleitung informiert", evidence: e?.evidence });

  // 8 · Nachgehakt (Verlauf)
  if (i.unansweredInbound >= 2) add({ type: "nachgehakt", stage: 2, confirmed: true, basis: "daten", why: `${i.unansweredInbound} Mails ohne Antwort`, evidence: "" });

  // Abgeschaltete und am Ticket verworfene Signale fallen weg
  const drop = new Set([...(i.disabled ?? []), ...(i.rejected ?? [])]);
  let signals = out.filter((s) => !drop.has(s.type));

  // 9 · Kein Handlungsbedarf: nur wenn sonst nichts anliegt (keine Anhänge, keine Aktion, kein anderes Signal)
  const d = raw.get("kein_handlungsbedarf");
  if ((d || i.systemNotice) && !drop.has("kein_handlungsbedarf") && !i.attachments.length && !i.actionCount && !signals.some((s) => s.stage <= 2)) {
    signals.push({ type: "kein_handlungsbedarf", stage: 4, confirmed: true, basis: "mail", why: i.systemNotice ? "System-Benachrichtigung" : "Kein Handlungsbedarf – ohne Antwort schließen", evidence: clip(d?.evidence) });
  }
  if (deadline && !signals.some((s) => s.type === "konkurrenz_frist")) deadline = null;
  signals = signals.sort((a, b) => a.stage - b.stage);

  const top = Math.min(...signals.filter((s) => s.stage !== 3).map((s) => s.stage), 9);
  const priority = (top <= 2 ? top : signals.some((s) => s.stage === 4) ? 4 : 3) as 1 | 2 | 3 | 4;
  const autoBlocked = signals.some((s) => AUTO_BLOCKING.includes(s.type));
  return { signals, priority, autoBlocked, deadline };
}

/** Fall B: Antwort darf automatisch raus, die Arbeit bleibt → Aufgabe mit Markierung. */
export type FollowUp = { type: "unterlagen_pruefen" | "slot_nachbesetzen" | "kandidat_aktivieren"; priority: 1 | 2; text: string; merges: string[] };
export function followUpTasks(signals: Signal[], intent: string | null): FollowUp[] {
  const res: FollowUp[] = [];
  for (const s of signals) {
    if (s.type === "unterlagen_eingegangen" && s.stage === 1) res.push({ type: "unterlagen_pruefen", priority: 1, text: `Unterlagen prüfen – Abschluss-Chance: ${s.why}`, merges: ["manuell"] });
    if (s.type === "termin_bald" && intent === "termin_absage") res.push({ type: "slot_nachbesetzen", priority: 2, text: `Slot nachbesetzen – Absage für ${s.appointment_at ? fmtWhen(s.appointment_at) : "Termin heute/morgen"}`, merges: [] });
    if (s.type === "rueckzug_spaet") res.push({ type: "kandidat_aktivieren", priority: 2, text: `Nächsten Kandidaten aktivieren – ${s.why}`, merges: ["rueckzug"] });
  }
  return res;
}
