// Führt db/migrations/*.sql (und mit --seed db/seed/*.sql) in Reihenfolge aus.
// Nutzung: DATABASE_URL=... npx tsx scripts/migrate.ts [--seed] [--reset]
import postgres from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL fehlt");
const sql = postgres(url, { prepare: false, max: 1, ssl: /@(localhost|127\.0\.0\.1)[:\/]/.test(url) ? false : "require", onnotice: () => {} });
const args = process.argv.slice(2);

async function run() {
  if (args.includes("--reset")) {
    await sql.unsafe("drop schema if exists ticket cascade; drop schema if exists mock_moovin cascade; drop table if exists public.schema_migrations;");
    console.log("Reset: Schemas gelöscht");
  }
  await sql`create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz default now())`;
  const dirs = ["db/migrations", ...(args.includes("--seed") ? ["db/seed"] : [])];
  for (const dir of dirs) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const name = `${dir}/${f}`;
      const done = await sql`select 1 from public.schema_migrations where name = ${name}`;
      if (done.length) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(join(dir, f), "utf8"));
        await tx`insert into public.schema_migrations (name) values (${name})`;
      });
      console.log("✔", name);
    }
  }
  await sql.end();
}
run().catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
