// CORS headers for Chrome extension routes.
// Uses the exact extension origin from EXTENSION_ORIGIN env var — never "*".

const EXTENSION_ORIGIN = process.env.EXTENSION_ORIGIN ?? "";

export function corsHeaders(requestOrigin?: string | null): HeadersInit {
  // Only allow the registered extension origin; reject all others.
  const allow =
    EXTENSION_ORIGIN && requestOrigin && requestOrigin === EXTENSION_ORIGIN
      ? EXTENSION_ORIGIN
      : "";

  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

export function corsPreflightResponse(requestOrigin?: string | null): Response {
  return new Response(null, { status: 204, headers: corsHeaders(requestOrigin) });
}
