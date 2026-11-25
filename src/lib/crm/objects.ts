import "server-only";
import { sql } from "../db";
import { matchObjects, type CrmObject, type ObjectMatch } from "./match";

// Objekte für die Erkennung im Mailtext (einige Tausend Zeilen) – kurz im Speicher, nach dem Abgleich verworfen
let cache: { at: number; rows: CrmObject[] } | null = null;
const TTL_MS = 5 * 60_000;

export function invalidateObjectCache() { cache = null; }

async function matchable(): Promise<CrmObject[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  const rows = await sql<CrmObject[]>`select object_id, title, street, zip, match_key, am_email, am_name, live from ticket.crm_objects where active`;
  cache = { at: Date.now(), rows: [...rows] };
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
