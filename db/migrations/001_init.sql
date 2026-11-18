-- moovin Ticketsystem – Datenmodell
-- Eigene Schemas (nicht "public"), damit Supabase sie NICHT über die REST-API (PostgREST) exponiert.
-- Zugriff ausschließlich serverseitig über die Postgres-Verbindung des Ticketsystems.

create schema if not exists ticket;

-- Mitarbeitende (AMs, Admins)
create table ticket.agents (
  id          bigserial primary key,
  email       text not null unique check (email = lower(email)),
  name        text not null,
  role        text not null default 'am' check (role in ('am','admin')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- Tickets
create table ticket.tickets (
  id                  bigserial primary key,
  status              text not null default 'neu'
                      check (status in ('neu','in_bearbeitung','entwurf','beantwortet','wartet','geschlossen')),
  sender_email        text not null check (sender_email = lower(sender_email)),
  sender_name         text,
  subject             text,
  applicant_id        text,               -- Referenz in moovin (keine Kopie der Bewerberdaten)
  applicant_known     boolean not null default false,
  reply_to_email      text,               -- hinterlegte Adresse aus moovin (Antworten NUR hierhin)
  object_id           text,
  object_title        text,
  application_id      text,
  assignee_email      text references ticket.agents(email) on update cascade,
  intent              text,
  language            text,
  confidence          numeric(4,3),
  summary             text,
  needs_human         boolean not null default true,
  needs_human_reason  text,
  sender_verified     boolean not null default false,
  auto_handled        boolean not null default false,
  due_at              timestamptz,
  first_response_at   timestamptz,
  last_inbound_at     timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index on ticket.tickets (status);
create index on ticket.tickets (assignee_email, status);
create index on ticket.tickets (sender_email);
create index on ticket.tickets (due_at) where status not in ('beantwortet','geschlossen');

-- Nachrichten (ein- und ausgehend)
create table ticket.messages (
  id               bigserial primary key,
  ticket_id        bigint not null references ticket.tickets(id) on delete cascade,
  direction        text not null check (direction in ('in','out')),
  from_email       text not null,
  from_name        text,
  to_email         text not null,
  subject          text,
  body_text        text not null default '',
  mail_message_id  text,               -- RFC 5322 Message-ID
  in_reply_to      text,
  references_hdr   text,
  auth_results     text,
  sender_verified  boolean,
  sent_by          text,               -- 'ki' | 'am:<email>' (nur bei out)
  delivery_status  text check (delivery_status in ('simuliert','gesendet','fehler')),
  created_at       timestamptz not null default now()
);
create index on ticket.messages (ticket_id, created_at);
create unique index on ticket.messages (mail_message_id) where mail_message_id is not null and direction = 'in';

-- Anhänge (werden NIE an Claude gegeben; nur weitergereicht)
create table ticket.attachments (
  id            bigserial primary key,
  message_id    bigint not null references ticket.messages(id) on delete cascade,
  filename      text not null,
  content_type  text not null,
  size_bytes    integer not null,
  content       bytea,
  forwarded_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- KI-Entwürfe
create table ticket.drafts (
  id            bigserial primary key,
  ticket_id     bigint not null references ticket.tickets(id) on delete cascade,
  in_message_id bigint references ticket.messages(id) on delete set null,
  model         text not null,
  body_text     text not null,
  analysis      jsonb not null default '{}',
  status        text not null default 'offen' check (status in ('offen','gesendet','verworfen','ersetzt')),
  final_text    text,
  similarity    numeric(4,3),            -- 1.0 = unverändert übernommen
  unchanged     boolean,
  usage         jsonb,
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index on ticket.drafts (ticket_id, created_at desc);

-- Aktionen in moovin
create table ticket.actions (
  id               bigserial primary key,
  ticket_id        bigint not null references ticket.tickets(id) on delete cascade,
  draft_id         bigint references ticket.drafts(id) on delete set null,
  type             text not null check (type in ('dokumente_ablegen','termin_absagen','termin_verschieben_wunsch','interesse_setzen','notiz')),
  payload          jsonb not null default '{}',
  label            text,
  status           text not null default 'vorgeschlagen' check (status in ('vorgeschlagen','ausgefuehrt','fehler','verworfen','blockiert')),
  blocked_reason   text,
  result           jsonb,
  idempotency_key  text unique,
  executed_by      text,
  executed_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index on ticket.actions (ticket_id);

-- Wissensdatenbank
create table ticket.knowledge_articles (
  id          bigserial primary key,
  scope       text not null default 'global' check (scope in ('global','objekt')),
  object_id   text,
  title       text not null,
  body        text not null,
  tags        text[] not null default '{}',
  status      text not null default 'aktiv' check (status in ('aktiv','entwurf')),
  source      text not null default 'manuell' check (source in ('manuell','antwort','moovin')),
  updated_by  text,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  tsv         tsvector,
  check (scope = 'global' or object_id is not null)
);
create index on ticket.knowledge_articles using gin (tsv);

create or replace function ticket.knowledge_tsv() returns trigger language plpgsql as $$
begin
  new.tsv :=
    setweight(to_tsvector('german', coalesce(new.title,'')), 'A') ||
    setweight(to_tsvector('german', array_to_string(new.tags,' ')), 'A') ||
    setweight(to_tsvector('german', coalesce(new.body,'')), 'B');
  return new;
end $$;
create trigger knowledge_tsv before insert or update on ticket.knowledge_articles
  for each row execute function ticket.knowledge_tsv();
create index on ticket.knowledge_articles (object_id);

-- Autonomie je Anliegen
create table ticket.intent_settings (
  intent      text primary key,
  label       text not null,
  mode        text not null default 'entwurf' check (mode in ('entwurf','auto')),
  threshold   numeric(3,2) not null default 0.85,
  locked      boolean not null default false,   -- true = nie Auto (z. B. Beschwerde)
  updated_by  text,
  updated_at  timestamptz not null default now(),
  check (not (locked and mode = 'auto'))
);

-- Audit-Log (insert-only)
create table ticket.audit_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor      text not null,        -- 'system' | 'ki' | 'am:<email>' | 'webhook'
  kind       text not null,        -- z. B. moovin_api, ki_call, action, login, mail_out
  ticket_id  bigint,
  detail     jsonb not null default '{}'
);
create index on ticket.audit_log (at desc);
create index on ticket.audit_log (ticket_id);

create or replace function ticket.audit_log_readonly() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log ist insert-only';
end $$;
create trigger audit_log_no_update before update or delete on ticket.audit_log
  for each row execute function ticket.audit_log_readonly();

-- Sessions (Prototyp-Login; Ziel: SSO über Google Workspace/M365)
create table ticket.sessions (
  id          text primary key,
  agent_email text not null references ticket.agents(email) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
