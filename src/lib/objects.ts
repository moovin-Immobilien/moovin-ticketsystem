import "server-only";
import { sql } from "./db";

/** Bekannte Objekte (aus bisherigen Tickets und Objekt-Wissen) für die Zuordnung im Allgemeinen Eingang. */
export async function knownObjects(): Promise<{ object_id: string; object_title: string | null }[]> {
  return sql<{ object_id: string; object_title: string | null }[]>`
    select object_id, max(object_title) as object_title from (
      select object_id, object_title from ticket.tickets where object_id is not null
      union all
      select object_id, null from ticket.knowledge_articles where scope = 'objekt' and object_id is not null
    ) x group by object_id order by max(object_title) nulls last, object_id limit 500`;
}
