"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { prepareTestbatterieAction, loadTestCaseAction, resumeTestbatterieAction } from "./actions";

type Case = { key: string; name: string; subject: string; intent: string; stufe: number | null; objekt: boolean; folgtAuf: string | null; anhaenge: number };
type Plan = { key: string; objectId: string | null; objectTitle: string | null; folgtAuf: string | null };
type Open = { run: string; total: number; done: number; failed: number };
type State = { status: "wartet" | "laeuft" | "ok" | "fehler"; ticketId?: number | null; error?: string; ms?: number; object?: string | null };
type Result = { key: string; ok: boolean; ticketId: number | null; error?: string; ms: number };

const PARALLEL = 3;

/**
 * Testbatterie laden: je Fall ein eigener Server-Aufruf (kein Vercel-Timeout), Folgemails nach dem Vorgänger.
 * Der Plan (Objekt je Fall) liegt serverseitig; bricht die Schleife ab (Seite verlassen, Verbindung weg),
 * lassen sich die fehlenden Fälle desselben Laufs mit denselben Objekten nachladen.
 */
export function Testbatterie({ cases, openRuns: initialOpen }: { cases: Case[]; openRuns: Open[] }) {
  const [openRuns, setOpenRuns] = useState<Open[]>(initialOpen);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(cases.map((c) => c.key)));
  const [run, setRun] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, State>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Warnung beim Verlassen der Seite, solange geladen wird – sonst bricht der Lauf ab
  useEffect(() => {
    if (!busy) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [busy]);

  const toggle = (key: string) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const set = (key: string, st: Partial<State>) => setStates((s) => ({ ...s, [key]: { ...(s[key] ?? { status: "wartet" }), ...st } }));

  /** Spielt die Fälle eines Plans ein. doneKeys = im Lauf bereits erfolgreich (nur beim Nachladen). */
  async function execute(runId: string, plan: Plan[], doneKeys: Set<string>) {
    // Folgemails ans Ende: ihr Vorgänger ist dann sicher schon gestartet (oder aus einem früheren Durchlauf vorhanden)
    const order = [...plan.filter((p) => !p.folgtAuf), ...plan.filter((p) => p.folgtAuf)];
    const running = new Map<string, Promise<Result>>();
    let next = 0;
    const worker = async () => {
      while (next < order.length) {
        const item = order[next++];
        const p = (async (): Promise<Result> => {
          if (item.folgtAuf && !doneKeys.has(item.folgtAuf)) {
            const prev = running.get(item.folgtAuf);
            if (!prev) return { key: item.key, ok: false, ticketId: null, error: `Vorgänger ${item.folgtAuf} nicht im Lauf`, ms: 0 };
            const r = await prev;
            if (!r.ok) return { key: item.key, ok: false, ticketId: null, error: `Vorgänger ${item.folgtAuf} fehlgeschlagen`, ms: 0 };
          }
          set(item.key, { status: "laeuft" });
          try { return await loadTestCaseAction(runId, item.key, item.objectId); }
          catch (e) { return { key: item.key, ok: false, ticketId: null, error: (e as Error).message || "Aufruf fehlgeschlagen", ms: 0 }; }
        })();
        running.set(item.key, p);
        const r = await p;
        set(item.key, { status: r.ok ? "ok" : "fehler", ticketId: r.ticketId, error: r.error, ms: r.ms });
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  }

  async function start() {
    setBusy(true); setError(null); setStates({});
    try {
      const { run, plan } = await prepareTestbatterieAction([...selected]);
      setRun(run);
      setStates(Object.fromEntries(plan.map((p) => [p.key, { status: "wartet", object: p.objectTitle } as State])));
      await execute(run, plan, new Set());
    } catch (e) {
      setError((e as Error).message || "Start fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  async function resume(runId: string) {
    setBusy(true); setError(null); setStates({});
    try {
      const st = await resumeTestbatterieAction(runId);
      if (!st) throw new Error("Lauf nicht gefunden");
      setRun(runId);
      const done = new Set(Object.entries(st.results).filter(([, r]) => !r.error && r.ticketId).map(([k]) => k));
      const initial: Record<string, State> = {};
      for (const [k, r] of Object.entries(st.results)) if (done.has(k)) initial[k] = { status: "ok", ticketId: r.ticketId, ms: r.ms ?? 0 };
      for (const p of st.missing) initial[p.key] = { status: "wartet", object: p.objectTitle };
      setStates(initial);
      await execute(runId, st.missing, done);
      const after = await resumeTestbatterieAction(runId);
      setOpenRuns((rs) => rs.map((r) => (r.run === runId && after ? { run: runId, total: after.total, done: after.done, failed: after.failed } : r)).filter((r) => r.done < r.total));
    } catch (e) {
      setError((e as Error).message || "Nachladen fehlgeschlagen");
    } finally {
      setBusy(false);
    }
  }

  const list = Object.values(states);
  const done = list.filter((s) => s.status === "ok" || s.status === "fehler").length;
  const failed = list.filter((s) => s.status === "fehler").length;

  return (
    <div className="space-y-3" data-testid="testbatterie">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-pink" disabled={busy || selected.size === 0} onClick={start} data-testid="testbatterie-start">
          {busy ? `Läuft … ${done}/${list.length}` : "Testbatterie laden"}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => setSelected(new Set(cases.map((c) => c.key)))}>Alle</button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => setSelected(new Set())}>Keine</button>
        <span className="text-sm text-muted">{selected.size} von {cases.length} Fällen ausgewählt · je Fall ein Claude-Aufruf (ca. 5–40 s) · <b>Seite während des Ladens nicht verlassen</b></span>
      </div>
      {openRuns.length > 0 && !busy && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm space-y-1" data-testid="testbatterie-open-runs">
          <div className="font-medium text-amber-900">Unvollständige Läufe</div>
          {openRuns.map((r) => (
            <div key={r.run} className="flex flex-wrap items-center gap-3">
              <span className="tabular-nums">Lauf {r.run}: {r.done}/{r.total} eingespielt{r.failed ? `, ${r.failed} Fehler` : ""}</span>
              <button type="button" className="btn-ghost" onClick={() => resume(r.run)} data-testid={`testbatterie-resume-${r.run}`}>Fehlende Fälle nachladen</button>
              <Link className="underline text-navy" href={`/simulieren/bericht?run=${r.run}`}>Bericht</Link>
            </div>
          ))}
        </div>
      )}
      {run && (
        <div className="rounded-lg bg-canvas px-3 py-2 text-sm flex flex-wrap items-center gap-3" data-testid="testbatterie-progress">
          <span>Lauf <b className="tabular-nums" data-testid="testbatterie-run">{run}</b></span>
          <span className="tabular-nums">{done}/{list.length} fertig{failed ? <span className="text-pink"> · {failed} Fehler</span> : null}</span>
          <div className="h-1.5 w-48 rounded-full bg-line overflow-hidden"><div className="h-full bg-navy" style={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }} /></div>
          {!busy && <Link className="underline text-navy" href={`/simulieren/bericht?run=${run}`} data-testid="testbatterie-report">Testbericht öffnen →</Link>}
        </div>
      )}
      {error && <p className="text-sm text-pink">{error}</p>}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
            <tr><th className="px-3 py-2 w-8" /><th className="px-3 py-2">Fall</th><th className="px-3 py-2">Soll</th><th className="px-3 py-2">Objekt</th><th className="px-3 py-2">Status</th></tr>
          </thead>
          <tbody>
            {cases.map((c) => {
              const st = states[c.key];
              return (
                <tr key={c.key} className="border-t border-line align-top" data-testid={`case-${c.key}`}>
                  <td className="px-3 py-2"><input type="checkbox" className="accent-navy" checked={selected.has(c.key)} onChange={() => toggle(c.key)} disabled={busy} aria-label={c.key} /></td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-ink">{c.key}{c.folgtAuf && <span className="ml-1 text-xs text-muted">(folgt auf {c.folgtAuf})</span>}</div>
                    <div className="text-xs text-muted truncate max-w-md">{c.name} · {c.subject}{c.anhaenge ? ` · ${c.anhaenge} Anhang/Anhänge` : ""}</div>
                  </td>
                  <td className="px-3 py-2 text-xs text-muted whitespace-nowrap">{c.intent}{c.stufe !== null ? ` · Stufe ${c.stufe}` : ""}</td>
                  <td className="px-3 py-2 text-xs text-muted">{st?.object ?? (c.objekt ? "" : "ohne Objekt")}</td>
                  <td className="px-3 py-2 text-xs whitespace-nowrap" data-testid={`case-status-${c.key}`} data-status={st?.status ?? ""}>
                    {!st ? "" : st.status === "wartet" ? <span className="text-muted">wartet</span>
                      : st.status === "laeuft" ? <span className="text-amber-700">läuft …</span>
                      : st.status === "ok" ? <span className="text-emerald-700">✓ <Link className="underline" href={`/tickets/${st.ticketId}`}>T-{st.ticketId}</Link> · {Math.round((st.ms ?? 0) / 1000)} s</span>
                      : <span className="text-pink" title={st.error}>✗ {st.error}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
