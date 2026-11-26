import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { currentAgent, canSeeTicket } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { classifyAttachment, contentDisposition } from "@/lib/attachments";

export const dynamic = "force-dynamic";

const text = (status: number, msg: string) =>
  new NextResponse(msg, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

/**
 * Anhang ansehen (?download=1 → herunterladen). Nur für angemeldete AMs, die das Ticket sehen dürfen; jeder Abruf landet im Audit-Log.
 * Typ wird am Inhalt erkannt; Vorschau nur für PDF/Bilder, gesperrte Typen werden nie ausgeliefert.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const agent = await currentAgent();
  if (!agent) return text(401, "Bitte anmelden.");
  const { id } = await ctx.params;
  const attId = Number(id);
  if (!Number.isInteger(attId) || attId <= 0) return text(404, "Nicht gefunden.");

  const [row] = await sql`select a.id, a.filename, a.content, t.id as ticket_id, t.assignee_email, t.due_at, t.status
    from ticket.attachments a join ticket.messages m on m.id = a.message_id join ticket.tickets t on t.id = m.ticket_id
    where a.id = ${attId}`;
  if (!row || !row.content || !(await canSeeTicket(agent, row as never))) return text(404, "Nicht gefunden.");

  const bytes = new Uint8Array(row.content as Buffer);
  const cls = classifyAttachment(row.filename, bytes.subarray(0, 16));
  const wantDownload = req.nextUrl.searchParams.get("download") === "1";
  const ticketId = Number(row.ticket_id);

  if (cls.kind === "blocked") {
    await audit(`am:${agent.email}`, "ticket", { event: "anhang_gesperrt", attachment: attId, filename: row.filename, grund: cls.reason }, ticketId);
    return text(403, `Dieser Anhang ist aus Sicherheitsgründen gesperrt (${cls.reason}). Bitte beim Bewerber als PDF anfordern.`);
  }
  const inline = !wantDownload && cls.preview;
  await audit(`am:${agent.email}`, "ticket", { event: inline ? "anhang_angesehen" : "anhang_heruntergeladen", attachment: attId, filename: row.filename }, ticketId);

  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": cls.mime,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": contentDisposition(inline ? "inline" : "attachment", row.filename),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Cross-Origin-Resource-Policy": "same-origin",
      // Die Datei darf nichts nachladen oder ausführen; Bilder zusätzlich in einer Sandbox
      "Content-Security-Policy": cls.kind === "image" ? "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" : "default-src 'none'; object-src 'self'",
      "Referrer-Policy": "no-referrer",
    },
  });
}
