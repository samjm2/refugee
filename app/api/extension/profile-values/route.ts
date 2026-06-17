import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { createServiceClient } from "@/lib/supabase/server";
import { corsHeaders, corsPreflightResponse } from "@/lib/extensionCors";
import { profileToValues, mergeDocumentFields } from "@/lib/formFill";
import type { Profile } from "@/lib/types";

const JWT_SECRET = process.env.EXTENSION_JWT_SECRET ?? "";

export async function OPTIONS(req: NextRequest) {
  return corsPreflightResponse(req.headers.get("origin"));
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const hdrs = corsHeaders(origin);

  // Verify Bearer JWT.
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: hdrs });
  }
  const token = authHeader.slice(7);

  if (!JWT_SECRET) {
    return NextResponse.json({ error: "Server not configured" }, { status: 503, headers: hdrs });
  }

  let userId: string;
  try {
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(token, secret);
    if (payload.scope !== "profile:read" || typeof payload.sub !== "string") {
      throw new Error("invalid scope");
    }
    userId = payload.sub;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401, headers: hdrs });
  }

  const serviceClient = await createServiceClient();

  // Load profile.
  const { data: profile, error: profileError } = await serviceClient
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();

  if (profileError || !profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404, headers: hdrs });
  }

  // Build non-sensitive ProfileValues from profile.
  let values = profileToValues(profile as Profile);

  // Merge non-sensitive extracted document fields (field NAMES only in the query;
  // values come through mergeDocumentFields which applies profileToValues merging).
  const { data: docs } = await serviceClient
    .from("documents")
    .select("extracted_fields")
    .eq("user_id", userId);

  if (docs) {
    for (const doc of docs) {
      const fields = (doc as { extracted_fields: Record<string, string> | null }).extracted_fields;
      values = mergeDocumentFields(values, fields);
    }
  }

  return NextResponse.json({ values }, { headers: hdrs });
}
