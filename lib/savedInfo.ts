// "My Information" — a lightweight, reusable store of the NON-SENSITIVE facts the
// user has given us (typed into a form, confirmed from a document, or entered at
// sign-up) so we never have to ask for the same thing twice.
//
// Why localStorage (not the DB): the Supabase `profiles` table has no columns for
// free-form identity fields like legal name, street address, date of birth, or
// country of origin, and this environment can't run a migration. localStorage is
// the existing pattern for client-side form state (see lib/autofill/formProgress)
// and keeps these additions zero-risk to the server flows. The structured
// eligibility profile stays in Supabase; this just layers reusable form answers
// on top. Server routes receive a copy in the request body when they need it.
//
// HARD RULE: sensitive identifiers (SSN, EIN, ITIN, A-Number, passport, bank,
// card, etc.) are NEVER stored here. setSavedInfo drops them defensively.

import { isSensitiveName, type ProfileValues } from "@/lib/formFill";

export type SavedInfo = Record<string, string>;

const STORAGE_KEY = "wayfinder:saved-info";

// Canonical keys we understand. Aligns with ProfileValues so overlaying is
// trivial, plus a couple of display-only extras (email, countryOfOrigin).
export const CANONICAL_KEYS = [
  "firstName",
  "lastName",
  "fullName",
  "dateOfBirth",
  "address",
  "city",
  "state",
  "zip",
  "phone",
  "email",
  "countryOfBirth",
  "countryOfOrigin",
  "arrivalDate",
  "age",
  "householdSize",
] as const;

export type CanonicalKey = (typeof CANONICAL_KEYS)[number];

// ── Pure helpers (server-safe — no window access) ──────────────────────────

// Map a raw field name OR human label to one of our canonical keys, or null when
// it isn't something we want to remember. Sensitive names always return null.
export function canonicalKeyForLabel(label: string): CanonicalKey | null {
  const n = (label || "").toLowerCase();
  if (!n.trim()) return null;
  if (isSensitiveName(n)) return null;
  if (/(first.?name|given.?name|f\.?name)/.test(n)) return "firstName";
  if (/(last.?name|surname|family.?name|l\.?name)/.test(n)) return "lastName";
  if (/(full.?name|legal.?name|applicant.?name|\bname\b)/.test(n)) return "fullName";
  if (/(date.?of.?birth|birth.?date|\bdob\b)/.test(n)) return "dateOfBirth";
  if (/(street|home.?address|mailing.?address|\baddress\b|address.?line)/.test(n)) return "address";
  if (/\bcity\b|town/.test(n)) return "city";
  if (/\bstate\b|province/.test(n)) return "state";
  if (/\bzip\b|postal|zip.?code/.test(n)) return "zip";
  if (/e-?mail/.test(n)) return "email";
  if (/phone|telephone|\btel\b|mobile|cell/.test(n)) return "phone";
  if (/country.?of.?origin|nationality/.test(n)) return "countryOfOrigin";
  if (/country.?of.?birth|birth.?country|\bcountry\b/.test(n)) return "countryOfBirth";
  if (/arrival|date.?of.?entry|entry.?date|date.?of.?arrival/.test(n)) return "arrivalDate";
  if (/household.?size|family.?size|number.?in.?household|people.?in.?home/.test(n)) return "householdSize";
  if (/\bage\b/.test(n)) return "age";
  return null;
}

// Overlay saved info onto a ProfileValues bag, filling only the gaps (never
// clobbering a value the caller already resolved from the profile/documents).
// Server-safe: pass a plain SavedInfo object. countryOfOrigin doubles as
// countryOfBirth for form-fill purposes.
export function overlayValues(base: ProfileValues, info: SavedInfo | null | undefined): ProfileValues {
  if (!info) return base;
  const out: ProfileValues = { ...base };
  const set = (k: keyof ProfileValues, v: string | undefined) => {
    if (v && v.trim() && !out[k]) out[k] = v.trim();
  };
  set("firstName", info.firstName);
  set("lastName", info.lastName);
  set("fullName", info.fullName);
  set("dateOfBirth", info.dateOfBirth);
  set("address", info.address);
  set("city", info.city);
  set("state", info.state);
  set("zip", info.zip);
  set("phone", info.phone);
  set("countryOfBirth", info.countryOfBirth || info.countryOfOrigin);
  set("arrivalDate", info.arrivalDate);
  set("age", info.age);
  set("householdSize", info.householdSize);
  return out;
}

// Drop empty + sensitive entries from a patch. Used by setSavedInfo and reusable
// on the server before persisting anything.
export function sanitizeInfo(patch: SavedInfo): SavedInfo {
  const clean: SavedInfo = {};
  for (const [k, v] of Object.entries(patch)) {
    const val = (v ?? "").trim();
    if (!val) continue;
    if (isSensitiveName(k)) continue;
    clean[k] = val;
  }
  return clean;
}

// ── Client helpers (localStorage) ──────────────────────────────────────────

export function getSavedInfo(): SavedInfo {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as SavedInfo) : {};
  } catch {
    return {};
  }
}

// Merge a patch into the store (gap-tolerant: new non-empty values win so the
// freshest answer is kept). Returns the merged result. No-ops server-side.
export function setSavedInfo(patch: SavedInfo): SavedInfo {
  if (typeof window === "undefined") return {};
  const current = getSavedInfo();
  const merged = { ...current, ...sanitizeInfo(patch) };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    // Let any live "My Information" views refresh.
    window.dispatchEvent(new CustomEvent("wayfinder:saved-info-changed"));
  } catch {
    /* quota or disabled storage — non-fatal */
  }
  return merged;
}

export function clearSavedInfo(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new CustomEvent("wayfinder:saved-info-changed"));
  } catch {
    /* ignore */
  }
}

// Convenience: capture a batch of {label, value} pairs the user typed into a
// form, mapping each to a canonical key and saving the non-sensitive ones.
export function recordEntries(entries: Array<{ label: string; value: string }>): void {
  const patch: SavedInfo = {};
  for (const { label, value } of entries) {
    const key = canonicalKeyForLabel(label);
    if (key && value && value.trim()) patch[key] = value.trim();
  }
  if (Object.keys(patch).length) setSavedInfo(patch);
}
