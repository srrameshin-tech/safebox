/**
 * safebox-worker
 *
 * Old behaviour: trusted a fixed value in the X-Auth-Token header.
 * That string lived in public client code, so anyone could read it and use it.
 *
 * New behaviour: the browser sends a Firebase ID token.
 *   Authorization: Bearer <idToken>
 * This worker verifies the signature against Google's public keys and checks
 * that the token really belongs to this Firebase project and to the admin email.
 * A Firebase ID token cannot be forged and it expires in one hour, so nothing
 * useful is left sitting in the public source.
 *
 * Deployed from the safebox repo (worker/ directory) via Cloudflare Workers Builds.
 *
 * Routes (unchanged, so the app keeps working the same way):
 *   PUT    /<key>   upload
 *   GET    /<key>   download
 *   DELETE /<key>   delete
 */

const FIREBASE_PROJECT_ID = "kmbsc-chit";
const ALLOWED_EMAILS = ["srrameshin@gmail.com"];

const ALLOWED_ORIGINS = [
  "https://safebox.sramesh.in",
  "http://localhost:8080",
];

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// ---------------------------------------------------------------- CORS

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body, status, request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(request) },
  });
}

// ---------------------------------------------------------------- JWT

function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

let jwksCache = { keys: null, fetchedAt: 0 };

async function getKey(kid) {
  const oneHour = 60 * 60 * 1000;
  if (!jwksCache.keys || Date.now() - jwksCache.fetchedAt > oneHour) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error("jwks fetch failed");
    const data = await res.json();
    jwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
  }
  let jwk = jwksCache.keys.find((k) => k.kid === kid);

  // Google rotates keys. If the kid is unknown, refetch once before giving up.
  if (!jwk) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw new Error("jwks refetch failed");
    const data = await res.json();
    jwksCache = { keys: data.keys || [], fetchedAt: Date.now() };
    jwk = jwksCache.keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error("unknown key id");

  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

/** Returns the token payload if everything checks out, otherwise throws. */
async function verifyIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");

  const header = b64urlToJson(parts[0]);
  const payload = b64urlToJson(parts[1]);

  if (header.alg !== "RS256") throw new Error("bad algorithm");
  if (!header.kid) throw new Error("no key id");

  const key = await getKey(header.kid);
  const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    signed
  );
  if (!ok) throw new Error("bad signature");

  const now = Math.floor(Date.now() / 1000);
  const skew = 60; // allow a minute of clock drift

  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error("wrong audience");
  if (payload.iss !== "https://securetoken.google.com/" + FIREBASE_PROJECT_ID)
    throw new Error("wrong issuer");
  if (!payload.exp || payload.exp + skew < now) throw new Error("expired");
  if (!payload.iat || payload.iat - skew > now) throw new Error("issued in the future");
  if (!payload.sub) throw new Error("no subject");

  // Anonymous sign-in produces a valid token with no email. Reject it here:
  // safebox files are admin-only.
  if (!payload.email) throw new Error("no email on token");
  if (!ALLOWED_EMAILS.includes(payload.email)) throw new Error("email not allowed");

  return payload;
}

// ---------------------------------------------------------------- R2

function findBucket(env) {
  if (env.SAFEBOX_BUCKET) return env.SAFEBOX_BUCKET;
  // Fallback: locate any R2 binding, in case the name ever changes.
  for (const v of Object.values(env)) {
    if (v && typeof v.get === "function" && typeof v.put === "function" && typeof v.delete === "function") {
      return v;
    }
  }
  return null;
}

// ---------------------------------------------------------------- handler

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const bucket = findBucket(env);
    if (!bucket) {
      console.error("no R2 binding found on env");
      return json({ error: "storage unavailable" }, 500, request);
    }

    const auth = request.headers.get("Authorization") || "";
    if (!auth.startsWith("Bearer ")) {
      return json({ error: "unauthorized" }, 401, request);
    }

    try {
      await verifyIdToken(auth.slice(7).trim());
    } catch (e) {
      console.warn("token rejected:", e.message);
      return json({ error: "unauthorized" }, 401, request);
    }

    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (!key || key.includes("..")) {
      return json({ error: "bad key" }, 400, request);
    }

    try {
      if (request.method === "PUT") {
        const body = await request.arrayBuffer();
        await bucket.put(key, body, {
          httpMetadata: {
            contentType: request.headers.get("Content-Type") || "application/octet-stream",
          },
        });
        return json({ ok: true, key }, 200, request);
      }

      if (request.method === "GET") {
        const obj = await bucket.get(key);
        if (!obj) return json({ error: "not found" }, 404, request);
        return new Response(obj.body, {
          status: 200,
          headers: {
            "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
            "Cache-Control": "private, no-store",
            ...corsHeaders(request),
          },
        });
      }

      if (request.method === "DELETE") {
        await bucket.delete(key);
        return json({ ok: true, key }, 200, request);
      }
    } catch (e) {
      console.error("storage error:", e.message);
      return json({ error: "storage error" }, 500, request);
    }

    return json({ error: "method not allowed" }, 405, request);
  },
};
