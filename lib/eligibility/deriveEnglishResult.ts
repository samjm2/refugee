// Deterministic, INSTANT English eligibility result (no LLM). The eligibility
// decision is rule-based, so we can re-derive a clean English result from the
// profile at any time. Used by the dashboard to (a) self-heal results that were
// stored in another language, and (b) provide a clean English base to translate
// other languages from — instead of translating a translation.

import { readFileSync } from "fs";
import { join } from "path";
import type { Profile, BenefitRecord, EligibilityBenefit } from "@/lib/types";
import type { FPLTable } from "./derive";
import { runEngine } from "./engine";

export function deriveEnglishResult(profile: Profile): {
  summary: string;
  benefits: EligibilityBenefit[];
} {
  const benefits = JSON.parse(
    readFileSync(join(process.cwd(), "database", "benefits.json"), "utf8"),
  ) as BenefitRecord[];
  const fpl = JSON.parse(
    readFileSync(join(process.cwd(), "data", "fpl_2025.json"), "utf8"),
  ) as FPLTable;

  const result = runEngine(profile, benefits, fpl, new Date());

  // Rank: soonest deadline first (nulls last) — mirrors the eligibility route.
  const ranked = [...result].sort((a, b) => {
    const ad = a.deadline?.daysLeft ?? null;
    const bd = b.deadline?.daysLeft ?? null;
    if (ad != null && bd != null) return ad - bd;
    if (ad != null) return -1;
    if (bd != null) return 1;
    return 0;
  });

  const names = ranked
    .filter((b) => b.status !== "not_eligible")
    .map((b) => b.name)
    .slice(0, 8)
    .join(", ");
  const summary = names ? `You may qualify for: ${names}.` : "";

  // The engine output is the deterministic SOURCE text (verified by
  // construction — no AI narrative to audit here), so tag it verified. This
  // keeps the "Checked against our sources" badge when the dashboard self-heals
  // a row that was stored in another language back into English, instead of
  // silently dropping the verification metadata.
  return {
    summary,
    benefits: ranked.map((b) => ({
      ...b,
      verification: { status: "verified" as const, claims: [] },
    })),
  };
}
