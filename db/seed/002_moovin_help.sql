-- Wissensdatenbank auf Basis des offiziellen moovin-Hilfecenters (help.moovin.de, FAQs für Mietinteressent:innen)
-- und moovin.de/mieten, Stand 18.11.2026. Ersetzt die allgemeinen Platzhalter-Artikel des Prototyps.
-- Objekt-Ergänzungen (scope = 'objekt') bleiben unverändert.

delete from ticket.knowledge_articles where scope = 'global';

insert into ticket.knowledge_articles (scope, title, body, tags, source, updated_by) values
('global', 'Wohnung finden und bewerben',
 'Alle aktuell verfügbaren Wohnungen stehen in der moovin-Immobiliensuche: https://www.moovin.de/mieten bzw. https://app.moovin.de/r/properties. Jede Wohnung, die dort oder auf Portalen wie ImmoScout24 oder Immowelt angezeigt wird, ist aktuell verfügbar. Bewerben geht nur auf eine konkrete Wohnung: Wohnung auswählen, auf „Jetzt bewerben“ klicken, Formular absenden. Alternativ über das Kontaktformular eines Immobilienportals. Allgemeine Mietgesuche ohne konkrete Wohnung (per Mail oder allgemeinem Kontaktformular) können nicht bearbeitet werden. moovin übernimmt keine individuelle Wohnungssuche im Auftrag. Quelle: help.moovin.de (Wo finde ich eine passende Wohnung?, Wie bewerbe ich mich?, Ist die Wohnung noch verfügbar?)',
 '{wohnungssuche,suche,verfügbar,verfügbarkeit,bewerben,angebot,freie,wohnungen,mietgesuch,auftrag}', 'moovin', 'hilfecenter-import'),

('global', 'Suchagent anlegen',
 'Wenn aktuell keine passende Wohnung dabei ist, kann man in der moovin-Immobiliensuche (https://www.moovin.de/mieten) einen Suchagenten mit den eigenen Kriterien anlegen. Sobald eine passende Wohnung eingestellt wird, kommt automatisch eine Benachrichtigung per E-Mail. Quelle: help.moovin.de (Kann ich Sie mit der Suche nach meiner Traumwohnung beauftragen?), moovin.de/mieten',
 '{suchagent,benachrichtigung,suche,kriterien,neue,angebote,wohnungssuche}', 'moovin', 'hilfecenter-import'),

('global', 'Ablauf nach der Bewerbung',
 'Nach der Bewerbung kommt eine E-Mail mit der Bitte, das moovin-Profil anzulegen bzw. zu vervollständigen (kostenlos). Im Profil sieht man alle Bewerbungen, Termine und Dokumente und kann Bonitätsunterlagen schon vor der Besichtigung hochladen. Ein Abgleich der Angaben mit den Anforderungen des Vermieters (Matching) entscheidet über die Einladung zur Besichtigung; das Team begleitet den Prozess persönlich. Einladungen zur Besichtigung kommen per E-Mail und im Profil. Nach der Besichtigung bestätigt man sein Mietinteresse über den Button in der E-Mail, danach wird geprüft und dem Eigentümer vorgeschlagen. Eine zusätzliche Bestätigung der Bewerbung ist nicht nötig; moovin meldet sich von selbst, sobald es Neuigkeiten gibt. Quelle: help.moovin.de (Wie läuft der Prozess nach der Bewerbung ab?)',
 '{bewerbung,ablauf,prozess,status,profil,matching,wann,dauer,rückmeldung,neuigkeiten}', 'moovin', 'hilfecenter-import'),

