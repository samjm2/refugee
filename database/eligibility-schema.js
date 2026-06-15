/**
 * eligibility-schema.js
 * ----------------------
 * The standardized variable library for the DETERMINISTIC eligibility engine.
 *
 * No AI decides eligibility. Each benefit in benefits.js carries a `rule`
 * expressed as a logic tree over the variables defined here. The engine
 * collects the user's answers (one value per variable, gathered in onboarding),
 * evaluates each benefit's rule, and returns qualify / needs-review / not-eligible.
 *
 * Variable types:
 *   boolean  -> true / false answer
 *   number   -> numeric answer compared against a threshold
 *   enum     -> one value from a fixed set
 *
 * Every variable below maps to exactly one onboarding question
 * (see onboarding-questions.docx). `derivable` notes when the engine can
 * compute a variable from another answer instead of asking directly.
 */

window.ELIGIBILITY_SCHEMA = {

  // ---------------------------------------------------------------
  // IMMIGRATION STATUS  (enum + booleans)
  // The single most important driver. Most benefits gate on this first.
  // ---------------------------------------------------------------
  immigration_status: {
    type: "enum",
    values: [
      "refugee_207",          // Refugee admitted under INA §207
      "asylee_208",           // Asylum granted under INA §208
      "siv",                  // Special Immigrant Visa (Iraqi/Afghan)
      "afghan_parolee",       // Afghan humanitarian / non-SI parolee (OAW)
      "ukrainian_parolee",    // Uniting for Ukraine parolee
      "cuban_haitian_entrant",
      "trafficking_victim",   // Certified victim of severe trafficking (T-visa/ORR letter)
      "amerasian",
      "lpr_from_humanitarian",// Adjusted to green card FROM a humanitarian status
      "lpr_other",            // Green card via other path (subject to 5-yr bar)
      "us_citizen",
      "other_none"            // None of the above / undocumented
    ],
    question: "What is your current immigration status?",
    note: "Drives nearly every rule. 'lpr_from_humanitarian' is critical: adjusting to LPR restores SNAP/Medicaid eligibility lost under OBBBA."
  },

  // Convenience booleans derived from immigration_status, so benefit rules
  // can stay readable. The engine sets these from the enum above.
  is_orr_eligible_population: {
    type: "boolean",
    derivable: "true when immigration_status in {refugee_207, asylee_208, siv, afghan_parolee, cuban_haitian_entrant, trafficking_victim, amerasian}",
    question: null,
    note: "The set of statuses ORR-funded programs (RCA, RMA, MG, RSS, etc.) serve."
  },
  is_qualified_alien: {
    type: "boolean",
    derivable: "true for all humanitarian statuses + LPR + citizen; false for other_none",
    question: null,
    note: "PRWORA 'qualified alien' category."
  },
  has_adjusted_to_lpr: {
    type: "boolean",
    derivable: "true when immigration_status in {lpr_from_humanitarian, lpr_other}",
    question: null,
    note: "Green card holders regain SNAP/Medicaid (humanitarian-origin LPRs are exempt from the 5-year bar)."
  },

  // ---------------------------------------------------------------
  // DOCUMENTS  (booleans) — needed both for eligibility and to apply
  // ---------------------------------------------------------------
  has_i94: {
    type: "boolean",
    question: "Do you have an I-94 arrival/departure record?",
    note: "Proof of status/entry. I-94 coded §207 or 'Visa 93' proves refugee status for ORR."
  },
  has_ead: {
    type: "boolean",
    question: "Do you have an Employment Authorization Document (work permit / EAD card)?",
    note: "EAD with code A03 also proves refugee status. Carries the A-Number."
  },
  has_ssn: {
    type: "boolean",
    question: "Do you have a Social Security Number?",
    note: "Required to apply for several cash/work benefits. Many arrive without one."
  },
  has_orr_eligibility_letter: {
    type: "boolean",
    question: "If you are a trafficking victim, do you have an ORR certification/eligibility letter?",
    note: "Trafficking victims need this letter (not an I-94) to access ORR benefits."
  },

  // ---------------------------------------------------------------
  // TIME / DATES  (numbers) — the deadline math
  // The engine computes these from the user's entered dates vs. today.
  // ---------------------------------------------------------------
  months_since_eligibility_date: {
    type: "number",
    question: "What is your ORR eligibility date (usually your arrival or status-grant date)?",
    derivable: "months between eligibility_date and today",
    note: "Drives the 4-month RCA/RMA window (for eligibility dates on/after 2025-05-05)."
  },
  months_since_arrival: {
    type: "number",
    question: "When did you arrive in the United States?",
    derivable: "months between arrival_date and today",
    note: "RSS and most employment/integration services run up to 5 years (60 months) from arrival."
  },
  years_since_status_grant: {
    type: "number",
    question: "When was your refugee/asylee status granted?",
    derivable: "years between status_grant_date and today",
    note: "SSI eligibility for humanitarian statuses ends 7 years from the status-grant date."
  },
  eligibility_date_on_or_after_may5_2025: {
    type: "boolean",
    derivable: "true when eligibility_date >= 2025-05-05",
    question: null,
    note: "Determines whether the 4-month (new) or 12-month (legacy) RCA/RMA window applies."
  },

  // ---------------------------------------------------------------
  // HOUSEHOLD  (numbers + booleans)
  // ---------------------------------------------------------------
  age: {
    type: "number",
    question: "What is your age?",
    note: "Used for SSI (65+), school programs (under 18), WIC (under 5), TANF child (under 19)."
  },
  household_size: {
    type: "number",
    question: "How many people live in your household (including you)?",
    note: "Income thresholds are computed as a % of the Federal Poverty Level for this size."
  },
  household_gross_monthly_income: {
    type: "number",
    question: "What is your household's total monthly income before taxes (in US dollars)?",
    note: "Compared against program-specific % of FPL. Enter 0 if no income yet."
  },
  num_children_under_19: {
    type: "number",
    question: "How many children under age 19 live in your household?",
    note: "TANF requires a dependent child under 19."
  },
  num_children_under_18: {
    type: "number",
    question: "How many children under age 18 live in your household?",
    note: "School meal programs, childcare."
  },
  num_children_under_5: {
    type: "number",
    question: "How many children under age 5 live in your household?",
    note: "WIC covers children under 5."
  },
  is_pregnant: {
    type: "boolean",
    question: "Is anyone in your household currently pregnant?",
    note: "WIC; and pregnant women may retain Medicaid/CHIP in some states after the Oct 2026 cut."
  },
  is_unaccompanied_minor: {
    type: "boolean",
    question: "Are you under 18 and in the U.S. without a parent or legal guardian?",
    note: "Gates the Unaccompanied Refugee Minors (URM) program."
  },

  // ---------------------------------------------------------------
  // CONDITION / SITUATION  (booleans)
  // ---------------------------------------------------------------
  is_disabled: {
    type: "boolean",
    question: "Do you have a disability that limits your ability to work?",
    note: "SSI / SSDI."
  },
  is_blind: {
    type: "boolean",
    question: "Are you blind or have very limited vision?",
    note: "SSI / SSDI special category."
  },
  has_40_work_quarters: {
    type: "boolean",
    question: "Have you (or a spouse/parent) worked in the U.S. for about 10 years (40 work credits)?",
    note: "SSDI; and lets some LPRs bypass the SSI/SNAP 5-year bar."
  },
  is_employed_or_seeking: {
    type: "boolean",
    question: "Are you currently working, or looking for work / in job training?",
    note: "Employment services, childcare (for working/training parents), Matching Grant."
  },
  wants_to_start_business: {
    type: "boolean",
    question: "Are you interested in starting or growing your own small business?",
    note: "Microenterprise Development, Agricultural Partnership, IDA."
  },
  wants_english_classes: {
    type: "boolean",
    question: "Would you like English-language (ESL) classes?",
    note: "Refugee Support Services / English language training."
  },
  needs_interpreter: {
    type: "boolean",
    question: "Do you need interpreter or translation help?",
    note: "RSS interpretation services."
  },

  // ---------------------------------------------------------------
  // OTHER-BENEFIT STATUS  (booleans) — many programs gate on NOT having another
  // The engine can infer these after evaluating the relevant benefit.
  // ---------------------------------------------------------------
  eligible_for_tanf: {
    type: "boolean",
    derivable: "result of evaluating the TANF rule",
    question: null,
    note: "RCA and Matching Grant are only for those NOT eligible for TANF (or SSI)."
  },
  eligible_for_ssi: {
    type: "boolean",
    derivable: "result of evaluating the SSI rule",
    question: null,
    note: "RCA/MG exclude those eligible for SSI."
  },
  eligible_for_medicaid: {
    type: "boolean",
    derivable: "result of evaluating the Medicaid rule",
    question: null,
    note: "RMA is only for those NOT eligible for Medicaid."
  },
  receives_other_cash_benefit: {
    type: "boolean",
    question: "Are you already receiving any other cash assistance (TANF, SSI, or general assistance)?",
    note: "Categorical-eligibility shortcuts for SNAP; exclusions for RCA."
  }
};

/**
 * RULE OPERATORS the engine supports (used in benefits.js `rule` trees):
 *   { all: [...] }              -> AND
 *   { any: [...] }              -> OR
 *   { not: rule }               -> NOT
 *   { var: "x", eq: value }     -> equals
 *   { var: "x", in: [...] }     -> membership
 *   { var: "x", lte: n }        -> <=
 *   { var: "x", gte: n }        -> >=
 *   { var: "x", lt: n }         -> <
 *   { var: "x", gt: n }         -> >
 *   { var: "x", is: true/false} -> boolean check
 *   { fpl: pct, of: "income_var", size: "household_size" } -> income <= pct% of FPL
 *
 * Each leaf can also carry `review: true` to force a "needs human review"
 * result instead of a hard yes/no (used for contested / state-variable rules).
 */
