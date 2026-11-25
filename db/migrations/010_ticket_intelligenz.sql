-- Ticket-Intelligenz: Signale (Abschluss-Chance, zeitkritisch, kein Handlungsbedarf), Stufe 1–4 je Ticket und Aufgabe,
-- Rückmeldung „Markierung passt nicht“. Priorisiert wird der Vorgang, nie die Person. Nur additive Änderungen.

-- Stufe: 1 Abschluss-Chance · 2 zeitkritisch · 3 normal · 4 kein Handlungsbedarf (setzt der Server, nie das Modell)
alter table ticket.tickets add column if not exists priority smallint not null default 3;
alter table ticket.tickets drop constraint if exists tickets_priority_check;
alter table ticket.tickets add constraint tickets_priority_check check (priority between 1 and 4);
-- Signale mit Beleg: [{type, stage, confirmed, basis: daten|mail, why, evidence, deadline, at}]
alter table ticket.tickets add column if not exists signals jsonb not null default '[]'::jsonb;
-- Messung: wann wurde das Ticket zur Abschluss-Chance, wann beantwortet, wann Zusage in moovin
alter table ticket.tickets add column if not exists chance_at          timestamptz;
alter table ticket.tickets add column if not exists chance_answered_at timestamptz;
alter table ticket.tickets add column if not exists chance_won_at      timestamptz;
create index if not exists tickets_queue_idx on ticket.tickets (assignee_email, status, priority, due_at);

alter table ticket.tasks add column if not exists priority smallint not null default 3;
alter table ticket.tasks drop constraint if exists tasks_priority_check;
alter table ticket.tasks add constraint tasks_priority_check check (priority between 1 and 4);
alter table ticket.tasks drop constraint if exists tasks_type_check;
alter table ticket.tasks add constraint tasks_type_check check (type in
  ('verschiebewunsch','rueckzug','interesse','notiz','nachfassen','manuell','unterlagen_pruefen','slot_nachbesetzen','kandidat_aktivieren'));
create index if not exists tasks_queue_idx on ticket.tasks (assignee_email, status, priority, due_at);

-- „Markierung passt nicht“: Rückmeldung je Signal → Trefferquote auf der Autonomie-Seite
create table if not exists ticket.signal_feedback (
  id           bigserial primary key,
  ticket_id    bigint not null references ticket.tickets(id) on delete cascade,
  signal       text not null,
  agent_email  text not null,
  created_at   timestamptz not null default now()
);
create index if not exists signal_feedback_signal_idx on ticket.signal_feedback (signal, created_at);
create unique index if not exists signal_feedback_once_idx on ticket.signal_feedback (ticket_id, signal);
