-- Testbatterie: Testtickets kennzeichnen (Mail-Sperre, ausgeblendet für AMs, nicht in Kennzahlen), Laufkennung je Ticket
-- und Ergebnis je Testfall (Soll/Ist-Bericht). Nur additive Änderungen.

-- Testticket: wird beim Anlegen gesetzt (vor der KI-Analyse); Folgemails im selben Thread erben es über das Ticket.
-- Für Testtickets geht nie eine Mail raus (deliver), kein Auto-Versand, keine Schreibaufrufe an moovin.
alter table ticket.tickets add column if not exists is_test  boolean not null default false;
-- Laufkennung der Testbatterie (z. B. 20261126-153012), damit Berichte und Löschen je Lauf möglich sind
alter table ticket.tickets add column if not exists test_run text;
create index if not exists tickets_is_test_idx on ticket.tickets (is_test);
create index if not exists tickets_test_run_idx on ticket.tickets (test_run) where test_run is not null;

-- Ergebnis je Testfall: Stand des Tickets direkt nach der Verarbeitung dieses Falls (Folgemails überschreiben das Ticket,
-- nicht den Stand des Vorgängers). Wird mit dem Ticket gelöscht.
create table if not exists ticket.test_results (
  id           bigserial primary key,
  test_run     text not null,
  case_key     text not null,
  ticket_id    bigint references ticket.tickets(id) on delete cascade,
  object_id    text,                       -- eingesetztes CRM-Objekt (Platzhalter)
  expected     jsonb not null default '{}'::jsonb,
  actual       jsonb,
  error        text,
  duration_ms  integer,
  actor        text not null,
  created_at   timestamptz not null default now(),
  unique (test_run, case_key)
);
create index if not exists test_results_run_idx on ticket.test_results (test_run);
