import { NextRequest, NextResponse } from "next/server";
import { finishGoogleLogin } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const fail = (msg: string, pending = false) =>
    NextResponse.redirect(`${env.appUrl()}/login?error=${encodeURIComponent(msg)}${pending ? "&pending=1" : ""}`);
  if (sp.get("error")) return fail("Google-Anmeldung abgebrochen");
  const code = sp.get("code"), state = sp.get("state");
  if (!code || !state) return fail("Google-Anmeldung unvollständig");
  try {
    const r = await finishGoogleLogin(code, state);
    if (!r.ok) return fail(r.error, r.pending);
    return NextResponse.redirect(`${env.appUrl()}${r.next}`);
  } catch (e) {
    console.error("google login", e);
    return fail("Google-Anmeldung fehlgeschlagen");
  }
}
