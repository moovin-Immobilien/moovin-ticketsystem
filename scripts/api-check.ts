// Konformitätstest für die moovin Ticket-API (docs/moovin-api.openapi.yaml).
// Prüft eine Implementierung von außen – genau so, wie das Ticketsystem sie aufruft.
//
// Nutzung (Werte für eine Staging-Umgebung mit Testdaten):
//   API_URL=https://staging.app.moovin.de/api/ticket/v1 \
//   KEY_ID=proto-1 SECRET=... \
//   OWN_EMAIL=test.bewerber@example.org OWN_APPLICATION_ID=... OWN_APPOINTMENT_ID=... OWN_LISTING_ID=... \
//   FOREIGN_EMAIL=anderer.bewerber@example.org \
//   [PAST_APPOINTMENT_ID=...] \
//   npx tsx scripts/api-check.ts [--write] [--destructive]
//
//   ohne Flag      nur lesende Aufrufe + Sicherheitsprüfungen (ändert nichts)
//   --write        zusätzlich Notiz, Dokument, Kopie einer Nachricht, Terminzusage (Testdaten!)
//   --destructive  zusätzlich Terminabsage von OWN_APPOINTMENT_ID (Slot wird frei)
//
// FOREIGN_EMAIL muss ein anderer Bewerber sein, der sich NICHT auf OWN_LISTING_ID beworben hat.
// Exit-Code 0 = alles bestanden, 1 = mindestens ein Fehler.

import { randomUUID } from "node:crypto";
import { signRequest } from "../src/lib/hmac";

const args = new Set(process.argv.slice(2));
const WRITE = args.has("--write") || args.has("--destructive");
const DESTRUCTIVE = args.has("--destructive");

