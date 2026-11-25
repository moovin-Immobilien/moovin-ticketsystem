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
        if (!/from Deals where Pipeline = 'Vermietung'/.test(query) || /limit [1-9]\d*,/.test(query)) { res.writeHead(204).end(); return; }
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
  return (await sql`select * from ticket.tickets where id = ${msg.ticket_id}`)[0];
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
    await check("Freigabe → Versand über Brevo, Message-ID gespeichert, Antwortadresse aus moovin", async () => {
      await sendFromUi(lena, annaId, { awaitReply: false });
      const last = brevo.sent.at(-1) as { to: { email: string }[]; replyTo: { email: string }; subject: string };
      assert(last && last.to[0].email === "anna.schmidt@example.org" && /\[#T-\d+\]/.test(last.subject), JSON.stringify(last));
      const [m] = await sql`select provider_message_id from ticket.messages where ticket_id = ${annaId} and direction = 'out'`;
      brevoMsgId = m.provider_message_id; assert(/brevo-/.test(brevoMsgId ?? ""), "provider_message_id fehlt");
      const [a] = await sql`select status from ticket.actions where ticket_id = ${annaId} and type = 'dokumente_ablegen'`;
      assert(a?.status === "ausgefuehrt", `Dokumente: ${a?.status}`);
    });
    await check("Geschlossenes Ticket: Antwort (In-Reply-To = Brevo-ID, ohne [#T]) öffnet es wieder", async () => {
      await lena.goto(`${BASE}/tickets/${annaId}`);
      await sql`update ticket.tickets set status = 'geschlossen', closed_at = now() where id = ${annaId}`;
      const t = await mailIn({ from: "anna.schmidt@example.org", name: "Anna Schmidt", subject: "AW: Ihre Unterlagen", text: "Danke! Wie ist der Stand?", inReplyTo: brevoMsgId });
      assert(Number(t.id) === annaId, `neues Ticket ${t.id} statt ${annaId}`);
      assert(t.status === "entwurf" && t.reopened_at, `Status ${t.status}`);
      assert((await sql`select 1 from ticket.audit_log where ticket_id = ${annaId} and detail->>'event' = 'wiedereroeffnet'`).length, "Audit fehlt");
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
      assert(k.type === "rueckzug" && k.assignee_email === LENA && k.status === "offen", JSON.stringify(k));
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
    await check("Ohne moovin: Adresse in der Mail → AM laut CRM, kein moovin-Aufruf, Platzhalter statt „unbekannt“", async () => {
      const calls = Number((await sql`select count(*) from mock_moovin.request_log`)[0].count);
      const t = await mailIn({ from: "paula.neu@example.com", name: "Paula Neu", subject: "Bewerbung", text: "Guten Tag,\n\nwie ist der Stand meiner Bewerbung für die Wohnung Teststr. 12, 10115 Berlin?\n\nPaula Neu" });
      offId = Number(t.id);
      assert(t.assignee_email === LENA && t.routing_source === "crm_adresse" && t.object_id === "MV-TST001", JSON.stringify({ a: t.assignee_email, r: t.routing_source, o: t.object_id }));
      const [d] = await sql`select body_text from ticket.drafts where ticket_id = ${offId} order by id desc limit 1`;
      assert(d.body_text.includes("[AM:") && !/keiner Bewerbung zuordnen/.test(d.body_text), d.body_text);
      assert(Number((await sql`select count(*) from mock_moovin.request_log`)[0].count) === calls, "moovin wurde aufgerufen");
      await lena.goto(`${BASE}/tickets/${offId}`);
      assert(await lena.locator('[data-testid="moovin-off"]').count() === 1, "Hinweis im Ticket fehlt");
      assert((await lena.locator('[data-testid="object-card"]').innerText()).includes("Adresse in der Mail"), "Zuordnungsquelle fehlt");
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
      const [k] = await until(async () => { const r = await sql`select * from ticket.tasks where ticket_id = ${offId} and type = 'rueckzug'`; return r.length ? r : null; });
      assert(k.assignee_email === LENA && k.status === "offen", JSON.stringify(k));
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

    console.log("\n14 Leitplanken");
    await check("Keine Mail an Bewerber ohne Freigabe/Auto-Regel (keine proaktiven Mails)", async () => {
      const toApplicants = brevo.sent.filter((m) => !String((m as { to: { email: string }[] }).to[0].email).endsWith("@moovin.de"));
      const outs = await sql`select count(*) from ticket.messages where direction = 'out'`;
      assert(toApplicants.length === Number(outs[0].count), `${toApplicants.length} Mails vs. ${outs[0].count} Antworten`);
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
