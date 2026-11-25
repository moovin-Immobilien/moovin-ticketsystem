import Link from "next/link";
import { requireAgent } from "@/lib/auth";
import { sql } from "@/lib/db";
import { demoMode } from "@/lib/env";
import { moovinEnabled } from "@/lib/settings";
import { logoutAction } from "../login/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const agent = await requireAgent();
  const moovinOn = await moovinEnabled();
  const [c] = await sql`select
      (select count(*) from ticket.tickets where assignee_email is null and status not in ('beantwortet','geschlossen') and merged_into is null) as eingang,
      (select count(*) from ticket.agents where not active and approved_at is null) as pending`;
  const nav: { href: string; label: string; count?: number }[] = [
    { href: "/mein", label: "Mein Bereich" },
    { href: "/eingang", label: "Allgemeiner Eingang", count: Number(c.eingang) },
    { href: "/tickets", label: "Alle Tickets" },
    { href: "/wissen", label: "Wissen" },
    { href: "/simulieren", label: "Testmail" },
    ...(agent.role === "admin"
      ? [{ href: "/dashboard", label: "Dashboard" }, { href: "/team", label: "Team", count: Number(c.pending) }, { href: "/autonomie", label: "Autonomie" }, { href: "/audit", label: "Audit" }]
      : []),
  ];
  return (
    <div className="flex-1 flex flex-col">
      <header className="bg-white border-b border-line">
        <div className="mx-auto max-w-[90rem] px-6 h-14 flex items-center gap-5">
          <Link href="/mein" className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/moovin-logo.svg" alt="moovin" className="h-6" />
            <span className="hidden 2xl:inline text-sm font-semibold text-navy border-l border-line pl-3">Tickets</span>
          </Link>
          <nav className="flex gap-0.5 text-sm">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="px-2.5 py-1.5 rounded-lg text-muted hover:text-navy hover:bg-canvas whitespace-nowrap">
                {n.label}{n.count ? <span className="ml-1.5 rounded-full bg-pink px-1.5 text-[11px] font-semibold text-white tabular-nums">{n.count}</span> : null}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <form action="/suche"><input name="q" placeholder="Suche: Name, Mail, Objekt, T-Nr." className="input h-8 w-52 text-xs" /></form>
            <span className="text-muted whitespace-nowrap">{agent.name}</span>
            <form action={logoutAction}><button className="text-muted hover:text-pink text-xs">Abmelden</button></form>
          </div>
        </div>
      </header>
      {demoMode() && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-xs">
          <div className="mx-auto max-w-[90rem] px-6 py-1.5">Demo-Modus: Kein Claude-API-Key hinterlegt – Anliegen werden per Stichwortregeln erkannt. Mit Key arbeitet Claude.</div>
        </div>
      )}
      {!moovinOn && (
        <div className="bg-sky-50 border-b border-sky-200 text-sky-800 text-xs" data-testid="banner-moovin-off">
          <div className="mx-auto max-w-[90rem] px-6 py-1.5">Livetest ohne moovin-Anbindung: Zuordnung zum AM über das CRM (Objekt in der Mail), keine Bewerberdaten – [AM: …]-Platzhalter ergänzen, Aktionen werden Aufgaben.</div>
        </div>
      )}
      <main className="mx-auto max-w-[90rem] w-full px-6 py-6 flex-1">{children}</main>
    </div>
  );
}