function need(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Umgebungsvariable ${name} fehlt (siehe Kopf von scripts/api-check.ts)`); process.exit(2); }
  return v;
}
const API_URL = need("API_URL").replace(/\/$/, "");
const KEY_ID = need("KEY_ID");
const SECRET = need("SECRET");
const OWN_EMAIL = need("OWN_EMAIL");
const OWN_APP = need("OWN_APPLICATION_ID");
const OWN_APPT = need("OWN_APPOINTMENT_ID");
const OWN_LISTING = need("OWN_LISTING_ID");
const FOREIGN_EMAIL = need("FOREIGN_EMAIL");
const PAST_APPT = process.env.PAST_APPOINTMENT_ID;
// Optional ein zusätzlicher Header, z. B. für geschützte Staging-Umgebungen: EXTRA_HEADER="Name: Wert"
const EXTRA_HEADERS: Record<string, string> = {};
if (process.env.EXTRA_HEADER) {
  const i = process.env.EXTRA_HEADER.indexOf(":");
  if (i > 0) EXTRA_HEADERS[process.env.EXTRA_HEADER.slice(0, i).trim()] = process.env.EXTRA_HEADER.slice(i + 1).trim();
}

type Res = { status: number; data: any; raw: string };
type Opts = { subject?: string | null; body?: unknown; idem?: string | null; keyId?: string; secret?: string; tsOffset?: number; tamper?: boolean; noSig?: boolean };

async function call(method: "GET" | "POST", path: string, o: Opts = {}): Promise<Res> {
  const url = new URL(API_URL + path);
  const bodyStr = o.body === undefined ? "" : JSON.stringify(o.body);
  const ts = (Math.floor(Date.now() / 1000) + (o.tsOffset ?? 0)).toString();
  let sig = signRequest(o.secret ?? SECRET, ts, method, url.pathname + url.search, bodyStr);
  if (o.tamper) sig = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
  const headers: Record<string, string> = { ...EXTRA_HEADERS };
  if (!o.noSig) Object.assign(headers, { "X-Moovin-Key-Id": o.keyId ?? KEY_ID, "X-Moovin-Timestamp": ts, "X-Moovin-Signature": sig });
  const subject = o.subject === undefined ? OWN_EMAIL : o.subject;
  if (subject) headers["X-Subject-Email"] = subject;
  if (o.idem) headers["Idempotency-Key"] = o.idem;
  if (bodyStr) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { method, headers, body: bodyStr || undefined, signal: AbortSignal.timeout(15_000) });
  const raw = await res.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* kein JSON */ }
  return { status: res.status, data, raw };
}

let passed = 0, failed = 0;
const failures: string[] = [];
async function check(name: string, fn: () => Promise<string | true>) {
  try {
    const r = await fn();
    if (r === true) { passed++; console.log(`  ✔ ${name}`); }
    else { failed++; failures.push(`${name}: ${r}`); console.log(`  ✘ ${name} – ${r}`); }
  } catch (e) {
    failed++; const msg = e instanceof Error ? e.message : String(e);
    failures.push(`${name}: ${msg}`); console.log(`  ✘ ${name} – ${msg}`);
  }
}
const expect = (r: Res, codes: number[]) => (codes.includes(r.status) ? true : `HTTP ${r.status} statt ${codes.join("/")} ${r.raw.slice(0, 160)}`);
const enc = encodeURIComponent;

const APP_STATUS = ["eingegangen", "unvollstaendig", "in_pruefung", "eingeladen", "besichtigt", "beim_eigentuemer", "zusage", "absage", "zurueckgezogen"];
const APPT_STATUS = ["eingeladen", "bestaetigt", "abgesagt", "stattgefunden", "no_show"];
const FORBIDDEN_KEYS = /score|ranking|rank|reject|ablehnungsgrund|income|einkommen|gehalt|salary|schufa|document_content|birth|geburt|phone|telefon|mobile|street_address|wohnadresse|iban|note|notiz|first_name|vorname/i;
// Erlaubte Felder (Datensparsamkeit): alles andere ist ein Befund
const ALLOWED = {
  applicant: ["id", "salutation", "last_name", "language"],
  application: ["id", "listing_id", "object_title", "status", "missing_documents", "account_manager_email", "appointment"],
  appointment: ["id", "starts_at", "ends_at", "status", "meeting_point"],
};
function extraKeys(o: Record<string, unknown> | null | undefined, allowed: string[], where: string): string[] {
  return o ? Object.keys(o).filter((k) => !allowed.includes(k)).map((k) => `${where}.${k}`) : [];
}

function forbiddenKeys(obj: unknown, path = ""): string[] {
  if (!obj || typeof obj !== "object") return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.test(k) && k !== "missing_documents") out.push(path + k);
    out.push(...forbiddenKeys(v, `${path}${k}.`));
  }
  return out;
}

async function main() {
  console.log(`moovin Ticket-API Konformitätstest → ${API_URL}`);
  console.log(`Modus: ${DESTRUCTIVE ? "lesen + schreiben + Absage" : WRITE ? "lesen + schreiben" : "nur lesen"}\n`);

  console.log("1 Signatur und Zugriffsschutz");
  const ctxPath = `/applicants?email=${enc(OWN_EMAIL)}`;
  await check("ohne Signatur-Header → 401", async () => expect(await call("GET", ctxPath, { noSig: true }), [401]));
  await check("manipulierte Signatur → 401", async () => expect(await call("GET", ctxPath, { tamper: true }), [401]));
  await check("unbekannte Key-Id → 401", async () => expect(await call("GET", ctxPath, { keyId: "gibt-es-nicht" }), [401]));
  await check("falsches Secret → 401", async () => expect(await call("GET", ctxPath, { secret: "falsch-" + randomUUID() }), [401]));
  await check("Zeitstempel 6 min alt → 401", async () => expect(await call("GET", ctxPath, { tsOffset: -360 }), [401]));
  await check("Zeitstempel 6 min in der Zukunft → 401", async () => expect(await call("GET", ctxPath, { tsOffset: 360 }), [401]));
  await check("Query nachträglich geändert → 401", async () => {
    // Signatur über OWN_EMAIL, gesendet wird FOREIGN_EMAIL in der Query
    const url = new URL(API_URL + ctxPath);
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = signRequest(SECRET, ts, "GET", url.pathname + url.search, "");
    const res = await fetch(API_URL + `/applicants?email=${enc(FOREIGN_EMAIL)}`, { headers: { ...EXTRA_HEADERS, "X-Moovin-Key-Id": KEY_ID, "X-Moovin-Timestamp": ts, "X-Moovin-Signature": sig, "X-Subject-Email": OWN_EMAIL } });
    return res.status === 401 ? true : `HTTP ${res.status} statt 401`;
  });
  await check("ohne X-Subject-Email → 400", async () => expect(await call("GET", ctxPath, { subject: null }), [400, 401]));

  console.log("\n2 Lesen: Bewerber-Kontext");
  let ctx: any = null;
  await check("GET /applicants eigener Bewerber → 200 + Pflichtfelder", async () => {
    const r = await call("GET", ctxPath);
    if (r.status !== 200) return `HTTP ${r.status} ${r.raw.slice(0, 160)}`;
    ctx = r.data;
    const a = ctx?.applicant;
    if (!a?.id || a.last_name === undefined) return "applicant.id/last_name fehlen";
    if (!Array.isArray(ctx.applications)) return "applications ist kein Array";
    return true;
  });
  await check("Bewerbungen: status aus Enum, listing_id gesetzt, OWN_APPLICATION_ID enthalten", async () => {
    if (!ctx) return "kein Kontext";
    for (const ap of ctx.applications) {
      if (!ap.id || !ap.listing_id || !ap.object_title) return `Bewerbung ohne id/listing_id/object_title`;
      if (!APP_STATUS.includes(ap.status)) return `unbekannter status „${ap.status}“ bei ${ap.id}`;
      if (ap.missing_documents !== undefined && !Array.isArray(ap.missing_documents)) return `missing_documents kein Array bei ${ap.id}`;
      if (ap.appointment) {
        if (!ap.appointment.id || !ap.appointment.starts_at) return `appointment ohne id/starts_at bei ${ap.id}`;
        if (!APPT_STATUS.includes(ap.appointment.status)) return `unbekannter Terminstatus „${ap.appointment.status}“`;
        if (Number.isNaN(Date.parse(ap.appointment.starts_at)) || !/[zZ]|[+-]\d\d:?\d\d$/.test(ap.appointment.starts_at)) return `starts_at nicht ISO 8601 mit Zeitzone: ${ap.appointment.starts_at}`;
      }
    }
    if (!ctx.applications.some((ap: any) => ap.id === OWN_APP)) return `OWN_APPLICATION_ID ${OWN_APP} nicht in der Antwort`;
    return true;
  });
  await check("Datensparsam: nur vereinbarte Felder, keine Scores/Einkommen/Kontaktdaten", async () => {
    if (!ctx) return "kein Kontext";
    const extra = [
      ...extraKeys(ctx, ["applicant", "applications"], "root"),
      ...extraKeys(ctx.applicant, ALLOWED.applicant, "applicant"),
      ...ctx.applications.flatMap((ap: any) => [...extraKeys(ap, ALLOWED.application, `application ${ap.id}`), ...extraKeys(ap.appointment, ALLOWED.appointment, `appointment ${ap.appointment?.id}`)]),
    ];
    const bad = forbiddenKeys(ctx);
    if (bad.length) return `verbotene Felder: ${bad.join(", ")}`;
    return extra.length ? `nicht vereinbarte Felder: ${extra.join(", ")}` : true;
  });
  await check("unbekannte Mailadresse → 404", async () => {
    const e = `unbekannt-${randomUUID().slice(0, 8)}@example.invalid`;
    return expect(await call("GET", `/applicants?email=${enc(e)}`, { subject: e }), [404]);
  });
  await check("email-Parameter ≠ X-Subject-Email → kein Datenzugriff (400/404)", async () =>
    expect(await call("GET", `/applicants?email=${enc(OWN_EMAIL)}`, { subject: FOREIGN_EMAIL }), [400, 403, 404]));

  console.log("\n3 Lesen: Inserat (optional)");
  await check("GET /listings/{eigenes Inserat} → 200 + Pflichtfelder (404 = Endpunkt nicht gebaut)", async () => {
    const r = await call("GET", `/listings/${enc(OWN_LISTING)}`);
    if (r.status === 404) return true;
    if (r.status !== 200) return `HTTP ${r.status} ${r.raw.slice(0, 160)}`;
    if (!r.data?.id || !r.data?.title || !r.data?.address) return "id/title/address fehlen";
    const bad = forbiddenKeys(r.data);
    return bad.length ? `verbotene Felder: ${bad.join(", ")}` : true;
  });
  await check("Inserat eines anderen Bewerbers → 404", async () => expect(await call("GET", `/listings/${enc(OWN_LISTING)}`, { subject: FOREIGN_EMAIL }), [404]));

  console.log("\n4 Schreiben: Schutz (ändert nichts)");
  const noteBody = { source_ticket_id: "api-check", text: "Konformitätstest – bitte ignorieren", ticket_url: "https://example.invalid/tickets/0" };
  await check("POST ohne Idempotency-Key → 400", async () => expect(await call("POST", `/applications/${enc(OWN_APP)}/notes`, { body: noteBody, idem: null }), [400]));
  await check("Notiz an fremde Bewerbung (fremder Absender) → 404", async () =>
    expect(await call("POST", `/applications/${enc(OWN_APP)}/notes`, { body: noteBody, idem: randomUUID(), subject: FOREIGN_EMAIL }), [404]));
  await check("Termin fremd absagen (fremder Absender) → 404", async () =>
    expect(await call("POST", `/appointments/${enc(OWN_APPT)}/reply`, { body: { source_ticket_id: "api-check", answer: "absage" }, idem: randomUUID(), subject: FOREIGN_EMAIL }), [404]));
  await check("Termin fremd zusagen (fremder Absender) → 404", async () =>
    expect(await call("POST", `/appointments/${enc(OWN_APPT)}/reply`, { body: { source_ticket_id: "api-check", answer: "zusage" }, idem: randomUUID(), subject: FOREIGN_EMAIL }), [404]));
  await check("ungültige answer → 400", async () =>
    expect(await call("POST", `/appointments/${enc(OWN_APPT)}/reply`, { body: { source_ticket_id: "api-check", answer: "vielleicht" }, idem: randomUUID() }), [400, 422]));
  const OWN_APPLICANT = String(ctx?.applicant?.id ?? "unbekannt");
  await check("Dokumente an fremdes Bewerberprofil → 404", async () =>
    expect(await call("POST", `/applicants/${enc(OWN_APPLICANT)}/documents`, { body: { source_ticket_id: "api-check", files: [] }, idem: randomUUID(), subject: FOREIGN_EMAIL }), [404]));
  const copyBody = { source_ticket_id: "api-check", ticket_url: "https://example.invalid/tickets/0", direction: "in", sent_at: new Date().toISOString(),
    from: OWN_EMAIL, to: "mieter@moovin.de", subject: "Konformitätstest", text: "Testmail – bitte ignorieren", attachments: [], sender_verified: true };
  await check("Optional: Kopie in fremdes Bewerberprofil → 404", async () =>
    expect(await call("POST", `/applicants/${enc(OWN_APPLICANT)}/correspondence`, { body: copyBody, idem: randomUUID(), subject: FOREIGN_EMAIL }), [404]));

  if (WRITE) {
    console.log("\n5 Schreiben (Testdaten werden verändert)");
    const idem = randomUUID();
    let first: Res | null = null;
    await check("Notiz anlegen → 201", async () => { first = await call("POST", `/applications/${enc(OWN_APP)}/notes`, { body: noteBody, idem }); return expect(first, [201]); });
    await check("gleicher Idempotency-Key nochmal → gleiche Antwort", async () => {
      const again = await call("POST", `/applications/${enc(OWN_APP)}/notes`, { body: noteBody, idem });
      if (!first) return "erster Aufruf fehlt";
      return again.status === first.status && again.raw === first.raw ? true : `HTTP ${again.status} / ${again.raw.slice(0, 80)} ≠ erster Aufruf`;
    });
    await check("Dokument im Bewerberprofil ablegen → 201", async () => expect(await call("POST", `/applicants/${enc(OWN_APPLICANT)}/documents`, {
      idem: randomUUID(),
      body: { source_ticket_id: "api-check", files: [{ filename: "api-check.txt", content_type: "text/plain", content_base64: Buffer.from("Konformitätstest").toString("base64") }] },
    }), [201]));
    await check("Optional: Kopie einer Nachricht ablegen → 201 (404 = nicht gebaut)", async () =>
      expect(await call("POST", `/applicants/${enc(OWN_APPLICANT)}/correspondence`, { body: copyBody, idem: randomUUID() }), [201, 404]));
    await check("Termin zusagen → 200 (409 falls schon abgesagt/vergangen)", async () => expect(await call("POST", `/appointments/${enc(OWN_APPT)}/reply`, { idem: randomUUID(), body: { source_ticket_id: "api-check", answer: "zusage" } }), [200, 409]));
    if (PAST_APPT) {
      await check("vergangenen Termin zusagen → 409", async () => expect(await call("POST", `/appointments/${enc(PAST_APPT)}/reply`, { idem: randomUUID(), body: { source_ticket_id: "api-check", answer: "zusage" } }), [409]));
      await check("vergangenen Termin absagen → 409", async () => expect(await call("POST", `/appointments/${enc(PAST_APPT)}/reply`, { idem: randomUUID(), body: { source_ticket_id: "api-check", answer: "absage" } }), [409]));
    }
    if (DESTRUCTIVE) {
      await check("Termin absagen → 200", async () => expect(await call("POST", `/appointments/${enc(OWN_APPT)}/reply`, { idem: randomUUID(), body: { source_ticket_id: "api-check", answer: "absage", comment: "Konformitätstest" } }), [200]));
      await check("schon abgesagten Termin nochmal absagen → 409", async () => expect(await call("POST", `/appointments/${enc(OWN_APPT)}/reply`, { idem: randomUUID(), body: { source_ticket_id: "api-check", answer: "absage" } }), [409]));
      await check("abgesagten Termin zusagen → 409", async () => expect(await call("POST", `/appointments/${enc(OWN_APPT)}/reply`, { idem: randomUUID(), body: { source_ticket_id: "api-check", answer: "zusage" } }), [409]));
    }
  } else {
    console.log("\n(Schreibende Aufrufe übersprungen – mit --write bzw. --destructive ausführen)");
  }

  console.log(`\nErgebnis: ${passed} bestanden, ${failed} fehlgeschlagen`);
  if (failed) { console.log("\nFehler:"); for (const f of failures) console.log(`- ${f}`); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
