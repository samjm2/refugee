# Refugee Benefits Database

Deterministic eligibility database for the Refugee Benefits Navigator.
**Eligibility is decided by rules, not AI.** Each benefit carries a machine-evaluable `rule`; the engine evaluates it against the user's onboarding answers.

## Scope
- **U.S. federal** refugee programs only (portable across states).
- **Current 2025–2026 rules**, including the OBBBA cuts (SNAP lost Nov 1 2025; Medicaid/CHIP ending Oct 1 2026; ACA subsidies ending Jan 1 2027) and the RCA/RMA reduction to 4 months (May 5 2025).
- **25 programs** across 7 categories.

## Files
| File | What it is |
|------|-----------|
| `database/benefits.js` | Master database as a JS module (`window.BENEFITS`). 25 program records. |
| `database/benefits.json` | Same data as pure JSON for non-JS tooling. |
| `database/eligibility-schema.js` | The 31 standardized variables (`window.ELIGIBILITY_SCHEMA`) + the rule-operator reference. |
| `database/eligibility-schema.json` | Same schema as pure JSON. |
| `onboarding-questions.docx` | The 24 onboarding questions, each mapped to a schema variable. (List only — not the UI.) |

## How the deterministic engine works
1. Onboarding asks the questions in `onboarding-questions.docx`. Each answer fills one variable in `eligibility-schema.js`.
2. The engine computes derived variables (e.g. `months_since_eligibility_date` from the entered date; `is_orr_eligible_population` from the status enum).
3. Evaluate `eligible_for_tanf`, `eligible_for_ssi`, `eligible_for_medicaid` first (RCA/RMA/Matching Grant rules depend on them).
4. For each benefit, evaluate its `rule` tree using the operators documented at the bottom of `eligibility-schema.js`.
5. Each leaf may carry `review: true` → that benefit returns **needs human review** instead of a hard yes/no (used for contested or state-variable rules, e.g. SNAP-for-humanitarian-LPRs, income thresholds requiring exact FPL tables).

### Rule operators
```
{ all: [...] }   AND        { any: [...] }  OR        { not: rule }  NOT
{ var:"x", eq:v }   { var:"x", in:[...] }   { var:"x", lte:n / gte:n / lt:n / gt:n }
{ var:"x", is:true|false }
{ fpl: pct, of:"income_var", size:"household_size" }   income <= pct% of Federal Poverty Level
```
The engine needs a current **Federal Poverty Level table** by household size to resolve `fpl` checks. (Not included here — it changes annually; load the current HHS FPL table.)

## Key conditional logic captured
- **Restoration paths** (`restore_if_lost` on each record): e.g. adjusting to LPR (green card, Form I-485) restores SNAP and Medicaid eligibility lost under OBBBA. This is the single most useful piece of guidance in the database right now.
- **Time cliffs**: RCA/RMA 4-month window (clock starts at eligibility date, not application date); SSI 7-year window from status grant; RSS/employment 5-year window from arrival.
- **Not-immigration-restricted programs**: WIC, LIHEAP, school meals, and emergency care remain available regardless of the 2025 cuts.

## Sourcing
Every record carries a `sources` array with official or official-adjacent citations (ORR/ACF, USDA FNS, SSA, CMS, USCIS, eCFR, NILC) and an `asOf` date. Rules reflect law as of mid-2026 and should be re-verified before each program year, since this area is changing rapidly.

## Important
This database supports navigation and form preparation. It does **not** make immigration-status decisions — those route to a licensed attorney or DOJ-accredited representative (see the `adjustment_of_status` and `legal_services` records).
