"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string; count?: number };

// Unterseiten ohne eigenen Menüpunkt: welcher Reiter soll hervorgehoben werden?
const ALIAS: Record<string, string> = { "/objekte": "/team", "/abwesenheit": "/mein", "/suche": "/tickets" };

/** Hauptmenü mit Markierung des aktiven Reiters (auch auf Unterseiten wie /tickets/123 oder /simulieren/bericht). */
export function NavLinks({ items }: { items: NavItem[] }) {
  const pathname = usePathname() ?? "";
  const base = "/" + (pathname.split("/")[1] ?? "");
  const current = ALIAS[base] ?? base;
  return (
    <nav className="flex gap-0.5 text-sm" data-testid="main-nav">
      {items.map((n) => {
        const active = current === n.href;
        return (
          <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
            className={`px-2.5 py-1.5 rounded-lg whitespace-nowrap ${active ? "bg-navy text-white font-semibold" : "text-muted hover:text-navy hover:bg-canvas"}`}>
            {n.label}{n.count ? <span className="ml-1.5 rounded-full bg-pink px-1.5 text-[11px] font-semibold text-white tabular-nums">{n.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
