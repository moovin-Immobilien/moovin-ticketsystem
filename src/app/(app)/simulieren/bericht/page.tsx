import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { sql } from "@/lib/db";
import { TEST_CASES, RUN_RE, compare, type Actual, type Expected } from "@/lib/testbatterie";

/** Testbericht je Lauf: Soll (testbatterie.json) gegen Ist (Stand direkt nach der Verarbeitung des Falls). */
export default async function Bericht(props: PageProps<"/simulieren/bericht">) {
  await requireAdmin();
  const sp = await props.searchParams;
  const runs = await sql`select test_run, count(*) as n, count(*) filter (where error is not null) as errors, min(created_at) as at
    from ticket.test_results group by test_run order by test_run desc limit 50`;
  const run = typeof sp.run === "string" && RUN_RE.test(sp.run) ? sp.run : (runs[0]?.test_run as string | undefined) ?? null;
  const rows = run ? await sql`select r.*, t.subject, t.sender_email, t.is_test from ticket.test_results r left join ticket.tickets t on t.id = r.ticket_id where r.test_run = ${run}` : [];
  const byKey = new Map(rows.map((r) => [String(r.case_key), r]));
  const order = TEST_CASES.map((c) => c.key).filter((k) => byKey.has(k));
  for (const r of rows) if (!order.includes(String(r.case_key))) order.push(String(r.case_key));

  const results = order.map((k) => {
    const r = byKey.get(k)!;
    const exp = (TEST_CASES.find((c) => c.key === k)?.erwartet ?? r.expected ?? {}) as Expected;
    return { key: k, r, exp, checks: compare(exp, (r.actual ?? null) as Actual | null) };
  });
  const rate = (field: string) => {
    const xs = results.map((x) => x.checks.find((c) => c.field === field)).filter((c) => c && c.ok !== null);
    const ok = xs.filter((c) => c!.ok).length;
    return { ok, n: xs.length, pct: xs.length ? Math.round((ok / xs.length) * 100) : null };
  };
  const intent = rate("Anliegen"), stufe = rate("Stufe");
  const errors = results.filter((x) => x.r.error).length;
  const deviations = results.filter((x) => x.checks.some((c) => c.ok === false)).length;

  return (
    <div className="space-y-5" data-testid="testbericht">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/simulieren" className="text-xs text-muted hover:text-navy">← Testmail / Testbatterie</Link>
          <h1 className="text-xl font-semibold text-navy mt-1">Testbericht{run ? ` · Lauf ${run}` : ""}</h1>
        </div>
        <form action="/simulieren/bericht" className="flex gap-2">
          <select name="run" defaultValue={run ?? ""} className="input w-72">
            {runs.map((r) => <option key={r.test_run} value={r.test_run}>Lauf {r.test_run} · {String(r.n)} Fälle{Number(r.errors) ? ` · ${r.errors} Fehler` : ""}</option>)}
          </select>
          <button className="btn-ghost">Anzeigen</button>
        </form>
      </div>

      {!run && <div className="card p-8 text-center text-muted">Noch kein Lauf. Unter „Testmail“ die Testbatterie laden.</div>}

      {run && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Kpi label="Trefferquote Anliegen" value={intent.pct === null ? "–" : `${intent.pct} %`} sub={`${intent.ok}/${intent.n}`} testid="quote-anliegen" />
            <Kpi label="Trefferquote Stufe" value={stufe.pct === null ? "–" : `${stufe.pct} %`} sub={`${stufe.ok}/${stufe.n}`} testid="quote-stufe" />
            <Kpi label="Fälle" value={String(results.length)} sub="eingespielt" />
            <Kpi label="Mit Abweichung" value={String(deviations)} warn={deviations > 0} sub="mind. ein Feld rot" />
            <Kpi label="Fehler" value={String(errors)} warn={errors > 0} sub="nicht verarbeitet" />
          </div>

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2.5">Fall</th>
                  {["Anliegen", "Stufe", "Signale", "Fall", "Zuordnung", "Sprache", "Auto", "[AM: …]", "Aktion"].map((h) => <th key={h} className="px-3 py-2.5">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {results.map(({ key, r, exp, checks }) => (
                  <tr key={key} className="border-t border-line align-top" data-testid={`bericht-${key}`}>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-ink">{key}</div>
                      {r.ticket_id ? <Link className="text-xs underline text-navy" href={`/tickets/${r.ticket_id}`}>T-{r.ticket_id}</Link> : <span className="text-xs text-muted">kein Ticket</span>}
                      {r.object_id && <div className="text-xs text-muted">{r.object_id}</div>}
                      {exp.hinweis && <div className="text-xs text-amber-700 mt-1">Prüfen: {exp.hinweis}</div>}
                      {r.error && <div className="text-xs text-pink mt-1" data-testid={`bericht-fehler-${key}`}>Fehler: {r.error}</div>}
                    </td>
                    {r.error && !r.actual
                      ? <td colSpan={9} className="px-3 py-2.5 text-pink">nicht verarbeitet</td>
                      : checks.map((c) => (
                        <td key={c.field} className={`px-3 py-2.5 text-xs ${c.ok === false ? "bg-pink-50 text-pink font-medium" : c.ok ? "text-emerald-700" : "text-muted"}`} data-ok={c.ok === null ? "" : String(c.ok)}>
                          <div>{c.ist}</div>
                          {c.soll !== "–" && c.ok === false && <div className="text-[11px] opacity-80">Soll: {c.soll}</div>}
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">Ist = Stand des Tickets direkt nach dem Einspielen des Falls. Grün = wie erwartet, rot = Abweichung (Soll darunter), grau = kein Soll angegeben. „Prüfen“-Hinweise bitte im Entwurf von Hand ansehen.</p>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, warn, testid }: { label: string; value: string; sub?: string; warn?: boolean; testid?: string }) {
  return (
    <div className="card px-4 py-3" data-testid={testid}>
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${warn ? "text-pink" : "text-navy"}`}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}
