"use server";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { requireAgent, canSeeTicket } from "@/lib/auth";
import { sendDraft, analyzeTicket, closeTicket } from "@/lib/pipeline";
import { audit } from "@/lib/audit";

async function guard(ticketId: number) {
  const agent = await requireAgent();
  const [t] = await sql`select assignee_email, due_at, status from ticket.tickets where id = ${ticketId}`;
  if (!t || !(await canSeeTicket(agent, t as never))) throw new Error("Kein Zugriff");
  return agent;
}

export async function sendAction(ticketId: number, draftId: number, text: string, actionIds: number[]) {
  const agent = await guard(ticketId);
  try {
    const r = await sendDraft({ ticketId, draftId, actor: `am:${agent.email}`, finalText: text, actionIds });
    revalidatePath(`/tickets/${ticketId}`);
    const failed = r.results.filter((x) => !x.ok);
    return { ok: true, message: `Antwort ${r.delivery === "simuliert" ? "(simuliert) " : ""}versendet${r.results.length ? `, ${r.results.length - failed.length}/${r.results.length} Aktionen ausgeführt` : ""}.`, failed };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function regenerateAction(ticketId: number) {
  const agent = await guard(ticketId);
  await analyzeTicket(ticketId, `am:${agent.email}`);
  revalidatePath(`/tickets/${ticketId}`);
}

export async function closeAction(ticketId: number) {
  const agent = await guard(ticketId);
  await closeTicket(ticketId, `am:${agent.email}`);
  revalidatePath(`/tickets/${ticketId}`);
}

export async function takeOverAction(ticketId: number) {
  const agent = await guard(ticketId);
  await sql`update ticket.tickets set assignee_email = ${agent.email}, updated_at = now() where id = ${ticketId}`;
  await audit(`am:${agent.email}`, "ticket", { event: "übernommen" }, ticketId);
  revalidatePath(`/tickets/${ticketId}`);
}

export async function assignAction(ticketId: number, email: string) {
  const agent = await guard(ticketId);
  const target = email ? (await sql`select email from ticket.agents where email = ${email} and active`)[0]?.email ?? null : null;
  await sql`update ticket.tickets set assignee_email = ${target}, updated_at = now() where id = ${ticketId}`;
  await audit(`am:${agent.email}`, "ticket", { event: "zugewiesen", to: target }, ticketId);
  revalidatePath(`/tickets/${ticketId}`);
}
