import { SIGNAL_INFO, type Signal } from "@/lib/signals";

/** Ticket-Intelligenz: Farbbalken links (Stufe 1 grün, 2 orange, 4 grau; gestrichelt = nur laut Mail). */
export function markClass(priority: number | null | undefined, signals?: Signal[] | null): string {
  const p = Number(priority ?? 3);
  const top = (signals ?? []).filter((s) => s.stage === p);
  const dashed = top.length > 0 && top.every((s) => s.basis === "mail" && !s.confirmed) ? " border-dashed" : "";
  if (p === 1) return `border-l-4 border-emerald-500${dashed}`;
  if (p === 2) return `border-l-4 border-orange-400${dashed}`;
  if (p === 4) return "border-l-4 border-slate-200";
  return "border-l-4 border-transparent";
}

export const STAGE_LABEL: Record<number, string> = { 1: "Abschluss-Chance", 2: "Zeitkritisch", 3: "Normal", 4: "Kein Handlungsbedarf" };
const ICON: Record<number, string> = { 1: "▲", 2: "⏱", 4: "–" };

/** Zeile „Warum oben?“ mit den Belegen der Signale. */
export function WhyLine({ priority, signals }: { priority: number | null | undefined; signals?: Signal[] | null }) {
  const p = Number(priority ?? 3);
  const shown = (signals ?? []).filter((s) => s.stage <= 2 || (p === 4 && s.stage === 4));
  if (!shown.length || p === 3) return null;
  const color = p === 1 ? "text-emerald-700" : p === 2 ? "text-orange-700" : "text-slate-500";
  return (
    <div className={`text-xs ${color}`} data-testid="why">
      <span className="font-semibold">{ICON[p]} {p === 4 ? "Kein Handlungsbedarf" : "Warum oben?"}</span>{" "}
      {shown.map((s, i) => (
        <span key={s.type}>
          {i > 0 && " · "}
          {p === 4 && s.type === "kein_handlungsbedarf" ? s.why.replace(/^Kein Handlungsbedarf – /, "") : s.why}
          {s.basis === "mail" && !s.confirmed && <span className="text-muted"> (laut Mail)</span>}
        </span>
      ))}
    </div>
  );
}

export function SignalChips({ signals }: { signals?: Signal[] | null }) {
  return (
    <>
      {(signals ?? []).map((s) => (
        <span key={s.type} className={`badge ${s.stage === 1 ? "bg-emerald-50 text-emerald-700" : s.stage === 2 ? "bg-orange-50 text-orange-700" : "bg-slate-100 text-slate-600"} ${s.basis === "mail" && !s.confirmed ? "border border-dashed border-current" : ""}`}>
          {SIGNAL_INFO[s.type]?.short ?? s.type}
        </span>
      ))}
    </>
  );
}
