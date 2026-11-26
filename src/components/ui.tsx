import { INTENT_LABEL, type Intent } from "@/lib/intents";

const STATUS_STYLE: Record<string, [string, string]> = {
  neu: ["Neu", "bg-pink-50 text-pink"],
  in_bearbeitung: ["In Bearbeitung", "bg-amber-50 text-amber-700"],
  entwurf: ["Entwurf bereit", "bg-blue-50 text-blue-700"],
  beantwortet: ["Beantwortet", "bg-emerald-50 text-emerald-700"],
  wartet: ["Wartet", "bg-slate-100 text-slate-600"],
  geschlossen: ["Geschlossen", "bg-slate-100 text-slate-500"],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, cls] = STATUS_STYLE[status] ?? [status, "bg-slate-100 text-slate-600"];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function IntentBadge({ intent }: { intent: string | null }) {
  if (!intent) return <span className="text-muted text-xs">–</span>;
  return <span className="badge bg-navy/5 text-navy">{INTENT_LABEL[intent as Intent] ?? intent}</span>;
}

export function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null || value === undefined) return null;
  const pct = Math.round(Number(value) * 100);
  const color = pct >= 85 ? "bg-emerald-500" : pct >= 60 ? "bg-amber-500" : "bg-pink";
  return (
    <div className="flex items-center gap-2" title={`Konfidenz ${pct} %`}>
      <div className="h-1.5 w-16 rounded-full bg-line overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${pct}%` }} /></div>
      <span className="text-xs text-muted tabular-nums whitespace-nowrap">{pct} %</span>
    </div>
  );
}

export function fmtDateTime(d: Date | string | null | undefined) {
  if (!d) return "–";
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
}

export function fmtLong(d: Date | string | null | undefined) {
  if (!d) return "–";
  return new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(d));
}

/** Kennzeichen für Testtickets (Testbatterie/Testmail): kein Versand, nicht in Kennzahlen. */
export function TestBadge({ isTest }: { isTest?: boolean | null }) {
  if (!isTest) return null;
  return <span className="badge bg-violet-100 text-violet-800 font-semibold" title="Testticket: es geht nie eine Mail raus, zählt nicht in Kennzahlen" data-testid="badge-test">TEST</span>;
}

export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified
    ? <span className="badge bg-emerald-50 text-emerald-700" title="DKIM/DMARC bestanden">✓ Absender verifiziert</span>
    : <span className="badge bg-amber-50 text-amber-700" title="DKIM/DMARC nicht bestanden – keine Aktionen in moovin">⚠ nicht verifiziert</span>;
}
