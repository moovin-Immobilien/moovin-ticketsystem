-- Objekt → AM aus dem CRM (Zoho, Modul Abschlüsse, Pipeline Vermietung; täglich nur lesend abgeglichen),
-- Objekt-Erkennung im Mailtext und Schalter „moovin-Anbindung an/aus“. Nur additive Änderungen.

-- Objekte mit zuständigem AM (Spiegel aus dem CRM, nie zurückgeschrieben)
create table if not exists ticket.crm_objects (
  object_id          text primary key,          -- moovin-ID (MV-ABC123), sonst CRM-<Abschluss-ID>
  crm_id             text unique,
  title              text,                      -- „Straße Nr, PLZ Ort“
  street             text,
  zip                text,
  city               text,
  match_key          text,                      -- normalisierte „Straße Hausnummer“ für die Erkennung im Mailtext
  customer           text,                      -- Kunde (Auftraggeber) laut CRM
  customer_object_id text,
  stage              text,
  live               boolean not null default false,  -- in Vermarktung (hat Vorrang bei Mehrdeutigkeit)
  am_name            text,                      -- „Zuständiger Account Manager“ im CRM
  am_email           text check (am_email is null or am_email = lower(am_email)),
  active             boolean not null default true,   -- im letzten Abgleich enthalten
  source             text not null default 'zoho' check (source in ('zoho','manuell')),
  synced_at          timestamptz not null default now()
);
create index if not exists crm_objects_key_idx on ticket.crm_objects (match_key) where active;
create index if not exists crm_objects_am_idx on ticket.crm_objects (am_email) where active;

-- Einstellungen (z. B. moovin-Anbindung an/aus, Stand des CRM-Abgleichs)
create table if not exists ticket.settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

-- Woher die Zuordnung eines Tickets stammt und warum es ggf. im Allgemeinen Eingang liegt
alter table ticket.tickets add column if not exists routing_source text;   -- moovin | crm_id | crm_adresse | manuell
alter table ticket.tickets add column if not exists routing_note   text;
