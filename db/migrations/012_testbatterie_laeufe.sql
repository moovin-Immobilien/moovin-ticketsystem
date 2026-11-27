-- Testbatterie: Plan je Lauf serverseitig speichern, damit ein abgebrochener Lauf (Seite verlassen, Verbindung weg)
-- mit denselben Objekten fortgesetzt werden kann („Fehlende Fälle nachladen“). Nur additiv.
create table if not exists ticket.test_runs (
  run         text primary key,            -- Laufkennung, z. B. 20261127-063240
  plan        jsonb not null,              -- [{ key, objectId, objectTitle, folgtAuf }]
  created_by  text not null,
  created_at  timestamptz not null default now()
);