('global', 'Bewerbungsstatus im Profil',
 'Den aktuellen Stand aller Bewerbungen sieht man im moovin-Profil: einloggen unter https://app.moovin.de/r/login, oben rechts das Menü (drei Striche) öffnen, „Bewerbungen“ wählen. Status-Bedeutungen: Beworben = Anfrage ist eingegangen. Eingeladen = Terminvorschlag zur Besichtigung erhalten. Dokumente hochladen = Upload-Bereich für Bonitätsunterlagen ist freigeschaltet (fehlen nach Prüfung Unterlagen, bitte nachreichen). In Prüfung = Unterlagen werden geprüft. Bewerbung vollständig = Prüfung abgeschlossen. Mietervorschlag = moovin hat die Person dem Eigentümer vorgeschlagen, Rückmeldung steht aus. Abgelehnt = der Vermieter hat sich anders entschieden. Angemietet = Zuschlag erhalten. Quelle: help.moovin.de (Was bedeuten die unterschiedlichen Status?, Bewerbungsstatus einsehen)',
 '{status,stand,bewerbung,profil,login,beworben,eingeladen,prüfung,mietervorschlag,abgelehnt,angemietet}', 'moovin', 'hilfecenter-import'),

('global', 'Zusätzliche Nachrichten und Chancen erhöhen',
 'Eine zusätzliche Nachricht nach der Bewerbung erhöht die Chancen nicht: Die Bewerbung ist verbindlich gespeichert, und der Abgleich mit den Anforderungen des Vermieters läuft für alle gleich. Was hilft: das Profil vollständig ausfüllen, ein Foto hinzufügen und die Bonitätsunterlagen früh hochladen, dann kann nach der Interessensbestätigung sofort geprüft werden. Eine Zusage ist trotzdem nie garantiert, weil es oft sehr viele geeignete Bewerbungen gibt. Quelle: help.moovin.de (Erhöht eine zusätzliche Nachricht meine Chancen?, Wie kann ich die Chancen erhöhen?)',
 '{chancen,dringend,interesse,nachricht,bevorzugt,priorität,erhöhen,foto,profil}', 'moovin', 'hilfecenter-import'),

('global', 'Besichtigung: Einladung, Zusage, Absage, Alternativtermin',
 'Einladungen zur Besichtigung kommen per E-Mail; Zu- und Absage am schnellsten über die Buttons in dieser E-Mail. Mit der Absage über den Button wird automatisch ein Alternativtermin angefragt. Einen festen Ersatztermin gibt es nicht sofort: Besichtigungen werden gebündelt geplant, ein neuer Termin wird nur angeboten, wenn weitere Besichtigungen stattfinden, und der Vermietungsstand kann sich kurzfristig ändern. moovin versucht, möglichst jeder Bewerbung einen Termin anzubieten; eine Einladung setzt eine Bewerbung auf eine konkrete Wohnung voraus. Zur Besichtigung bitte einen Lichtbildausweis mitbringen. Quelle: help.moovin.de (Termin zu- oder absagen / Alternativtermin / Bewerbung zurückziehen, Besichtigungstermin vereinbaren)',
 '{besichtigung,termin,zusage,absage,alternativtermin,ersatztermin,verschieben,einladung,treffpunkt}', 'moovin', 'hilfecenter-import'),

('global', 'Virtuelle Besichtigung',
 'Für viele Wohnungen gibt es vorab einen 360-Grad-Rundgang in der Immobiliensuche auf moovin.de. Die eigentliche Besichtigung findet vor Ort statt. Quelle: moovin.de/mieten',
 '{video,virtuell,online,360,rundgang,besichtigung,ferne}', 'moovin', 'hilfecenter-import'),

('global', 'Nach der Besichtigung: Wohnung anmieten',
 'Wer die Wohnung mieten möchte, bestätigt das Mietinteresse über den Button „Bewerbung vervollständigen“ in der E-Mail, die nach der Besichtigung kommt. Erst danach wird der Upload für die Bonitätsunterlagen im Profil freigeschaltet bzw. geprüft und die Bewerbung dem Eigentümer vorgeschlagen. Anschließend meldet sich ein Account Manager zu den nächsten Schritten. Quelle: help.moovin.de (Was muss ich nach der Besichtigung tun?, Wohnung gefallen – was tun?)',
 '{anmieten,mieten,interesse,bestätigen,nach,besichtigung,vervollständigen,zusage}', 'moovin', 'hilfecenter-import'),

