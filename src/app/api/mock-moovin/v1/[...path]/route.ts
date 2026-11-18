// ATTRAPPE der moovin Ticket-API (nur Prototyp). Implementiert docs/moovin-api.openapi.yaml
// inkl. HMAC-Prüfung, Subject-Bindung und Idempotenz – damit Guido sieht, wie es sich verhalten soll.
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";
import { parseKeyList, verifySignature } from "@/lib/hmac";

export const dynamic = "force-dynamic";

const STATUS: Record<string, { label: string; next: string }> = {
  eingegangen: { label: "Ihre Bewerbung ist eingegangen.", next: "Wir prüfen Ihre Unterlagen auf Vollständigkeit." },
  unvollstaendig: { label: "Ihre Bewerbung ist eingegangen, es fehlen noch Unterlagen.", next: "Bitte reichen Sie die fehlenden Unterlagen nach." },
  in_pruefung: { label: "Ihre Unterlagen werden geprüft.", next: "Wir melden uns, sobald die Prüfung abgeschlossen ist." },
  eingeladen: { label: "Sie sind zur Besichtigung eingeladen.", next: "Bitte nehmen Sie den Besichtigungstermin wahr oder sagen Sie rechtzeitig ab." },
  besichtigt: { label: "Sie haben die Wohnung besichtigt.", next: "Bitte bestätigen Sie Ihr Interesse, falls noch nicht geschehen. Danach stellen wir die Bewerbungen dem Eigentümer vor." },
  beim_eigentuemer: { label: "Ihre Bewerbung liegt dem Eigentümer zur Entscheidung vor.", next: "Wir melden uns, sobald eine Entscheidung vorliegt." },
  zusage: { label: "Sie haben eine Zusage erhalten.", next: "Ihr Ansprechpartner meldet sich wegen des Mietvertrags." },
  absage: { label: "Die Wohnung wurde leider anderweitig vergeben.", next: "Gerne können Sie sich auf weitere Angebote bewerben." },
  zurueckgezogen: { label: "Sie haben Ihre Bewerbung zurückgezogen.", next: "Es sind keine weiteren Schritte nötig." },
};

/** Eingabeprüfung laut OpenAPI-Vertrag. Liefert eine Fehlermeldung (→ 400) oder null. */
function validatePost(res0: string, res2: string | undefined, b: Record<string, any>): string | null {
  if (b.__invalid) return "Body ist kein gültiges JSON";
  if (typeof b.source_ticket_id !== "string" || !b.source_ticket_id) return "source_ticket_id fehlt";
  if (res0 === "applications" && res2 === "documents") {
    if (!Array.isArray(b.files) || b.files.length > 20) return "files: Array mit höchstens 20 Dateien erwartet";
    for (const f of b.files) {
      if (!f?.filename || !f?.content_type || typeof f?.content_base64 !== "string") return "Datei braucht filename, content_type, content_base64";
      if ((f.content_base64.length * 3) / 4 > 15 * 1024 * 1024) return `${f.filename}: größer als 15 MB`;
    }
  }
  if (res0 === "applications" && res2 === "interest" && !["interessiert", "zurueckgezogen"].includes(b.interest)) return "interest muss interessiert oder zurueckgezogen sein";
  if (res0 === "applications" && res2 === "notes" && (typeof b.text !== "string" || !b.text || b.text.length > 4000)) return "text: 1 bis 4000 Zeichen";
  if (res0 === "appointments" && res2 === "reschedule-request" && (typeof b.wish !== "string" || !b.wish)) return "wish fehlt";
  return null;
}

