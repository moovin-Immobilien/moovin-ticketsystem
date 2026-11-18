import "server-only";
import { sql } from "./db";

export type KnowledgeHit = { id: number; scope: string; object_id: string | null; title: string; body: string };

/** Volltextsuche (deutsch) über aktive Artikel: global + Objekte, auf die der Absender sich beworben hat. */
export async function searchKnowledge(query: string, objectIds: string[], limit = 5): Promise<KnowledgeHit[]> {
  const q = query.trim().slice(0, 300);
  const rows = await sql<KnowledgeHit[]>`
    select id, scope, object_id, title, body,
           ts_rank(tsv, websearch_to_tsquery('german', ${q})) as rank
    from ticket.knowledge_articles
    where status = 'aktiv'
      and (scope = 'global' or object_id = any(${objectIds}))
      and (tsv @@ websearch_to_tsquery('german', ${q})
           or tsv @@ to_tsquery('german', ${orQuery(q)}))
    order by rank desc, scope desc
    limit ${limit}`;
  return rows;
}

function orQuery(q: string): string {
  const words = q.toLowerCase().replace(/[^a-zäöüß0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 12);
  return words.length ? words.map((w) => `${w}:*`).join(" | ") : "xxxxxx";
}
