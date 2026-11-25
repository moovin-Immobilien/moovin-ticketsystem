"use server";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { requireAgent, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { housekeeping } from "@/lib/workflow";

/** Abwesenheit mit Vertretung. AM für sich selbst, Admin für alle. Leere Daten = Abwesenheit löschen. */
export async function setAbsenceAction(form: FormData) {
  const agent = await requireAgent();
  const email = String(form.get("email") ?? agent.email).toLowerCase();
  if (email !== agent.email && agent.role !== "admin") throw new Error("Kein Zugriff");
  const from = String(form.get("from") ?? "").trim() || null;
  const until = String(form.get("until") ?? "").trim() || null;
  const deputyRaw = String(form.get("deputy") ?? "").trim().toLowerCase() || null;
  if ((from && !until) || (!from && until)) throw new Error("Von und bis angeben");
  if (from && until && until < from) throw new Error("Ende liegt vor dem Beginn");
  const deputy = deputyRaw && deputyRaw !== email ? (await sql`select email from ticket.agents where email = ${deputyRaw} and active`)[0]?.email ?? null : null;
  await sql`update ticket.agents set absent_from = ${from}, absent_until = ${until}, deputy_email = ${from ? deputy : null} where email = ${email}`;
  await audit(`am:${agent.email}`, "settings", { event: "abwesenheit", for: email, from, until, deputy });
  await housekeeping(`am:${agent.email}`); // beginnt die Abwesenheit heute, gehen offene Tickets sofort an die Vertretung
  revalidatePath("/abwesenheit"); revalidatePath("/team"); revalidatePath("/mein");
}

export async function approveAgentAction(email: string, role: "am" | "admin") {
  const admin = await requireAdmin();
  await sql`update ticket.agents set active = true, role = ${role}, approved_at = now(), approved_by = ${admin.email}, requested_at = null where email = ${email}`;
  await audit(`am:${admin.email}`, "settings", { event: "agent_freigeschaltet", email, role });
  revalidatePath("/team");
}

export async function updateAgentAction(email: string, form: FormData) {
  const admin = await requireAdmin();
  const role = form.get("role") === "admin" ? "admin" : "am";
  const active = form.get("active") === "on";
  const name = String(form.get("name") ?? "").trim();
  if (email === admin.email && (!active || role !== "admin")) throw new Error("Eigenen Admin-Zugang nicht entziehen");
  await sql`update ticket.agents set role = ${role}, active = ${active}, name = coalesce(nullif(${name}, ''), name),
            approved_at = case when ${active} then coalesce(approved_at, now()) else approved_at end,
            approved_by = case when ${active} then coalesce(approved_by, ${admin.email}) else approved_by end where email = ${email}`;
  if (!active) await sql`delete from ticket.sessions where agent_email = ${email}`;
  await audit(`am:${admin.email}`, "settings", { event: "agent_geaendert", email, role, active });
  revalidatePath("/team");
}

export async function addAgentAction(form: FormData) {
  const admin = await requireAdmin();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const name = String(form.get("name") ?? "").trim();
  const domain = process.env.LOGIN_DOMAIN ?? "moovin.de";
  if (!email.endsWith("@" + domain) || !name) throw new Error(`Name und @${domain}-Adresse angeben`);
  await sql`insert into ticket.agents (email, name, role, active, approved_at, approved_by) values (${email}, ${name}, 'am', true, now(), ${admin.email})
            on conflict (email) do update set active = true, approved_at = coalesce(ticket.agents.approved_at, now()), approved_by = coalesce(ticket.agents.approved_by, ${admin.email})`;
  await audit(`am:${admin.email}`, "settings", { event: "agent_angelegt", email });
  revalidatePath("/team"); revalidatePath("/objekte");
}