function json(status: number, data: unknown) {
  return NextResponse.json(data, { status });
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.text() : "";
  const subject = (req.headers.get("x-subject-email") ?? "").toLowerCase();
  const keyId = req.headers.get("x-moovin-key-id");

  const log = async (code: number) => {
    await sql`insert into mock_moovin.request_log (key_id, method, path, subject, status_code) values (${keyId}, ${req.method}, ${url.pathname}, ${subject}, ${code})`;
  };

  const v = verifySignature({
    keys: parseKeyList(env.mockMoovinKeys()),
    keyId,
    ts: req.headers.get("x-moovin-timestamp"),
    signature: req.headers.get("x-moovin-signature"),
    method: req.method,
    pathWithQuery: url.pathname + url.search,
    body,
  });
  if (!v.ok) { await log(401); return json(401, { error: v.reason }); }
  if (!subject) { await log(400); return json(400, { error: "X-Subject-Email fehlt" }); }

  // Idempotenz für Schreibzugriffe
  const idem = req.headers.get("idempotency-key");
  if (req.method === "POST") {
    if (!idem) { await log(400); return json(400, { error: "Idempotency-Key fehlt" }); }
    const prev = await sql`select response, status_code from mock_moovin.idempotency where key = ${idem}`;
    if (prev.length) { await log(prev[0].status_code); return json(prev[0].status_code, prev[0].response); }
  }

  const [res0, res1, res2] = path;
  let result: { status: number; data: unknown };

  try {
    const applicant = (await sql`select * from mock_moovin.applicants where email = ${subject}`)[0];
    const owns = async (table: "applications" | "appointments", id: string) => {
      if (!applicant) return false;
      if (table === "applications")
        return (await sql`select 1 from mock_moovin.applications where id = ${id} and applicant_id = ${applicant.id}`).length > 0;
      return (await sql`select 1 from mock_moovin.appointments ap join mock_moovin.applications a on a.id = ap.application_id
                        where ap.id = ${id} and a.applicant_id = ${applicant.id}`).length > 0;
    };

    if (req.method === "GET" && res0 === "applicants" && !res1) {
      const email = (url.searchParams.get("email") ?? "").toLowerCase();
      if (email !== subject) result = { status: 400, data: { error: "email ≠ X-Subject-Email" } };
      else if (!applicant) result = { status: 404, data: { error: "unbekannt" } };
      else {
        const apps = await sql`
          select a.*, o.title as object_title from mock_moovin.applications a
          join mock_moovin.objects o on o.id = a.object_id where a.applicant_id = ${applicant.id} order by a.created_at desc`;
        const appts = await sql`select * from mock_moovin.appointments where application_id = any(${apps.map((a) => a.id)})`;
        result = {
          status: 200,
          data: {
            applicant: { id: applicant.id, email: applicant.email, salutation: applicant.salutation, first_name: applicant.first_name, last_name: applicant.last_name, preferred_language: applicant.preferred_language },
            applications: apps.map((a) => {
              const appt = appts.find((x) => x.application_id === a.id);
              const s = STATUS[a.status] ?? { label: a.status, next: "" };
              return {
                id: a.id, object_id: a.object_id, object_title: a.object_title, status: a.status, status_label: s.label,
                missing_documents: a.missing_documents, next_step: s.next, created_at: a.created_at,
                appointment: appt ? { id: appt.id, starts_at: appt.starts_at, ends_at: appt.ends_at, kind: appt.kind, status: appt.status, meeting_point: appt.meeting_point } : null,
              };
            }),
          },
        };
      }
    } else if (req.method === "GET" && res0 === "objects" && res1 && !res2) {
      const o = (await sql`select o.* from mock_moovin.objects o where o.id = ${res1}
                  and exists (select 1 from mock_moovin.applications a join mock_moovin.applicants p on p.id = a.applicant_id
                              where a.object_id = o.id and p.email = ${subject})`)[0];
      if (!o) result = { status: 404, data: { error: "unbekannt" } };
      else {
        const { am_name, am_email, rooms, size_sqm, rent_cold_eur, rent_warm_eur, ...rest } = o;
        result = { status: 200, data: { ...rest, rooms: Number(rooms), size_sqm: Number(size_sqm), rent_cold_eur: Number(rent_cold_eur), rent_warm_eur: Number(rent_warm_eur), account_manager: { name: am_name, email: am_email } } };
      }
    } else if (req.method === "POST") {
      let b: Record<string, any> = {};
      try { b = body ? JSON.parse(body) : {}; } catch { b = { __invalid: true }; }
      const invalid = validatePost(res0, res2, b);
      if (invalid) result = { status: 400, data: { error: invalid } };
      else if (res0 === "applications" && res1 && res2 === "documents") {
        if (!(await owns("applications", res1))) result = { status: 404, data: { error: "unbekannt" } };
        else {
          for (const f of b.files ?? []) {
            const size = Math.floor(((f.content_base64 ?? "").length * 3) / 4);
            await sql`insert into mock_moovin.documents (application_id, filename, content_type, size_bytes, source_ticket) values (${res1}, ${f.filename}, ${f.content_type}, ${size}, ${b.source_ticket_id})`;
          }
          result = { status: 201, data: { stored: (b.files ?? []).length, status: "neu_unsortiert" } };
        }
      } else if (res0 === "applications" && res1 && res2 === "interest") {
        if (!(await owns("applications", res1))) result = { status: 404, data: { error: "unbekannt" } };
        else {
          await sql`update mock_moovin.applications set interest = ${b.interest},
                    status = case when ${b.interest} = 'zurueckgezogen' then 'zurueckgezogen' else status end where id = ${res1}`;
          if (b.interest === "zurueckgezogen")
            await sql`update mock_moovin.appointments set status = 'abgesagt' where application_id = ${res1} and starts_at > now()`;
          result = { status: 200, data: { interest: b.interest } };
        }
      } else if (res0 === "applications" && res1 && res2 === "notes") {
        if (!(await owns("applications", res1))) result = { status: 404, data: { error: "unbekannt" } };
        else {
          await sql`insert into mock_moovin.notes (application_id, text, source_ticket) values (${res1}, ${String(b.text ?? "").slice(0, 4000)}, ${b.source_ticket_id})`;
          result = { status: 201, data: { ok: true } };
        }
      } else if (res0 === "appointments" && res1 && res2 === "confirm") {
        if (!(await owns("appointments", res1))) result = { status: 404, data: { error: "unbekannt" } };
        else {
          const ap = (await sql`select * from mock_moovin.appointments where id = ${res1}`)[0];
          if (ap.status === "abgesagt" || new Date(ap.starts_at) < new Date()) result = { status: 409, data: { error: "Termin abgesagt oder vergangen" } };
          else {
            await sql`update mock_moovin.appointments set status = 'bestaetigt' where id = ${res1}`;
            result = { status: 200, data: { status: "bestaetigt" } };
          }
        }
      } else if (res0 === "appointments" && res1 && res2 === "cancel") {
        if (!(await owns("appointments", res1))) result = { status: 404, data: { error: "unbekannt" } };
        else {
          const ap = (await sql`select * from mock_moovin.appointments where id = ${res1}`)[0];
          if (ap.status === "abgesagt" || new Date(ap.starts_at) < new Date()) result = { status: 409, data: { error: "Termin bereits abgesagt oder vergangen" } };
          else {
            await sql`update mock_moovin.appointments set status = 'abgesagt' where id = ${res1}`;
            result = { status: 200, data: { status: "abgesagt", slot_freed: true } };
          }
        }
      } else if (res0 === "appointments" && res1 && res2 === "reschedule-request") {
        if (!(await owns("appointments", res1))) result = { status: 404, data: { error: "unbekannt" } };
        else {
          await sql`insert into mock_moovin.reschedule_requests (appointment_id, wish, source_ticket) values (${res1}, ${String(b.wish ?? "")}, ${b.source_ticket_id})`;
          result = { status: 201, data: { ok: true } };
        }
      } else result = { status: 404, data: { error: "Route unbekannt" } };
    } else result = { status: 404, data: { error: "Route unbekannt" } };
  } catch (e) {
    console.error(e);
    result = { status: 500, data: { error: "Interner Fehler" } };
  }

  if (req.method === "POST" && idem && result.status < 500)
    await sql`insert into mock_moovin.idempotency (key, response, status_code) values (${idem}, ${sql.json(result.data as never)}, ${result.status}) on conflict do nothing`;
  await log(result.status);
  return json(result.status, result.data);
}

export const GET = handle;
export const POST = handle;
