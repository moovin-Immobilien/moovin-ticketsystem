-- Aus Zoho-Desk-Auswertung: ~30 % der Mails sind Antworten auf Termin-Einladungen ("Rückmeldung erforderlich").
alter table ticket.actions drop constraint if exists actions_type_check;
alter table ticket.actions add constraint actions_type_check
  check (type in ('dokumente_ablegen','termin_bestaetigen','termin_absagen','termin_verschieben_wunsch','interesse_setzen','notiz'));
insert into ticket.intent_settings (intent, label, mode, threshold, locked) values
  ('termin_bestaetigen', 'Termin bestätigen', 'entwurf', 0.85, false),
  ('intern_system', 'System-/interne Mail', 'entwurf', 0.99, true)
on conflict (intent) do nothing;
