import Link from "next/link";
import { requireAgent } from "@/lib/auth";
import { sql } from "@/lib/db";
import { SAMPLES } from "@/lib/samples";
import { TEST_CASES, incompleteRuns } from "@/lib/testbatterie";
import { SimForm } from "./SimForm";
import { Testbatterie } from "./Testbatterie";
import { deleteTestTicketsAction } from "./actions";

// Server-Aktionen dieser Seite (je Fall ein Claude-Aufruf, ca. 10–40 s) dürfen länger laufen als der Standard
export const maxDuration = 120;

export default async function SimPage(props: PageProps<"/simulieren">) {
  const agent = await requireAgent();
  const admin = agent.role === "admin";
  const sp = await props.searchParams;
  const runs = admin ? await sql`select test_run, count(*) as n, min(created_at) as at from ticket.tickets where is_test and test_run is not null group by test_run order by test_run desc limit 30` : [];
  const [tc] = admin ? await sql`select count(*) as n from ticket.tickets where is_test` : [{ n: 0 }];
  const openRuns = admin ? (await incompleteRuns()).map((r) => ({ run: r.run, total: r.total, done: r.done, failed: r.failed })) : [];
  const deleted = typeof sp.geloescht === "string" ? sp.geloescht : null;
  return (
    <div className="space-y-5">
      <div className="grid lg:grid-cols-[1fr_320px] gap-5">
        <section className="card p-6">
          <h1 className="text-lg font-semibold text-navy mb-1">Testmail einspielen</h1>
          <p className="text-sm text-muted mb-5">Simuliert eine eingehende Mail an mieter@moovin.de – genau wie der echte Webhook. Die Absender stammen aus den fiktiven Testdaten.</p>
          <SimForm samples={SAMPLES} />
        </section>
        <aside className="card p-5 text-sm space-y-3 h-fit">
          <h2 className="font-semibold text-navy">Testbewerber</h2>
          <ul className="space-y-2 text-muted">
            <li><b className="text-ink">Anna Schmidt</b> – Hamburg, Unterlagen fehlen, Termin in 2 Tagen</li>
            <li><b className="text-ink">Mehmet Yilmaz</b> – Berlin, hat besichtigt</li>
            <li><b className="text-ink">Julia Becker</b> – Berlin, Termin morgen</li>
            <li><b className="text-ink">Tom Richter</b> – Potsdam, beim Eigentümer</li>
            <li><b className="text-ink">Sarah Klein</b> – Hamburg, Absage erhalten</li>
            <li><b className="text-ink">Lucas Martin</b> – Berlin, englisch, Termin in 3 Tagen</li>
          </ul>
          <p className="text-xs text-muted">Echter Eingang später per Webhook: <code>POST /api/inbound/email?token=…</code> (Postmark-Format).</p>
        </aside>
      </div>

      {admin && (
        <section className="card p-6 space-y-4" data-testid="testbatterie-section">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-navy">Testbatterie</h2>
              <p className="text-sm text-muted max-w-3xl">
                {TEST_CASES.length} feste Testfälle als <b>Testtickets</b>: Adressen und moovin-IDs aus dem CRM (live, mit AM), die Zuordnung läuft echt.
                Für Testtickets geht <b>nie</b> eine Mail raus (auch nicht an AMs oder Datenschutz), kein Auto-Versand, keine Schreibaufrufe an moovin;
                sie zählen nicht in Kennzahlen und sind für AMs ausgeblendet. Kosten: ein Lauf ≈ {TEST_CASES.length} Claude-Aufrufe (grob 2–4 $).
              </p>
            </div>
            <Link href="/simulieren/bericht" className="text-sm text-navy underline">Testberichte →</Link>
          </div>
          <Testbatterie cases={TEST_CASES.map((c) => ({ key: c.key, name: c.name, subject: c.subject, intent: c.erwartet.intent ?? "–", stufe: c.erwartet.stufe ?? null,
            objekt: c.objekt, folgtAuf: c.folgt_auf ?? null, anhaenge: c.anhaenge?.length ?? 0 }))} openRuns={openRuns} />

          <form action={deleteTestTicketsAction} className="rounded-lg border border-line p-4 flex flex-wrap items-center gap-3" data-testid="testtickets-loeschen">
            <span className="font-medium text-navy">Testtickets löschen</span>
            <select name="run" defaultValue="" className="input w-64">
              <option value="">Alle Testtickets ({String(tc.n)})</option>
              {runs.map((r) => <option key={r.test_run} value={r.test_run}>Lauf {r.test_run} ({String(r.n)} Tickets)</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confirm" className="accent-pink" /> Ja, endgültig löschen</label>
            <button className="btn-ghost">Löschen</button>
            <span className="text-xs text-muted w-full">Löscht nur Tickets mit Kennzeichen TEST samt Nachrichten, Entwürfen, Aktionen, Aufgaben, Notizen, Anhängen und Signal-Rückmeldungen. Das Audit-Log bleibt.</span>
            {deleted === "bestaetigen" && <span className="text-sm text-pink w-full">Bitte das Löschen bestätigen.</span>}
            {deleted !== null && deleted !== "bestaetigen" && <span className="text-sm text-emerald-700 w-full" data-testid="geloescht">{deleted} Testticket(s) gelöscht.</span>}
          </form>
        </section>
      )}
    </div>
  );
}
