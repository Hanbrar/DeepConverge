import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const errorParam = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  // If Google/Supabase returned an error (e.g. access_denied)
  if (errorParam) {
    console.error("[auth callback] OAuth error:", errorParam, errorDescription);
    const redirectUrl = new URL("/auth/signin", origin);
    redirectUrl.searchParams.set(
      "error",
      errorDescription || errorParam || "Authentication failed"
    );
    return NextResponse.redirect(redirectUrl);
  }

  if (code) {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          },
        },
      }
    );

    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(origin);
    }

    // Code exchange failed — redirect to sign-in with error
    console.error("[auth callback] Code exchange failed:", error.message);
    const redirectUrl = new URL("/auth/signin", origin);
    redirectUrl.searchParams.set("error", error.message);
    return NextResponse.redirect(redirectUrl);
  }

  // No code and no error — redirect home
  return NextResponse.redirect(origin);
}
