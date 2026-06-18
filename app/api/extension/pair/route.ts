import { NextResponse } from "next/server";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { randomBytes } from "crypto";

export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Mint a random 8-character pairing code.
  const code = randomBytes(4).toString("hex").toUpperCase();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  const serviceClient = await createServiceClient();
  const { error } = await serviceClient
    .from("extension_pairings")
    .insert({ code, user_id: user.id, expires_at: expiresAt.toISOString() });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ code, expiresAt: expiresAt.toISOString() });
}
