-- Option: Kopie von Mail und Antwort im Bewerber in moovin ablegen (POST /applicants/{id}/correspondence).
alter table ticket.messages add column if not exists copied_to_moovin_at timestamptz;

-- Attrappe
create table if not exists mock_moovin.correspondence (
  id              bigserial primary key,
  applicant_id    text not null references mock_moovin.applicants(id),
  application_id  text,
  source_ticket   text not null,
  ticket_url      text,
  direction       text not null check (direction in ('in','out')),
  sent_at         timestamptz,
  from_email      text,
  to_email        text,
  subject         text,
  body            text not null,
  attachments     text[] not null default '{}',
  sender_verified boolean,
  sent_by         text,
  created_at      timestamptz not null default now()
);
