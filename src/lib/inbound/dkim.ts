/**
 * Absenderprüfung anhand des Authentication-Results-Headers, den der empfangende Mailserver setzt.
 * verifiziert = dmarc=pass ODER (dkim=pass UND header.d/header.i passt zur Absenderdomain).
 * Wichtig: Nur Header des EIGENEN Inbound-Dienstes zählen (authserv-id), nicht vom Absender eingeschleuste.
 */
export function isSenderVerified(authResults: string | null, fromEmail: string, trustedAuthServIds: string[] = []): { verified: boolean; detail: string } {
  if (!authResults) return { verified: false, detail: "Kein Authentication-Results-Header" };
  const domain = fromEmail.split("@")[1]?.toLowerCase() ?? "";
  let blocks = authResults.split(/\n/).map((b) => b.trim()).filter(Boolean);
  // Ohne Liste vertrauenswürdiger Server zählt nur der oberste Header (vom eigenen Empfangsserver gesetzt).
  if (!trustedAuthServIds.length) blocks = blocks.slice(0, 1);
  for (const block of blocks) {
    const authserv = block.split(";")[0]?.trim().toLowerCase() ?? "";
    if (trustedAuthServIds.length && !trustedAuthServIds.some((t) => authserv.startsWith(t.toLowerCase()))) continue;
    const lower = block.toLowerCase();
    if (/\bdmarc=pass\b/.test(lower)) return { verified: true, detail: `dmarc=pass (${authserv})` };
    const dkimRe = /dkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = dkimRe.exec(lower))) {
      const d = m[1];
      if (d === domain || domain.endsWith("." + d)) return { verified: true, detail: `dkim=pass d=${d} (${authserv})` };
    }
  }
  return { verified: false, detail: "Weder DMARC noch DKIM (passend zur Absenderdomain) bestanden" };
}
