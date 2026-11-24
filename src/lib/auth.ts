import "server-only";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "./db";
import { env, googleLoginEnabled, passwordLoginEnabled } from "./env";
import { audit } from "./audit";
import { checkIdClaims, decodeJwtPayload } from "./oidc";

const COOKIE = "mt_session";
export type Agent = { email: string; name: string; role: "am" | "admin" };

function eq(a: string, b: string) {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

async function createSession(email: string) {
  const id = randomBytes(32).toString("base64url");
  await sql`insert into ticket.sessions (id, agent_email, expires_at) values (${id}, ${email}, now() + interval '12 hours')`;
  await sql`delete from ticket.sessions where expires_at < now()`;
  await sql`update ticket.agents set last_login_at = now() where email = ${email}`;
  (await cookies()).set(COOKIE, id, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 12 * 3600 });
}

/** Übergang: Prototyp-Passwort, nur solange Google-Login nicht eingerichtet ist. */
export async function login(emailRaw: string, password: string): Promise<string | null> {
  if (!passwordLoginEnabled()) return "Anmeldung nur mit Google";
  const email = emailRaw.trim().toLowerCase();
  if (!email.endsWith("@" + env.allowedDomain())) return "Nur moovin-Adressen";
  if (!eq(password, env.prototypePassword())) { await audit(email, "login", { ok: false, method: "passwort" }); return "Anmeldung fehlgeschlagen"; }
  const [agent] = await sql`select email from ticket.agents where email = ${email} and active`;
  if (!agent) { await audit(email, "login", { ok: false, method: "passwort", reason: "kein Agent" }); return "Kein Zugang – bitte Admin fragen"; }
  await createSession(email);
  await audit(`am:${email}`, "login", { ok: true, method: "passwort" });
  return null;
}

// ---------- Google (OpenID Connect, Authorization Code + PKCE) ----------

function googleUrls() {
  const base = env.googleOauthBase();
  return {
    auth: base ? `${base}/auth` : "https://accounts.google.com/o/oauth2/v2/auth",
    token: base ? `${base}/token` : "https://oauth2.googleapis.com/token",
  };
}
const redirectUri = () => `${env.appUrl()}/api/auth/google/callback`;

export async function startGoogleLogin(nextRaw: string): Promise<string> {
  if (!googleLoginEnabled()) throw new Error("Google-Login nicht eingerichtet");
  const next = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/mein";
  const state = randomBytes(24).toString("base64url");
  const nonce = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  await sql`delete from ticket.oauth_states where created_at < now() - interval '15 minutes'`;
  await sql`insert into ticket.oauth_states (state, nonce, code_verifier, next_path) values (${state}, ${nonce}, ${verifier}, ${next})`;
  const p = new URLSearchParams({
    client_id: env.googleClientId(), redirect_uri: redirectUri(), response_type: "code",
    scope: "openid email profile", state, nonce, code_challenge: challenge, code_challenge_method: "S256",
    hd: env.allowedDomain(), prompt: "select_account",
  });
  return `${googleUrls().auth}?${p}`;
}

export type GoogleResult = { ok: true; next: string } | { ok: false; error: string; pending?: boolean };

export async function finishGoogleLogin(code: string, state: string): Promise<GoogleResult> {
  const [st] = await sql`delete from ticket.oauth_states where state = ${state} and created_at > now() - interval '15 minutes' returning *`;
  if (!st) return { ok: false, error: "Anmeldung abgelaufen – bitte erneut versuchen" };
  const res = await fetch(googleUrls().token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.googleClientId(), client_secret: env.googleClientSecret(), redirect_uri: redirectUri(), grant_type: "authorization_code", code_verifier: st.code_verifier }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) { await audit("google", "login", { ok: false, reason: `token ${res.status}` }); return { ok: false, error: "Google-Anmeldung fehlgeschlagen" }; }
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) return { ok: false, error: "Google-Anmeldung fehlgeschlagen" };
  const check = checkIdClaims(decodeJwtPayload(tok.id_token), { clientId: env.googleClientId(), nonce: st.nonce, domain: env.allowedDomain() });
  if (!check.ok) { await audit("google", "login", { ok: false, reason: check.error }); return { ok: false, error: check.error }; }

  const [agent] = await sql`select email, active, google_sub, approved_at from ticket.agents where email = ${check.email}`;
  if (!agent) {
    // Unbekannte moovin-Adresse: als Antrag anlegen, ein Admin schaltet frei
    await sql`insert into ticket.agents (email, name, role, active, google_sub, requested_at) values (${check.email}, ${check.name}, 'am', false, ${check.sub}, now())
              on conflict (email) do nothing`;
    await audit(`am:${check.email}`, "login", { ok: false, method: "google", reason: "Freischaltung beantragt" });
    return { ok: false, pending: true, error: "Dein Zugang ist beantragt. Ein Admin muss ihn freischalten." };
  }
  if (agent.google_sub && agent.google_sub !== check.sub) {
    await audit(`am:${check.email}`, "login", { ok: false, method: "google", reason: "anderes Google-Konto" });
    return { ok: false, error: "Anmeldung fehlgeschlagen" };
  }
  if (!agent.active) {
    await sql`update ticket.agents set requested_at = coalesce(requested_at, now()) where email = ${check.email} and approved_at is null`;
    await audit(`am:${check.email}`, "login", { ok: false, method: "google", reason: "nicht freigeschaltet" });
    return { ok: false, pending: true, error: agent.approved_at ? "Dein Zugang ist deaktiviert." : "Dein Zugang ist beantragt. Ein Admin muss ihn freischalten." };
  }
  await sql`update ticket.agents set google_sub = coalesce(google_sub, ${check.sub}) where email = ${check.email}`;
  await createSession(check.email);
  await audit(`am:${check.email}`, "login", { ok: true, method: "google" });
  return { ok: true, next: st.next_path };
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
  if (a.role !== "admin") redirect("/mein");
  return a;
}

/** Darf der Agent dieses Ticket sehen? Eigene, Allgemeiner Eingang (ohne AM), überfällige; Admin alles. */
export async function canSeeTicket(agent: Agent, t: { assignee_email: string | null; due_at: Date | null; status: string }) {
  if (agent.role === "admin") return true;
  if (!t.assignee_email || t.assignee_email === agent.email) return true;
  return !!t.due_at && new Date(t.due_at) < new Date() && !["beantwortet", "geschlossen"].includes(t.status);
}

/** SQL-Bedingung zu canSeeTicket (Alias t). */
export function visibleSql(agent: Agent) {
  return agent.role === "admin"
    ? sql`true`
    : sql`(t.assignee_email = ${agent.email} or t.assignee_email is null or (t.due_at < now() and t.status not in ('beantwortet','geschlossen')))`;
}
