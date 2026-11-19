import { LoginForm } from "./LoginForm";

const FEATURES = [
  { title: "Antwortentwürfe in Sekunden", text: "Claude liest jede Bewerber-Mail und schlägt eine fertige Antwort vor." },
  { title: "Live-Daten aus moovin", text: "Bewerbungsstand, Termine und fehlende Unterlagen direkt im Ticket." },
  { title: "Sicher aufgebaut", text: "Keine KI in der moovin-Datenbank, keine Anhänge an die KI, jede Aktion protokolliert." },
];

export default async function LoginPage(props: PageProps<"/login">) {
  const sp = await props.searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/tickets";
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
          <p className="mt-1 mb-8 text-sm text-muted">Melde dich mit deiner moovin-Adresse an.</p>
          <LoginForm next={next} />
        </div>
      </section>
    </main>
  );
}
