import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { updateIntent } from "./actions";

const TARGET = 0.9;
const MIN_SAMPLE = 20;

export default async function AutonomiePage() {
  await requireAdmin();
  const rows = await sql`
    select s.*,
      count(d.id) filter (where d.status = 'gesendet') as sent,
      count(d.id) filter (where d.status = 'gesendet' and d.unchanged) as unchanged,
      count(d.id) filter (where d.status = 'gesendet' and d.decided_by = 'ki') as auto_sent,
      avg(d.similarity) filter (where d.status = 'gesendet' and d.decided_by <> 'ki') as avg_sim
    from ticket.intent_settings s
    left join ticket.tickets t on t.intent = s.intent
    left join ticket.drafts d on d.ticket_id = t.id and d.analysis->>'intent' = s.intent and d.created_at > now() - interval '60 days'
    group by s.intent order by s.locked, s.label`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-navy">Autonomie je Anliegen</h1>
        <p className="text-sm text-muted max-w-3xl">Regel: Ein Anliegen wird auf „Auto“ geschaltet, wenn mindestens {Math.round(TARGET * 100)} % der Entwürfe unverändert rausgehen (bei mindestens {MIN_SAMPLE} Fällen in 60 Tagen). Auto-Versand passiert trotzdem nur, wenn die Konfidenz über der Schwelle liegt, der Absender in moovin bekannt ist, die KI keinen Menschen anfordert und – bei Aktionen – der Absender verifiziert ist.</p>
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
            <tr><th className="px-4 py-2.5">Anliegen</th><th className="px-4 py-2.5">Gesendet</th><th className="px-4 py-2.5">Unverändert übernommen</th><th className="px-4 py-2.5">Davon automatisch</th><th className="px-4 py-2.5">Empfehlung</th><th className="px-4 py-2.5">Modus / Schwelle</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const human = Number(r.sent) - Number(r.auto_sent);
              const rate = human > 0 ? Number(r.unchanged) / human : null;
              const rec = r.locked ? "immer Mensch" : human < MIN_SAMPLE ? `noch ${MIN_SAMPLE - human} Fälle sammeln` : rate! >= TARGET ? "→ Auto freischalten" : "Entwurf beibehalten";
              return (
                <tr key={r.intent} className="border-t border-line">
                  <td className="px-4 py-3 font-medium">{r.label}{r.locked && <span className="ml-2 badge bg-slate-100 text-slate-500">gesperrt</span>}</td>
                  <td className="px-4 py-3 tabular-nums">{Number(r.sent)}</td>
                  <td className="px-4 py-3 tabular-nums">{rate === null ? "–" : `${Math.round(rate * 100)} %`} <span className="text-muted text-xs">({Number(r.unchanged)}/{human})</span></td>
                  <td className="px-4 py-3 tabular-nums">{Number(r.auto_sent)}</td>
                  <td className={`px-4 py-3 ${rec.startsWith("→") ? "text-emerald-700 font-medium" : "text-muted"}`}>{rec}</td>
                  <td className="px-4 py-3">
                    <form action={updateIntent} className="flex items-center gap-2">
                      <input type="hidden" name="intent" value={r.intent} />
                      <select name="mode" defaultValue={r.mode} disabled={r.locked} className="input w-28"><option value="entwurf">Entwurf</option><option value="auto">Auto</option></select>
                      <input name="threshold" type="number" step="0.01" min="0.5" max="0.99" defaultValue={Number(r.threshold)} disabled={r.locked} className="input w-20" />
                      {!r.locked && <button className="btn-ghost">Speichern</button>}
                    </form>
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
