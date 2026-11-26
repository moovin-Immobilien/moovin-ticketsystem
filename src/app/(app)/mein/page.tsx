import Link from "next/link";
import { sql } from "@/lib/db";
import { requireAgent, showTestTickets, testSql } from "@/lib/auth";
import { maybeHousekeeping, WAIT_DAYS } from "@/lib/workflow";
import { INTENT_LABEL, INTENTS, type Intent } from "@/lib/intents";
import { StatusBadge, IntentBadge, fmtDateTime, fmtLong, TestBadge } from "@/components/ui";
import { taskDoneAction, reviewedAction, closeAction } from "../tickets/[id]/actions";
import { markClass, WhyLine } from "@/components/signals";
import type { Signal } from "@/lib/signals";

const TABS = [
  { key: "todo", label: "Zu erledigen" },
  { key: "aufgaben", label: "Offene Aufgaben" },
  { key: "wartet", label: "Wartet auf Bewerber" },
  { key: "auto", label: "Automatisch erledigt" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default async function MeinBereich(props: PageProps<"/mein">) {
  const agent = await requireAgent();
  await maybeHousekeeping();
  const sp = await props.searchParams;
  const tab = (TABS.some((t) => t.key === sp.tab) || sp.tab === "chancen" ? sp.tab : "todo") as Tab | "chancen";
  const intentFilter = typeof sp.anliegen === "string" && INTENTS.includes(sp.anliegen as Intent) ? sp.anliegen : "";
  const me = agent.email;
  // Testtickets: für AMs standardmäßig ausgeblendet (Schalter „TEST ein/aus“), Admins sehen sie
  const tests = testSql(await showTestTickets(agent));

  const [c] = await sql`
    select
      (select count(*) from ticket.tickets t where t.assignee_email = ${me} and t.status in ('neu','in_bearbeitung','entwurf') and ${tests}) as todo,
      (select count(*) from ticket.tasks k join ticket.tickets t on t.id = k.ticket_id where k.assignee_email = ${me} and k.status = 'offen' and ${tests}) as aufgaben,
      (select count(*) from ticket.tickets t where t.assignee_email = ${me} and t.status = 'wartet' and ${tests}) as wartet,
      (select count(*) from ticket.tickets t where t.assignee_email = ${me} and t.auto_handled and t.reviewed_at is null and t.merged_into is null and ${tests}) as auto_unread,
      (select count(*) from ticket.tickets t where t.assignee_email = ${me} and t.status in ('neu','in_bearbeitung','entwurf') and t.priority = 1 and ${tests})
        + (select count(*) from ticket.tasks k join ticket.tickets t on t.id = k.ticket_id where k.assignee_email = ${me} and k.status = 'offen' and k.priority = 1 and ${tests}) as chancen`;

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold text-navy">Mein Bereich</h1>
          <p className="text-sm text-muted">{agent.name}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/mein?tab=chancen" data-testid="chancen" aria-selected={tab === "chancen"}
            className={`px-3 py-1.5 rounded-lg text-sm border flex items-center gap-2 ${tab === "chancen" ? "bg-emerald-600 text-white border-emerald-600" : "bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100"}`}>
            ▲ Chancen <span className="rounded-full px-1.5 text-xs tabular-nums bg-white/60" data-testid="count-chancen">{String(c.chancen)}</span>
          </Link>
          <Link href="/abwesenheit" className="btn-ghost">Abwesenheit eintragen</Link>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap" role="tablist">
        {TABS.map((t) => {
          const n = t.key === "auto" ? c.auto_unread : c[t.key];
          return (
            <Link key={t.key} href={`/mein?tab=${t.key}`} role="tab" aria-selected={tab === t.key} data-testid={`tab-${t.key}`}
              className={`px-3 py-1.5 rounded-lg text-sm border flex items-center gap-2 ${tab === t.key ? "bg-navy text-white border-navy" : "bg-white border-line text-muted hover:text-navy"}`}>
              {t.label}
              <span className={`rounded-full px-1.5 text-xs tabular-nums ${tab === t.key ? "bg-white/20" : "bg-canvas"}`} data-testid={`count-${t.key}`}>{String(n)}</span>
            </Link>
          );
        })}
      </div>

      {tab === "chancen" && <Chancen me={me} tests={tests} />}
      {tab === "todo" && <Todo me={me} tests={tests} />}
      {tab === "aufgaben" && <Aufgaben me={me} tests={tests} />}
      {tab === "wartet" && <Wartet me={me} tests={tests} />}
      {tab === "auto" && <Auto me={me} intent={intentFilter} tests={tests} />}
    </div>
  );
}

type Frag = ReturnType<typeof testSql>;

async function Todo({ me, tests }: { me: string; tests: Frag }) {
  const rows = await sql`select t.*, (select count(*) from ticket.tasks k where k.ticket_id = t.id and k.status = 'offen') as open_tasks
    from ticket.tickets t where t.assignee_email = ${me} and t.status in ('neu','in_bearbeitung','entwurf') and ${tests}
    order by ${queueOrder()}, t.due_at asc nulls last, t.created_at`;
  return <TicketTable rows={rows} empty="Nichts zu erledigen." extra={todoExtra} />;
}

// Reihenfolge (Ticket-Intelligenz): Stufe 1 → Stufe 2 → Überfällige → Fälligkeit → Stufe 4
const queueOrder = () => sql`case when t.priority = 1 then 0 when t.priority = 2 then 1 when t.priority = 4 then 4 when t.due_at < now() then 2 else 3 end`;

function todoExtra(t: Row) {
  if (Number(t.priority) === 4) return (
    <form action={closeAction.bind(null, Number(t.id))} className="inline">
      <button className="badge bg-white border border-line text-navy hover:bg-canvas" data-testid={`close-${t.id}`}>Ohne Antwort schließen</button>
    </form>
  );
  return (
    <>
      {t.needs_human ? <span className="text-xs text-pink">Handantwort: {t.needs_human_reason || "bitte prüfen"}</span> : <span className="text-xs text-blue-700">Entwurf zur Freigabe</span>}
      {Number(t.open_tasks) > 0 && <span className="text-xs text-muted"> · {String(t.open_tasks)} Aufgabe(n)</span>}
    </>
  );
}

/** „Chancen“: offene Abschluss-Chancen (Stufe 1) – Tickets und Aufgaben. */
async function Chancen({ me, tests }: { me: string; tests: Frag }) {
  const rows = await sql`select t.*, (select count(*) from ticket.tasks k where k.ticket_id = t.id and k.status = 'offen') as open_tasks
    from ticket.tickets t where t.assignee_email = ${me} and t.status in ('neu','in_bearbeitung','entwurf') and t.priority = 1 and ${tests}
    order by t.due_at asc nulls last, t.created_at`;
  return (
    <div className="space-y-4">
      <TicketTable rows={rows} empty="Keine offenen Abschluss-Chancen in „Zu erledigen“." extra={todoExtra} />
      <Aufgaben me={me} tests={tests} onlyChances />
    </div>
  );
}

async function Aufgaben({ me, tests, onlyChances }: { me: string; tests: Frag; onlyChances?: boolean }) {
  const rows = await sql`select k.*, t.sender_name, t.sender_email, t.object_title, t.is_test from ticket.tasks k join ticket.tickets t on t.id = k.ticket_id
    where k.assignee_email = ${me} and k.status = 'offen' and ${tests} ${onlyChances ? sql`and k.priority = 1` : sql``}
    order by case when k.priority = 1 then 0 when k.priority = 2 then 1 when k.due_at < now() then 2 else 3 end, k.due_at nulls last, k.created_at`;
  if (!rows.length) return onlyChances ? null : <div className="card p-8 text-center text-muted">Keine offenen Aufgaben.</div>;
  return (
    <div className="card divide-y divide-line" data-testid="task-list">
      {rows.map((k) => {
        const overdue = k.due_at && new Date(k.due_at) < new Date();
        return (
          <div key={k.id} className={`flex items-start gap-3 px-4 py-3 ${markClass(k.priority)}`} data-testid={`task-${k.id}`}>
            <form action={taskDoneAction.bind(null, Number(k.id), true)}>
              <button className="mt-0.5 h-5 w-5 rounded border border-line bg-white hover:border-navy" title="Abhaken" aria-label="Abhaken" />
            </form>
            <div className="flex-1">
              <div className="text-sm text-ink">
                {Number(k.priority) === 1 && <span className="badge bg-emerald-50 text-emerald-700 mr-2">▲ Abschluss-Chance</span>}
                {Number(k.priority) === 2 && <span className="badge bg-orange-50 text-orange-700 mr-2">⏱ Zeitkritisch</span>}
                {k.text}
              </div>
              <div className="text-xs text-muted">
                <Link className="underline" href={`/tickets/${k.ticket_id}`}>T-{k.ticket_id}</Link> <TestBadge isTest={k.is_test} /> · {k.sender_name || k.sender_email}{k.object_title ? ` · ${k.object_title}` : ""} · <span className="badge bg-canvas">{k.type}</span>
              </div>
            </div>
            <div className={`text-xs tabular-nums whitespace-nowrap ${overdue ? "text-pink font-semibold" : "text-muted"}`}>{fmtDateTime(k.due_at)}</div>
          </div>
        );
      })}
    </div>
  );
}

async function Wartet({ me, tests }: { me: string; tests: Frag }) {
  const rows = await sql`select t.*, extract(day from now() - t.waiting_since)::int as days from ticket.tickets t
    where t.assignee_email = ${me} and t.status = 'wartet' and ${tests} order by t.waiting_since`;
  return (
    <TicketTable rows={rows} empty="Keine Rückfragen offen." extra={(t) => (
      <span className={`text-xs ${Number(t.days) >= WAIT_DAYS ? "text-pink font-semibold" : "text-muted"}`}>
        wartet seit {fmtLong(t.waiting_since)}{Number(t.days) >= WAIT_DAYS ? ` – seit ${t.days} Tagen keine Antwort, bitte nachfassen oder schließen` : ""}
      </span>
    )} />
  );
}

async function Auto({ me, intent, tests }: { me: string; intent: string; tests: Frag }) {
  // Quote: Testtickets zählen nie mit
  const [q] = await sql`select count(*) filter (where auto_handled) as auto, count(*) as total from ticket.tickets
    where assignee_email = ${me} and first_response_at > now() - interval '30 days' and not is_test`;
  const quote = Number(q.total) ? Math.round((Number(q.auto) / Number(q.total)) * 100) : 0;
  const rows = await sql`select t.* from ticket.tickets t where t.assignee_email = ${me} and t.auto_handled and t.merged_into is null and ${tests}
    ${intent ? sql`and t.intent = ${intent}` : sql``} order by (t.reviewed_at is null) desc, t.first_response_at desc limit 200`;
  const intents = await sql`select distinct intent from ticket.tickets where assignee_email = ${me} and auto_handled and intent is not null order by 1`;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4">
        <div className="card px-4 py-3" data-testid="auto-quote">
          <div className="text-xs text-muted">Auto-Quote (30 Tage)</div>
          <div className="text-2xl font-semibold text-navy tabular-nums">{quote} %</div>
          <div className="text-xs text-muted">{String(q.auto)} von {String(q.total)} beantworteten Tickets</div>
        </div>
        <form className="flex gap-2 ml-auto" action="/mein">
          <input type="hidden" name="tab" value="auto" />
          <select name="anliegen" defaultValue={intent} className="input w-60">
            <option value="">Alle Anliegen</option>
            {intents.map((i) => <option key={i.intent} value={i.intent}>{INTENT_LABEL[i.intent as Intent] ?? i.intent}</option>)}
          </select>
          <button className="btn-ghost">Filtern</button>
        </form>
      </div>
      <TicketTable rows={rows} empty="Keine automatisch beantworteten Tickets." extra={(t) => t.reviewed_at
        ? <span className="badge bg-emerald-50 text-emerald-700">gegengelesen</span>
        : <form action={reviewedAction.bind(null, Number(t.id))}><button className="badge bg-white border border-line text-navy hover:bg-canvas">Als gegengelesen markieren</button></form>} />
    </div>
  );
}

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function TicketTable({ rows, empty, extra }: { rows: readonly Row[]; empty: string; extra: (t: Row) => React.ReactNode }) {
  if (!rows.length) return <div className="card p-8 text-center text-muted">{empty}</div>;
  return (
    <div className="card overflow-hidden">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((t) => {
            const overdue = t.due_at && new Date(t.due_at) < new Date() && !["beantwortet", "geschlossen", "wartet"].includes(t.status);
            return (
              <tr key={t.id} className="border-t border-line first:border-t-0 hover:bg-canvas/60" data-testid={`row-${t.id}`} data-priority={String(t.priority ?? 3)}>
                <td className={`px-4 py-3 text-muted tabular-nums whitespace-nowrap ${markClass(t.priority, t.signals as Signal[])}`}><Link href={`/tickets/${t.id}`}>T-{t.id}</Link>{t.is_test && <div className="mt-1"><TestBadge isTest /></div>}</td>
                <td className="px-4 py-3">
                  <Link href={`/tickets/${t.id}`} className="block">
                    <div className="font-medium text-ink">{t.sender_name || t.sender_email}</div>
                    <div className="text-muted truncate max-w-md">{t.subject || "(ohne Betreff)"}{t.object_title ? ` · ${t.object_title}` : ""}</div>
                  </Link>
                  <WhyLine priority={t.priority} signals={t.signals as Signal[]} />
                  <div className="mt-1">{extra(t)}</div>
                </td>
                <td className="px-4 py-3"><IntentBadge intent={t.intent} /></td>
                <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                <td className={`px-4 py-3 tabular-nums whitespace-nowrap ${overdue ? "text-pink font-semibold" : "text-muted"}`}>{t.due_at ? fmtDateTime(t.due_at) : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
