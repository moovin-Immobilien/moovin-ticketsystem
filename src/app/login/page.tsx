import { LoginForm } from "./LoginForm";
import { googleLoginEnabled, passwordLoginEnabled } from "@/lib/env";

const FEATURES = [
  { title: "Antwortentwürfe in Sekunden", text: "Claude liest jede Bewerber-Mail und schlägt eine fertige Antwort vor." },
  { title: "Live-Daten aus moovin", text: "Bewerbungsstand, Termine und fehlende Unterlagen direkt im Ticket." },
  { title: "Sicher aufgebaut", text: "Keine KI in der moovin-Datenbank, keine Anhänge an die KI, jede Aktion protokolliert." },
];

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/mein";
  const error = typeof sp.error === "string" ? sp.error : "";
  const pending = sp.pending === "1";
  const google = googleLoginEnabled();
  return (
    <main className="flex-1 grid lg:grid-cols-[1.1fr_1fr] min-h-screen">
      {/* Markenseite */}
      <section className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-navy px-14 py-12 text-white">
        <div aria-hidden className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-pink/25 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-40 -left-24 h-[28rem] w-[28rem] rounded-full bg-pink/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.07] [background-image:radial-gradient(white_1px,transparent_1px)] [background-size:22px_22px]" />

        <div className="relative flex items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/moovin-logo-white.svg" alt="moovin" className="h-9" />
          <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-white/80 ring-1 ring-white/15">Ticketsystem</span>
        </div>

        <div className="relative max-w-lg">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            Jede Bewerber-Mail beantwortet.<br />
            <span className="text-pink">Am selben Tag.</span>
          </h1>
          <p className="mt-4 text-base leading-relaxed text-white/70">
            Das Postfach für mieter@moovin.de: KI-Entwürfe, Live-Daten aus moovin und Freigabe mit einem Klick.
          </p>
          <ul className="mt-10 space-y-5">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-4">
                <span className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-pink/20 ring-1 ring-pink/40">
                  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 fill-pink" aria-hidden><path d="M8.1 13.6 4.5 10l-1.2 1.2 4.8 4.8 9.6-9.6-1.2-1.2z" /></svg>
                </span>
                <div>
                  <div className="font-medium">{f.title}</div>
                  <div className="text-sm text-white/60">{f.text}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative text-xs text-white/40">© {new Date().getFullYear()} moovin Immobilien GmbH · Hosting in Frankfurt (EU)</div>
      </section>

      {/* Anmeldung */}
      <section className="flex items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-sm">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/moovin-logo.svg" alt="moovin" className="h-10 mb-10" />
          <h2 className="text-2xl font-semibold tracking-tight text-navy">Willkommen zurück</h2>
          <p className="mt-1 mb-8 text-sm text-muted">Melde dich mit deinem moovin-Google-Konto an.</p>
          {error && (
            <p className={`mb-5 rounded-lg px-3 py-2 text-sm ${pending ? "bg-amber-50 text-amber-800" : "bg-pink-50 text-pink"}`}>{error}</p>
          )}
          {google ? (
            <a href={`/api/auth/google?next=${encodeURIComponent(next)}`} className="btn-pink h-11 w-full text-[15px] flex items-center justify-center gap-3">
              <svg viewBox="0 0 48 48" className="h-5 w-5 rounded-full bg-white p-0.5" aria-hidden><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.6 13.3l7.8 6C12.3 13.6 17.6 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.8-6C.9 16.6 0 20.2 0 24s.9 7.4 2.6 10.7l7.8-6z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.4 0-11.7-4.1-13.6-9.8l-7.8 6C6.6 42.6 14.6 48 24 48z"/></svg>
              Mit Google anmelden
            </a>
          ) : passwordLoginEnabled() ? (
            <>
              <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Übergang: Google-Login ist noch nicht eingerichtet. Bis dahin gilt das Prototyp-Passwort.</p>
              <LoginForm next={next} />
            </>
          ) : (
            <p className="rounded-lg bg-pink-50 px-3 py-2 text-sm text-pink">Anmeldung ist noch nicht eingerichtet (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET fehlen).</p>
          )}
          <p className="pt-6 text-center text-xs text-muted">Zugang nur für das moovin-Team. Neue Kolleginnen und Kollegen schaltet ein Admin frei.</p>
        </div>
      </section>
    </main>
  );
}
