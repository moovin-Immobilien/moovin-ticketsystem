"use client";
import Link from "next/link";
import { useState } from "react";
import { prepareTestbatterieAction, loadTestCaseAction } from "./actions";

type Case = { key: string; name: string; subject: string; intent: string; stufe: number | null; objekt: boolean; folgtAuf: string | null; anhaenge: number };
type State = { status: "wartet" | "laeuft" | "ok" | "fehler"; ticketId?: number | null; error?: string; ms?: number; object?: string | null };
type Result = { key: string; ok: boolean; ticketId: number | null; error?: string; ms: number };

const PARALLEL = 3;

/** Testbatterie laden: je Fall ein eigener Server-Aufruf (kein Vercel-Timeout), höchstens 3 parallel, Folgemails nach dem Vorgänger. */
export function Testbatterie({ cases }: { cases: Case[] }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(cases.map((c) => c.key)));
  const [run, setRun] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, State>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: string) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const set = (key: string, st: Partial<State>) => setStates((s) => ({ ...s, [key]: { ...(s[key] ?? { status: "wartet" }), ...st } }));

  async function start() {
    setBusy(true); setError(null); setStates({});
    try {
      const { run, plan } = await prepareTestbatterieAction([...selected]);
      setRun(run);
      setStates(Object.fromEntries(plan.map((p) => [p.key, { status: "wartet", object: p.objectTitle } as State])));
      // Folgemails ans Ende: ihr Vorgänger ist dann sicher schon gestartet
      const order = [...plan.filter((p) => !p.folgtAuf), ...plan.filter((p) => p.folgtAuf)];
      const running = new Map<string, Promise<Result>>();
      let next = 0;
      const worker = async () => {
        while (next < order.length) {
          const item = order[next++];
          const p = (async (): Promise<Result> => {
            if (item.folgtAuf) {
              const prev = await running.get(item.folgtAuf);
              if (!prev?.ok) return { key: item.key, ok: false, ticketId: null, error: `Vorgänger ${item.folgtAuf} fehlgeschlagen`, ms: 0 };
            }
            set(item.key, { status: "laeuft" });
            try { return await loadTestCaseAction(run, item.key, item.objectId); }
            catch (e) { return { key: item.key, ok: false, ticketId: null, error: (e as Error).message || "Aufruf fehlgeschlagen", ms: 0 }; }
          })();
          running.set(item.key, p);
          const r = await p;
          set(item.key, { status: r.ok ? "ok" : "fehler", ticketId: r.ticketId, error: r.error, ms: r.ms });
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
    } catch (e) {
      setError((e as Error).message || "Start fehlgeschlagen");
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
        <span className="text-sm text-muted">{selected.size} von {cases.length} Fällen ausgewählt · je Fall ein Claude-Aufruf (ca. 10–40 s), {PARALLEL} parallel</span>
      </div>
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
