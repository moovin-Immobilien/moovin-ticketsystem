-- Feedback-Paket 2 (D.10): Spam und Systemmails werden automatisch geschlossen.
alter table ticket.tickets add column if not exists auto_closed boolean not null default false;
create index if not exists tickets_auto_closed_idx on ticket.tickets (auto_closed) where auto_closed;

-- Feedback-Paket 2 (D.4): Antworten an Bewerber können Kopien tragen (Datenschutzteam bei konto_datenschutz).
alter table ticket.messages add column if not exists cc_email text;