('global', 'Benötigte Unterlagen',
 'Für die Prüfung werden digital benötigt: Einkommensnachweise der letzten 3 Monate (alternativ Rentenbescheid oder Leistungsnachweis), Personalausweis Vorder- und Rückseite, SCHUFA-Auskunft für Vermieter, Mietschuldenfreiheitsbescheinigung des aktuellen Vermieters und die Mieterselbstauskunft. Bitte alle Unterlagen vollständig einreichen, dann geht die Prüfung schneller; danach meldet sich ein Account Manager. Für Sonderfälle (Selbstständige, Studierende, Bürgschaft) klärt der Account Manager die Nachweise individuell. Quelle: help.moovin.de (Welche Dokumente werden benötigt?)',
 '{unterlagen,dokumente,nachweise,gehalt,einkommen,schufa,ausweis,mietschuldenfreiheit,selbstauskunft,bürgschaft}', 'moovin', 'hilfecenter-import'),

('global', 'Unterlagen hochladen',
 'Der Upload-Bereich im moovin-Profil wird freigeschaltet, sobald man sich auf eine Wohnung beworben und ein Profil angelegt hat. Hochladen: den Anweisungen in den moovin-E-Mails folgen oder unter https://app.moovin.de/r/login einloggen. Unterlagen werden nicht bei der Besichtigung angenommen; alles muss digital bereitgestellt werden. Geprüft wird nach der Besichtigung, wenn weiterhin Interesse besteht. Quelle: help.moovin.de (Wann kann ich meine Dokumente hochladen?, Soll ich Dokumente zur Besichtigung mitbringen?)',
 '{hochladen,upload,unterlagen,dokumente,profil,nachreichen,mitbringen,besichtigung}', 'moovin', 'hilfecenter-import'),

('global', 'Mieterselbstauskunft (MSA) und Aufgaben im Profil',
 'Die Mieterselbstauskunft ist freiwillig und hilft, sich dem Vermieter als passende Mietpartei vorzustellen. Sie wird nach der Besichtigung direkt im moovin-Profil ausgefüllt. Offene „Aufgaben“ im Dashboard zeigen, welche Angaben oder Dokumente moovin noch braucht, um die Bewerbung dem Vermieter vorzuschlagen; man wird dazu auch per E-Mail informiert. Bei technischen Fehlern in der Selbstauskunft hilft der zuständige Ansprechpartner weiter. Quelle: help.moovin.de (Was ist eine Mieterselbstauskunft?, Was sind Aufgaben im Dashboard?)',
 '{selbstauskunft,msa,aufgaben,dashboard,formular,fehler,ergänzen,kind,mitbewohner}', 'moovin', 'hilfecenter-import'),

('global', 'Bonitätsnachweis bestellen',
 'Über die moovin-App kann ein offiziell anerkannter Bonitätsnachweis (z. B. von der SCHUFA) in wenigen Minuten bestellt werden, ab 17,90 €. Vermieter verlangen ihn häufig. Quelle: moovin.de/mieten',
 '{bonität,bonitätsnachweis,schufa,bestellen,kosten}', 'moovin', 'hilfecenter-import'),

('global', 'Absage erhalten',
 'Oft bewerben sich viele geeignete Personen auf eine Wohnung, sodass auch gute Bewerbungen eine Absage erhalten können. Eine Absage bedeutet nicht, dass die Bewerbung ungeeignet war. Einzelne Gründe für die Auswahl des Eigentümers nennt moovin nicht. Weitere freie Wohnungen gibt es laufend auf moovin.de/mieten; ein Suchagent informiert über neue Angebote. Quelle: help.moovin.de (Warum habe ich eine Absage erhalten?)',
 '{absage,abgelehnt,vergeben,warum,grund}', 'moovin', 'hilfecenter-import'),

