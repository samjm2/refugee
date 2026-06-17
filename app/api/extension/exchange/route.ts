import { NextRequest, NextResponse } from "next/server";
import { SignJWT } from "jose";
import { createServiceClient } from "@/lib/supabase/server";
import { corsHeaders, corsPreflightResponse } from "@/lib/extensionCors";

const JWT_SECRET = process.env.EXTENSION_JWT_SECRET ?? "";

export async function OPTIONS(req: NextRequest) {
  return corsPreflightResponse(req.headers.get("origin"));
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const hdrs = corsHeaders(origin);

  let body: { code?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: hdrs });
  }

  const { code } = body;
  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "Missing code" }, { status: 400, headers: hdrs });
  }

  const serviceClient = await createServiceClient();

  // Validate code: unconsumed, not expired.
  const { data: pairing, error } = await serviceClient
    .from("extension_pairings")
    .select("user_id, expires_at, consumed_at")
    .eq("code", code)
    .single();

  if (error || !pairing) {
    return NextResponse.json({ error: "Invalid code" }, { status: 404, headers: hdrs });
  }
  if (pairing.consumed_at) {
    return NextResponse.json({ error: "Code already used" }, { status: 409, headers: hdrs });
  }
  if (new Date(pairing.expires_at) < new Date()) {
    return NextResponse.json({ error: "Code expired" }, { status: 410, headers: hdrs });
  }

  // Mark consumed.
  await serviceClient
    .from("extension_pairings")
    .update({ consumed_at: new Date().toISOString() })
    .eq("code", code);

  if (!JWT_SECRET) {
    return NextResponse.json({ error: "Server not configured" }, { status: 503, headers: hdrs });
  }

  // Mint a short-lived JWT (1 hour).
  const secret = new TextEncoder().encode(JWT_SECRET);
  const token = await new SignJWT({ sub: pairing.user_id, scope: "profile:read" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);

  return NextResponse.json({ token }, { headers: hdrs });
}
