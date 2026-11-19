-- Attrappe: Dokumente liegen in moovin am Bewerber (Profil), nicht an einer einzelnen Bewerbung.
alter table mock_moovin.documents add column if not exists applicant_id text references mock_moovin.applicants(id);
alter table mock_moovin.documents alter column application_id drop not null;