('global', 'Bewerbung zurückziehen',
 'Wer kein Interesse mehr hat, kann die Bewerbung vollständig zurückziehen; ein vereinbarter Besichtigungstermin wird dann freigegeben. Quelle: help.moovin.de (Termin zu- oder absagen / Bewerbung zurückziehen)',
 '{zurückziehen,rückzug,kein,interesse,abmelden,bewerbung}', 'moovin', 'hilfecenter-import'),

('global', 'Mietvertrag digital unterschreiben (Nect)',
 'Mietverträge werden häufig digital über den Partner Nect unterschrieben. Häufige Probleme und Lösungen: Name im moovin-System weicht vom Ausweis ab → Ansprechpartner korrigiert und schickt den Vertrag neu; für die Identifikation dasselbe Dokument nutzen, das in moovin hochgeladen ist. Name in Nect exakt wie im Ausweis eingeben (alle Vornamen, Bindestriche, „geb.“-Zusätze). Hologramm nicht erkannt → bei gutem Licht wiederholen und den Ausweis langsam kippen. Verwackelte Aufnahmen → Smartphone ruhig führen. Gesprochene Wörter laut und deutlich sagen, ohne Hintergrundgeräusche. Meldung „Bad Request“ → Dokument ist bereits unterschrieben oder wurde zurückgezogen; Postfach auf neuere Mails prüfen. Hilft das nicht: Nect-Support mit der Vorgangsnummer kontaktieren. Quelle: help.moovin.de (Probleme bei der digitalen Signatur)',
 '{mietvertrag,signatur,unterschrift,nect,digital,ident,ausweis,bad,request}', 'moovin', 'hilfecenter-import'),

('global', 'Kosten für Mietinteressenten',
 'Das moovin-Bewerberprofil ist kostenlos. Für Mietinteressenten fällt keine Maklerprovision an (Bestellerprinzip). Optional kostenpflichtig ist nur ein selbst bestellter Bonitätsnachweis (ab 17,90 €). Mietpreise in Inseraten sind teils „ab“-Preise, teils Kalt- oder All-in-Mieten. Quelle: moovin.de/mieten',
 '{kosten,provision,gebühr,kostenlos,miete,preis,kalt,warm}', 'moovin', 'hilfecenter-import'),

('global', 'Konto und Daten löschen (Datenschutz)',
 'Wer sein moovin-Konto und seine Daten löschen lassen möchte, schreibt eine kurze E-Mail an datenschutz@moovin.de; moovin kommt dem nach. Auskunft (Art. 15 DSGVO) und Löschung (Art. 17 DSGVO) laufen über dieselbe Adresse. Der Datenschutzbeauftragte ist unter dsb@moovin.de erreichbar. Man kann sich jederzeit erneut auf moovin-Wohnungen bewerben und ein neues Konto anlegen. Laufende Bewerbungen enden mit der Löschung. Quelle: help.moovin.de (Daten und Account löschen), moovin.de/datenschutz',
 '{löschen,account,konto,daten,datenschutz,dsgvo,auskunft,abmelden,newsletter}', 'moovin', 'hilfecenter-import'),

('global', 'Unzufrieden mit dem Ablauf / Beschwerde',
 'Rückmeldungen helfen moovin, die Abläufe aus Sicht der Interessent:innen zu verbessern. Ansprechpartner: die Person, die im Prozess betreut hat, oder per E-Mail beschwerde@moovin.de. Quelle: help.moovin.de (Der Prozess hat nicht meinen Erwartungen entsprochen)',
 '{beschwerde,unzufrieden,feedback,kritik,ärger,erwartungen}', 'moovin', 'hilfecenter-import'),

('global', 'Hilfecenter',
 'Antworten auf häufige Fragen zu Bewerbung, Besichtigung, Dokumenten, Datenschutz und Mietvertrag stehen im moovin-Hilfecenter: https://help.moovin.de/portal/de/kb/faqs-mietinteressen-innen',
 '{hilfe,faq,fragen,hilfecenter}', 'moovin', 'hilfecenter-import');
