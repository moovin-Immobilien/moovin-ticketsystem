import Link from "next/link";
import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { fmtLong } from "@/components/ui";
import { approveAgentAction, updateAgentAction, addAgentAction, setAbsenceAction } from "./actions";

/** Team (Admin): Freischaltung neuer Google-Anmeldungen, Rollen, Abwesenheiten. */
export default async function Team() {
  await requireAdmin();
  const pending = await sql`select * from ticket.agents where not active and approved_at is null order by requested_at desc nulls last`;
  const agents = await sql`select a.*, a.absent_from::text as af, a.absent_until::text as au, d.name as deputy_name,
      (select count(*) from ticket.tickets t where t.assignee_email = a.email and t.status not in ('beantwortet','geschlossen') and not t.is_test) as open_tickets
    from ticket.agents a left join ticket.agents d on d.email = a.deputy_email where a.approved_at is not null or a.active order by a.active desc, a.name`;
  const actives = agents.filter((a) => a.active);
  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold text-navy">Team</h1>
        <Link href="/objekte" className="text-sm text-muted hover:text-navy" data-testid="link-objekte">Objekte & Zuordnung (CRM, moovin-Anbindung) →</Link>
      </div>

      <section className="card p-5 space-y-3" data-testid="pending">
        <h2 className="font-semibold text-navy">Zugang beantragt ({pending.length})</h2>
        {pending.length === 0 && <p className="text-sm text-muted">Keine offenen Anträge. Neue moovin-Adressen erscheinen hier nach der ersten Google-Anmeldung.</p>}
        {pending.map((p) => (
          <div key={p.email} className="flex items-center gap-3 text-sm">
            <div className="flex-1"><div className="font-medium">{p.name}</div><div className="text-muted">{p.email} · beantragt {fmtLong(p.requested_at)}</div></div>
            <form action={approveAgentAction.bind(null, p.email, "am")}><button className="btn-pink">Als AM freischalten</button></form>
            <form action={approveAgentAction.bind(null, p.email, "admin")}><button className="btn-ghost">Als Admin</button></form>
          </div>
        ))}
      </section>

      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-canvas text-left text-xs uppercase tracking-wide text-muted">
            <tr><th className="px-4 py-2.5">Name / Adresse</th><th className="px-4 py-2.5">Rolle & Status</th><th className="px-4 py-2.5">Abwesenheit & Vertretung</th><th className="px-4 py-2.5">Offen</th></tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.email} className="border-t border-line align-top">
                <td className="px-4 py-3"><div className="font-medium">{a.name}</div><div className="text-muted">{a.email}</div><div className="text-xs text-muted">Letzte Anmeldung {fmtLong(a.last_login_at)}</div></td>
                <td className="px-4 py-3">
                  <form action={updateAgentAction.bind(null, a.email)} className="flex items-center gap-2">
                    <select name="role" defaultValue={a.role} className="input w-24"><option value="am">AM</option><option value="admin">Admin</option></select>
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="active" defaultChecked={a.active} className="accent-navy" /> aktiv</label>
                    <button className="btn-ghost">Speichern</button>
                  </form>
                </td>
                <td className="px-4 py-3">
                  <form action={setAbsenceAction} className="flex flex-wrap items-center gap-1">
                    <input type="hidden" name="email" value={a.email} />
                    <input type="date" name="from" defaultValue={a.af ?? ""} className="input w-36" />
                    <input type="date" name="until" defaultValue={a.au ?? ""} className="input w-36" />
                    <select name="deputy" defaultValue={a.deputy_email ?? ""} className="input w-40">
                      <option value="">Allgemeiner Eingang</option>
                      {actives.filter((x) => x.email !== a.email).map((x) => <option key={x.email} value={x.email}>{x.name}</option>)}
                    </select>
                    <button className="btn-ghost">OK</button>
                  </form>
                </td>
                <td className="px-4 py-3 tabular-nums">{String(a.open_tickets)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form action={addAgentAction} className="card p-5 flex flex-wrap items-end gap-2">
        <div><label className="label">Name</label><input name="name" required className="input w-56" /></div>
        <div><label className="label">moovin-Adresse</label><input name="email" type="email" required className="input w-72" /></div>
        <button className="btn-ghost">Vorab anlegen</button>
        <p className="w-full text-xs text-muted">Vorab angelegte Kolleginnen und Kollegen können sich sofort mit Google anmelden.</p>
      </form>
    </div>
  );
}
