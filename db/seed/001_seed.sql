-- Testdaten (fiktiv). Personen, Adressen und Objekte sind erfunden.

-- Mitarbeitende
insert into ticket.agents (email, name, role) values
  ('mellin@moovin.de', 'Fabian Mellin', 'admin'),
  ('lena.hoffmann@moovin.de', 'Lena Hoffmann (Test-AM)', 'am'),
  ('jonas.weber@moovin.de', 'Jonas Weber (Test-AM)', 'am')
on conflict (email) do nothing;

-- Autonomie je Anliegen
insert into ticket.intent_settings (intent, label, mode, threshold, locked) values
  ('bewerbungsstatus',       'Stand der Bewerbung',          'entwurf', 0.85, false),
  ('unterlagen_nachreichen', 'Unterlagen nachreichen',       'entwurf', 0.85, false),
  ('termin_absage',          'Termin absagen',               'entwurf', 0.85, false),
  ('termin_verschieben',     'Termin verschieben',           'entwurf', 0.85, false),
  ('besichtigung_frage',     'Frage zur Besichtigung',       'entwurf', 0.85, false),
  ('objekt_frage',           'Frage zum Objekt',             'entwurf', 0.85, false),
  ('interesse_bestaetigen',  'Interesse bestätigen',         'entwurf', 0.85, false),
  ('rueckzug',               'Bewerbung zurückziehen',       'entwurf', 0.85, false),
  ('beschwerde',             'Beschwerde',                   'entwurf', 0.99, true),
  ('nicht_zustaendig',       'Nicht zuständig (z. B. Bestandsmieter)', 'entwurf', 0.99, true),
  ('sonstiges',              'Sonstiges',                    'entwurf', 0.99, true),
  ('spam',                   'Spam / Werbung',               'entwurf', 0.99, true)
on conflict (intent) do nothing;

-- Wissensdatenbank – allgemein
insert into ticket.knowledge_articles (scope, title, body, tags, updated_by) values
('global', 'Ablauf der Bewerbung',
 'Nach Eingang der Bewerbung prüfen wir die Unterlagen auf Vollständigkeit. Vollständige Bewerbungen werden vorqualifiziert und zu einer Besichtigung (meist Sammelbesichtigung) eingeladen. Nach der Besichtigung können Interessenten ihr Interesse bestätigen. Anschließend stellen wir dem Eigentümer eine Auswahl vor; der Eigentümer entscheidet. Wir melden uns in jedem Fall – auch bei einer Absage.',
 '{bewerbung,ablauf,status}', 'mellin@moovin.de'),
('global', 'Benötigte Unterlagen',
 'Für eine vollständige Bewerbung benötigen wir: Personalausweis oder Reisepass, Gehaltsnachweise der letzten 3 Monate (Selbstständige: letzter Steuerbescheid/BWA), aktuelle SCHUFA-Auskunft (nicht älter als 3 Monate), Mietschuldenfreiheitsbescheinigung des aktuellen Vermieters. Unterlagen können einfach als Antwort auf unsere Mail (PDF oder Foto) gesendet werden. Bitte keine Unterlagen per Messenger.',
 '{unterlagen,dokumente,schufa,gehalt,nachweis}', 'mellin@moovin.de'),
('global', 'Unterlagen nachreichen',
 'Fehlende Unterlagen können als Antwort auf diese Mail als PDF oder Foto gesendet werden. Sie werden automatisch Ihrer Bewerbung zugeordnet. Die Prüfung erfolgt in der Regel innerhalb von 1–2 Werktagen.',
 '{unterlagen,nachreichen,upload}', 'mellin@moovin.de'),
('global', 'Besichtigung – allgemeine Hinweise',
 'Besichtigungen finden meist als Sammelbesichtigung statt. Bitte seien Sie pünktlich und bringen Sie einen Lichtbildausweis mit. Die Anwesenheit wird vor Ort erfasst. Den genauen Treffpunkt finden Sie in Ihrer Terminbestätigung. Bitte sagen Sie rechtzeitig ab, wenn Sie nicht kommen können – so kann der Platz an andere Interessenten gehen.',
 '{besichtigung,termin,treffpunkt,ausweis}', 'mellin@moovin.de'),
('global', 'Termin absagen oder verschieben',
 'Termine können per Antwort auf die Einladung abgesagt werden; der Platz wird dann freigegeben. Bei Sammelbesichtigungen sind individuelle Ersatztermine nur begrenzt möglich. Verschiebe-Wünsche geben wir an den zuständigen Ansprechpartner weiter, der sich mit möglichen Alternativen meldet. Eine Garantie für einen Ersatztermin gibt es nicht.',
 '{termin,absage,verschieben}', 'mellin@moovin.de'),
