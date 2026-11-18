import Link from "next/link";
import { requireAgent } from "@/lib/auth";
import { demoMode } from "@/lib/env";
import { logoutAction } from "../login/actions";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const agent = await requireAgent();
  const nav = [
    { href: "/tickets", label: "Tickets" },
    { href: "/wissen", label: "Wissen" },
    { href: "/simulieren", label: "Testmail" },
    ...(agent.role === "admin" ? [{ href: "/autonomie", label: "Autonomie" }, { href: "/audit", label: "Audit" }] : []),
  ];
  return (
    <div className="flex-1 flex flex-col">
      <header className="bg-white border-b border-line">
        <div className="mx-auto max-w-7xl px-6 h-14 flex items-center gap-8">
          <Link href="/tickets" className="flex items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/moovin-logo.svg" alt="moovin" className="h-6" />
            <span className="text-sm font-semibold text-navy border-l border-line pl-3">Tickets</span>
          </Link>
          <nav className="flex gap-1 text-sm">
            {nav.map((n) => (
              <Link key={n.href} href={n.href} className="px-3 py-1.5 rounded-lg text-muted hover:text-navy hover:bg-canvas">{n.label}</Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-muted">{agent.name}</span>
            <form action={logoutAction}><button className="text-muted hover:text-pink text-xs">Abmelden</button></form>
          </div>
        </div>
      </header>
      {demoMode() && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-800 text-xs">
          <div className="mx-auto max-w-7xl px-6 py-1.5">Demo-Modus: Kein Claude-API-Key hinterlegt – Anliegen werden per Stichwortregeln erkannt. Mit Key arbeitet Claude.</div>
        </div>
      )}
      <main className="mx-auto max-w-7xl w-full px-6 py-6 flex-1">{children}</main>
    </div>
  );
}
