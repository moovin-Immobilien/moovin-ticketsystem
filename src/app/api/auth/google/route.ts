import { NextRequest, NextResponse } from "next/server";
import { startGoogleLogin } from "@/lib/auth";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Startet den Google-Login (Workspace-Domain, nur openid/email/profile). */
export async function GET(req: NextRequest) {
  const next = req.nextUrl.searchParams.get("next") ?? "/mein";
  try {
    return NextResponse.redirect(await startGoogleLogin(next));
  } catch (e) {
    return NextResponse.redirect(`${env.appUrl()}/login?error=${encodeURIComponent((e as Error).message)}`);
  }
}