('global', 'Bearbeitungsdauer',
 'Die Prüfung vollständiger Unterlagen dauert in der Regel 1–3 Werktage. Die Entscheidung trifft der Eigentümer; nach der Besichtigung dauert das erfahrungsgemäß 3–10 Werktage.',
 '{dauer,bearbeitung,wann,entscheidung}', 'mellin@moovin.de'),
('global', 'Provision und Kosten für Mieter',
 'Für Mietinteressenten entstehen bei moovin keine Maklerprovision und keine Bewerbungskosten. Es gilt das Bestellerprinzip.',
 '{provision,kosten,gebuehr}', 'mellin@moovin.de'),
('global', 'Datenschutz',
 'Bewerbungsunterlagen werden ausschließlich für das Vermietungsverfahren genutzt und nach Abschluss gemäß Datenschutzerklärung gelöscht. Auskunft und Löschung sind jederzeit über datenschutz@moovin.de möglich.',
 '{datenschutz,dsgvo,loeschung}', 'mellin@moovin.de'),
('global', 'Absage – Kommunikation',
 'Wenn eine Wohnung an andere Interessenten vergeben wurde, teilen wir das freundlich mit. Gründe für die Auswahl des Eigentümers nennen wir nicht. Gerne können sich Interessenten auf weitere Angebote auf moovin.de bewerben.',
 '{absage,vergeben,abgelehnt}', 'mellin@moovin.de');

-- Wissensdatenbank – Ergänzungen je Objekt (vom AM gepflegt)
insert into ticket.knowledge_articles (scope, object_id, title, body, tags, updated_by) values
('objekt', 'OBJ-HH-001', 'Parken Quartier Lindenpark',
 'Anwohnerparkzone. Tiefgaragenstellplätze nur über Warteliste, 120 € pro Monat.', '{parken,stellplatz,tiefgarage}', 'lena.hoffmann@moovin.de'),
('objekt', 'OBJ-B-002', 'Ausstattung Spreeufer Lofts',
 'Einbauküche inklusive, Fahrradkeller, Aufzug vorhanden. Balkon Richtung Spree (Südwest). Keine Waschmaschine in der Wohnung, Anschluss im Bad vorhanden.', '{ausstattung,kueche,aufzug,balkon,fahrrad}', 'jonas.weber@moovin.de'),
('objekt', 'OBJ-P-003', 'Gartenhöfe – Möblierung',
 'Das Apartment wird unmöbliert vermietet. Einbauküche vorhanden.', '{moebliert,ausstattung}', 'lena.hoffmann@moovin.de');

-- ===== Attrappe moovin =====
insert into mock_moovin.objects values
('OBJ-HH-001', 'Quartier Lindenpark – 2-Zimmer, WE 2.04', 'Lindenallee 12, 20259 Hamburg', 'Eimsbüttel', 'Hamburg',
  2, 58.4, 1080, 1290, (current_date + 45), 'Kleintiere erlaubt, Hunde und Katzen nach Absprache', 'Anwohnerparkzone; Tiefgarage auf Warteliste', false,
  'Sammelbesichtigung, Treffpunkt vor dem Hauseingang Lindenallee 12. Bitte Lichtbildausweis mitbringen.',
  'Bewerbung über app.moovin.de; Unterlagen: Ausweis, 3 Gehaltsnachweise, SCHUFA, Mietschuldenfreiheit.',
  'https://app.moovin.de/expose/OBJ-HH-001', 'Lena Hoffmann', 'lena.hoffmann@moovin.de'),
('OBJ-B-002', 'Spreeufer Lofts – 3-Zimmer, WE 5.11', 'Stralauer Allee 40, 10245 Berlin', 'Friedrichshain', 'Berlin',
  3, 86.0, 1720, 2010, (current_date + 30), 'Keine Hunde, Kleintiere erlaubt', 'Kein Stellplatz', false,
  'Sammelbesichtigung, Treffpunkt im Foyer Haus B. Bitte Lichtbildausweis mitbringen.',
  'Bewerbung über app.moovin.de; Unterlagen: Ausweis, 3 Gehaltsnachweise, SCHUFA, Mietschuldenfreiheit.',
  'https://app.moovin.de/expose/OBJ-B-002', 'Jonas Weber', 'jonas.weber@moovin.de'),
