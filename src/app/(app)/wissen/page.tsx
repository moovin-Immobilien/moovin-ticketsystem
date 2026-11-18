import Link from "next/link";
import { sql } from "@/lib/db";
import { requireAgent } from "@/lib/auth";
import { fmtDateTime } from "@/components/ui";
import { saveArticle, deleteArticle } from "./actions";

export default async function WissenPage(props: PageProps<"/wissen">) {
  const agent = await requireAgent();
  const sp = await props.searchParams;
  const editId = typeof sp.edit === "string" ? Number(sp.edit) : null;
  const q = typeof sp.q === "string" ? sp.q : "";
  const articles = await sql`
    select * from ticket.knowledge_articles
    where ${q ? sql`(title ilike ${"%" + q + "%"} or body ilike ${"%" + q + "%"} or ${q.toLowerCase()} = any(tags))` : sql`true`}
    order by scope, object_id nulls first, title`;
  const objects = await sql`select distinct object_id, object_title from ticket.tickets where object_id is not null
                            union select distinct object_id, null from ticket.knowledge_articles where object_id is not null order by 1`;
  const objMap = new Map<string, string>();
  for (const o of objects) if (!objMap.has(o.object_id) || o.object_title) objMap.set(o.object_id, o.object_title ?? o.object_id);
  const edit = editId ? articles.find((a) => Number(a.id) === editId) : null;
  const isAdmin = agent.role === "admin";

  return (
    <div className="grid lg:grid-cols-[1fr_400px] gap-5">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-navy">Wissensdatenbank</h1>
          <form action="/wissen"><input name="q" defaultValue={q} placeholder="Suchen …" className="input w-56" /></form>
        </div>
        <p className="text-sm text-muted">Claude nutzt nur aktive Artikel. Objektdaten (Miete, Größe, Haustiere, Treffpunkt …) kommen live aus moovin – hier stehen nur Ergänzungen der AMs und die allgemeine FAQ.</p>
        {articles.map((a) => (
          <article key={a.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className={`badge ${a.scope === "global" ? "bg-navy/5 text-navy" : "bg-pink-50 text-pink"}`}>{a.scope === "global" ? "Allgemein" : objMap.get(a.object_id) ?? a.object_id}</span>
                  {a.status === "entwurf" && <span className="badge bg-amber-50 text-amber-700">Entwurf</span>}
                </div>
                <h3 className="font-medium text-ink">{a.title}</h3>
              </div>
              {(isAdmin || a.scope === "objekt") && (
                <div className="flex gap-2 text-xs">
                  <Link href={`/wissen?edit=${a.id}`} className="text-navy hover:underline">Bearbeiten</Link>
                  <form action={deleteArticle.bind(null, Number(a.id))}><button className="text-muted hover:text-pink">Löschen</button></form>
                </div>
              )}
            </div>
            <p className="text-sm text-ink/90 mt-2 whitespace-pre-wrap">{a.body}</p>
            <div className="text-xs text-muted mt-2">{a.tags.length ? `#${a.tags.join(" #")} · ` : ""}{a.updated_by} · {fmtDateTime(a.updated_at)}</div>
          </article>
        ))}
      </section>
      <aside className="card p-5 h-fit sticky top-4">
        <h2 className="font-semibold text-navy mb-3">{edit ? "Artikel bearbeiten" : "Neuer Artikel"}</h2>
        <form action={saveArticle} className="space-y-3" key={edit?.id ?? "new"}>
          {edit && <input type="hidden" name="id" value={edit.id} />}
          <div>
            <label className="label">Geltung</label>
            <select name="scope" defaultValue={edit?.scope ?? (isAdmin ? "global" : "objekt")} className="input">
              {isAdmin && <option value="global">Allgemein (alle Objekte)</option>}
              <option value="objekt">Ergänzung zu einem Objekt</option>
            </select>
          </div>
          <div>
            <label className="label">Objekt-ID (bei Objekt-Ergänzung)</label>
            <input name="object_id" list="objs" defaultValue={edit?.object_id ?? ""} className="input" placeholder="z. B. OBJ-B-002" />
            <datalist id="objs">{[...objMap.entries()].map(([id, t]) => <option key={id} value={id}>{t}</option>)}</datalist>
          </div>
          <div><label className="label">Titel</label><input name="title" defaultValue={edit?.title ?? ""} className="input" required /></div>
          <div><label className="label">Text</label><textarea name="body" defaultValue={edit?.body ?? ""} className="input min-h-40" required /></div>
          <div><label className="label">Stichworte (Komma-getrennt)</label><input name="tags" defaultValue={edit?.tags?.join(", ") ?? ""} className="input" /></div>
          <div>
            <label className="label">Status</label>
            <select name="status" defaultValue={edit?.status ?? "aktiv"} className="input"><option value="aktiv">Aktiv (Claude nutzt ihn)</option><option value="entwurf">Entwurf</option></select>
          </div>
          <div className="flex gap-2">
            <button className="btn-primary">Speichern</button>
            {edit && <Link href="/wissen" className="btn-ghost">Abbrechen</Link>}
          </div>
        </form>
      </aside>
    </div>
  );
}
