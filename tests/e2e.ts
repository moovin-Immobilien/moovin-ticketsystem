// End-to-End-Tests für das moovin Ticketsystem (lokal, gegen eine lokale Postgres-Datenbank).
//
//   npm run test:e2e
//
// Der Test
//  - setzt die LOKALE Datenbank zurück (nur localhost erlaubt) und spielt die Testdaten ein,
//  - startet einen Testserver für Google-Login, Brevo und Zoho CRM (Port 4010),
//  - startet `next dev` auf Port 3100 im Demo-Modus (ohne Claude-Key, keine Kosten),
//  - prüft alle Funktionen über die Oberfläche (Playwright) und direkt in der Datenbank.
// Voraussetzung: DATABASE_URL (lokal) in .env.local, Playwright mit Chromium installiert, kein anderer `next dev` im Ordner.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { parseBrevo, parsePostmark } from "../src/lib/inbound/parse";
import { checkIdClaims } from "../src/lib/oidc";
import { normalizeAddress, addressKey, matchObjects, resolveAmEmail, type CrmObject } from "../src/lib/crm/match";
import { evaluateSignals, followUpTasks, docKind, type EvaluateInput } from "../src/lib/signals";
import { addWorkingHours, dueBeforeDeadline } from "../src/lib/sla";
import type { ApplicantContext, Application } from "../src/lib/moovin/types";

// ---------- Umgebung ----------
function loadEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();
const DB = process.env.DATABASE_URL ?? "";
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(DB)) { console.error("E2E nur gegen lokale Datenbank (DATABASE_URL auf localhost)"); process.exit(2); }
const PORT = 3100, MOCK = 4010;
const BASE = `http://localhost:${PORT}`;
const MOCK_BASE = `http://localhost:${MOCK}`;
const INBOUND_TOKEN = "e2e-inbound-token";
const CRON = "e2e-cron-secret";
const sql = postgres(DB, { max: 2, onnotice: () => {} });

function loadPlaywright() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  try { return require("playwright"); } catch { return require(join(execSync("npm root -g").toString().trim(), "playwright")); }
  /* eslint-enable @typescript-eslint/no-require-imports */
}
const { chromium } = loadPlaywright();

// ---------- Testserver: Google (OIDC) + Brevo ----------
type Pending = { nonce: string; challenge: string; email: string; hd: string };
const google = { nextUser: { email: "", hd: "moovin.de" }, codes: new Map<string, Pending>() };
const brevo = { sent: [] as Record<string, unknown>[], n: 0 };

// Testdaten Zoho CRM (Abschlüsse, Pipeline Vermietung) – Form wie die echte COQL-Antwort
const deal = (id: string, o: Record<string, string | null>) => ({ id, Deal_Name: `1NKM: ${o.moovin_ID ?? "SP"}: ${o.Stra_e}`, Kunden_Objekt_ID: null,
  "Account_Name.Account_Name": "Testkunde GmbH", Modified_Time: "2026-11-20T10:00:00+01:00", PLZ: null, Ort: null, moovin_ID: null, ...o });
const zoho = {
  calls: [] as string[],
  open: [
    deal("9001", { moovin_ID: "MV-TST001", Stra_e: "Teststraße 12", PLZ: "10115", Ort: "Berlin", Stage: "Online / Besichtigungen", Neu_Zust_ndiger_Account_Manager: "Lena Hoffmann" }),
    deal("9002", { moovin_ID: "MV-TST002", Stra_e: "Musterweg 7", PLZ: "20095", Ort: "Hamburg", Stage: "Quervermarktung", Neu_Zust_ndiger_Account_Manager: "Ole Wenner" }),
    deal("9012", { moovin_ID: "MV-TST002", Stra_e: "Musterweg 7", PLZ: "20095", Ort: "Hamburg", Stage: "Auftragseingang", Neu_Zust_ndiger_Account_Manager: "Lena Hoffmann", Modified_Time: "2026-01-01T10:00:00+01:00" }),
    deal("9003", { moovin_ID: "MV-TST003", Stra_e: "Teststraße 12", PLZ: "80331", Ort: "München", Stage: "Online / Besichtigungen", Neu_Zust_ndiger_Account_Manager: "Jonas Weber" }),
    deal("9004", { Stra_e: "Kollower Straße", PLZ: "21493", Ort: "Schwarzenbek", Stage: "Quervermarktung", Neu_Zust_ndiger_Account_Manager: "Jonas Weber" }),
    deal("9005", { moovin_ID: "MV-TST005", Stra_e: "Ringweg 3", PLZ: "50667", Ort: "Köln", Stage: "On Hold_in Vorbereitung", Neu_Zust_ndiger_Account_Manager: "Erika Unbekannt" }),
  ],
  recent: [deal("9009", { moovin_ID: "MV-TST009", Stra_e: "Altbauweg 3", PLZ: "04109", Ort: "Leipzig", Stage: "Rechnungserstellung", Neu_Zust_ndiger_Account_Manager: "Jonas Weber" })],
  users: [
    { full_name: "Lena Hoffmann", email: "lena.hoffmann@moovin.de", status: "active" },
    { full_name: "Jonas Weber", email: "jonas.weber@moovin.de", status: "active" },
    { full_name: "Ole Wenner", email: "wenner@moovin.de", status: "active" },
  ],
};

function b64url(o: unknown) { return Buffer.from(JSON.stringify(o)).toString("base64url"); }

function startMock(): Promise<Server> {
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", MOCK_BASE);
    const body = await new Promise<string>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
    if (url.pathname === "/google/auth") {
      const p = url.searchParams;
      if (p.get("scope") !== "openid email profile" || p.get("code_challenge_method") !== "S256" || !p.get("nonce")) { res.writeHead(400).end("bad"); return; }
      const code = randomBytes(8).toString("hex");
      google.codes.set(code, { nonce: p.get("nonce")!, challenge: p.get("code_challenge")!, email: google.nextUser.email, hd: google.nextUser.hd });
      res.writeHead(302, { Location: `${p.get("redirect_uri")}?code=${code}&state=${encodeURIComponent(p.get("state")!)}` }).end();
      return;
    }
    if (url.pathname === "/google/token" && req.method === "POST") {
      const f = new URLSearchParams(body);
      const c = google.codes.get(f.get("code") ?? "");
      const okPkce = c && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge;
      if (!c || !okPkce || f.get("client_secret") !== "e2e-secret") { res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"invalid_grant"}'); return; }
      google.codes.delete(f.get("code")!);
      const claims = { iss: "https://accounts.google.com", aud: "e2e-client", exp: Math.floor(Date.now() / 1000) + 3600, nonce: c.nonce,
        sub: `sub-${c.email}`, email: c.email, email_verified: true, hd: c.hd, name: c.email.split("@")[0].replace(".", " ") };
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id_token: `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig` }));
      return;
    }
    if (url.pathname === "/zoho/oauth/v2/token" && req.method === "POST") {
      const f = new URLSearchParams(body);
      zoho.calls.push("token");
      if (f.get("client_id") !== "e2e-zoho" || f.get("client_secret") !== "e2e-zoho-secret") { res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"invalid_client"}'); return; }
      if (f.get("grant_type") === "authorization_code") {
        if (f.get("code") !== "1000.e2e-grant") { res.writeHead(200, { "Content-Type": "application/json" }).end('{"error":"invalid_code"}'); return; }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: "zt-1", refresh_token: "e2e-zoho-refresh", api_domain: "https://www.zohoapis.eu",
          scope: "ZohoCRM.coql.READ ZohoCRM.modules.deals.READ ZohoCRM.users.READ", expires_in: 3600 }));
        return;
      }
      if (f.get("refresh_token") !== "e2e-zoho-refresh" || f.get("grant_type") !== "refresh_token") { res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"invalid_grant"}'); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"access_token":"zt-1","expires_in":3600}');
      return;
    }
    if (url.pathname.startsWith("/zoho/crm/")) {
      if (req.headers.authorization !== "Zoho-oauthtoken zt-1") { res.writeHead(401).end(); return; }
      zoho.calls.push(`${req.method} ${url.pathname}`);
      if (url.pathname === "/zoho/crm/v8/users") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ users: zoho.users, info: { more_records: false } })); return; }
      if (url.pathname === "/zoho/crm/v8/coql" && req.method === "POST") {
        const query = String(JSON.parse(body).select_query ?? "");
        if (!/from Deals where \(?Pipeline = 'Vermietung'/.test(query) || /limit [1-9]\d*,/.test(query)) { res.writeHead(204).end(); return; }
        const data = /Stage not in/.test(query) ? zoho.open : /Modified_Time >= '/.test(query) ? zoho.recent : [];
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data, info: { count: data.length, more_records: false } }));
        return;
      }
      res.writeHead(404).end(); return;
    }
    if (url.pathname.startsWith("/v3/inbound/attachments/")) {
      if (req.headers["api-key"] !== "e2e-brevo") { res.writeHead(401).end(); return; }
      const token = decodeURIComponent(url.pathname.split("/").pop()!);
      if (token === "kaputt") { res.writeHead(404).end(); return; }
      res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(Buffer.from(`%PDF-1.4 Testdatei ${token}`));
      return;
    }
    if (url.pathname === "/v3/smtp/email" && req.method === "POST") {
      if (req.headers["api-key"] !== "e2e-brevo") { res.writeHead(401).end(); return; }
      brevo.sent.push(JSON.parse(body));
      res.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ messageId: `<brevo-${++brevo.n}@smtp-relay.mailin.fr>` }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((r) => srv.listen(MOCK, () => r(srv)));
}

// ---------- Next-Server ----------
let next: ChildProcess | null = null;
async function startNext() {
  next = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    env: {
      ...process.env, NODE_ENV: "development", APP_URL: BASE, ANTHROPIC_API_KEY: "", MOOVIN_API_URL: "",
      MAIL_PROVIDER: "brevo", BREVO_API_KEY: "e2e-brevo", BREVO_API_TEST_BASE: MOCK_BASE,
      GOOGLE_CLIENT_ID: "e2e-client", GOOGLE_CLIENT_SECRET: "e2e-secret", GOOGLE_OAUTH_TEST_BASE: `${MOCK_BASE}/google`,
      INBOUND_WEBHOOK_TOKEN: INBOUND_TOKEN, CRON_SECRET: CRON, TRUSTED_AUTHSERV_IDS: "", MOOVIN_COPY_CORRESPONDENCE: "1", MOOVIN_API_MODE: "an",
      ZOHO_CLIENT_ID: "", ZOHO_CLIENT_SECRET: "", ZOHO_REFRESH_TOKEN: "", ZOHO_TEST_BASE: `${MOCK_BASE}/zoho`,
    },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let log = "";
  next.stdout?.on("data", (d) => (log += d)); next.stderr?.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${BASE}/login`); if (r.ok) return; } catch { /* startet noch */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("next dev startet nicht:\n" + log.slice(-2000));
}
function stopNext() { if (next?.pid) try { process.kill(-next.pid, "SIGTERM"); } catch { /* schon beendet */ } }

// ---------- Hilfen ----------
let passed = 0, failed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; const m = (e as Error).message.split("\n")[0]; failures.push(`${name}: ${m}`); console.log(`  ✘ ${name} – ${m}`); }
}
function assert(c: unknown, msg: string): asserts c { if (!c) throw new Error(msg); }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("Zeitüberschreitung"); await wait(300); }
}

const ADMIN = "admin.test@moovin.de", LENA = "lena.hoffmann@moovin.de", JONAS = "jonas.weber@moovin.de", NEU = "neu.kollegin@moovin.de";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;
async function loginAs(browser: { newContext: () => Promise<{ newPage: () => Promise<Page> }> }, email: string, hd = "moovin.de"): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  google.nextUser = { email, hd };
  await page.goto(`${BASE}/login`);
  await Promise.all([
    page.waitForURL((u: URL) => u.pathname !== "/login" || u.search.includes("error"), { timeout: 60_000 }),
    page.click("text=Mit Google anmelden"),
  ]);
  return page;
}

let nMail = 0;
function brevoItem(o: { from: string; name: string; subject: string; text: string; inReplyTo?: string; attachments?: { name: string; token: string }[]; verified?: boolean }) {
  const domain = o.from.split("@")[1];
  return {
    Uuid: [randomBytes(8).toString("hex")], MessageId: `e2e-${++nMail}-${randomBytes(4).toString("hex")}@mail.example`,
    InReplyTo: o.inReplyTo ?? null, From: { Address: o.from, Name: o.name }, To: [{ Address: "mieter@reply.moovin.de", Name: null }],
    Recipients: [{ Address: "mieter@reply.moovin.de", Name: null }], Subject: o.subject, RawTextBody: o.text, RawHtmlBody: null,
    ExtractedMarkdownMessage: o.text, Spam: { Score: 0 },
    Attachments: (o.attachments ?? []).map((a) => ({ Name: a.name, ContentType: "application/pdf", ContentLength: 1000, ContentID: "", DownloadToken: a.token })),
    Headers: { "Authentication-Results": o.verified === false ? `mx.brevo; dkim=none; dmarc=fail` : `mx.brevo; dkim=pass header.d=${domain}; dmarc=pass`, "Message-ID": undefined as unknown as string },
  };
}
async function postBrevo(items: unknown[], token = INBOUND_TOKEN) {
  return fetch(`${BASE}/api/inbound/email?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items }) });
}
async function mailIn(o: Parameters<typeof brevoItem>[0]) {
  const before = Number((await sql`select coalesce(max(id),0) as m from ticket.messages`)[0].m);
  const r = await postBrevo([brevoItem(o)]);
  assert(r.status === 200, `Webhook ${r.status}`);
  const msg = await until(async () => (await sql`select * from ticket.messages where id > ${before} and from_email = ${o.from} and direction = 'in'`)[0]);
  // KI-Verarbeitung abwarten (Entwurf zur Nachricht)
  await until(async () => (await sql`select 1 from ticket.drafts where in_message_id = ${msg.id}`)[0]);
  // Analyse abgeschlossen (Status, Zuordnung und Signale werden nach dem Entwurf gesetzt)
  return until(async () => (await sql`select * from ticket.tickets where id = ${msg.ticket_id} and status <> 'neu'`)[0]);
}
async function sendFromUi(page: Page, ticketId: number, opts: { awaitReply?: boolean } = {}) {
  await page.goto(`${BASE}/tickets/${ticketId}`);
  const box = page.locator('input[name="awaitReply"]');
  if (opts.awaitReply !== undefined && (await box.isChecked()) !== opts.awaitReply) await box.click();
  const before = Number((await sql`select count(*) from ticket.messages where ticket_id = ${ticketId} and direction = 'out'`)[0].count);
  await page.click('button:has-text("Freigeben & senden")');
  await until(async () => Number((await sql`select count(*) from ticket.messages where ticket_id = ${ticketId} and direction = 'out'`)[0].count) > before, 30_000);
  await wait(500);
}

