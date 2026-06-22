import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getTranslations, type UIStrings } from "@/lib/translations";
import { translateEligibilityResult } from "@/lib/eligibility/translateResult";
import { deriveEnglishResult } from "@/lib/eligibility/deriveEnglishResult";
import type { Profile } from "@/lib/types";

// In-memory cache of translated eligibility results, keyed by user+language+row.
// Avoids re-translating on every load AND avoids overwriting the stored result,
// so switching back to the result's own language is instant and lossless.
const eligTranslationCache = new Map<string, unknown>();
import { TranslationProvider } from "@/components/i18n/TranslationProvider";
import enStrings from "@/locales/en.json";
import benefitsData from "@/database/benefits.json";
import DashboardClient, { type ViewId } from "./DashboardClient";

const VALID_VIEWS: ViewId[] = ["plan", "documents", "form", "help", "settings"];

// Presentation-only map so the Action Plan can show "where & how to apply" and
// which form is needed. Pulled from the benefits database; the eligibility
// engine and benefits data themselves are NOT modified.
type FormInfo = { how_to_apply?: string; apply_link?: string; form?: { name?: string; url?: string; type?: string } };
function buildFormInfoById(): Record<string, FormInfo> {
  const out: Record<string, FormInfo> = {};
  for (const b of benefitsData as Array<{ id: string } & FormInfo>) {
    out[b.id] = { how_to_apply: b.how_to_apply, apply_link: b.apply_link, form: b.form };
  }
  return out;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const initialTab: ViewId = VALID_VIEWS.includes(rawTab as ViewId)
    ? (rawTab as ViewId)
    : "plan";

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/auth/login?redirectTo=/dashboard");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  if (!profile?.onboarding_complete) redirect("/onboarding");

  const { data: eligibilityResult } = await supabase
    .from("eligibility_results")
    .select("*")
    .eq("user_id", user.id)
    .order("generated_at", { ascending: false })
    .limit(1)
    .single();

  const { data: documents } = await supabase
    .from("documents")
    .select("*")
    .eq("user_id", user.id)
    .order("uploaded_at", { ascending: false });

  // Seed the live-translation provider with the user's language + strings.
  const language = profile.language_code ?? "en";

  // Show benefit text in the user's CURRENT language. The eligibility DECISION is
  // deterministic, so:
  //  • if the stored result is already in the user's language → use it (keeps the
  //    warm AI narrative);
  //  • otherwise build a clean ENGLISH base — from the stored row if it's English,
  //    else re-derived instantly from the engine (this self-heals rows that were
  //    previously stored in another language) — and translate that for non-English.
  let resolvedResult = eligibilityResult;
  const rowLang = eligibilityResult?.language ?? "en";
  if (eligibilityResult && rowLang !== language) {
    const englishBase =
      rowLang === "en"
        ? eligibilityResult
        : { ...eligibilityResult, language: "en", ...deriveEnglishResult(profile as Profile) };

    if (language === "en") {
      resolvedResult = englishBase;
    } else {
      const cacheKey = `${user.id}:${language}:${eligibilityResult.generated_at ?? eligibilityResult.id}`;
      const cached = eligTranslationCache.get(cacheKey);
      if (cached) {
        resolvedResult = cached as typeof eligibilityResult;
      } else {
        const translated = (await Promise.race([
          translateEligibilityResult(englishBase, language),
          new Promise((res) => setTimeout(() => res(null), 22000)),
        ])) as typeof eligibilityResult | null;
        // Fall back to the clean English base (never leave it stuck in a stale
        // language) and cache a successful translation.
        if (translated && translated !== englishBase) {
          eligTranslationCache.set(cacheKey, translated);
          resolvedResult = translated;
        } else {
          resolvedResult = englishBase;
        }
      }
    }
  }
  let initialTranslations: UIStrings;
  try {
    initialTranslations = await getTranslations(language);
  } catch {
    initialTranslations = enStrings as UIStrings;
  }

  return (
    <TranslationProvider initialLang={language} initialTranslations={initialTranslations}>
      <DashboardClient
        profile={profile}
        eligibilityResult={resolvedResult}
        documents={documents ?? []}
        formInfoById={buildFormInfoById()}
        initialTab={initialTab}
      />
    </TranslationProvider>
  );
}
