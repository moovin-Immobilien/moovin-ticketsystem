import { sql } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { berlinToday } from "@/lib/workflow";
import { setAbsenceAction } from "../team/actions";

export default async function Abwesenheit() {
  const agent = await requireAgent();
  const [me] = await sql`select absent_from::text, absent_until::text, deputy_email from ticket.agents where email = ${agent.email}`;
  const colleagues = await sql`select email, name from ticket.agents where active and email <> ${agent.email} order by name`;
  const today = berlinToday();
  const active = me.absent_from && me.absent_from <= today && today <= me.absent_until;
  return (
    <div className="max-w-xl space-y-5">
      <h1 className="text-xl font-semibold text-navy">Abwesenheit</h1>
      <p className="text-sm text-muted">In diesem Zeitraum gehen neue und offene Tickets sowie offene Aufgaben an deine Vertretung. Ohne Vertretung landen sie im Allgemeinen Eingang. Nach der Abwesenheit bleiben sie bei der Vertretung; neue Tickets kommen wieder zu dir.</p>
      {active && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">Du bist aktuell als abwesend eingetragen (bis {me.absent_until}).</p>}
      <form action={setAbsenceAction} className="card p-5 space-y-4" data-testid="absence-form">
        <input type="hidden" name="email" value={agent.email} />
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label" htmlFor="from">Von</label><input id="from" name="from" type="date" defaultValue={me.absent_from ?? ""} className="input" /></div>
          <div><label className="label" htmlFor="until">Bis</label><input id="until" name="until" type="date" defaultValue={me.absent_until ?? ""} className="input" /></div>
        </div>
        <div>
          <label className="label" htmlFor="deputy">Vertretung</label>
          <select id="deputy" name="deputy" defaultValue={me.deputy_email ?? ""} className="input">
            <option value="">Keine – Allgemeiner Eingang</option>
            {colleagues.map((c) => <option key={c.email} value={c.email}>{c.name}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button className="btn-pink">Speichern</button>
        </div>
        <p className="text-xs text-muted">Zum Löschen beide Daten leeren und speichern.</p>
      </form>
    </div>
  );
}
