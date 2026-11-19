// ATTRAPPE der moovin Ticket-API (nur Prototyp). Implementiert docs/moovin-api.openapi.yaml
// inkl. HMAC-Prüfung, Subject-Bindung, Idempotenz und Datensparsamkeit – damit Guido sieht, wie es sich verhalten soll.
import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { env } from "@/lib/env";
import { parseKeyList, verifySignature } from "@/lib/hmac";

export const dynamic = "force-dynamic";

const OPEN_APPT = ["eingeladen", "bestaetigt"];

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
  if (res0 === "applications" && res2 === "notes" && (typeof b.text !== "string" || !b.text || b.text.length > 4000)) return "text: 1 bis 4000 Zeichen";
  if (res0 === "appointments" && res2 === "reply") {
    if (!["zusage", "absage", "verschieben"].includes(b.answer)) return "answer muss zusage, absage oder verschieben sein";
    if (b.answer === "verschieben" && (typeof b.comment !== "string" || !b.comment)) return "comment (Wunsch) fehlt";
    if (b.comment !== undefined && (typeof b.comment !== "string" || b.comment.length > 500)) return "comment: höchstens 500 Zeichen";
  }
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
        // Datensparsam: nur aktuelle Bewerbungen (≤ 180 Tage; abgeschlossene nur bis 30 Tage danach), nur nötige Felder
        const apps = await sql`
          select a.*, o.title as object_title, o.am_email from mock_moovin.applications a
          join mock_moovin.objects o on o.id = a.object_id
          where a.applicant_id = ${applicant.id} and a.created_at > now() - interval '180 days'
            and (a.status not in ('absage','zurueckgezogen') or a.created_at > now() - interval '30 days')
          order by a.created_at desc`;
        const appts = await sql`select * from mock_moovin.appointments where application_id = any(${apps.map((a) => a.id)}) order by starts_at desc`;
        result = {
          status: 200,
          data: {
            applicant: { id: applicant.id, salutation: applicant.salutation || null, last_name: applicant.last_name, language: applicant.preferred_language },
            applications: apps.map((a) => {
              const appt = appts.find((x) => x.application_id === a.id);
              return {
                id: a.id, listing_id: a.object_id, object_title: a.object_title, status: a.status,
                missing_documents: a.missing_documents, account_manager_email: a.am_email,
                appointment: appt ? { id: appt.id, starts_at: new Date(appt.starts_at).toISOString(), ends_at: appt.ends_at ? new Date(appt.ends_at).toISOString() : null, status: appt.status, meeting_point: appt.meeting_point } : null,
              };
            }),
          },
        };
      }
    } else if (req.method === "GET" && res0 === "listings" && res1 && !res2) {
      // Nur öffentliche Inseratsdaten, nur für Inserate, auf die sich der Absender beworben hat
      const o = (await sql`select o.* from mock_moovin.objects o where o.id = ${res1}
                  and exists (select 1 from mock_moovin.applications a join mock_moovin.applicants p on p.id = a.applicant_id
                              where a.object_id = o.id and p.email = ${subject})`)[0];
      if (!o) result = { status: 404, data: { error: "unbekannt" } };
      else result = { status: 200, data: {
        id: o.id, title: o.title, address: o.address, rooms: Number(o.rooms), size_sqm: Number(o.size_sqm),
        rent_cold_eur: Number(o.rent_cold_eur), rent_warm_eur: Number(o.rent_warm_eur), available_from: o.available_from,
        pets: o.pets, parking: o.parking, wbs_required: o.wbs_required, viewing_info: o.viewing_info, listing_url: o.listing_url,
      } };
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
      } else if (res0 === "applications" && res1 && res2 === "notes") {
        if (!(await owns("applications", res1))) result = { status: 404, data: { error: "unbekannt" } };
        else {
          await sql`insert into mock_moovin.notes (application_id, text, source_ticket) values (${res1}, ${String(b.text ?? "").slice(0, 4000)}, ${b.source_ticket_id})`;
          result = { status: 201, data: { ok: true } };
        }
      } else if (res0 === "appointments" && res1 && res2 === "reply") {
        if (!(await owns("appointments", res1))) result = { status: 404, data: { error: "unbekannt" } };
        else {
          const ap = (await sql`select * from mock_moovin.appointments where id = ${res1}`)[0];
          if (!OPEN_APPT.includes(ap.status) || new Date(ap.starts_at) < new Date()) result = { status: 409, data: { error: `Termin ist ${ap.status === "abgesagt" ? "abgesagt" : "nicht mehr offen"}`, status: ap.status } };
          else if (b.answer === "zusage") {
            await sql`update mock_moovin.appointments set status = 'bestaetigt' where id = ${res1}`;
            result = { status: 200, data: { status: "bestaetigt" } };
          } else if (b.answer === "absage") {
            await sql`update mock_moovin.appointments set status = 'abgesagt' where id = ${res1}`;
            result = { status: 200, data: { status: "abgesagt" } };
          } else {
            await sql`insert into mock_moovin.reschedule_requests (appointment_id, wish, source_ticket) values (${res1}, ${String(b.comment)}, ${b.source_ticket_id})`;
            result = { status: 200, data: { status: ap.status, wish_recorded: true } };
          }
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
