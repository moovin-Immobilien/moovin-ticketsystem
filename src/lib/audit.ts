import "server-only";
import type postgres from "postgres";
import { sql } from "./db";

export type AuditKind = "moovin_api" | "ki_call" | "action" | "login" | "mail_out" | "mail_in" | "ticket" | "settings" | "knowledge";

export async function audit(actor: string, kind: AuditKind, detail: Record<string, unknown> = {}, ticketId?: number | null) {
  try {
    await sql`insert into ticket.audit_log (actor, kind, ticket_id, detail)
              values (${actor}, ${kind}, ${ticketId ?? null}, ${sql.json(detail as postgres.JSONValue)})`;
  } catch (e) {
    console.error("audit failed", e);
  }
}
