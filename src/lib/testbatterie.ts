import "server-only";
import { sql } from "./db";
import { audit } from "./audit";
import { processInbound } from "./pipeline";
import { SIGNAL_INFO, type Signal, type SignalType } from "./signals";
import type { InboundMail } from "./inbound/parse";
import data from "./testbatterie.json";

// Testbatterie: feste Testfälle (src/lib/testbatterie.json) als Testtickets einspielen und Soll/Ist auswerten.
// Testtickets sind is_test: nie Versand (deliver), kein Auto-Versand, keine moovin-Schreibaufrufe, nicht in Kennzahlen.

export type Expected = {
  intent?: string; stufe?: number; signal?: string; fall?: string; auto?: boolean;
  zuordnung?: string; sprache?: string; aktion?: string; hinweis?: string;
};
export type TestCase = {
  key: string; from: string; name: string; verified: boolean; objekt: boolean;
  subject: string; body: string; anhaenge?: string[]; folgt_auf?: string; erwartet: Expected;
};
export const TEST_CASES: readonly TestCase[] = (data as { faelle: TestCase[] }).faelle;
export const caseByKey = (key: string) => TEST_CASES.find((c) => c.key === key) ?? null;

/** Laufkennung: Zeitstempel Berlin, z. B. 20261126-153012 */
export const RUN_RE = /^\d{8}-\d{6}$/;
export function newRunId(d = new Date()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}-${String(Number(p.hour) % 24).padStart(2, "0")}${p.minute}${p.second}`;
}

export const caseMessageId = (run: string, key: string) => `<testbatterie-${run}-${key}@test.local>`;

// ---------- Objekte für die Platzhalter ----------

export type TestObject = { object_id: string; street: string; zip: string | null; city: string | null; title: string | null };
export type PlanItem = { key: string; objectId: string | null; objectTitle: string | null; folgtAuf: string | null };

/** Deterministischer Zufall je Lauf (mulberry32 über einen Hash der Laufkennung). */
function rng(seedText: string) {
  let h = 2166136261;
  for (const c of seedText) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * Plan je Lauf: pro Fall ein anderes Objekt (live, aktiv, mit AM und erkennbarer Adresse), Städte gemischt –
 * zufällig, aber pro Lauf fest. Fälle mit {{ID}} bekommen ein Objekt mit echter moovin-ID. Folgemails nutzen das Objekt
 * des Vorgängers. Fälle mit objekt: false bekommen keins. Ausgewählte Folgemails ziehen ihren Vorgänger mit.
 */
export async function planRun(run: string, keys: string[]): Promise<PlanItem[]> {
  const wanted = new Set(keys.filter((k) => caseByKey(k)));
  for (const k of [...wanted]) { const f = caseByKey(k)?.folgt_auf; if (f) wanted.add(f); }
  const cases = TEST_CASES.filter((c) => wanted.has(c.key));

  const rows = await sql<TestObject[]>`select object_id, street, zip, city, title from ticket.crm_objects
    where live and active and am_email is not null and street is not null and match_key is not null
      and coalesce(title, '') !~* 'stellpl|garage|tiefgarage|parkplatz' and coalesce(street, '') !~* 'stellpl|garage' order by object_id`;
  const r = rng(run);
  // Städte gemischt: je Stadt mischen, Städte mischen, dann reihum ziehen
  const byCity = new Map<string, TestObject[]>();
  for (const o of shuffle([...rows], r)) {
    const c = (o.city ?? o.zip ?? "?").trim().toLowerCase();
    byCity.set(c, [...(byCity.get(c) ?? []), o]);
  }
  const queues = shuffle([...byCity.values()], r);
  const mixed: TestObject[] = [];
  while (queues.some((q) => q.length)) for (const q of queues) { const o = q.shift(); if (o) mixed.push(o); }

  const used = new Set<string>();
  const take = (needId: boolean): TestObject | null => {
    const pool = mixed.filter((o) => !needId || /^MV-/i.test(o.object_id));
    const fresh = pool.find((o) => !used.has(o.object_id)) ?? pool[used.size % Math.max(1, pool.length)] ?? null;
    if (fresh) used.add(fresh.object_id);
    return fresh;
  };
  const chosen = new Map<string, TestObject | null>();
  // Zuerst die Fälle mit {{ID}} (brauchen eine moovin-ID), dann der Rest
  const needsId = (c: TestCase) => /\{\{ID\}\}/.test(c.subject + c.body);
  for (const c of [...cases.filter((c) => needsId(c) && !c.folgt_auf), ...cases.filter((c) => !needsId(c) && !c.folgt_auf)]) {
    chosen.set(c.key, c.objekt ? take(needsId(c)) : null);
  }
  for (const c of cases.filter((c) => c.folgt_auf)) chosen.set(c.key, c.objekt ? chosen.get(c.folgt_auf!) ?? take(needsId(c)) : null);

  return cases.map((c) => {
    const o = chosen.get(c.key) ?? null;
    return { key: c.key, objectId: o?.object_id ?? null, objectTitle: o ? o.title ?? `${o.street}, ${[o.zip, o.city].filter(Boolean).join(" ")}` : null, folgtAuf: c.folgt_auf ?? null };
  });
}

/** Platzhalter füllen. Ohne passendes CRM-Objekt (z. B. leere Testdatenbank) fiktive Werte. */
export function fillPlaceholders(text: string, o: TestObject | null): string {
  const adresse = o?.street ?? "Musterstraße 1";
  const plzOrt = o ? [o.zip, o.city].filter(Boolean).join(" ") : "10115 Berlin";
  const id = o && /^MV-/i.test(o.object_id) ? o.object_id : "MV-TEST00";
  return text.replaceAll("{{ADRESSE}}", adresse).replaceAll("{{PLZ_ORT}}", plzOrt).replaceAll("{{ID}}", id);
}

// Dummy-Anhänge (Inhalt egal – gehen nie an Claude)
const DUMMY_PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF").toString("base64");
const DUMMY_JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]).toString("base64");
function dummyAttachment(filename: string) {
  const jpg = /\.jpe?g$/i.test(filename);
  const b64 = jpg ? DUMMY_JPG : DUMMY_PDF;
  return { filename, contentType: jpg ? "image/jpeg" : "application/pdf", contentBase64: b64, size: Buffer.from(b64, "base64").length };
}

export function buildMail(run: string, c: TestCase, o: TestObject | null): InboundMail {
  const from = c.from.trim().toLowerCase();
  const prev = c.folgt_auf ? caseMessageId(run, c.folgt_auf) : null;
  return {
    fromEmail: from,
    fromName: c.name,
    to: "mieter@moovin.de",
    subject: fillPlaceholders(c.subject, o),
    text: fillPlaceholders(c.body, o),
    messageId: caseMessageId(run, c.key),
    inReplyTo: prev,
    references: prev,
    authResults: c.verified ? `inbound.test; dkim=pass header.d=${from.split("@")[1]}; spf=pass; dmarc=pass` : "inbound.test; dkim=none; spf=softfail; dmarc=fail",
    attachments: (c.anhaenge ?? []).map(dummyAttachment),
  };
}

// ---------- Läufe (Plan serverseitig, Fortsetzen nach Abbruch) ----------

export async function saveRun(run: string, plan: PlanItem[], actor: string) {
  await sql`insert into ticket.test_runs (run, plan, created_by) values (${run}, ${sql.json(plan as never)}, ${actor}) on conflict (run) do nothing`;
}

export type RunStatus = { run: string; total: number; done: number; failed: number; missing: PlanItem[]; results: Record<string, { ticketId: number | null; error: string | null; ms: number | null }> };

/**
 * Stand eines Laufs: Welche Fälle des gespeicherten Plans haben noch kein (erfolgreiches) Ergebnis?
 * Die fehlenden werden mit demselben Objekt nachgeladen; Folgemails hängen weiter an ihrem Vorgänger.
 */
export async function runStatus(run: string): Promise<RunStatus | null> {
  if (!RUN_RE.test(run)) return null;
  const [r] = await sql`select plan from ticket.test_runs where run = ${run}`;
  if (!r) return null;
  const plan = (r.plan ?? []) as PlanItem[];
  const rows = await sql`select case_key, ticket_id, error, duration_ms from ticket.test_results where test_run = ${run}`;
  const results: RunStatus["results"] = {};
  for (const x of rows) results[String(x.case_key)] = { ticketId: x.ticket_id === null ? null : Number(x.ticket_id), error: x.error ?? null, ms: x.duration_ms === null ? null : Number(x.duration_ms) };
  const ok = (k: string) => !!results[k] && !results[k].error && !!results[k].ticketId;
  const missing = plan.filter((p) => !ok(p.key));
  return { run, total: plan.length, done: plan.filter((p) => ok(p.key)).length, failed: plan.filter((p) => results[p.key]?.error).length, missing, results };
}

/** Unvollständige Läufe (Plan gespeichert, nicht alle Fälle erfolgreich), neueste zuerst. */
export async function incompleteRuns(limit = 5): Promise<RunStatus[]> {
  const runs = await sql`select run from ticket.test_runs order by run desc limit 20`;
  const out: RunStatus[] = [];
  for (const r of runs) {
    const st = await runStatus(String(r.run));
    if (st && st.missing.length) out.push(st);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------- Einspielen eines Falls ----------

export type CaseResult = { key: string; ok: boolean; ticketId: number | null; error?: string; ms: number };

export async function loadCase(run: string, key: string, objectId: string | null, actor: string): Promise<CaseResult> {
  const started = Date.now();
  const c = caseByKey(key);
  if (!RUN_RE.test(run) || !c) return { key, ok: false, ticketId: null, error: "Unbekannter Lauf oder Fall", ms: 0 };
  let ticketId: number | null = null;
  try {
    let o: TestObject | null = null;
    if (c.objekt && objectId) {
      [o] = await sql<TestObject[]>`select object_id, street, zip, city, title from ticket.crm_objects where object_id = ${objectId} and active`;
      if (!o) throw new Error(`Objekt ${objectId} nicht (mehr) im CRM-Spiegel`);
    }
    if (c.folgt_auf) {
      const [prev] = await sql`select ticket_id, error from ticket.test_results where test_run = ${run} and case_key = ${c.folgt_auf}`;
      if (!prev || prev.error || !prev.ticket_id) throw new Error(`Vorgänger ${c.folgt_auf} fehlt oder ist fehlgeschlagen`);
    }
    const res = await processInbound(buildMail(run, c, o), actor, [], { isTest: true, testRun: run });
    ticketId = res.ticketId;
    const actual = await snapshot(ticketId);
    await sql`insert into ticket.test_results (test_run, case_key, ticket_id, object_id, expected, actual, error, duration_ms, actor)
      values (${run}, ${key}, ${ticketId}, ${o?.object_id ?? null}, ${sql.json(c.erwartet as never)}, ${sql.json(actual as never)}, null, ${Date.now() - started}, ${actor})
      on conflict (test_run, case_key) do update set ticket_id = excluded.ticket_id, object_id = excluded.object_id, actual = excluded.actual,
        error = null, duration_ms = excluded.duration_ms, created_at = now()`;
    return { key, ok: true, ticketId, ms: Date.now() - started };
  } catch (e) {
    const error = (e as Error).message.slice(0, 500);
    await sql`insert into ticket.test_results as r (test_run, case_key, ticket_id, object_id, expected, error, duration_ms, actor)
      values (${run}, ${key}, ${ticketId}, ${objectId}, ${sql.json(c.erwartet as never)}, ${error}, ${Date.now() - started}, ${actor})
      on conflict (test_run, case_key) do update set error = excluded.error, ticket_id = coalesce(excluded.ticket_id, r.ticket_id), duration_ms = excluded.duration_ms`
      .catch(() => {});
    return { key, ok: false, ticketId, error, ms: Date.now() - started };
  }
}

// ---------- Ist-Stand und Vergleich ----------

export type Actual = {
  intent: string | null; stufe: number | null; signals: string[]; faelle: string[];
  routing_source: string | null; assignee: string | null; sprache: string | null; auto: boolean;
  aktionen: string[]; confidence: number | null; status: string; needs_human: boolean;
};

/** Stand des Tickets direkt nach der Verarbeitung (Folgemails ändern später das Ticket, nicht diesen Stand). */
export async function snapshot(ticketId: number): Promise<Actual> {
  const [t] = await sql`select * from ticket.tickets where id = ${ticketId}`;
  const [d] = await sql`select id, body_text from ticket.drafts where ticket_id = ${ticketId} order by id desc limit 1`;
  const acts = d ? await sql`select type from ticket.actions where draft_id = ${d.id} order by id` : [];
  const signals = ((t.signals ?? []) as Signal[]);
  const faelle = [...new Set(signals.map((s) => SIGNAL_INFO[s.type as SignalType]?.fall).filter((f): f is "B" | "C" | "D" => !!f && f !== "-"))].sort();
  return {
    intent: t.intent ?? null, stufe: t.priority === null ? null : Number(t.priority), signals: signals.map((s) => s.type), faelle,
    routing_source: t.routing_source ?? null, assignee: t.assignee_email ?? null, sprache: t.language ?? null, auto: !!t.auto_handled,
    aktionen: acts.map((a) => String(a.type)),
    confidence: t.confidence === null ? null : Number(t.confidence), status: t.status, needs_human: !!t.needs_human,
  };
}

export type Check = { field: string; soll: string; ist: string; ok: boolean | null };

/** Soll/Ist je Feld. ok = null: kein Soll angegeben (nur Anzeige). */
export function compare(e: Expected, a: Actual | null): Check[] {
  const v = (x: unknown) => (x === null || x === undefined || x === "" ? "–" : String(x));
  if (!a) return [];
  const zuordnungIst = a.assignee ? (a.routing_source ?? "zugeordnet") : "allgemeiner_eingang";
  return [
    { field: "Anliegen", soll: v(e.intent), ist: v(a.intent), ok: e.intent ? a.intent === e.intent : null },
    { field: "Stufe", soll: v(e.stufe), ist: v(a.stufe), ok: e.stufe !== undefined ? a.stufe === e.stufe : null },
    { field: "Signale", soll: v(e.signal), ist: a.signals.join(", ") || "–", ok: e.signal ? a.signals.includes(e.signal) : null },
    { field: "Fall", soll: v(e.fall), ist: a.faelle.join(", ") || "–", ok: e.fall ? a.faelle.includes(e.fall) : null },
    { field: "Zuordnung", soll: v(e.zuordnung), ist: `${zuordnungIst}${a.assignee ? ` (${a.assignee})` : ""}`,
      ok: e.zuordnung ? (e.zuordnung === "allgemeiner_eingang" ? !a.assignee : a.routing_source === e.zuordnung && !!a.assignee) : null },
    { field: "Sprache", soll: v(e.sprache), ist: v(a.sprache), ok: e.sprache ? a.sprache === e.sprache : null },
    { field: "Auto", soll: e.auto === undefined ? "–" : e.auto ? "ja" : "nein", ist: a.auto ? "ja" : "nein", ok: e.auto !== undefined ? a.auto === e.auto : null },
    { field: "Aktion", soll: v(e.aktion), ist: a.aktionen.join(", ") || "–", ok: e.aktion ? a.aktionen.includes(e.aktion) : null },
  ];
}

// ---------- Aufräumen ----------

/**
 * Löscht Testtickets (optional nur eines Laufs) samt Nachrichten, Anhängen, Entwürfen, Aktionen, Aufgaben, Notizen,
 * Signal-Rückmeldungen und Testergebnissen (ON DELETE CASCADE). Das Audit-Log bleibt (insert-only).
 */
export async function deleteTestTickets(actor: string, run: string | null): Promise<number> {
  if (run !== null && !RUN_RE.test(run)) throw new Error("Unbekannter Lauf");
  const n = await sql.begin(async (tx) => {
    const ids = (await tx`select id from ticket.tickets where is_test ${run ? tx`and test_run = ${run}` : tx``} for update`).map((r) => Number(r.id));
    if (ids.length) {
      // Verweise „zusammengeführt in“ auf zu löschende Tickets lösen (sonst blockiert der Fremdschlüssel)
      await tx`update ticket.tickets set merged_into = null where merged_into = any(${ids}::bigint[]) and not (id = any(${ids}::bigint[]))`;
      await tx`delete from ticket.tickets where id = any(${ids}::bigint[]) and is_test`;
    }
    await tx`delete from ticket.test_results where ${run ? tx`test_run = ${run}` : tx`true`}`;
    await tx`delete from ticket.test_runs where ${run ? tx`run = ${run}` : tx`true`}`;
    return ids.length;
  });
  await audit(actor, "ticket", { event: "testtickets_geloescht", run: run ?? "alle", tickets: n });
  return n;
}
