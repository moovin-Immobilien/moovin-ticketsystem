-- ATTRAPPE der moovin-Seite – nur für den Prototyp.
-- Simuliert, was app.moovin.de über die Ticket-API liefert. In Produktion entfällt dieses Schema;
-- die echte API (Guido) ersetzt /api/mock-moovin/v1.

create schema if not exists mock_moovin;

create table mock_moovin.objects (
  id               text primary key,
  title            text not null,
  address          text not null,
  district         text,
  city             text,
  rooms            numeric,
  size_sqm         numeric,
  rent_cold_eur    numeric,
  rent_warm_eur    numeric,
  available_from   date,
  pets             text,
  parking          text,
  wbs_required     boolean default false,
  viewing_info     text,
  application_info text,
  listing_url      text,
  am_name          text,
  am_email         text
);

create table mock_moovin.applicants (
  id                 text primary key,
  email              text not null unique check (email = lower(email)),
  salutation         text default '',
  first_name         text not null,
  last_name          text not null,
  preferred_language text default 'de'
);

create table mock_moovin.applications (
  id                text primary key,
  applicant_id      text not null references mock_moovin.applicants(id),
  object_id         text not null references mock_moovin.objects(id),
  status            text not null,
  missing_documents text[] not null default '{}',
  interest          text,
  created_at        timestamptz not null default now()
);

create table mock_moovin.appointments (
  id             text primary key,
  application_id text not null references mock_moovin.applications(id),
  starts_at      timestamptz not null,
  ends_at        timestamptz,
  kind           text not null default 'sammelbesichtigung',
  status         text not null default 'bestaetigt',
  meeting_point  text
);

create table mock_moovin.documents (
  id             bigserial primary key,
  application_id text not null references mock_moovin.applications(id),
  filename       text not null,
  content_type   text,
  size_bytes     integer,
  status         text not null default 'neu_unsortiert',
  source_ticket  text,
  created_at     timestamptz not null default now()
);

create table mock_moovin.notes (
  id             bigserial primary key,
  application_id text not null references mock_moovin.applications(id),
  text           text not null,
  source_ticket  text,
  created_at     timestamptz not null default now()
);

create table mock_moovin.reschedule_requests (
  id             bigserial primary key,
  appointment_id text not null references mock_moovin.appointments(id),
  wish           text not null,
  source_ticket  text,
  created_at     timestamptz not null default now()
);

create table mock_moovin.idempotency (
  key         text primary key,
  response    jsonb not null,
  status_code integer not null,
  created_at  timestamptz not null default now()
);

create table mock_moovin.request_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  key_id      text,
  method      text,
  path        text,
  subject     text,
  status_code integer
);
