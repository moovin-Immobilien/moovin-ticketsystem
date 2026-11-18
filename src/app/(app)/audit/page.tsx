import Link from "next/link";
import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { fmtLong } from "@/components/ui";

export default async function AuditPage() {
  await requireAdmin();
  const rows = await sql`select * from ticket.audit_log order by at desc limit 300`;
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold text-navy">Audit-Log</h1>
      <p className="text-sm text-muted">Unveränderlich (insert-only). Jeder Aufruf der moovin-API, jeder KI-Aufruf, jede Aktion, jeder Login.</p>
      <div className="card overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-canvas text-left uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Zeit</th><th className="px-3 py-2">Wer</th><th className="px-3 py-2">Art</th><th className="px-3 py-2">Ticket</th><th className="px-3 py-2">Details</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line align-top">
                <td className="px-3 py-2 whitespace-nowrap text-muted">{fmtLong(r.at)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.actor}</td>
                <td className="px-3 py-2"><span className="badge bg-navy/5 text-navy">{r.kind}</span></td>
                <td className="px-3 py-2">{r.ticket_id ? <Link href={`/tickets/${r.ticket_id}`} className="text-navy hover:underline">T-{r.ticket_id}</Link> : "–"}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted break-all">{JSON.stringify(r.detail)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