// ---------- Testbatterie und Testsperre ----------
async function testTicketViaForm(page: Page, o: { from: string; name: string; subject: string; body: string }) {
  await page.goto(`${BASE}/simulieren`);
  const f = page.locator('form:has(input[name="is_test"])');
  await f.locator('input[name="from"]').fill(o.from);
  await f.locator('input[name="name"]').fill(o.name);
  await f.locator('input[name="subject"]').fill(o.subject);
  await f.locator('textarea[name="body"]').fill(o.body);
  if (await f.locator('input[name="attach"]').isChecked()) await f.locator('input[name="attach"]').click();
  assert(await f.locator('input[name="is_test"]').isChecked(), "Testticket nicht vorausgewählt");
  await Promise.all([page.waitForURL(/\/tickets\/\d+$/, { timeout: 60_000 }), f.locator('button:has-text("Mail einspielen")').click()]);
  const id = Number(new URL(page.url()).pathname.split("/").pop());
  return until(async () => (await sql`select * from ticket.tickets where id = ${id} and status <> 'neu'`)[0]);
}

async function testbatterie(admin: Page, lena: Page) {
  console.log("\n15 Testbatterie und Testsperre");
  let run = "";
  let dashBefore = "";
  const moovinWrites = async () => Number((await sql`select count(*) from mock_moovin.request_log where method = 'POST'`)[0].count);

  await check("Testticket: Senden, Verschiebewunsch und Datenschutz → kein Request beim Brevo-Testserver, alles „simuliert“, kein moovin-Schreibaufruf", async () => {
    await admin.goto(`${BASE}/dashboard`);
    dashBefore = await admin.locator('[data-testid="dashboard"] .grid').first().innerText();
    const sentBefore = brevo.sent.length;
    const writesBefore = await moovinWrites();
    // Verschiebewunsch (bekannte Bewerberin mit Termin → Aktion; beim Testticket als Aufgabe, Mail an den AM gesperrt)
    const t = await testTicketViaForm(admin, { from: "julia.becker@example.net", name: "Julia Becker", subject: "Termin verschieben?", body: "Könnte ich den Besichtigungstermin auf Samstag verschieben?" });
    assert(t.is_test && !t.test_run, `is_test ${t.is_test}`);
    const [act] = await sql`select * from ticket.actions where ticket_id = ${t.id} and type = 'termin_verschieben_wunsch'`;
    assert(act && act.payload.manual && act.status === "vorgeschlagen", `Aktion: ${JSON.stringify(act)}`);
    assert(await admin.locator('[data-testid="badge-test"]').count() >= 1, "Badge TEST fehlt im Ticket");
    await sendFromUi(admin, Number(t.id), { awaitReply: false });
    const [a2] = await sql`select status, result from ticket.actions where id = ${act.id}`;
    assert(a2.status === "ausgefuehrt" && a2.result.delivery === "simuliert", JSON.stringify(a2));
    assert((await sql`select 1 from ticket.tasks where ticket_id = ${t.id} and type = 'verschiebewunsch'`).length, "keine Aufgabe");
    // Datenschutz (Weiterleitung an datenschutz@moovin.de gesperrt)
    const d = await testTicketViaForm(admin, { from: "erika.muster@example.org", name: "Erika Muster", subject: "DSGVO", body: "Bitte löschen Sie meine Daten gemäß DSGVO." });
    const [dact] = await sql`select id from ticket.actions where ticket_id = ${d.id} and type = 'datenschutz_weiterleiten'`;
    assert(dact, "keine Datenschutz-Aktion");
    await sendFromUi(admin, Number(d.id), { awaitReply: false });
    // Datenschutzteam liest per CC der Antwort mit; die separate Weiterleitung entfällt (Paket 2, D.4)
    const [d2] = await sql`select status, result from ticket.actions where id = ${dact.id}`;
    assert(d2.status === "ausgefuehrt" && d2.result.skipped === true, JSON.stringify(d2));
    const [dOut] = await sql`select cc_email, delivery_status from ticket.messages where ticket_id = ${d.id} and direction = 'out'`;
    assert(dOut.cc_email === "datenschutz@moovin.de" && dOut.delivery_status === "simuliert", JSON.stringify(dOut));
    assert(brevo.sent.length === sentBefore, `Brevo aufgerufen: ${JSON.stringify(brevo.sent.slice(sentBefore).map((m) => (m as { to: unknown }).to))}`);
    const outs = await sql`select delivery_status from ticket.messages where ticket_id in (${t.id}, ${d.id}) and direction = 'out'`;
    assert(outs.length === 2 && outs.every((m) => m.delivery_status === "simuliert"), JSON.stringify(outs));
    const locks = await sql`select detail from ticket.audit_log where ticket_id in (${t.id}, ${d.id}) and kind = 'mail_out'`;
    assert(locks.length === 3 && locks.every((l) => l.detail.mode === "test_gesperrt"), JSON.stringify(locks.map((l) => l.detail)));
    assert(locks.some((l) => Array.isArray(l.detail.cc) && l.detail.cc.includes("datenschutz@moovin.de")), "CC an den Datenschutz fehlt im Audit");
    assert(locks.some((l) => String(l.detail.to).endsWith("@moovin.de") && l.detail.reason === "Testticket"), "interne Mail nicht über das Kennzeichen gesperrt");
    assert((await moovinWrites()) === writesBefore, "Schreibaufruf an moovin");
  });

  await check("Testticket: kein Auto-Versand, auch wenn das Anliegen auf „auto“ steht", async () => {
    await sql`update ticket.intent_settings set mode = 'auto', threshold = 0.5 where intent = 'bewerbungsstatus'`;
    try {
      const t = await testTicketViaForm(admin, { from: "mehmet.yilmaz@example.org", name: "Mehmet Yilmaz", subject: "Stand", body: "Gibt es Neuigkeiten zum Stand meiner Bewerbung?" });
      assert(t.intent === "bewerbungsstatus" && !t.auto_handled && t.status === "entwurf", `${t.intent} auto=${t.auto_handled} ${t.status}`);
      assert(!(await sql`select 1 from ticket.messages where ticket_id = ${t.id} and direction = 'out'`).length, "Antwort verschickt");
    } finally {
      await sql`update ticket.intent_settings set mode = 'entwurf' where intent = 'bewerbungsstatus'`;
    }
  });

  await check("Testbatterie laden (Admin): Auswahl, Fortschritt, Laufkennung, Platzhalter aus dem CRM, Folgemail im selben Thread", async () => {
    const sentBefore = brevo.sent.length;
    await admin.goto(`${BASE}/simulieren`);
    await admin.click('[data-testid="testbatterie"] button:has-text("Keine")');
    for (const k of ["status_kurz", "nachgehakt_2", "objekt_haustier", "termin_verschieben", "datenschutz_loeschen", "allgemeine_suche", "bounce"]) {
      await admin.locator(`[data-testid="case-${k}"] input[type="checkbox"]`).check();
    }
    await admin.click('[data-testid="testbatterie-start"]');
    await admin.waitForSelector('[data-testid="testbatterie-report"]', { timeout: 180_000 });
    run = (await admin.locator('[data-testid="testbatterie-run"]').innerText()).trim();
    assert(/^\d{8}-\d{6}$/.test(run), `Lauf ${run}`);
    const res = await sql`select * from ticket.test_results where test_run = ${run}`;
    assert(res.length === 8 && res.every((r) => !r.error && r.ticket_id), `Ergebnisse: ${JSON.stringify(res.map((r) => [r.case_key, r.error]))}`);
    const tickets = await sql`select * from ticket.tickets where test_run = ${run}`;
    assert(tickets.length === 7 && tickets.every((t) => t.is_test), `Tickets ${tickets.length}`);
    const byKey = new Map(res.map((r) => [String(r.case_key), r]));
    const by = { get: (k: string) => { const r = byKey.get(k); assert(r, `Fall ${k} fehlt`); return r; } };
    assert(by.get("nachgehakt_1").ticket_id === by.get("nachgehakt_2").ticket_id, "Folgemail nicht im selben Thread");
    const [follow] = await sql`select in_reply_to from ticket.messages where mail_message_id = ${`<testbatterie-${run}-nachgehakt_2@test.local>`}`;
    assert(follow?.in_reply_to === `<testbatterie-${run}-nachgehakt_1@test.local>`, JSON.stringify(follow));
    // Platzhalter: Objekt aus dem CRM (live, aktiv, mit AM); {{ID}} = moovin-ID
    const h = by.get("objekt_haustier");
    const [o] = await sql`select * from ticket.crm_objects where object_id = ${h.object_id} and live and active and am_email is not null`;
    const [hm] = await sql`select subject, body_text from ticket.messages where ticket_id = ${h.ticket_id} and direction = 'in'`;
    assert(o && /^MV-/.test(o.object_id) && hm.subject.includes(o.object_id) && hm.body_text.includes(o.street) && !/\{\{/.test(hm.body_text), JSON.stringify({ o: o?.object_id, hm }));
    assert(!by.get("datenschutz_loeschen").object_id && !by.get("allgemeine_suche").object_id, "Fall ohne Objekt hat Objekt");
    // Zuordnung läuft echt: AM laut CRM, sofern im Ticketsystem freigeschaltet
    const agent = (await sql`select 1 from ticket.agents where email = ${o.am_email} and active`).length > 0;
    assert(agent ? h.actual.routing_source === "crm_id" && h.actual.assignee === o.am_email : !h.actual.assignee, JSON.stringify(h.actual));
    const [m] = await sql`select actor from ticket.audit_log where ticket_id = ${h.ticket_id} and kind = 'mail_in'`;
    assert(m.actor === `test:${ADMIN}`, m.actor);
    assert(brevo.sent.length === sentBefore, "Brevo aufgerufen");
    assert((await sql`select 1 from ticket.test_runs where run = ${run}`).length, "Plan des Laufs nicht gespeichert");
  });

  await check("Testbatterie: abgebrochener Lauf → „Fehlende Fälle nachladen“ mit demselben Objekt, Folgemail hängt am vorhandenen Vorgänger", async () => {
    const [h] = await sql`select ticket_id, object_id from ticket.test_results where test_run = ${run} and case_key = 'objekt_haustier'`;
    const [n2] = await sql`select ticket_id from ticket.test_results where test_run = ${run} and case_key = 'nachgehakt_2'`;
    // Abbruch simulieren: Ergebnis und Ticket eines Falls weg, Folgemail nur als Ergebnis weg (Ticket bleibt beim Vorgänger)
    await sql`delete from ticket.tickets where id = ${h.ticket_id}`;
    await sql`delete from ticket.test_results where test_run = ${run} and case_key in ('objekt_haustier', 'nachgehakt_2')`;
    await sql`delete from ticket.messages where mail_message_id = ${`<testbatterie-${run}-nachgehakt_2@test.local>`}`;
    await admin.goto(`${BASE}/simulieren`);
    const box = await admin.locator('[data-testid="testbatterie-open-runs"]').innerText();
    assert(box.includes(run) && box.includes("6/8"), box);
    await admin.click(`[data-testid="testbatterie-resume-${run}"]`);
    await admin.waitForSelector('[data-testid="testbatterie-report"]', { timeout: 180_000 });
    const res = await sql`select * from ticket.test_results where test_run = ${run}`;
    assert(res.length === 8 && res.every((r) => !r.error && r.ticket_id), JSON.stringify(res.map((r) => [r.case_key, r.error])));
    const [h2] = await sql`select object_id from ticket.test_results where test_run = ${run} and case_key = 'objekt_haustier'`;
    assert(h2.object_id === h.object_id, `Objekt gewechselt: ${h.object_id} → ${h2.object_id}`);
    const [f2] = await sql`select ticket_id from ticket.test_results where test_run = ${run} and case_key = 'nachgehakt_2'`;
    assert(Number(f2.ticket_id) === Number(n2.ticket_id), "Folgemail nicht am vorhandenen Vorgänger");
    assert(await admin.locator('[data-testid="testbatterie-open-runs"]').count() === 0 || !(await admin.locator('[data-testid="testbatterie-open-runs"]').innerText()).includes(run), "Lauf gilt noch als unvollständig");
  });

  await check("Testbericht je Lauf: Soll/Ist, Trefferquote Anliegen und Stufe, Links zu den Tickets", async () => {
    await admin.goto(`${BASE}/simulieren/bericht?run=${run}`);
    const txt = await admin.locator('[data-testid="testbericht"]').innerText();
    assert(txt.includes(`Lauf ${run}`) && /Trefferquote Anliegen\s*\d+ %/.test(txt) && /Trefferquote Stufe\s*\d+ %/.test(txt), txt.slice(0, 400));
    for (const k of ["status_kurz", "nachgehakt_1", "nachgehakt_2", "bounce"]) assert(await admin.locator(`[data-testid="bericht-${k}"]`).count() === 1, `Zeile ${k}`);
    assert(await admin.locator('[data-testid="bericht-bounce"] a[href^="/tickets/"]').count() === 1, "Link zum Ticket");
    const bounce = await admin.locator('[data-testid="bericht-bounce"]').innerText();
    assert(bounce.includes("intern_system"), bounce);
  });

  await check("Sichtbarkeit: Badge TEST, für AMs ausgeblendet (Schalter), nicht in Dashboard und Quoten", async () => {
    await admin.goto(`${BASE}/tickets?view=offen`);
    assert(await admin.locator('[data-testid="badge-test"]').count() > 0, "Admin sieht keine Testtickets");
    const anyTest = await sql`select id, assignee_email from ticket.tickets where is_test and status not in ('beantwortet','geschlossen') order by id`;
    await lena.goto(`${BASE}/tickets?view=offen`);
    assert(await lena.locator('[data-testid="badge-test"]').count() === 0, "AM sieht Testtickets");
    await lena.goto(`${BASE}/eingang`);
    assert(await lena.locator('[data-testid="badge-test"]').count() === 0, "AM sieht Testtickets im Eingang");
    await lena.goto(`${BASE}/mein`);
    const lenaTest = anyTest.filter((t) => t.assignee_email === LENA);
    for (const t of lenaTest) assert(await lena.locator(`[data-testid="row-${t.id}"]`).count() === 0, `T-${t.id} in Mein Bereich`);
    // Schalter: AM kann einblenden
    await lena.click('[data-testid="toggle-tests"]');
    await lena.waitForSelector('[data-testid="toggle-tests"]:has-text("TEST ein")');
    await lena.goto(`${BASE}/eingang`);
    const poolTest = anyTest.filter((t) => !t.assignee_email);
    if (poolTest.length) assert(await lena.locator('[data-testid="badge-test"]').count() > 0, "eingeblendet, aber nicht sichtbar");
    await lena.click('[data-testid="toggle-tests"]');
    await lena.waitForSelector('[data-testid="toggle-tests"]:has-text("TEST aus")');
    // Kennzahlen unverändert
    await admin.goto(`${BASE}/dashboard`);
    assert((await admin.locator('[data-testid="dashboard"] .grid').first().innerText()) === dashBefore, "Dashboard zählt Testtickets");
  });

  await check("Testtickets löschen (je Lauf, mit Bestätigung): Tickets samt Nachrichten weg, Audit-Log bleibt", async () => {
    const ids = (await sql`select id from ticket.tickets where test_run = ${run}`).map((r) => Number(r.id));
    const auditBefore = Number((await sql`select count(*) from ticket.audit_log where ticket_id = any(${ids})`)[0].count);
    await admin.goto(`${BASE}/simulieren`);
    const f = admin.locator('[data-testid="testtickets-loeschen"]');
    await f.locator('select[name="run"]').selectOption(run);
    await f.locator('button:has-text("Löschen")').click();
    await admin.waitForURL(/geloescht=bestaetigen/);
    assert((await sql`select count(*) from ticket.tickets where test_run = ${run}`)[0].count === "7", "ohne Bestätigung gelöscht");
    const f2 = admin.locator('[data-testid="testtickets-loeschen"]');
    await f2.locator('select[name="run"]').selectOption(run);
    await f2.locator('input[name="confirm"]').check();
    await f2.locator('button:has-text("Löschen")').click();
    await admin.waitForSelector('[data-testid="geloescht"]');
    assert((await admin.locator('[data-testid="geloescht"]').innerText()).startsWith("7 "), await admin.locator('[data-testid="geloescht"]').innerText());
    assert(!(await sql`select 1 from ticket.tickets where id = any(${ids})`).length && !(await sql`select 1 from ticket.messages where ticket_id = any(${ids})`).length, "Reste");
    assert(!(await sql`select 1 from ticket.test_results where test_run = ${run}`).length, "Testergebnisse übrig");
    assert(Number((await sql`select count(*) from ticket.audit_log where ticket_id = any(${ids})`)[0].count) === auditBefore, "Audit-Log verändert");
    assert((await sql`select 1 from ticket.tickets where is_test`).length > 0, "andere Testtickets mitgelöscht");
    assert((await sql`select 1 from ticket.tickets where not is_test`).length > 0, "echte Tickets gelöscht");
  });
}

// ---------- Ablauf ----------
async function main() {
  console.log("Reset der lokalen Datenbank …");
  execSync(`npx tsx scripts/migrate.ts --reset --seed`, { stdio: "ignore", env: process.env });
  await sql`insert into ticket.agents (email, name, role, active, approved_at, approved_by) values (${ADMIN}, 'Admin Test', 'admin', true, now(), 'e2e')`;
  await sql`delete from ticket.agents where email not in (${ADMIN}, ${LENA}, ${JONAS})`;

  const mock = await startMock();
  console.log("Starte next dev …");
  await startNext();
  const browser = await chromium.launch();

  try {
    console.log("\n0 Bausteine ohne Server");
    await check("Brevo-Payload wird normalisiert (Absender, Text, Anhang-Token, Auth-Header)", async () => {
      const [m] = parseBrevo({ items: [brevoItem({ from: "A@Example.org", name: "A", subject: "S", text: "T", attachments: [{ name: "x.pdf", token: "t1" }] }) as never] });
      assert(m.fromEmail === "a@example.org" && m.text === "T" && m.attachments[0].downloadToken === "t1" && /dmarc=pass/.test(m.authResults ?? ""), JSON.stringify(m));
    });
    await check("Postmark-Format bleibt unterstützt", async () => {
      const m = parsePostmark({ FromFull: { Email: "b@example.org", Name: "B" }, Subject: "S", TextBody: "T", Headers: [{ Name: "Message-ID", Value: "<x@y>" }] });
      assert(m.fromEmail === "b@example.org" && m.messageId === "<x@y>", JSON.stringify(m));
    });
    await check("Google-ID-Token: Domain, Nonce, Audience, Ablauf werden geprüft", async () => {
      const base = { iss: "https://accounts.google.com", aud: "c", exp: Math.floor(Date.now() / 1000) + 60, nonce: "n", sub: "s", email: "x@moovin.de", email_verified: true, hd: "moovin.de" };
      const o = { clientId: "c", nonce: "n", domain: "moovin.de" };
      assert(checkIdClaims(base, o).ok, "gültiges Token abgelehnt");
      assert(!checkIdClaims({ ...base, hd: undefined, email: "x@gmail.com" }, o).ok, "Gmail akzeptiert");
      assert(!checkIdClaims({ ...base, nonce: "x" }, o).ok, "falsche Nonce akzeptiert");
      assert(!checkIdClaims({ ...base, aud: "andere" }, o).ok, "fremde Audience akzeptiert");
      assert(!checkIdClaims({ ...base, exp: 1 }, o).ok, "abgelaufenes Token akzeptiert");
      assert(!checkIdClaims({ ...base, email_verified: false }, o).ok, "unbestätigte Mail akzeptiert");
    });
    await check("Adress-Normalisierung: Straße/Str., Bindestriche, Hausnummer mit Buchstabe", async () => {
      assert(addressKey("Konsul-Schmidt-Straße 54") === addressKey("Konsul Schmidt Str. 54"), `${addressKey("Konsul-Schmidt-Straße 54")} vs ${addressKey("Konsul Schmidt Str. 54")}`);
      assert(addressKey("Rheinstraße 25a") === "rheinstr 25a" && normalizeAddress("Rheinstr. 25 a") === "rheinstr 25a", normalizeAddress("Rheinstr. 25 a"));
      assert(addressKey("Mastbrooker Weg") === null, "Schlüssel ohne Hausnummer");
    });
    await check("Objekt-Erkennung: moovin-ID, Adresse, PLZ entscheidet, Hausnummer exakt, verschiedene AMs → kein AM", async () => {
      const o = (id: string, street: string, zip: string, am: string, live = true): CrmObject => ({ object_id: id, title: `${street}, ${zip}`, street, zip, match_key: addressKey(street), am_email: am, am_name: am, live });
      const objs = [o("MV-AAA001", "Hauptstraße 4", "10115", "a@x"), o("MV-AAA002", "Hauptstraße 4", "80331", "b@x"), o("MV-AAA003", "Hauptstraße 49", "10115", "c@x"),
                    o("MV-AAA004", "Ringweg 1", "20095", "d@x"), o("MV-AAA005", "Ringweg 1", "20095", "e@x", false)];
      assert(matchObjects("Frage zu MV-AAA003", objs).amEmail === "c@x", "ID");
      assert(matchObjects("Wohnung Hauptstr. 4, 10115 Berlin", objs).amEmail === "a@x", "PLZ");
      assert(matchObjects("Wohnung Hauptstr. 4", objs).amEmail === null, "ohne PLZ eindeutig?");
      assert(matchObjects("Hauptstraße 49 in Berlin", objs).object?.object_id === "MV-AAA003", "Hausnummer 49 ≠ 4");
      assert(matchObjects("Ringweg 1", objs).amEmail === "d@x", "Vermarktung hat Vorrang");
      assert(matchObjects("Ich suche eine Wohnung in Hamburg", objs).how === null, "Fehltreffer");
    });
    await check("AM-Name aus dem CRM → Mailadresse (unscharf, eindeutig)", async () => {
      const users = [{ full_name: "Lilly Gehlsen", email: "gehlsen@moovin.de", active: true }, { full_name: "Caluta Osei", email: "osei@moovin.de", active: true },
                     { full_name: "Tanja Muster", email: "t1@moovin.de", active: false }, { full_name: "Tanja Muster", email: "t2@moovin.de", active: false }];
      assert(resolveAmEmail("Lillyan-Mia Gehlsen", users) === "gehlsen@moovin.de", "Gehlsen");
      assert(resolveAmEmail("Caluta Blessing Osei", users) === "osei@moovin.de", "Osei");
      assert(resolveAmEmail("Tanja Muster", users) === null, "mehrdeutig zugeordnet");
      assert(resolveAmEmail("Max Mustermann", users) === null, "Unbekannter zugeordnet");
    });

    // ---------- Ticket-Intelligenz (reine Funktionen) ----------
    const NOW = new Date("2026-11-25T10:00:00+01:00"); // Mittwoch
    const app = (o: Partial<Application>): Application => ({ id: "AP-1", listing_id: "MV-X", object_title: "Testweg 1", status: "eingeladen", missing_documents: [], appointment: null, ...o });
    const ctxOf = (...apps: Application[]): ApplicantContext => ({ applicant: { id: "A-1", last_name: "Test" }, applications: apps });
    const ev = (o: Partial<EvaluateInput>) => evaluateSignals({ raw: [], intent: "sonstiges", attachments: [], ctx: null, moovinOn: true, unansweredInbound: 1, actionCount: 0, now: NOW, ...o });
    const viewedApp = app({ status: "besichtigt", appointment: { id: "AT-1", starts_at: "2026-11-21T17:00:00Z", status: "stattgefunden" } });
    await check("Signal Unterlagen: nach Besichtigung → Stufe 1; alle fehlenden geschickt → Stufe 1; sonst nur Hinweis", async () => {
      const a = ev({ attachments: [{ filename: "a.pdf" }, { filename: "b.pdf" }, { filename: "c.pdf" }], ctx: ctxOf(viewedApp) });
      assert(a.priority === 1 && /3 Unterlage\(n\) nach Besichtigung am 21\.11\./.test(a.signals[0].why), JSON.stringify(a));
      const b = ev({ attachments: [{ filename: "SCHUFA.pdf" }, { filename: "Gehalt_Okt.pdf" }], ctx: ctxOf(app({ status: "unvollstaendig", missing_documents: ["SCHUFA-Auskunft", "Gehaltsnachweise der letzten 3 Monate"] })) });
      assert(b.priority === 1 && /Fehlten: Gehaltsnachweise, SCHUFA → alle geschickt|Fehlten: SCHUFA, Gehaltsnachweise → alle geschickt/.test(b.signals[0].why), JSON.stringify(b));
      const c = ev({ attachments: [{ filename: "Gehalt.pdf" }], ctx: ctxOf(app({ status: "unvollstaendig", missing_documents: ["Gehaltsnachweise", "Mietschuldenfreiheitsbescheinigung"] })) });
      assert(c.priority === 3 && c.signals[0].stage === 3, JSON.stringify(c));
      assert(docKind("Personalausweis_Rueckseite.jpg") === "Ausweis" && docKind("Foto.jpg") === null, "Unterlagenart");
    });
    await check("Signale Anmietwunsch/Vertrag/Frist: nur mit passendem Status Stufe 1, sperren immer den Auto-Versand", async () => {
      const z = ev({ raw: [{ type: "zusage_nach_besichtigung", evidence: "wir möchten die Wohnung nehmen" }], ctx: ctxOf(viewedApp) });
      assert(z.priority === 1 && z.autoBlocked && z.signals[0].confirmed, JSON.stringify(z));
      const z2 = ev({ raw: [{ type: "zusage_nach_besichtigung", evidence: "x" }], ctx: ctxOf(app({ status: "eingeladen" })) });
      assert(z2.priority === 3 && z2.autoBlocked, `vor Besichtigung: ${JSON.stringify(z2)}`);
      const v = ev({ raw: [{ type: "vertragsphase", evidence: "Kaution" }], ctx: ctxOf(app({ status: "beim_eigentuemer" })) });
      const v2 = ev({ raw: [{ type: "vertragsphase", evidence: "Kaution" }], ctx: ctxOf(app({ status: "in_pruefung" })) });
      assert(v.priority === 1 && v2.priority === 3, `${v.priority}/${v2.priority}`);
      const k = ev({ raw: [{ type: "konkurrenz_frist", evidence: "bis Freitag", deadline: "2026-11-27" }], ctx: ctxOf(app({ status: "eingeladen" })) });
      const k2 = ev({ raw: [{ type: "konkurrenz_frist", evidence: "bis Freitag", deadline: "2026-11-27" }], ctx: ctxOf(app({ status: "absage" })) });
      assert(k.priority === 1 && k.deadline === "2026-11-27" && /Entscheidet bis 27\.11\./.test(k.signals[0].why) && k2.priority === 3 && !k2.deadline, JSON.stringify([k, k2]));
    });
    await check("Signale zeitkritisch: Termin < 48 h, Rückzug spät, Eskalation, Nachgehakt → Stufe 2; Gegenfälle nicht", async () => {
      const soon = app({ appointment: { id: "AT-2", starts_at: "2026-11-26T17:00:00Z", status: "bestaetigt" } });
      const later = app({ appointment: { id: "AT-3", starts_at: "2026-11-28T17:00:00Z", status: "bestaetigt" } });
      const t1 = ev({ intent: "termin_absage", ctx: ctxOf(soon) });
      assert(t1.priority === 2 && t1.signals[0].type === "termin_bald", JSON.stringify(t1));
      assert(ev({ intent: "termin_absage", raw: [{ type: "termin_bald" }], ctx: ctxOf(later) }).priority === 3, "Termin in 3 Tagen");
      const f = followUpTasks(t1.signals, "termin_absage");
      assert(f[0]?.type === "slot_nachbesetzen" && f[0].priority === 2, JSON.stringify(f));
      const r = ev({ intent: "rueckzug", ctx: ctxOf(app({ status: "beim_eigentuemer" })) });
      assert(r.priority === 2 && followUpTasks(r.signals, "rueckzug")[0].type === "kandidat_aktivieren", JSON.stringify(r));
      assert(ev({ intent: "rueckzug", ctx: ctxOf(app({ status: "eingeladen" })) }).priority === 3, "früher Rückzug");
      const e = ev({ raw: [{ type: "eskalation", evidence: "zum dritten Mal" }] });
      assert(e.priority === 2 && e.autoBlocked, JSON.stringify(e));
      assert(ev({ unansweredInbound: 2 }).signals[0]?.type === "nachgehakt" && ev({ unansweredInbound: 1 }).priority === 3, "Nachgehakt");
    });
    await check("Kein Handlungsbedarf nur ohne Anhang, Aktion und anderes Signal; abgeschaltet/verworfen fällt weg; moovin aus → „laut Mail“", async () => {
      const d = { type: "kein_handlungsbedarf", evidence: "Danke, bis Montag" };
      assert(ev({ raw: [d] }).priority === 4 && ev({ raw: [d] }).autoBlocked, "D");
      assert(ev({ raw: [d], attachments: [{ filename: "x.pdf" }] }).priority !== 4, "mit Anhang");
      assert(ev({ raw: [d], actionCount: 1 }).priority === 3, "mit Aktion");
      assert(ev({ raw: [d], unansweredInbound: 3 }).priority === 2, "nachgehakt schlägt D");
      assert(ev({ raw: [{ type: "eskalation" }], disabled: ["eskalation"] }).priority === 3, "abgeschaltet");
      assert(ev({ raw: [{ type: "zusage_nach_besichtigung" }], ctx: ctxOf(viewedApp), rejected: ["zusage_nach_besichtigung"] }).priority === 3, "verworfen");
      const off = ev({ raw: [{ type: "zusage_nach_besichtigung", evidence: "nehmen" }], moovinOn: false });
      assert(off.priority === 1 && off.signals[0].basis === "mail" && !off.signals[0].confirmed && /laut Mail/.test(off.signals[0].why), JSON.stringify(off));
      assert(ev({ raw: [{ type: "bonitaet_gut", evidence: "verdiene gut" }, { type: "herkunft" }] }).signals.length === 0, "Personenmerkmal als Signal");
    });
    await check("SLA nach Stufe: Arbeitsstunden Mo–Fr 8–18 Uhr, Frist minus Puffer", async () => {
      const fri = new Date("2026-11-27T17:00:00+01:00");
      assert(addWorkingHours(new Date("2026-11-25T10:00:00+01:00"), 2).toISOString() === new Date("2026-11-25T12:00:00+01:00").toISOString(), "2 h");
      assert(addWorkingHours(fri, 2).toISOString() === new Date("2026-11-30T09:00:00+01:00").toISOString(), `Wochenende: ${addWorkingHours(fri, 2).toISOString()}`);
      assert(addWorkingHours(new Date("2026-11-28T11:00:00+01:00"), 4).toISOString() === new Date("2026-11-30T12:00:00+01:00").toISOString(), "Samstag");
      assert(dueBeforeDeadline("2026-11-27", NOW)!.toISOString() === new Date("2026-11-26T12:00:00+01:00").toISOString(), "Frist");
    });

    console.log("\n1 Login (nur Google)");
    await check("Login-Seite zeigt nur Google, kein Passwortfeld", async () => {
      const p = await (await browser.newContext()).newPage();
      await p.goto(`${BASE}/login`);
      assert(await p.locator("text=Mit Google anmelden").count() === 1, "Google-Button fehlt");
      assert(await p.locator('input[type="password"]').count() === 0, "Passwortfeld sichtbar");
    });
    let admin: Page;
    await check("Admin meldet sich mit Google an → Mein Bereich", async () => {
      admin = await loginAs(browser, ADMIN);
      assert(admin.url().endsWith("/mein"), admin.url());
      assert((await sql`select google_sub from ticket.agents where email = ${ADMIN}`)[0].google_sub === `sub-${ADMIN}`, "google_sub nicht gespeichert");
    });
    await check("Unbekannte moovin-Adresse → kein Zugang, Antrag angelegt", async () => {
      const p = await loginAs(browser, NEU);
      assert(p.url().includes("/login") && (await p.content()).includes("beantragt"), p.url());
      const [a] = await sql`select active, requested_at from ticket.agents where email = ${NEU}`;
      assert(a && !a.active && a.requested_at, "kein Antrag");
      const r = await p.goto(`${BASE}/mein`); assert(r.url().includes("/login"), "ohne Freischaltung Zugriff");
    });
    await check("Fremde Domain (privates Gmail) wird abgelehnt", async () => {
      const p = await loginAs(browser, "jemand@gmail.com", "");
      assert(p.url().includes("/login") && (await p.content()).includes("Nur Konten der Domain"), p.url());
      assert(!(await sql`select 1 from ticket.agents where email = 'jemand@gmail.com'`).length, "Agent angelegt");
    });
    await check("Admin schaltet Antrag frei → Anmeldung klappt", async () => {
      await admin.goto(`${BASE}/team`);
      await admin.click('[data-testid="pending"] button:has-text("Als AM freischalten")');
      await admin.waitForLoadState("networkidle");
      assert((await sql`select active from ticket.agents where email = ${NEU}`)[0].active, "nicht aktiv");
      const p = await loginAs(browser, NEU);
      assert(p.url().endsWith("/mein"), p.url());
      assert((await sql`select count(*) from ticket.audit_log where kind = 'settings' and detail->>'event' = 'agent_freigeschaltet'`)[0].count === "1", "Audit fehlt");
    });
    await check("AM sieht weder Dashboard noch Team", async () => {
      const p = await loginAs(browser, NEU);
      await p.goto(`${BASE}/dashboard`); assert(p.url().endsWith("/mein"), `Dashboard: ${p.url()}`);
      await p.goto(`${BASE}/team`); assert(p.url().endsWith("/mein"), `Team: ${p.url()}`);
    });

    const lena = await loginAs(browser, LENA);
    const jonas = await loginAs(browser, JONAS);

    console.log("\n2 Brevo: Eingang, Anhänge, Versand, Threading");
    let annaId = 0;
    await check("Webhook ohne gültiges Token → 401", async () => {
      assert((await postBrevo([brevoItem({ from: "x@example.org", name: "x", subject: "s", text: "t" })], "falsch")).status === 401, "nicht 401");
    });
    await check("Brevo-Mail mit Anhang → Ticket bei Lena, Anhang per API geladen", async () => {
      const t = await mailIn({ from: "anna.schmidt@example.org", name: "Anna Schmidt", subject: "Unterlagen", text: "Guten Tag,\n\nanbei meine Gehaltsnachweise.\n\nAnna Schmidt", attachments: [{ name: "Gehalt.pdf", token: "tok-1" }] });
      annaId = Number(t.id);
      assert(t.assignee_email === LENA && t.sender_verified, `AM ${t.assignee_email}, verifiziert ${t.sender_verified}`);
      const [a] = await sql`select a.* from ticket.attachments a join ticket.messages m on m.id = a.message_id where m.ticket_id = ${annaId}`;
      assert(a && Buffer.from(a.content).toString().includes("tok-1"), "Anhang nicht geladen");
    });
    await check("Anhang nicht ladbar → Hinweis am Ticket, Mensch nötig", async () => {
      const t = await mailIn({ from: "tom.richter@example.com", name: "Tom Richter", subject: "Nachweis", text: "anbei der Nachweis", attachments: [{ name: "x.pdf", token: "kaputt" }] });
      assert(t.needs_human && /Anhänge nicht geladen/.test(t.needs_human_reason), t.needs_human_reason);
      assert((await sql`select 1 from ticket.notes where ticket_id = ${t.id} and kind = 'system'`).length, "keine Notiz");
      await sql`update ticket.tickets set status = 'geschlossen' where id = ${t.id}`;
    });
    let brevoMsgId = "";
    await check("Testsperre: Freigabe an @example.org (normales Ticket) → kein Brevo-Aufruf, Status „simuliert“, Aktionen laufen", async () => {
      const before = brevo.sent.length;
      await sendFromUi(lena, annaId, { awaitReply: false });
      assert(brevo.sent.length === before, `Brevo aufgerufen: ${JSON.stringify(brevo.sent.slice(before))}`);
      const [m] = await sql`select delivery_status, provider_message_id, to_email from ticket.messages where ticket_id = ${annaId} and direction = 'out'`;
      assert(m.delivery_status === "simuliert" && !m.provider_message_id && m.to_email === "anna.schmidt@example.org", JSON.stringify(m));
      assert((await sql`select 1 from ticket.audit_log where ticket_id = ${annaId} and kind = 'mail_out' and detail->>'mode' = 'test_gesperrt' and detail->>'reason' = 'Test-Domain'`).length, "Audit test_gesperrt fehlt");
      const [a] = await sql`select status from ticket.actions where ticket_id = ${annaId} and type = 'dokumente_ablegen'`;
      assert(a?.status === "ausgefuehrt", `Dokumente: ${a?.status}`);
    });
    let extId = 0;
    await check("Freigabe → Versand über Brevo, Message-ID gespeichert (Empfänger außerhalb der Test-Domains)", async () => {
      const t = await mailIn({ from: "kim.extern@e2e-mieter.de", name: "Kim Extern", subject: "Frage", text: "Wie ist der Stand meiner Bewerbung?" });
      extId = Number(t.id);
      await sendFromUi(lena, extId, { awaitReply: false });
      const last = brevo.sent.at(-1) as { to: { email: string }[]; replyTo: { email: string }; subject: string };
      assert(last && last.to[0].email === "kim.extern@e2e-mieter.de" && last.replyTo.email && /\[#T-\d+\]/.test(last.subject), JSON.stringify(last));
      const [m] = await sql`select provider_message_id, delivery_status from ticket.messages where ticket_id = ${extId} and direction = 'out'`;
      brevoMsgId = m.provider_message_id; assert(/brevo-/.test(brevoMsgId ?? "") && m.delivery_status === "gesendet", "provider_message_id fehlt");
    });
    await check("Geschlossenes Ticket: Antwort (In-Reply-To = Brevo-ID, ohne [#T]) öffnet es wieder", async () => {
      await sql`update ticket.tickets set status = 'geschlossen', closed_at = now() where id = ${extId}`;
      const t = await mailIn({ from: "kim.extern@e2e-mieter.de", name: "Kim Extern", subject: "AW: Ihre Anfrage", text: "Danke! Und wie geht es weiter?", inReplyTo: brevoMsgId });
      assert(Number(t.id) === extId, `neues Ticket ${t.id} statt ${extId}`);
      assert(t.status === "entwurf" && t.reopened_at, `Status ${t.status}`);
      assert((await sql`select 1 from ticket.audit_log where ticket_id = ${extId} and detail->>'event' = 'wiedereroeffnet'`).length, "Audit fehlt");
      await sql`update ticket.tickets set status = 'geschlossen', closed_at = now() where id = ${extId}`;
      // Annas Ticket (Antwort war wegen Test-Domain nur simuliert) über [#T-…] im Betreff wieder öffnen – die folgenden Tests arbeiten damit weiter
      await lena.goto(`${BASE}/tickets/${annaId}`);
      await sql`update ticket.tickets set status = 'geschlossen', closed_at = now() where id = ${annaId}`;
      const a = await mailIn({ from: "anna.schmidt@example.org", name: "Anna Schmidt", subject: `AW: Ihre Unterlagen [#T-${annaId}]`, text: "Danke! Wie ist der Stand?" });
      assert(Number(a.id) === annaId && a.status === "entwurf" && a.reopened_at, `Anna: ${a.id} ${a.status}`);
    });

    console.log("\n3 Allgemeiner Eingang");
    let unknownId = 0;
    await check("Unbekannter Absender landet im Allgemeinen Eingang mit Grund", async () => {
      const t = await mailIn({ from: "max.mustermann@example.de", name: "Max Mustermann", subject: "Wohnung Stralauer Allee?", text: "Ist die Wohnung noch frei?" });
      unknownId = Number(t.id);
      assert(!t.assignee_email, `AM ${t.assignee_email}`);
      await lena.goto(`${BASE}/eingang`);
      const row = lena.locator(`[data-testid="eingang-${unknownId}"]`);
      assert(await row.count() === 1 && (await row.innerText()).includes("Kein Bewerber in moovin"), "nicht im Eingang");
    });
    await check("Zuordnung per Klick zu Objekt → AM des Objekts, Audit-Log", async () => {
      // Jonas betreut OBJ-B-002 (Ticket von Julia)
      await mailIn({ from: "julia.becker@example.net", name: "Julia Becker", subject: "Frage", text: "Wie ist der Stand meiner Bewerbung?" });
      await lena.goto(`${BASE}/eingang`);
      const form = lena.locator(`[data-testid="eingang-${unknownId}"] form`);
      await form.locator('input[name="object"]').fill("OBJ-B-002");
      await form.locator('button:has-text("Zuordnen")').click();
      await lena.waitForLoadState("networkidle");
      const [t] = await until(async () => { const r = await sql`select assignee_email, object_id from ticket.tickets where id = ${unknownId}`; return r[0].assignee_email ? r : null; });
      assert(t.assignee_email === JONAS && t.object_id === "OBJ-B-002", JSON.stringify(t));
      const [a] = await sql`select actor, detail from ticket.audit_log where ticket_id = ${unknownId} and detail->>'event' = 'zugeordnet'`;
      assert(a && a.actor === `am:${LENA}`, "Audit fehlt");
    });

    console.log("\n4 Mein Bereich: Aufgaben");
    let tomId = 0;
    await check("Rückzug → nach Freigabe Aufgabe „Bewerbung zurückziehen“ bei Lena", async () => {
      const t = await mailIn({ from: "tom.richter@example.com", name: "Tom Richter", subject: "Rückzug Bewerbung", text: "Ich habe eine andere Wohnung gefunden und ziehe meine Bewerbung zurück." });
      tomId = Number(t.id);
      await sendFromUi(lena, tomId, { awaitReply: false });
      const [k] = await until(async () => { const r = await sql`select * from ticket.tasks where ticket_id = ${tomId}`; return r.length ? r : null; });
      // Eine Aufgabe je Ticket: Rückzug in später Phase stuft sie hoch (Fall B), der Rückzug-Punkt steht in der Checkliste
      assert(/Bewerbung in moovin zurückziehen/.test(k.text) && k.assignee_email === LENA && k.status === "offen" && k.priority <= 2, JSON.stringify(k));
      assert(Number((await sql`select count(*) from ticket.tasks where ticket_id = ${tomId} and status = 'offen'`)[0].count) === 1, "mehr als eine offene Aufgabe");
    });
    await check("Verschiebewunsch → Mail an AM und Aufgabe bei Jonas", async () => {
      const t = await mailIn({ from: "julia.becker@example.net", name: "Julia Becker", subject: "Termin verschieben?", text: "Könnte ich den Besichtigungstermin auf Samstag verschieben?" });
      await sendFromUi(jonas, Number(t.id), { awaitReply: false });
      const [k] = await until(async () => { const r = await sql`select * from ticket.tasks where ticket_id = ${t.id} and type = 'verschiebewunsch'`; return r.length ? r : null; });
      assert(k.assignee_email === JONAS, k.assignee_email);
      assert(brevo.sent.some((m) => (m as { to: { email: string }[] }).to[0].email === JONAS), "keine Mail an AM");
    });
    await check("Reiter „Offene Aufgaben“ zeigt Zähler, Abhaken erledigt die Aufgabe", async () => {
      await lena.goto(`${BASE}/mein?tab=aufgaben`);
      assert((await lena.locator('[data-testid="count-aufgaben"]').innerText()) === "1", "Zähler ≠ 1");
      await lena.click('[data-testid="task-list"] button[aria-label="Abhaken"]');
      await lena.waitForLoadState("networkidle");
      await until(async () => (await sql`select status from ticket.tasks where ticket_id = ${tomId}`)[0].status === "erledigt");
      await lena.goto(`${BASE}/mein?tab=aufgaben`);
      assert((await lena.locator('[data-testid="count-aufgaben"]').innerText()) === "0", "Zähler ≠ 0");
    });
    await check("Reiter „Zu erledigen“: Überfällige stehen oben", async () => {
      const [a] = await sql`select id from ticket.tickets where id = ${annaId}`;
      await sql`update ticket.tickets set due_at = now() - interval '2 hours' where id = ${a.id}`;
      await mailIn({ from: "sarah.klein@example.org", name: "Sarah Klein", subject: "Frage", text: "Wie ist der Stand?" });
      await lena.goto(`${BASE}/mein?tab=todo`);
      const first = await lena.locator("tbody tr").first().innerText();
      assert(first.includes(`T-${annaId}`), `oben: ${first.slice(0, 60)}`);
    });

    console.log("\n5 Wartet auf Bewerber");
    let ninaId = 0;
    await check("Unklarer Termin → Rückfrage vorausgewählt; nach Senden „Wartet“", async () => {
      const t = await mailIn({ from: "nina.vogel@example.org", name: "Nina Vogel", subject: "Besichtigung", text: "Hallo, ich komme gerne zur Besichtigung." });
      ninaId = Number(t.id);
      const page = t.assignee_email === LENA ? lena : jonas;
      await page.goto(`${BASE}/tickets/${ninaId}`);
      assert(await page.locator('input[name="awaitReply"]').isChecked(), "Rückfrage nicht vorausgewählt");
      await sendFromUi(page, ninaId);
      const [r] = await sql`select status, waiting_since, due_at from ticket.tickets where id = ${ninaId}`;
      assert(r.status === "wartet" && r.waiting_since && !r.due_at, JSON.stringify(r));
    });
    await check("Antwort des Bewerbers holt das Ticket zurück nach „Zu erledigen“", async () => {
      const t = await mailIn({ from: "nina.vogel@example.org", name: "Nina Vogel", subject: `Re: Besichtigung [#T-${ninaId}]`, text: "Ich komme gerne zur Besichtigung in der Stralauer Allee." });
      assert(Number(t.id) === ninaId && t.status === "entwurf" && !t.waiting_since, `${t.id} ${t.status}`);
      const [a] = await sql`select type, payload from ticket.actions where ticket_id = ${ninaId} and status = 'vorgeschlagen'`;
      assert(a?.type === "termin_bestaetigen" && a.payload.appointment_id === "AT-9008", JSON.stringify(a));
    });
    await check("Nach 7 Tagen ohne Antwort: Hinweis-Aufgabe (Cron), keine Mail an den Bewerber", async () => {
      await sql`update ticket.tickets set status = 'wartet', waiting_since = now() - interval '8 days', waiting_reminded_at = null, due_at = null where id = ${ninaId}`;
      const sentBefore = brevo.sent.length;
      assert((await fetch(`${BASE}/api/cron/daily`)).status === 401, "Cron ohne Secret erlaubt");
      const r = await fetch(`${BASE}/api/cron/daily`, { headers: { Authorization: `Bearer ${CRON}` } });
      assert(r.ok && (await r.json()).reminders === 1, "keine Erinnerung");
      assert((await sql`select 1 from ticket.tasks where ticket_id = ${ninaId} and type = 'nachfassen'`).length, "keine Aufgabe");
      assert(brevo.sent.length === sentBefore, "Mail verschickt");
      const r2 = await fetch(`${BASE}/api/cron/daily`, { headers: { Authorization: `Bearer ${CRON}` } });
      assert((await r2.json()).reminders === 0, "doppelte Erinnerung");
    });

    console.log("\n6 Automatisch erledigt");
    await check("Auto-Antwort erscheint im Reiter mit Auto-Quote; „gegengelesen“ markierbar", async () => {
      await sql`update ticket.intent_settings set mode = 'auto', threshold = 0.8 where intent = 'bewerbungsstatus'`;
      const t = await mailIn({ from: "mehmet.yilmaz@example.org", name: "Mehmet Yilmaz", subject: "Stand", text: "Gibt es Neuigkeiten zum Stand meiner Bewerbung?" });
      const done = await until(async () => (await sql`select * from ticket.tickets where id = ${t.id} and auto_handled`)[0]);
      await sql`update ticket.intent_settings set mode = 'entwurf' where intent = 'bewerbungsstatus'`;
      await jonas.goto(`${BASE}/mein?tab=auto`);
      assert((await jonas.locator('[data-testid="auto-quote"]').innerText()).includes("%"), "keine Quote");
      await jonas.click(`tr:has-text("T-${done.id}") button:has-text("Als gegengelesen markieren")`);
      await jonas.waitForLoadState("networkidle");
      await until(async () => (await sql`select reviewed_at from ticket.tickets where id = ${done.id}`)[0].reviewed_at);
    });

    console.log("\n7 Interne Notizen und Weitergabe");
    await check("Interne Notiz: sichtbar im Ticket, nie in Mails, moovin-Kopie oder KI-Verlauf", async () => {
      await lena.goto(`${BASE}/tickets/${annaId}`);
      await lena.fill('[data-testid="notes"] textarea[name="text"]', "GEHEIM-NOTIZ-4711");
      await lena.click('button:has-text("Notiz speichern")');
      await lena.waitForSelector("text=GEHEIM-NOTIZ-4711");
      await sendFromUi(lena, annaId, { awaitReply: false });
      assert(!brevo.sent.some((m) => JSON.stringify(m).includes("GEHEIM-NOTIZ")), "Notiz in Mail");
      assert(!(await sql`select 1 from mock_moovin.correspondence where body like '%GEHEIM-NOTIZ%'`).length, "Notiz in moovin-Kopie");
      assert(!(await sql`select 1 from ticket.messages where body_text like '%GEHEIM-NOTIZ%'`).length, "Notiz im Mailverlauf (KI)");
    });
    await check("Weitergabe an Kollegen mit Kommentar → neuer AM, Notiz, Audit", async () => {
      await lena.goto(`${BASE}/tickets/${annaId}`);
      const f = lena.locator('[data-testid="handover-form"]');
      await f.locator("select").selectOption(JONAS);
      await f.locator("textarea").fill("Bitte du, ich bin im Termin.");
      await f.locator('button:has-text("Weitergeben")').click();
      await lena.waitForLoadState("networkidle");
      await until(async () => (await sql`select assignee_email from ticket.tickets where id = ${annaId}`)[0].assignee_email === JONAS);
      assert((await sql`select 1 from ticket.notes where ticket_id = ${annaId} and kind = 'weitergabe' and target_email = ${JONAS}`).length, "Notiz fehlt");
      await sql`update ticket.tickets set assignee_email = ${LENA} where id = ${annaId}`;
    });

    console.log("\n8 Bearbeitungssperre");
    await check("Zweiter Bearbeiter sieht, wer das Ticket offen hat", async () => {
      const t = await mailIn({ from: "anna.schmidt@example.org", name: "Anna Schmidt", subject: `Re: Ihre Anfrage [#T-${annaId}]`, text: "Noch eine Frage zum Parken." });
      await admin.goto(`${BASE}/tickets/${t.id}`);
      await lena.goto(`${BASE}/tickets/${t.id}`);
      await lena.waitForSelector('[data-testid="presence"] >> text=Admin Test', { timeout: 30_000 });
    });
    await check("Warnung vor dem Senden, wenn jemand anderes zwischenzeitlich geantwortet hat", async () => {
      await admin.reload(); await lena.reload();
      await sendFromUi(admin, annaId);
      // Lenas Seite ist veraltet: Entwurf ist schon gesendet → Fehler statt Doppelversand
      let dialog = "";
      lena.once("dialog", async (d: { message: () => string; dismiss: () => Promise<void> }) => { dialog = d.message(); await d.dismiss(); });
      await lena.click('button:has-text("Freigeben & senden")');
      await lena.waitForTimeout(2500);
      const txt = await lena.locator("body").innerText();
      assert(dialog.includes("zwischenzeitlich geantwortet") || /bereits bearbeitet|zwischenzeitlich/.test(txt), "keine Warnung");
      const outs = await sql`select count(*) from ticket.messages where ticket_id = ${annaId} and direction = 'out'`;
      assert(Number(outs[0].count) === 3, `Antworten: ${outs[0].count}`);
    });

    console.log("\n9 Zusammenführen");
    await check("Zwei Tickets desselben Absenders zusammenführen, Verlauf vollständig", async () => {
      const t1 = await mailIn({ from: "lucas.martin@example.com", name: "Lucas Martin", subject: "Frage 1", text: "Wo ist der Treffpunkt?" });
      await sql`update ticket.tickets set status = 'geschlossen', closed_at = now() where id = ${t1.id}`;
      const t2 = await mailIn({ from: "lucas.martin@example.com", name: "Lucas Martin", subject: "Frage 2", text: "Darf ich einen Hund halten?" });
      assert(t1.id !== t2.id, "kein zweites Ticket");
      await jonas.goto(`${BASE}/tickets/${t2.id}`);
      await jonas.locator('[data-testid="merge"] select').selectOption(String(t1.id));
      await jonas.click('button:has-text("Hierhin zusammenführen")');
      await jonas.waitForLoadState("networkidle");
      const [src] = await until(async () => { const r = await sql`select merged_into, status from ticket.tickets where id = ${t2.id}`; return r[0].merged_into ? r : null; });
      assert(Number(src.merged_into) === Number(t1.id) && src.status === "geschlossen", JSON.stringify(src));
      const n = await sql`select count(*) from ticket.messages where ticket_id = ${t1.id}`;
      assert(Number(n[0].count) === 2, `Nachrichten: ${n[0].count}`);
      const t3 = await mailIn({ from: "lucas.martin@example.com", name: "Lucas Martin", subject: `Re: Frage 2 [#T-${t2.id}]`, text: "Und Parken?" });
      assert(Number(t3.id) === Number(t1.id), `Antwort landet in ${t3.id}`);
    });

    console.log("\n10 Abwesenheit");
    await check("Lena abwesend mit Vertretung Jonas → offene und neue Tickets bei Jonas", async () => {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
      const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date(Date.now() + 86_400_000));
      const [{ id: sarahId }] = await sql`select id from ticket.tickets where sender_email = 'sarah.klein@example.org' and assignee_email = ${LENA} and status not in ('beantwortet','geschlossen') order by id desc limit 1`;
      await lena.goto(`${BASE}/abwesenheit`);
      await lena.fill("#from", today); await lena.fill("#until", tomorrow);
      await lena.selectOption("#deputy", JONAS);
      await lena.click('[data-testid="absence-form"] button:has-text("Speichern")');
      await until(async () => !(await sql`select 1 from ticket.tickets where assignee_email = ${LENA} and status not in ('beantwortet','geschlossen')`).length);
      const [t] = await sql`select assignee_email, deputy_for from ticket.tickets where id = ${sarahId}`;
      assert(t.assignee_email === JONAS && t.deputy_for === LENA, JSON.stringify(t));
      const n = await mailIn({ from: "tom.richter@example.com", name: "Tom Richter", subject: "Noch eine Frage", text: "Wie lange dauert die Prüfung meiner Unterlagen?" });
      assert(n.assignee_email === JONAS && n.deputy_for === LENA, JSON.stringify({ a: n.assignee_email, d: n.deputy_for }));
    });
    await check("Ohne Vertretung → Allgemeiner Eingang; nach Rückkehr zurück an den AM", async () => {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
      await sql`update ticket.agents set absent_from = ${today}, absent_until = ${today}, deputy_email = null where email = ${JONAS}`;
      const t = await mailIn({ from: "julia.becker@example.net", name: "Julia Becker", subject: "Noch was", text: "Wie ist der Stand?", });
      assert(!t.assignee_email, `AM ${t.assignee_email}`);
      await sql`update ticket.agents set absent_from = null, absent_until = null, deputy_email = null where email in (${JONAS}, ${LENA})`;
      const r = await fetch(`${BASE}/api/cron/daily`, { headers: { Authorization: `Bearer ${CRON}` } });
      assert((await r.json()).back >= 1, "nichts zurückgegeben");
      const [b] = await sql`select assignee_email, deputy_for from ticket.tickets where id = ${t.id}`;
      assert(b.assignee_email === JONAS && !b.deputy_for, `nach Rückkehr: ${JSON.stringify(b)}`);
    });

    console.log("\n11 Suche");
    await check("Suche nach Name, Mail, Objekt und Ticket-Nr.", async () => {
      for (const q of ["Anna", "anna.schmidt@example.org", "Lindenpark", `T-${annaId}`]) {
        await admin.goto(`${BASE}/suche?q=${encodeURIComponent(q)}`);
        assert((await admin.locator('[data-testid="search-results"]').innerText()).includes(`T-${annaId}`), `kein Treffer für ${q}`);
      }
    });
    await check("Suche beachtet Rollen: AM findet fremde, nicht überfällige Tickets nicht", async () => {
      await sql`update ticket.tickets set due_at = now() + interval '1 day' where assignee_email = ${JONAS}`;
      const [t] = await sql`select id, sender_name from ticket.tickets where assignee_email = ${JONAS} and status not in ('beantwortet','geschlossen') limit 1`;
      const p = await loginAs(browser, NEU);
      await p.goto(`${BASE}/suche?q=T-${t.id}`);
      assert((await p.locator('[data-testid="search-results"]').innerText()).includes("0 Treffer"), "fremdes Ticket gefunden");
    });

    console.log("\n12 Dashboard");
    await check("Dashboard (Admin) zeigt Kennzahlen", async () => {
      await admin.goto(`${BASE}/dashboard`);
      const txt = await admin.locator('[data-testid="dashboard"]').innerText();
      for (const s of ["Tickets pro Tag", "Tickets pro Woche", "Erste Antwort", "Auto-Quote je Anliegen", "Überfällig", "Offene Aufgaben je AM"]) assert(txt.includes(s), `fehlt: ${s}`);
    });

    console.log("\n13 CRM-Zuordnung und Livetest ohne moovin-API");
    await check("Zoho verbinden in der App: falscher Code → Hinweis, richtiger Code → Lese-Token serverseitig, Abgleich", async () => {
      await admin.goto(`${BASE}/team`);
      await admin.click('[data-testid="link-objekte"]');
      await admin.waitForURL(`${BASE}/objekte`);
      const form = admin.locator('[data-testid="zoho-connect"]');
      await form.locator('input[name="client_id"]').fill("e2e-zoho");
      await form.locator('input[name="client_secret"]').fill("e2e-zoho-secret");
      await form.locator('input[name="code"]').fill("1000.abgelaufen");
      await form.locator('button:has-text("Verbinden")').click();
      await admin.waitForSelector('[data-testid="zoho-msg"]');
      assert((await admin.locator('[data-testid="zoho-msg"]').innerText()).includes("nicht angenommen"), "kein Hinweis bei falschem Code");
      assert(!(await sql`select 1 from ticket.settings where key = 'zoho_auth'`).length, "Token trotz Fehler gespeichert");
      zoho.calls = [];
      const f2 = admin.locator('[data-testid="zoho-connect"]');
      await f2.locator('input[name="client_id"]').fill("e2e-zoho");
      await f2.locator('input[name="client_secret"]').fill("e2e-zoho-secret");
      await f2.locator('input[name="code"]').fill("1000.e2e-grant");
      await f2.locator('button:has-text("Verbinden")').click();
      await admin.waitForSelector('[data-testid="zoho-status"]');
      assert((await admin.locator('[data-testid="zoho-msg"]').innerText()).includes("6 Objekte"), await admin.locator('[data-testid="zoho-msg"]').innerText());
      const [z] = await sql`select value from ticket.settings where key = 'zoho_auth'`;
      assert(z?.value.refresh_token === "e2e-zoho-refresh", "Token fehlt");
      assert(!(await admin.content()).includes("e2e-zoho-secret") && !(await admin.content()).includes("e2e-zoho-refresh"), "Geheimnis im Browser");
      assert(!(await sql`select 1 from ticket.audit_log where detail::text like '%e2e-zoho-secret%' or detail::text like '%e2e-zoho-refresh%'`).length, "Geheimnis im Audit-Log");
    });
    await check("CRM-Abgleich (nur lesend) über „Objekte“: Objekte mit AM, Dubletten, unklare Namen", async () => {
      zoho.calls = [];
      await admin.click('button:has-text("Jetzt abgleichen")');
      await until(async () => Number((await sql`select count(*) from ticket.audit_log where detail->>'event' = 'crm_abgleich' and actor = ${"am:" + ADMIN}`)[0].count) >= 2);
      const [st] = await sql`select value from ticket.settings where key = 'crm_sync'`;
      assert(st.value.ok && st.value.rows === 6 && JSON.stringify(st.value.unresolved) === '["Erika Unbekannt"]', JSON.stringify(st.value));
      assert(zoho.calls.every((c) => c === "token" || c.startsWith("POST /zoho/crm/v8/coql") || c.startsWith("GET /zoho/crm/v8/users")), `Schreibzugriff? ${zoho.calls.join(",")}`);
      const [t1] = await sql`select * from ticket.crm_objects where object_id = 'MV-TST001'`;
      assert(t1.am_email === LENA && t1.live && t1.match_key === "teststr 12", JSON.stringify(t1));
      const [t2] = await sql`select am_name, stage from ticket.crm_objects where object_id = 'MV-TST002'`;
      assert(t2.am_name === "Ole Wenner" && t2.stage === "Quervermarktung", `Dublette: ${JSON.stringify(t2)}`);
      assert((await sql`select 1 from ticket.crm_objects where object_id = 'CRM-9004' and match_key is null`).length, "Stellplatz ohne Nr.");
      await admin.reload();
      assert((await admin.locator('[data-testid="crm-count"]').innerText()) === "6", "Zähler");
      assert((await admin.locator('[data-testid="crm-ams"]').innerText()).includes("Ole Wenner"), "AM-Liste");
    });
    await check("moovin-Anbindung ausschalten → Hinweis für alle, Audit", async () => {
      await admin.click('button:has-text("moovin-Anbindung ausschalten")');
      await until(async () => (await sql`select value from ticket.settings where key = 'moovin_api'`)[0]?.value === "aus");
      await lena.goto(`${BASE}/mein`);
      assert(await lena.locator('[data-testid="banner-moovin-off"]').count() === 1, "kein Hinweis");
      assert((await sql`select 1 from ticket.audit_log where detail->>'event' = 'moovin_anbindung' and detail->>'value' = 'aus'`).length, "Audit fehlt");
    });
    let offId = 0;
    await check("Ohne moovin: Adresse in der Mail → AM laut CRM, kein moovin-Aufruf, neutraler Entwurf ohne Platzhalter und ohne „unbekannt“", async () => {
      const calls = Number((await sql`select count(*) from mock_moovin.request_log`)[0].count);
      const t = await mailIn({ from: "paula.neu@example.com", name: "Paula Neu", subject: "Bewerbung", text: "Guten Tag,\n\nwie ist der Stand meiner Bewerbung für die Wohnung Teststr. 12, 10115 Berlin?\n\nPaula Neu" });
      offId = Number(t.id);
      assert(t.assignee_email === LENA && t.routing_source === "crm_adresse" && t.object_id === "MV-TST001", JSON.stringify({ a: t.assignee_email, r: t.routing_source, o: t.object_id }));
      const [d] = await sql`select body_text from ticket.drafts where ticket_id = ${offId} order by id desc limit 1`;
      assert(!/\[AM:|\[.*?\]/.test(d.body_text) && !/keiner Bewerbung zuordnen/.test(d.body_text) && /Login|Profil/.test(d.body_text), d.body_text);
      assert(t.needs_human, "Entwurf ohne Bewerberdaten muss geprüft werden");
      assert(Number((await sql`select count(*) from mock_moovin.request_log`)[0].count) === calls, "moovin wurde aufgerufen");
      await lena.goto(`${BASE}/tickets/${offId}`);
      assert(await lena.locator('[data-testid="moovin-off"]').count() === 1, "Hinweis im Ticket fehlt");
      assert((await lena.locator('[data-testid="object-card"]').innerText()).includes("Adresse in der Mail"), "Zuordnungsquelle fehlt");
    });
    await check("Ohne moovin: eine Aufgabe je Ticket – Unterlagen + Anmietwunsch + Notiz ergeben EINE Aufgabe als Checkliste, Folgemail ergänzt sie", async () => {
      const t = await mailIn({ from: "paula.neu@example.com", name: "Paula Neu", subject: "Unterlagen Teststr. 12", text: "Guten Tag,\n\nanbei meine Unterlagen wie besprochen. Wir möchten die Wohnung Teststr. 12, 10115 Berlin gerne anmieten.\n\nPaula Neu",
        attachments: [{ name: "Gehalt_Neu.pdf", token: "tok-neu-1" }, { name: "SCHUFA_Neu.pdf", token: "tok-neu-2" }] });
      assert(Number(t.id) === offId, `neues Ticket statt Thread (${t.id} ≠ ${offId})`);
      await sql`insert into ticket.actions (ticket_id, draft_id, type, payload, label, status, idempotency_key)
        select ${offId}, d.id, 'notiz', ${sql.json({ type: "notiz", application_id: "", appointment_id: "", interest: "", text: "Partnerin zieht mit ein", manual: true })}, 'Notiz', 'vorgeschlagen', ${`e2e-notiz-${offId}`}
        from ticket.drafts d where d.ticket_id = ${offId} and d.status = 'offen'`;
      await sendFromUi(lena, offId, { awaitReply: false });
      const open = await until(async () => { const r = await sql`select * from ticket.tasks where ticket_id = ${offId} and status = 'offen'`; return r.length ? r : null; });
      assert(open.length === 1, `${open.length} offene Aufgaben statt 1: ${JSON.stringify(open.map((k) => k.text))}`);
      const lines = String(open[0].text).split("\n");
      assert(lines.length >= 2 && /^Unterlagen prüfen/.test(lines[0]) && open[0].priority === 1, JSON.stringify(open[0]));
      assert(lines.some((l) => /Notiz in moovin eintragen/.test(l)), "Notiz-Punkt fehlt");
      assert(!lines.some((l, i) => lines.findIndex((x) => x === l) !== i), "doppelte Zeilen");
      // Folgemail mit weiterem Anhang → gleiche Aufgabe, nicht neu
      await mailIn({ from: "paula.neu@example.com", name: "Paula Neu", subject: "Nachtrag", text: "Hier noch die Mietschuldenfreiheitsbescheinigung.", attachments: [{ name: "Mietschuldenfreiheit_Neu.pdf", token: "tok-neu-3" }] });
      await sendFromUi(lena, offId, { awaitReply: false });
      const after = await sql`select * from ticket.tasks where ticket_id = ${offId} and status = 'offen'`;
      assert(after.length === 1 && Number(after[0].id) === Number(open[0].id), `nach Folgemail ${after.length} Aufgaben`);
      await lena.goto(`${BASE}/mein?tab=aufgaben`);
      const txt = await lena.locator(`[data-testid="task-${open[0].id}"]`).innerText();
      assert(txt.includes("Unterlagen prüfen") && txt.includes("Notiz"), txt);
    });
    await check("Reiter „Erledigt“: von mir beantwortete Tickets, Wiedereröffnen", async () => {
      await lena.goto(`${BASE}/mein?tab=erledigt`);
      assert(Number(await lena.locator('[data-testid="count-erledigt"]').innerText()) >= 1, "Zähler Erledigt");
      assert(await lena.locator(`[data-testid="row-${offId}"]`).count() === 1, "Ticket fehlt unter Erledigt");
      await lena.click(`[data-testid="reopen-${offId}"]`);
      await until(async () => (await sql`select status from ticket.tickets where id = ${offId}`)[0].status === "in_bearbeitung");
      assert((await sql`select 1 from ticket.audit_log where ticket_id = ${offId} and detail->>'event' = 'wiedereroeffnet' and (detail->>'manuell')::boolean`).length, "Audit fehlt");
      await lena.goto(`${BASE}/mein?tab=todo`);
      assert(await lena.locator(`[data-testid="row-${offId}"]`).count() === 1, "Ticket nicht in Zu erledigen");
    });
    await check("Ohne moovin: Objekt eines nicht freigeschalteten AM → Allgemeiner Eingang mit Hinweis", async () => {
      const t = await mailIn({ from: "karl.test@example.com", name: "Karl Test", subject: "Exposé MV-TST002", text: "Ist ein Stellplatz dabei?" });
      assert(!t.assignee_email && /Ole Wenner/.test(t.routing_note ?? ""), JSON.stringify({ a: t.assignee_email, n: t.routing_note }));
      await lena.goto(`${BASE}/eingang`);
      assert((await lena.locator(`[data-testid="eingang-${t.id}"]`).innerText()).includes("Ole Wenner"), "Hinweis fehlt im Eingang");
      // Zuordnung per Objekt ohne AM-Auswahl → AM laut CRM
      const form = lena.locator(`[data-testid="eingang-${t.id}"] form`);
      await form.locator('input[name="object"]').fill("MV-TST003");
      await form.locator('button:has-text("Zuordnen")').click();
      const [r] = await until(async () => { const x = await sql`select assignee_email, object_id, routing_source from ticket.tickets where id = ${t.id}`; return x[0].assignee_email ? x : null; });
      assert(r.assignee_email === JONAS && r.object_id === "MV-TST003" && r.routing_source === "manuell", JSON.stringify(r));
    });
    await check("Ohne moovin: Rückzug → Aktion wird Aufgabe, nichts an moovin (auch unverifiziert)", async () => {
      const notes = Number((await sql`select count(*) from mock_moovin.notes`)[0].count);
      const t = await mailIn({ from: "paula.neu@example.com", name: "Paula Neu", subject: `Re: Bewerbung [#T-${offId}]`, text: "Ich ziehe meine Bewerbung für die Teststraße 12 zurück, ich habe etwas anderes gefunden.", verified: false });
      assert(Number(t.id) === offId, `Ticket ${t.id}`);
      const [a] = await sql`select status, payload, label from ticket.actions where ticket_id = ${offId} and status in ('vorgeschlagen','blockiert') order by id desc limit 1`;
      assert(a?.status === "vorgeschlagen" && a.payload.manual && /Aufgabe für den AM/.test(a.label), JSON.stringify(a));
      await sendFromUi(lena, offId, { awaitReply: false });
      // Eine Aufgabe je Ticket: der Rückzug wird Punkt in der bestehenden offenen Aufgabe
      const [k] = await until(async () => { const r = await sql`select * from ticket.tasks where ticket_id = ${offId} and status = 'offen' and text like '%Bewerbung in moovin zurückziehen%'`; return r.length ? r : null; });
      assert(k.assignee_email === LENA, JSON.stringify(k));
      assert(Number((await sql`select count(*) from ticket.tasks where ticket_id = ${offId} and status = 'offen'`)[0].count) === 1, "mehr als eine offene Aufgabe");
      const [x] = await sql`select status, result from ticket.actions where ticket_id = ${offId} and payload->>'manual' = 'true' order by id desc limit 1`;
      assert(x.status === "ausgefuehrt" && x.result.manuell, JSON.stringify(x));
      assert(Number((await sql`select count(*) from mock_moovin.notes`)[0].count) === notes, "Notiz an moovin geschrieben");
      assert(!(await sql`select 1 from mock_moovin.correspondence where body like '%Teststraße 12 zurück%'`).length, "Kopie an moovin");
    });
    await check("Ohne moovin: allgemeine Frage ohne Objekt → Eingang mit Grund", async () => {
      const t = await mailIn({ from: "suche.jemand@example.com", name: "Suche Jemand", subject: "Wohnung gesucht", text: "Haben Sie eine 3-Zimmer-Wohnung in Hamburg für mich?" });
      assert(!t.assignee_email && /Kein Objekt in der Mail erkannt/.test(t.routing_note ?? ""), JSON.stringify({ a: t.assignee_email, n: t.routing_note }));
    });
    await check("moovin-Anbindung wieder einschalten", async () => {
      await admin.goto(`${BASE}/objekte`);
      await admin.click('button:has-text("moovin-Anbindung einschalten")');
      await until(async () => (await sql`select value from ticket.settings where key = 'moovin_api'`)[0]?.value === "an");
      await lena.goto(`${BASE}/mein`);
      assert(await lena.locator('[data-testid="banner-moovin-off"]').count() === 0, "Hinweis bleibt");
    });

    console.log("\n14 Ticket-Intelligenz");
    let mehmetId = 0;
    await check("Fall B: Unterlagen nach Besichtigung, Auto-Antwort → markierte Aufgabe ganz oben, Zähler „Chancen“", async () => {
      await sql`update ticket.intent_settings set mode = 'auto', threshold = 0.8 where intent = 'unterlagen_nachreichen'`;
      const t = await mailIn({ from: "mehmet.yilmaz@example.org", name: "Mehmet Yilmaz", subject: "Unterlagen", text: "Guten Tag,\n\nanbei meine SCHUFA wie besprochen.\n\nMehmet Yilmaz", attachments: [{ name: "SCHUFA_Yilmaz.pdf", token: "tok-schufa" }] });
      mehmetId = Number(t.id);
      await until(async () => (await sql`select 1 from ticket.tasks where ticket_id = ${mehmetId} and type = 'unterlagen_pruefen'`)[0]);
      assert((await sql`select sent_by from ticket.messages where ticket_id = ${mehmetId} and direction = 'out' order by id desc limit 1`)[0].sent_by === "ki", "nicht automatisch");
      await sql`update ticket.intent_settings set mode = 'entwurf' where intent = 'unterlagen_nachreichen'`;
      const [s] = await sql`select signals from ticket.tickets where id = ${mehmetId}`;
      assert(s.signals[0]?.type === "unterlagen_eingegangen" && s.signals[0].stage === 1 && s.signals[0].confirmed, JSON.stringify(s.signals));
      const [k] = await sql`select * from ticket.tasks where ticket_id = ${mehmetId} and type = 'unterlagen_pruefen'`;
      assert(k && k.priority === 1 && k.assignee_email === JONAS && /Abschluss-Chance/.test(k.text), JSON.stringify(k));
      await jonas.goto(`${BASE}/mein?tab=aufgaben`);
      assert((await jonas.locator('[data-testid="task-list"] > div').first().innerText()).includes("Abschluss-Chance"), "Aufgabe nicht oben");
      assert(Number(await jonas.locator('[data-testid="count-chancen"]').innerText()) >= 1, "Zähler Chancen");
    });
    await check("Fall D: „Vielen Dank, bis Montag!“ → Stufe 4 ganz unten, kurzer Entwurf mit Login-Hinweis, „Ohne Antwort schließen“", async () => {
      const t = await mailIn({ from: "mehmet.yilmaz@example.org", name: "Mehmet Yilmaz", subject: "Danke", text: "Vielen Dank, bis Montag!" });
      assert(Number(t.id) === mehmetId && t.priority === 4 && t.status === "entwurf", JSON.stringify({ id: t.id, p: t.priority, s: t.status }));
      const [d] = await sql`select body_text from ticket.drafts where ticket_id = ${mehmetId} order by id desc limit 1`;
      assert(/app\.moovin\.de\/r\/login/.test(d.body_text) && !/Ansprechpartner meldet sich/.test(d.body_text), `Entwurf: ${d.body_text}`);
      await jonas.goto(`${BASE}/mein?tab=todo`);
      const last = jonas.locator("tbody tr").last();
      assert((await last.getAttribute("data-testid")) === `row-${mehmetId}` && (await last.innerText()).includes("Kein Handlungsbedarf"), "nicht unten");
      await jonas.click(`[data-testid="close-${mehmetId}"]`);
      await until(async () => (await sql`select status from ticket.tickets where id = ${mehmetId}`)[0].status === "geschlossen");
    });
    await check("Spam und Abwesenheitsnotiz → automatisch geschlossen, kein Entwurf, nicht im Eingang; echte Antwort öffnet wieder", async () => {
      const before = Number((await sql`select coalesce(max(id),0) as m from ticket.tickets`)[0].m);
      await postBrevo([brevoItem({ from: "sales@seo-agentur.example", name: "SEO Agentur", subject: "Backlinks für moovin.de", text: "Wir bieten Ihnen 500 Backlinks und SEO Rankings zum Festpreis." }),
                       brevoItem({ from: "ole.bergmann@example.org", name: "Ole Bergmann", subject: "Automatische Antwort: Ihre Anfrage", text: "Abwesenheitsnotiz: Ich bin bis 05.12. nicht erreichbar und melde mich danach." })]);
      const rows = await until(async () => { const r = await sql`select id, intent, status, auto_closed, sender_email from ticket.tickets where id > ${before} and status = 'geschlossen'`; return r.length === 2 ? r : null; });
      assert(rows.every((r) => r.auto_closed && ["spam", "intern_system"].includes(r.intent)), JSON.stringify(rows));
      const spam = rows.find((r) => r.sender_email === "sales@seo-agentur.example")!;
      assert(!(await sql`select 1 from ticket.drafts where ticket_id = ${spam.id} and status = 'offen'`).length, "offener Entwurf bei Spam");
      assert((await sql`select 1 from ticket.audit_log where ticket_id = ${spam.id} and detail->>'event' = 'automatisch_geschlossen'`).length, "Audit fehlt");
      await lena.goto(`${BASE}/eingang`);
      assert(await lena.locator(`[data-testid="eingang-${spam.id}"]`).count() === 0, "Spam im Eingang");
      const ole = rows.find((r) => r.sender_email === "ole.bergmann@example.org")!;
      const back = await mailIn({ from: "ole.bergmann@example.org", name: "Ole Bergmann", subject: `Re: Ihre Anfrage [#T-${ole.id}]`, text: "Jetzt bin ich wieder da – ich suche eine 2-Zimmer-Wohnung in Hamburg, haben Sie etwas für mich?" });
      assert(Number(back.id) === Number(ole.id) && back.status === "entwurf" && !back.auto_closed, JSON.stringify({ id: back.id, s: back.status, a: back.auto_closed }));
    });
    let chanceId = 0;
    await check("Fall C: Anmietwunsch nach Besichtigung → nie automatisch (auch bei Auto), Stufe 1 ganz oben mit „Warum oben?“", async () => {
      await sql`update ticket.intent_settings set mode = 'auto', threshold = 0.5 where intent = 'interesse_bestaetigen'`;
      const t = await mailIn({ from: "mehmet.yilmaz@example.org", name: "Mehmet Yilmaz", subject: "Wohnung Spreeufer", text: "Guten Tag,\n\nvielen Dank für die Besichtigung. Ich möchte die Wohnung gerne anmieten.\n\nMehmet Yilmaz" });
      chanceId = Number(t.id);
      await wait(1500);
      await sql`update ticket.intent_settings set mode = 'entwurf' where intent = 'interesse_bestaetigen'`;
      const [r] = await sql`select priority, auto_handled, status, signals, due_at, chance_at from ticket.tickets where id = ${chanceId}`;
      assert(r.priority === 1 && r.status === "entwurf" && r.chance_at, JSON.stringify(r));
      const [o] = await sql`select count(*) as n from ticket.messages where ticket_id = ${chanceId} and direction = 'out'
        and id > (select max(id) from ticket.messages where ticket_id = ${chanceId} and direction = 'in')`;
      assert(Number(o.n) === 0, "automatisch gesendet");
      assert(r.signals.some((x: { type: string; confirmed: boolean }) => x.type === "zusage_nach_besichtigung" && x.confirmed), JSON.stringify(r.signals));
      assert(new Date(r.due_at).getTime() - Date.now() <= 3 * 24 * 3600_000, "SLA Stufe 1");
      await jonas.goto(`${BASE}/mein?tab=todo`);
      const first = jonas.locator("tbody tr").first();
      assert((await first.getAttribute("data-testid")) === `row-${chanceId}`, `oben: ${await first.getAttribute("data-testid")}`);
      assert((await first.innerText()).includes("Warum oben?") && (await first.innerText()).includes("Will anmieten"), await first.innerText());
      await jonas.click('[data-testid="chancen"]');
      assert((await jonas.locator("body").innerText()).includes(`T-${chanceId}`), "nicht unter Chancen");
    });
    await check("Termin < 48 h mit Beleg aus moovin (Julia, morgen); Lucas (in 3 Tagen) ohne", async () => {
      const j = await mailIn({ from: "julia.becker@example.net", name: "Julia Becker", subject: "Besichtigung", text: "Ich komme morgen gerne zur Besichtigung." });
      const js = j.signals as { type: string; confirmed: boolean; stage: number }[];
      assert(js.some((x) => x.type === "termin_bald" && x.confirmed && x.stage === 2) && j.priority <= 2, JSON.stringify(js));
      const l = await mailIn({ from: "lucas.martin@example.com", name: "Lucas Martin", subject: "Viewing", text: "I will come to the viewing tomorrow." });
      assert(!(l.signals as { type: string }[]).some((x) => x.type === "termin_bald"), JSON.stringify(l.signals));
    });
    await check("„Markierung passt nicht“ → Signal fällt weg, Stufe neu, Trefferquote auf der Autonomie-Seite", async () => {
      await jonas.goto(`${BASE}/tickets/${chanceId}`);
      const f = jonas.locator('[data-testid="signal-feedback"]');
      await f.locator("select").selectOption("zusage_nach_besichtigung");
      await f.locator("button").click();
      await until(async () => (await sql`select priority from ticket.tickets where id = ${chanceId}`)[0].priority !== 1);
      assert((await sql`select 1 from ticket.signal_feedback where ticket_id = ${chanceId} and signal = 'zusage_nach_besichtigung'`).length, "keine Rückmeldung");
      await admin.goto(`${BASE}/autonomie`);
      const row = await admin.locator('[data-testid="signal-zusage_nach_besichtigung"]').innerText();
      assert(/\b1\b/.test(row) && row.includes("0 %"), row);
      assert((await sql`select 1 from ticket.audit_log where ticket_id = ${chanceId} and detail->>'event' = 'markierung_passt_nicht'`).length, "Audit fehlt");
    });
    await check("Dashboard zeigt Chancen je AM, Reaktionszeit Stufe 1, Eskalationen", async () => {
      await admin.goto(`${BASE}/dashboard`);
      const txt = await admin.locator('[data-testid="dashboard"]').innerText();
      for (const s of ["Offene Chancen", "Chancen älter als 2 h", "Reaktion Stufe 1", "Chance → Zusage", "Eskalationen offen", "Offene Chancen je AM"]) assert(txt.includes(s), `fehlt: ${s}`);
    });

    await testbatterie(admin, lena);

    console.log("\n16 Leitplanken");
    await check("Keine Mail an Bewerber ohne Freigabe/Auto-Regel (keine proaktiven Mails), nie an Test-Domains", async () => {
      const to = (m: unknown) => String((m as { to: { email: string }[] }).to[0].email);
      const toApplicants = brevo.sent.filter((m) => !to(m).endsWith("@moovin.de"));
      const outs = await sql`select count(*) from ticket.messages where direction = 'out' and delivery_status = 'gesendet'`;
      assert(toApplicants.length === Number(outs[0].count), `${toApplicants.length} Mails vs. ${outs[0].count} Antworten`);
      assert(!brevo.sent.some((m) => /@(.+\.)?example\.(com|org|net)$|\.(test|invalid|local|example)$/.test(to(m))), "Mail an Test-Domain");
    });
    await check("Audit-Log bleibt insert-only", async () => {
      let blocked = false;
      try { await sql`update ticket.audit_log set actor = 'x' where id = (select min(id) from ticket.audit_log)`; } catch { blocked = true; }
      assert(blocked, "Update möglich");
    });
  } finally {
    await browser.close();
    stopNext();
    mock.close();
    await sql.end();
  }
  console.log(`\nErgebnis: ${passed} bestanden, ${failed} fehlgeschlagen`);
  if (failed) { console.log("\nFehler:"); for (const f of failures) console.log(`- ${f}`); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); stopNext(); process.exit(1); });
