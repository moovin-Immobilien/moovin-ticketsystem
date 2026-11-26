import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Logo für den Mailfuß: offizielles moovin-Logo (public/moovin-logo.svg) mit Claim, als PNG (Mailprogramme zeigen kein SVG).
// 262×100 px, im Mailfuß mit 131×50 angezeigt (scharf auf Retina). Öffentlich, ohne Login.
const W = 262;
const H = 100;
const logoSvg = await readFile(join(process.cwd(), "public/moovin-logo.svg"));
const logoSrc = `data:image/svg+xml;base64,${logoSvg.toString("base64")}`;

export async function GET() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "white" }}>
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img src={logoSrc} width={W} height={Math.round((W * 185) / 580)} />
        <div style={{ display: "flex", marginTop: -8, marginLeft: 56, fontSize: 13.5, color: "#001e46", letterSpacing: 0.2 }}>Real estate. Really easy.</div>
      </div>
    ),
    { width: W, height: H, headers: { "Cache-Control": "public, max-age=86400, s-maxage=31536000" } },
  );
}
