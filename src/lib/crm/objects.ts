import "server-only";
import { sql } from "../db";
import { matchObjects, type CrmObject, type ObjectMatch } from "./match";

// Objekte für die Erkennung im Mailtext (einige Tausend Zeilen) im Speicher. Jede Instanz prüft per kurzer Abfrage,
// ob seit dem Laden ein Abgleich lief (Stand + Anzahl) – so bleibt keine Serverless-Instanz auf altem Stand.
let cache: { version: string; rows: CrmObject[] } | null = null;

export function invalidateObjectCache() { cache = null; }

async function matchable(): Promise<CrmObject[]> {
  const [v] = await sql`select coalesce(max(synced_at)::text, '') || ':' || count(*) as version from ticket.crm_objects where active`;
  if (cache && cache.version === v.version) return cache.rows;
  const rows = await sql<CrmObject[]>`select object_id, title, street, zip, match_key, am_email, am_name, live from ticket.crm_objects where active`;
  cache = { version: String(v.version), rows: [...rows] };
  return cache.rows;
}

/** Erkennt das Objekt (moovin-ID oder Adresse) in Betreff und Text einer Mail – inkl. zitierter Originalmail. */
export async function recognizeObject(text: string): Promise<ObjectMatch> {
  return matchObjects(text.slice(0, 60_000), await matchable());
}

export async function crmObject(objectId: string) {
  const [o] = await sql`select * from ticket.crm_objects where object_id = ${objectId}`;
  return o ?? null;
}
