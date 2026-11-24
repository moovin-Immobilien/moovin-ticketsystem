import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { INTENT_LABEL, type Intent } from "@/lib/intents";

/** Dashboard (Admin): Volumen, erste Antwortzeit, Auto-Quote je Anliegen, offene/überfällige Tickets, offene Aufgaben je AM. */
export default async function Dashboard() {
  await requireAdmin();
  const perDay = await sql`select to_char(d, 'DD.MM.') as label, coalesce(n, 0)::int as n
    from generate_series((now() at time zone 'Europe/Berlin')::date - 13, (now() at time zone 'Europe/Berlin')::date, '1 day') d
    left join (select (created_at at time zone 'Europe/Berlin')::date as day, count(*) as n from ticket.tickets where merged_into is null group by 1) x on x.day = d
    order by d`;
  const perWeek = await sql`select 'KW ' || to_char(w, 'IW') as label, coalesce(n, 0)::int as n
    from generate_series(date_trunc('week', now() at time zone 'Europe/Berlin') - interval '7 weeks', date_trunc('week', now() at time zone 'Europe/Berlin'), '1 week') w
    left join (select date_trunc('week', created_at at time zone 'Europe/Berlin') as wk, count(*) as n from ticket.tickets where merged_into is null group by 1) x on x.wk = w
    order by w`;
  const [rt] = await sql`select
      percentile_cont(0.5) within group (order by extract(epoch from first_response_at - created_at) / 60) as median,
      percentile_cont(0.9) within group (order by extract(epoch from first_response_at - created_at) / 60) as p90,
      count(*) as n
    from ticket.tickets where first_response_at is not null and created_at > now() - interval '30 days'`;
  const [st] = await sql`select
      count(*) filter (where status not in ('beantwortet','geschlossen','wartet')) as offen,
      count(*) filter (where status not in ('beantwortet','geschlossen','wartet') and due_at < now()) as ueberfaellig,
      count(*) filter (where status = 'wartet') as wartet,
      count(*) filter (where status not in ('beantwortet','geschlossen') and assignee_email is null) as eingang
    from ticket.tickets where merged_into is null`;
  const auto = await sql`select intent, count(*) as total, count(*) filter (where auto_handled) as auto
    from ticket.tickets where first_response_at is not null and created_at > now() - interval '30 days' and intent is not null
    group by intent order by count(*) desc`;
  const tasks = await sql`select coalesce(a.name, 'Allgemeiner Eingang') as name, count(*) filter (where k.status = 'offen') as offen,
      count(*) filter (where k.status = 'offen' and k.due_at < now()) as ueberfaellig
    from ticket.tasks k left join ticket.agents a on a.email = k.assignee_email group by 1 having count(*) filter (where k.status = 'offen') > 0 order by 2 desc`;
  const maxDay = Math.max(1, ...perDay.map((d) => Number(d.n)));
  const maxWeek = Math.max(1, ...perWeek.map((d) => Number(d.n)));
  const min = (v: unknown) => (v === null || v === undefined ? "–" : Number(v) < 120 ? `${Math.round(Number(v))} min` : `${(Number(v) / 60).toFixed(1)} h`);

  return (
    <div className="space-y-5" data-testid="dashboard">
      <h1 className="text-xl font-semibold text-navy">Dashboard</h1>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <Kpi label="Offen" value={st.offen} />
        <Kpi label="Überfällig" value={st.ueberfaellig} warn={Number(st.ueberfaellig) > 0} />
        <Kpi label="Wartet auf Bewerber" value={st.wartet} />
        <Kpi label="Allgemeiner Eingang" value={st.eingang} />
        <Kpi label="Erste Antwort (Median, 30 T.)" value={min(rt.median)} />
        <Kpi label="Erste Antwort (90 %, 30 T.)" value={min(rt.p90)} />
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <Bars title="Tickets pro Tag (14 Tage)" rows={perDay} max={maxDay} />
        <Bars title="Tickets pro Woche (8 Wochen)" rows={perWeek} max={maxWeek} />
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <section className="card p-4">
          <h2 className="font-semibold text-navy mb-3">Auto-Quote je Anliegen (30 Tage)</h2>
          <table className="w-full text-sm">
            <tbody>
              {auto.length === 0 && <tr><td className="text-muted py-4">Noch keine beantworteten Tickets.</td></tr>}
              {auto.map((a) => {
                const pct = Number(a.total) ? Math.round((Number(a.auto) / Number(a.total)) * 100) : 0;
                return (
                  <tr key={a.intent} className="border-t border-line first:border-t-0">
                    <td className="py-2">{INTENT_LABEL[a.intent as Intent] ?? a.intent}</td>
                    <td className="py-2 w-40"><div className="h-2 rounded-full bg-line overflow-hidden"><div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} /></div></td>
                    <td className="py-2 pl-3 tabular-nums text-right whitespace-nowrap">{pct} % <span className="text-muted">({String(a.auto)}/{String(a.total)})</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        <section className="card p-4">
          <h2 className="font-semibold text-navy mb-3">Offene Aufgaben je AM</h2>
          <table className="w-full text-sm">
            <tbody>
              {tasks.length === 0 && <tr><td className="text-muted py-4">Keine offenen Aufgaben.</td></tr>}
              {tasks.map((t) => (
                <tr key={t.name} className="border-t border-line first:border-t-0">
                  <td className="py-2">{t.name}</td>
                  <td className="py-2 text-right tabular-nums">{String(t.offen)}{Number(t.ueberfaellig) > 0 && <span className="text-pink"> ({String(t.ueberfaellig)} überfällig)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}

function Kpi({ label, value, warn }: { label: string; value: unknown; warn?: boolean }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-2xl font-semibold tabular-nums ${warn ? "text-pink" : "text-navy"}`}>{String(value)}</div>
    </div>
  );
}

function Bars({ title, rows, max }: { title: string; rows: readonly Record<string, unknown>[]; max: number }) {
  return (
    <section className="card p-4">
      <h2 className="font-semibold text-navy mb-3">{title}</h2>
      <div className="flex items-end gap-1 h-36">
        {rows.map((r) => (
          <div key={String(r.label)} className="flex-1 flex flex-col items-center justify-end h-full" title={`${r.label}: ${r.n}`}>
            <div className="text-[10px] text-muted tabular-nums">{Number(r.n) || ""}</div>
            <div className="w-full rounded-t bg-navy/80" style={{ height: `${(Number(r.n) / max) * 100}%`, minHeight: Number(r.n) ? 2 : 0 }} />
          </div>
        ))}
      </div>
      <div className="flex gap-1 mt-1">
        {rows.map((r) => <div key={String(r.label)} className="flex-1 text-center text-[10px] text-muted truncate">{String(r.label)}</div>)}
      </div>
    </section>
  );
}
