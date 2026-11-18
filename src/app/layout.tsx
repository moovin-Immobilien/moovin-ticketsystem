import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "moovin Ticketsystem",
  description: "KI-gestütztes Ticketsystem für Mietinteressenten",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="de" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
