-- Neue Anliegen aus dem Test mit echten Desk-Mails: rund ein Drittel der Mails braucht keine moovin-Daten
-- (allgemeine Wohnungssuche, Konto/Datenschutz, Technik/Login). Start im Entwurfsmodus.
insert into ticket.intent_settings (intent, label, mode, threshold, locked) values
  ('wohnungssuche_allgemein', 'Allgemeine Wohnungssuche',   'entwurf', 0.85, false),
  ('konto_datenschutz',       'Konto / Daten löschen',      'entwurf', 0.85, false),
  ('technik_login',           'Technik / Login / Profil',   'entwurf', 0.85, false)
on conflict (intent) do nothing;
