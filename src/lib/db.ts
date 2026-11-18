import "server-only";
import postgres from "postgres";
import { env } from "./env";

const g = globalThis as unknown as { __sql?: postgres.Sql };
const url = env.databaseUrl();
const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);

// prepare:false → kompatibel mit Supabase-Pooler (Transaction Mode); TLS außer lokal
export const sql: postgres.Sql =
  g.__sql ?? (g.__sql = postgres(url, { prepare: false, max: 5, idle_timeout: 20, ssl: local ? false : "require", onnotice: () => {} }));
