-- Paket „Arbeitsbereiche“: Google-Login, Allgemeiner Eingang, Mein Bereich (Aufgaben, Wartet), interne Notizen,
-- Bearbeitungssperre, Zusammenführen, Abwesenheit, Brevo. Nur additive Änderungen an bestehenden Tabellen.

-- Mitarbeitende: Google-Login, Freischaltung, Abwesenheit mit Vertretung
alter table ticket.agents add column if not exists google_sub     text unique;
alter table ticket.agents add column if not exists last_login_at  timestamptz;
alter table ticket.agents add column if not exists requested_at   timestamptz;   -- Erstanmeldung ohne Freischaltung
alter table ticket.agents add column if not exists approved_at    timestamptz;
alter table ticket.agents add column if not exists approved_by    text;
alter table ticket.agents add column if not exists absent_from    date;
alter table ticket.agents add column if not exists absent_until   date;
alter table ticket.agents add column if not exists deputy_email   text references ticket.agents(email) on update cascade on delete set null;
alter table ticket.agents drop constraint if exists agents_absence_check;
alter table ticket.agents add constraint agents_absence_check
  check ((absent_from is null and absent_until is null) or (absent_from is not null and absent_until is not null and absent_until >= absent_from));
alter table ticket.agents drop constraint if exists agents_deputy_check;
alter table ticket.agents add constraint agents_deputy_check check (deputy_email is null or deputy_email <> email);
-- bestehende aktive Agents gelten als freigeschaltet
update ticket.agents set approved_at = coalesce(approved_at, created_at), approved_by = coalesce(approved_by, 'migration') where active;

-- Tickets: Warten auf Bewerber, Gegenlesen von Auto-Antworten, Zusammenführen, Vertretung
alter table ticket.tickets add column if not exists waiting_since        timestamptz;
alter table ticket.tickets add column if not exists waiting_reminded_at  timestamptz;
alter table ticket.tickets add column if not exists reviewed_at          timestamptz;
alter table ticket.tickets add column if not exists reviewed_by          text;
alter table ticket.tickets add column if not exists merged_into          bigint references ticket.tickets(id);
alter table ticket.tickets add column if not exists deputy_for           text;   -- AM, den der aktuelle Bearbeiter vertritt
alter table ticket.tickets add column if not exists reopened_at          timestamptz;
create index if not exists tickets_waiting_idx on ticket.tickets (waiting_since) where status = 'wartet';
create index if not exists tickets_object_idx on ticket.tickets (object_id);
create index if not exists tickets_search_idx on ticket.tickets using gin (
  to_tsvector('simple', coalesce(sender_name,'') || ' ' || sender_email || ' ' || coalesce(object_title,'') || ' ' || coalesce(object_id,'') || ' ' || coalesce(subject,'')));

-- Nachrichten: Message-ID des Versanddienstes (Brevo vergibt eigene; Antworten verweisen darauf)
alter table ticket.messages add column if not exists provider_message_id text;
create index if not exists messages_provider_id_idx on ticket.messages (provider_message_id) where provider_message_id is not null;
create index if not exists messages_mail_id_out_idx on ticket.messages (mail_message_id) where direction = 'out';

-- Aufgaben für den AM (was in moovin zu tun ist)
create table if not exists ticket.tasks (
  id             bigserial primary key,
  ticket_id      bigint not null references ticket.tickets(id) on delete cascade,
  action_id      bigint unique references ticket.actions(id) on delete set null,
  assignee_email text references ticket.agents(email) on update cascade on delete set null,
  type           text not null check (type in ('verschiebewunsch','rueckzug','interesse','notiz','nachfassen','manuell')),
  text           text not null,
  status         text not null default 'offen' check (status in ('offen','erledigt')),
  due_at         timestamptz,
  created_by     text not null default 'system',
  created_at     timestamptz not null default now(),
  done_by        text,
  done_at        timestamptz
);
create index if not exists tasks_assignee_idx on ticket.tasks (assignee_email, status);
create index if not exists tasks_ticket_idx on ticket.tasks (ticket_id);

-- Interne Notizen und Weitergaben (nie an Bewerber, nie an moovin, nie an die KI)
create table if not exists ticket.notes (
  id            bigserial primary key,
  ticket_id     bigint not null references ticket.tickets(id) on delete cascade,
  author_email  text not null,
  kind          text not null default 'notiz' check (kind in ('notiz','weitergabe','system')),
  target_email  text,
  text          text not null,
  created_at    timestamptz not null default now()
);
create index if not exists notes_ticket_idx on ticket.notes (ticket_id, created_at);

-- Wer hat das Ticket gerade offen (Bearbeitungssperre, nur Anzeige)
create table if not exists ticket.presence (
  ticket_id    bigint not null references ticket.tickets(id) on delete cascade,
  agent_email  text not null references ticket.agents(email) on update cascade on delete cascade,
  seen_at      timestamptz not null default now(),
  primary key (ticket_id, agent_email)
);

-- Kurzlebiger Zustand für den Google-Login (state/nonce/PKCE) – serverseitig statt nur im Cookie
create table if not exists ticket.oauth_states (
  state          text primary key,
  nonce          text not null,
  code_verifier  text not null,
  next_path      text not null default '/mein',
  created_at     timestamptz not null default now()
);
