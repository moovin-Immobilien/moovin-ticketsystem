import "server-only";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "./db";
import { env } from "./env";
import { audit } from "./audit";

const COOKIE = "mt_session";
export type Agent = { email: string; name: string; role: "am" | "admin" };

function eq(a: string, b: string) {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/** Prototyp-Login: moovin-Adresse + gemeinsames Prototyp-Passwort. Ziel: SSO (Google Workspace/M365). */
export async function login(emailRaw: string, password: string): Promise<string | null> {
  const email = emailRaw.trim().toLowerCase();
  if (!email.endsWith("@" + env.allowedDomain())) return "Nur moovin-Adressen";
  if (!eq(password, env.prototypePassword())) { await audit(email, "login", { ok: false }); return "Anmeldung fehlgeschlagen"; }
  const [agent] = await sql`select email from ticket.agents where email = ${email} and active`;
  if (!agent) { await audit(email, "login", { ok: false, reason: "kein Agent" }); return "Kein Zugang – bitte Admin fragen"; }
  const id = randomBytes(32).toString("base64url");
  await sql`insert into ticket.sessions (id, agent_email, expires_at) values (${id}, ${email}, now() + interval '12 hours')`;
  (await cookies()).set(COOKIE, id, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 12 * 3600 });
  await audit(`am:${email}`, "login", { ok: true });
  return null;
}

export async function logout() {
  const c = await cookies();
  const id = c.get(COOKIE)?.value;
  if (id) await sql`delete from ticket.sessions where id = ${id}`;
  c.delete(COOKIE);
}

export async function currentAgent(): Promise<Agent | null> {
  const id = (await cookies()).get(COOKIE)?.value;
  if (!id) return null;
  const rows = await sql<Agent[]>`select a.email, a.name, a.role from ticket.sessions s join ticket.agents a on a.email = s.agent_email
                                  where s.id = ${id} and s.expires_at > now() and a.active`;
  return rows[0] ?? null;
}

export async function requireAgent(): Promise<Agent> {
  const a = await currentAgent();
  if (!a) redirect("/login");
  return a;
}

export async function requireAdmin(): Promise<Agent> {
  const a = await requireAgent();
  if (a.role !== "admin") redirect("/tickets");
  return a;
}

/** Darf der Agent dieses Ticket sehen? Eigene, Pool (ohne AM), überfällige; Admin alles. */
export async function canSeeTicket(agent: Agent, t: { assignee_email: string | null; due_at: Date | null; status: string }) {
  if (agent.role === "admin") return true;
  if (!t.assignee_email || t.assignee_email === agent.email) return true;
  return !!t.due_at && new Date(t.due_at) < new Date() && !["beantwortet", "geschlossen"].includes(t.status);
}