('OBJ-P-003', 'Gartenhöfe Potsdam – 1-Zimmer-Apartment, WE A-07', 'Zeppelinstraße 150, 14471 Potsdam', 'Potsdam West', 'Potsdam',
  1, 34.5, 610, 760, (current_date + 14), 'Keine Haustiere', 'Fahrradstellplatz', true,
  'Einzelbesichtigung nach Vereinbarung, Treffpunkt Eingang Haus A.',
  'WBS erforderlich. Unterlagen: Ausweis, WBS, 3 Gehaltsnachweise, SCHUFA.',
  'https://app.moovin.de/expose/OBJ-P-003', 'Lena Hoffmann', 'lena.hoffmann@moovin.de');

insert into mock_moovin.applicants values
('A-1001', 'anna.schmidt@example.org', 'Frau', 'Anna', 'Schmidt', 'de'),
('A-1002', 'mehmet.yilmaz@example.org', 'Herr', 'Mehmet', 'Yilmaz', 'de'),
('A-1003', 'julia.becker@example.net', 'Frau', 'Julia', 'Becker', 'de'),
('A-1004', 'tom.richter@example.com', 'Herr', 'Tom', 'Richter', 'de'),
('A-1005', 'sarah.klein@example.org', 'Frau', 'Sarah', 'Klein', 'de'),
('A-1006', 'lucas.martin@example.com', 'Herr', 'Lucas', 'Martin', 'en');

insert into mock_moovin.applications (id, applicant_id, object_id, status, missing_documents, created_at) values
('AP-5001', 'A-1001', 'OBJ-HH-001', 'unvollstaendig', '{"Gehaltsnachweise der letzten 3 Monate","Mietschuldenfreiheitsbescheinigung"}', now() - interval '5 days'),
('AP-5002', 'A-1002', 'OBJ-B-002', 'besichtigt', '{}', now() - interval '12 days'),
('AP-5003', 'A-1003', 'OBJ-B-002', 'eingeladen', '{}', now() - interval '6 days'),
('AP-5004', 'A-1004', 'OBJ-P-003', 'beim_eigentuemer', '{}', now() - interval '15 days'),
('AP-5005', 'A-1005', 'OBJ-HH-001', 'absage', '{}', now() - interval '20 days'),
('AP-5006', 'A-1006', 'OBJ-B-002', 'eingeladen', '{}', now() - interval '4 days');

insert into mock_moovin.appointments (id, application_id, starts_at, ends_at, kind, status, meeting_point) values
('AT-9001', 'AP-5001', ((current_date + 2) + time '17:00') at time zone 'Europe/Berlin', ((current_date + 2) + time '17:30') at time zone 'Europe/Berlin', 'sammelbesichtigung', 'bestaetigt', 'Vor dem Hauseingang Lindenallee 12, Hamburg'),
('AT-9002', 'AP-5002', ((current_date - 3) + time '18:00') at time zone 'Europe/Berlin', null, 'sammelbesichtigung', 'stattgefunden', 'Foyer Haus B, Stralauer Allee 40, Berlin'),
('AT-9003', 'AP-5003', ((current_date + 1) + time '18:00') at time zone 'Europe/Berlin', ((current_date + 1) + time '18:30') at time zone 'Europe/Berlin', 'sammelbesichtigung', 'bestaetigt', 'Foyer Haus B, Stralauer Allee 40, Berlin'),
('AT-9006', 'AP-5006', ((current_date + 3) + time '18:00') at time zone 'Europe/Berlin', ((current_date + 3) + time '18:30') at time zone 'Europe/Berlin', 'sammelbesichtigung', 'eingeladen', 'Foyer Haus B, Stralauer Allee 40, Berlin');

-- Bewerberin mit zwei offenen Einladungen (Test: welcher Termin ist gemeint?)
insert into mock_moovin.applicants values ('A-1007', 'nina.vogel@example.org', 'Frau', 'Nina', 'Vogel', 'de');
insert into mock_moovin.applications (id, applicant_id, object_id, status, missing_documents, created_at) values
('AP-5007', 'A-1007', 'OBJ-HH-001', 'eingeladen', '{}', now() - interval '3 days'),
('AP-5008', 'A-1007', 'OBJ-B-002', 'eingeladen', '{}', now() - interval '2 days');
insert into mock_moovin.appointments (id, application_id, starts_at, ends_at, kind, status, meeting_point) values
('AT-9007', 'AP-5007', ((current_date + 4) + time '17:00') at time zone 'Europe/Berlin', ((current_date + 4) + time '17:30') at time zone 'Europe/Berlin', 'sammelbesichtigung', 'eingeladen', 'Vor dem Hauseingang Lindenallee 12, Hamburg'),
('AT-9008', 'AP-5008', ((current_date + 5) + time '18:00') at time zone 'Europe/Berlin', ((current_date + 5) + time '18:30') at time zone 'Europe/Berlin', 'sammelbesichtigung', 'eingeladen', 'Foyer Haus B, Stralauer Allee 40, Berlin');
