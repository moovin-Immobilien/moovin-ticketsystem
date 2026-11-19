-- Datenschutzanfragen (Löschung/Auskunft), die an mieter@ gehen, werden intern an datenschutz@moovin.de weitergeleitet,
-- statt den Absender erneut schreiben zu lassen (eine Anfrage an mieter@ gilt bereits als gestellt).
alter table ticket.actions drop constraint if exists actions_type_check;
alter table ticket.actions add constraint actions_type_check
  check (type in ('dokumente_ablegen','termin_bestaetigen','termin_absagen','termin_verschieben_wunsch','interesse_setzen','notiz','datenschutz_weiterleiten'));
