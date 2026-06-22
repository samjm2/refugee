"use client";

// The user-facing "Fill Out Form with AI" experience. A side panel that drives
// the portal-automation agent and narrates it in real time:
//   • opens the benefits portal in a new tab (via the extension)
//   • snapshots each page, asks the planner for the next safe actions, executes
//     the safe ones, and shows a live feed
//   • pauses to ASK the user for missing info
//   • hands SENSITIVE fields to the user (highlights them in the portal) with a
//     Resume button
//   • stops at the review/submit step — it never submits an application
//
// All control stays with the user: pause/cancel anytime, and nothing sensitive
// is ever typed or submitted by the agent.

import { useCallback, useEffect, useRef, useState } from "react";
import { agent, detectExtension, type ExecAction } from "@/lib/autofill/agentClient";
import type { Plan, PlanAction, PageSnapshot } from "@/lib/autofill/plan";
import { useTranslation } from "@/components/i18n/TranslationProvider";
import { getSavedInfo, setSavedInfo, canonicalKeyForLabel } from "@/lib/savedInfo";

type Phase = "checking" | "no_extension" | "ready" | "running" | "ask" | "handoff" | "login" | "captcha" | "unreachable" | "review" | "done" | "error";
type Tone = "info" | "ok" | "warn" | "danger";
interface FeedItem { id: number; tone: Tone; text: string }

const MAX_ROUNDS = 16;

const TONE_DOT: Record<Tone, string> = {
  info: "bg-harbor-400",
  ok: "bg-success-600",
  warn: "bg-review-600",
  danger: "bg-danger-600",
};

// Turn a canonical saved-info key (e.g. "dateOfBirth") into a readable label
// ("Date of birth") for the review summary.
function humanizeKey(key: string): string {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

// A STRUCTURAL signature of the page (url + headings + field identities +
// button labels) — deliberately excludes field values, so we can tell a real
// step change from "same page, we just typed into it."
function structSig(s: PageSnapshot): string {
  return JSON.stringify([
    s.url,
    s.headings,
    s.fields.map((f) => [f.ref, f.type, f.label]),
    s.buttons.map((b) => b.text),
  ]);
}

export default function AutofillAgent({
  benefitName,
  portalUrl,
  onClose,
  attorneyNeeded = false,
}: {
  benefitName: string;
  portalUrl: string;
  onClose: () => void;
  attorneyNeeded?: boolean;
}) {
  const { t } = useTranslation();
  const af = t.dashboard.autofill;

  const [phase, setPhase] = useState<Phase>("checking");
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [ask, setAsk] = useState<{ field: string; question: string } | null>(null);
  const [answer, setAnswer] = useState("");
  const [handoff, setHandoff] = useState<{ label: string; reason: string; kind?: "consent" } | null>(null);
  const [error, setError] = useState("");
  // Submit gate: before we hand the user to the official site to submit, they
  // must confirm they reviewed the information — and, for forms that need a
  // lawyer, that an attorney/accredited rep reviewed it too.
  const [reviewedConfirmed, setReviewedConfirmed] = useState(false);
  const [attorneyConfirmed, setAttorneyConfirmed] = useState(false);

  const askedRef = useRef<string[]>([]);
  const answersRef = useRef<Record<string, string>>({});
  const roundsRef = useRef(0);
  const lastSigRef = useRef("");
  const lastFilledRef = useRef(0);
  const stuckRef = useRef(0);
  const cancelRef = useRef(false);
  const resumingCaptchaRef = useRef(false);
  const feedIdRef = useRef(0);
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  // Holds the latest advance() so the loop can re-invoke itself after a
  // navigation without a useCallback self-reference (disallowed by the linter).
  const advanceRef = useRef<() => void>(() => {});

  const log = useCallback((tone: Tone, text: string) => {
    setFeed((f) => [...f, { id: ++feedIdRef.current, tone, text }]);
  }, []);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [feed, phase]);

  useEffect(() => {
    let alive = true;
    detectExtension().then((present) => {
      if (alive) setPhase(present ? "ready" : "no_extension");
    });
    return () => {
      alive = false;
      cancelRef.current = true;
      void agent.close().catch(() => {});
    };
  }, []);

  async function getPlan(snapshot: PageSnapshot): Promise<Plan> {
    const res = await fetch("/api/autofill/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        snapshot,
        asked: askedRef.current,
        answers: answersRef.current,
        savedInfo: getSavedInfo(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "Couldn't plan the next step.");
    return data.plan as Plan;
  }

  // One round: read the page, plan, act, then either continue, pause, or finish.
  const advance = useCallback(async () => {
    if (cancelRef.current) return;
    if (roundsRef.current >= MAX_ROUNDS) {
      setPhase("done");
      log("info", "Reached the step limit for one session — you can take it from here.");
      return;
    }
    roundsRef.current += 1;
    setPhase("running");
    try {
      log("info", af.agent.readingPage);
      // Read the page, retrying a couple of times — a real government portal can
      // take several seconds to settle after a navigation. If we still can't read
      // it, the page is either mid-load or has thrown up a human-verification step
      // (a reCAPTCHA / "verify you're not a robot" interstitial) that strips out
      // our content script, so snapshotting fails before we ever see snap.captcha.
      // Either way only the user can move it forward — hand it to them via the
      // captcha-style pause instead of dying with a dead-end "Try again" error.
      let snap: PageSnapshot | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          snap = await agent.snapshot();
          break;
        } catch {
          if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (!snap) {
        await agent.focusPortal().catch(() => {});
        log("warn", af.agent.unreadable);
        resumingCaptchaRef.current = true; // don't re-pause on a lingering widget once they resume
        setPhase("unreachable");
        return;
      }
      // Progress = the page structure changed (new step) OR we filled a new
      // field. If neither happens across rounds, we're stuck (e.g. clicking a
      // link on an info page that never becomes a form).
      const sig = structSig(snap);
      const filled = snap.fields.filter((f) => f.value && f.value !== "").length;
      const progressed = sig !== lastSigRef.current || filled > lastFilledRef.current;
      stuckRef.current = progressed ? 0 : stuckRef.current + 1;
      lastSigRef.current = sig;
      lastFilledRef.current = filled;

      if (snap.headings[0]) log("info", `On: ${snap.headings[0]}${snap.step ? ` (${snap.step})` : ""}`);
      log("info", `Found ${snap.fields.length} field${snap.fields.length === 1 ? "" : "s"} on this step.`);

      // reCAPTCHA → only a human can solve it. Switch the user to the site and
      // pause. (We skip this check on the round right after they resume, so a
      // lingering captcha widget doesn't trap us once they've solved it.)
      if (snap.captcha && !resumingCaptchaRef.current) {
        await agent.focusPortal().catch(() => {});
        log("warn", af.agent.captcha);
        setPhase("captcha");
        return;
      }
      resumingCaptchaRef.current = false;

      const plan = await getPlan(snap);
      if (plan.summary) log("info", plan.summary);

      // Login wall → hand control to the user to sign in. We never fill or store
      // a password; the user signs in themselves, then resumes. We trust the
      // planner's classification: a page that merely *contains* a sign-in box but
      // also offers a guest/apply path is NOT a login wall (pageType stays
      // application_step), so the agent takes the guest path instead.
      if (plan.pageType === "login") {
        await agent.focusPortal().catch(() => {});
        log("warn", af.agent.accountWall);
        setPhase("login");
        return;
      }

      // No-progress guard: same structure, nothing newly filled, across rounds →
      // stop instead of looping. Almost always an info/navigation page, a login
      // wall, or a dead end — not a fillable application.
      if (stuckRef.current >= 2) {
        await agent.focusPortal().catch(() => {});
        log("warn", af.agent.accountWallStuck);
        setPhase("login");
        return;
      }

      const actions = plan.actions;
      const fills = actions.filter(
        (a): a is Extract<PlanAction, { action: "fill" | "select" | "check" }> =>
          a.action === "fill" || a.action === "select" || a.action === "check",
      );
      const asks = actions.filter((a): a is Extract<PlanAction, { action: "ask_user" }> => a.action === "ask_user");
      const handoffs = actions.filter((a): a is Extract<PlanAction, { action: "handoff_sensitive" }> => a.action === "handoff_sensitive");
      const click = actions.find((a): a is Extract<PlanAction, { action: "click" }> => a.action === "click");
      const review = actions.find((a) => a.action === "review");
      const done = actions.find((a) => a.action === "done");

      // 1) Execute the safe fills.
      if (fills.length) {
        const exec: ExecAction[] = fills.map((a) =>
          a.action === "check"
            ? { action: "check", ref: a.ref, value: a.value }
            : { action: a.action, ref: a.ref, value: a.value },
        );
        const results = await agent.execute(exec);
        fills.forEach((a, i) => {
          const r = results[i];
          if (r?.ok) log("ok", `Filled ${a.label}.`);
          else log("warn", `Couldn't fill ${a.label}${r?.note ? ` (${r.note})` : ""}.`);
        });
      }

      // 2) Review/submit page → highlight sensitive fields, stop (never submit).
      if (review) {
        for (const h of handoffs) await agent.highlight(h.ref).catch(() => {});
        // Don't jump to the portal yet — show the review gate here first. The
        // user reviews their info and confirms before we let them go submit.
        log("ok", af.agent.reviewReady);
        setPhase("review");
        return;
      }

      // If the page never changed since the last round AND all the agent can do
      // is ask/hand off again, we're stuck — almost always because this isn't an
      // actual application form (an info/landing page, a login wall, etc.). Stop
      // instead of looping the same question forever.
      const onlyNeedsUser = !fills.length && !click && (asks.length > 0 || handoffs.length > 0);
      if (stuckRef.current >= 1 && onlyNeedsUser) {
        await agent.focusPortal().catch(() => {});
        log("warn", af.agent.accountWallStuck);
        setPhase("login");
        return;
      }

      // 3) Missing info → ask the user (one question; we re-plan after the answer).
      //    Stay on Wayfinder — the question is answered here in the panel, NOT on
      //    the portal, so we do NOT switch tabs.
      if (asks.length) {
        const a = asks[0];
        log("warn", `Need your input: ${a.question}`);
        setAsk({ field: a.field, question: a.question });
        setPhase("ask");
        return;
      }

      // 4) Sensitive field mid-form → hand control to the user. A legal
      //    consent/agreement step gets a special "talk to your attorney first"
      //    message instead of the generic sensitive hand-off.
      if (handoffs.length) {
        const h = handoffs[0];
        await agent.highlight(h.ref).catch(() => {});
        await agent.focusPortal().catch(() => {});
        const isConsent = /\b(agree|consent|terms|certif|attest|rights and responsib|authoriz|penalty of perjury)\b/i.test(h.label);
        if (isConsent) {
          log("warn", "This form has a legal agreement to accept. Please talk to your attorney or accredited representative before you check it.");
        } else {
          log("warn", `${h.label} is sensitive — please enter it yourself in the portal.`);
        }
        setHandoff({ label: h.label, reason: h.reason, kind: isConsent ? "consent" : undefined });
        setPhase("handoff");
        return;
      }

      // 5) Advance to the next step.
      if (click) {
        log("info", `Continuing to the next step (${click.label})…`);
        await agent.execute([{ action: "click", ref: click.ref }]);
        setTimeout(() => advanceRef.current(), 1300); // let the page navigate
        return;
      }

      // 6) Done, or stuck with nothing left to do → take the user to the portal
      //    to review and submit (we never submit for them).
      if (done || stuckRef.current >= 1) {
        // Same as review: hold on Wayfinder for the review gate before submit.
        setPhase("done");
        log("ok", done ? af.agent.allDone : af.agent.nothingLeft);
        return;
      }

      // Only fills happened and the page changed — look again.
      setTimeout(() => advanceRef.current(), 600);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }, [log, af]);

  // Keep the ref pointing at the current advance() for the recursive timeouts.
  useEffect(() => { advanceRef.current = () => { void advance(); }; }, [advance]);

  async function start() {
    setFeed([]);
    askedRef.current = [];
    answersRef.current = {};
    roundsRef.current = 0;
    lastSigRef.current = "";
    lastFilledRef.current = 0;
    stuckRef.current = 0;
    resumingCaptchaRef.current = false;
    cancelRef.current = false;
    setReviewedConfirmed(false);
    setAttorneyConfirmed(false);
    setPhase("running");
    try {
      log("info", af.agent.openingPortal);
      await agent.openPortal(portalUrl);
      await advance();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open the portal.");
      setPhase("error");
    }
  }

  function submitAnswer() {
    if (!ask) return;
    const v = answer.trim();
    if (!v) return;
    answersRef.current[ask.field] = v;
    if (!askedRef.current.includes(ask.field)) askedRef.current.push(ask.field);
    // Remember reusable, non-sensitive answers for future forms. The planner only
    // uses ask_user for ordinary facts (sensitive ones go through handoff), and
    // canonicalKeyForLabel returns null for anything sensitive or unrecognized —
    // so nothing sensitive is ever persisted here.
    const key = canonicalKeyForLabel(ask.field) ?? canonicalKeyForLabel(ask.question);
    if (key) setSavedInfo({ [key]: v });
    log("ok", `You answered: ${v}`);
    setAsk(null);
    setAnswer("");
    // Answering a question IS forward progress. Reset the stuck counter so the
    // next round — often another ask_user on a normal multi-field form — isn't
    // misread as "stuck" and wrongly bounced to the create-an-account wall.
    stuckRef.current = 0;
    void advance();
  }

  function resumeFromHandoff() {
    setHandoff(null);
    // Resolving a hand-off (e.g. they created an account or signed in) is real
    // progress — clear the stuck counter so we don't immediately re-pause.
    stuckRef.current = 0;
    void advance();
  }

  function resumeFromCaptcha() {
    // Skip the captcha check on the next round so a still-present widget doesn't
    // immediately re-pause us now that the user has solved it.
    resumingCaptchaRef.current = true;
    log("info", af.agent.resuming);
    void advance();
  }

  function cancel() {
    cancelRef.current = true;
    void agent.close().catch(() => {});
    onClose();
  }

  const busy = phase === "running";

  // Everything Wayfinder knows about the user (their saved "My Information"),
  // shown in the review gate so they can verify it before submitting.
  const infoRows: Array<{ label: string; value: string }> =
    phase === "review" || phase === "done"
      ? Object.entries(getSavedInfo())
          .filter(([, v]) => v && v.trim())
          .map(([k, v]) => ({ label: humanizeKey(k), value: v }))
      : [];
  const canSubmit = reviewedConfirmed && (!attorneyNeeded || attorneyConfirmed);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="AI application assistant">
      <button aria-hidden="true" tabIndex={-1} className="absolute inset-0 bg-black/40" onClick={cancel} />
      <div className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-surface shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border bg-harbor-50 px-5 py-4">
          <div>
            <h2 className="font-display text-lg font-bold text-text">{af.assistantTitle}</h2>
            <p className="text-sm text-text-muted">{benefitName}</p>
          </div>
          <button onClick={cancel} aria-label="Close" className="rounded-md p-1.5 text-text-muted hover:bg-harbor-100 hover:text-text focus-visible:outline-none">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {phase === "checking" && <p className="text-sm text-text-muted">Checking for the Wayfinder browser extension…</p>}

          {phase === "no_extension" && (
            <div className="rounded-[--radius-md] border border-review-100 bg-review-50 px-4 py-3 text-sm text-review-700">
              <p className="font-semibold">Can&apos;t reach the Wayfinder extension on this page.</p>
              <p className="mt-1">
                <strong>If you just installed or reloaded the extension, refresh this page</strong> (⌘R / Ctrl-R) and try again — reloading the extension disconnects it from open tabs until they reload.
              </p>
              <p className="mt-2">
                If it&apos;s not connected yet, open <strong>Settings → Auto-fill</strong> to connect it. The extension lets Wayfinder read and fill the portal page in your browser — your data never leaves your machine except the non-sensitive facts needed to fill a field.
              </p>
              <button
                onClick={() => window.location.reload()}
                className="mt-3 rounded-[--radius-md] bg-primary px-4 py-2 text-sm font-semibold text-on-primary hover:bg-primary-hover"
              >
                Refresh this page
              </button>
            </div>
          )}

          {phase !== "checking" && phase !== "no_extension" && (
            <>
              {/* Prominent, friendly loading state while the agent is actively
                  snapshotting / planning / filling. The live log stays visible
                  below it so the user can still follow along. */}
              {busy && (
                <div
                  className="mb-4 flex flex-col items-center gap-3 rounded-[--radius-md] border border-harbor-200 bg-harbor-50 px-4 py-6 text-center"
                  role="status"
                  aria-live="polite"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-9 w-9 animate-spin rounded-full border-[3px] border-harbor-200 border-t-harbor-500"
                  />
                  <p className="text-base font-semibold text-text">{af.filling}</p>
                  <p className="text-sm text-text-muted">{af.fillingHint}</p>
                </div>
              )}

              {feed.length === 0 && !busy ? (
                <p className="text-sm text-text-muted">
                  Wayfinder will open the application portal, fill what it can from your profile, ask you about anything it doesn&apos;t know, and pause for anything sensitive. It never submits — you always do that yourself.
                </p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {feed.map((it) => (
                    <li key={it.id} className="flex items-start gap-2.5 text-sm text-text">
                      <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${TONE_DOT[it.tone]}`} aria-hidden="true" />
                      <span>{it.text}</span>
                    </li>
                  ))}
                  <div ref={feedEndRef} />
                </ul>
              )}

              {/* Ask the user for missing info */}
              {phase === "ask" && ask && (
                <div className="mt-4 rounded-[--radius-md] border border-harbor-200 bg-harbor-50 p-4">
                  <p className="mb-2 text-sm font-semibold text-text">{ask.question}</p>
                  <input
                    autoFocus
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") submitAnswer(); }}
                    placeholder="Type your answer"
                    className="w-full rounded-[--radius-md] border-2 border-border bg-surface px-3 py-2 text-base text-text focus:border-harbor-400 focus:outline-none"
                  />
                  <button onClick={submitAnswer} disabled={!answer.trim()} className="mt-3 w-full rounded-[--radius-md] bg-primary py-2.5 text-sm font-semibold text-on-primary hover:bg-primary-hover disabled:opacity-40">
                    Send &amp; continue
                  </button>
                </div>
              )}

              {/* Sensitive handoff */}
              {phase === "handoff" && handoff && (
                <div className="mt-4 rounded-[--radius-md] border-2 border-review-100 bg-review-50 p-4">
                  {handoff.kind === "consent" ? (
                    <>
                      <p className="text-sm font-semibold text-review-700">Talk to your attorney before you agree</p>
                      <p className="mt-1 text-sm text-review-700">
                        This form has a legal agreement to accept (&ldquo;{handoff.label}&rdquo;). Because it can affect your immigration case, <strong>please reach out to your attorney or a DOJ-accredited representative before you check this box and continue.</strong>
                      </p>
                      <div className="mt-2 rounded-[--radius-md] border border-review-100 bg-surface px-3 py-2 text-sm">
                        <p className="font-semibold text-text">Iowa Migrant Movement for Justice — legal aid</p>
                        <p className="text-text-muted">(515) 255-9809 · info@iowammj.org</p>
                        <p className="mt-1 text-xs text-text-faint">You can find more legal help in the Find Help tab.</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-review-700">This field is sensitive: {handoff.label}</p>
                      <p className="mt-1 text-sm text-review-700">{handoff.reason} We&apos;ve highlighted it in the portal tab. Please enter it there yourself, then resume.</p>
                    </>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => agent.focusPortal()} className="flex-1 rounded-[--radius-md] border-2 border-review-100 bg-surface py-2.5 text-sm font-semibold text-review-700 hover:bg-review-50">
                      Open the portal
                    </button>
                    <button onClick={resumeFromHandoff} className="flex-1 rounded-[--radius-md] bg-primary py-2.5 text-sm font-semibold text-on-primary hover:bg-primary-hover">
                      {handoff.kind === "consent" ? "I've spoken with them — Continue" : "I've filled it in — Continue"}
                    </button>
                  </div>
                </div>
              )}

              {/* Account / sign-in wall — the user must create an account (or sign
                  in) on the site, then resume. Reuses the standard resume path so
                  the agent re-snapshots and re-plans where it left off. */}
              {phase === "login" && (
                <div className="mt-4 rounded-[--radius-md] border-2 border-harbor-200 bg-harbor-50 p-4">
                  <p className="text-sm font-semibold text-text">{af.createAccountTitle}</p>
                  <p className="mt-1 text-sm text-text-muted">{af.createAccountBody}</p>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => agent.focusPortal()} className="flex-1 rounded-[--radius-md] border-2 border-harbor-300 bg-surface py-2.5 text-sm font-semibold text-harbor-700 hover:bg-harbor-50">
                      {af.openPortal}
                    </button>
                    <button onClick={resumeFromHandoff} className="flex-1 rounded-[--radius-md] bg-primary py-2.5 text-sm font-semibold text-on-primary hover:bg-primary-hover">
                      {af.createAccountResume}
                    </button>
                  </div>
                </div>
              )}

              {/* reCAPTCHA hand-off */}
              {phase === "captcha" && (
                <div className="mt-4 rounded-[--radius-md] border-2 border-review-100 bg-review-50 p-4">
                  <p className="text-sm font-semibold text-text">Please complete the reCAPTCHA yourself</p>
                  <p className="mt-1 text-sm text-text-muted">
                    This page has a &ldquo;verify you&apos;re not a robot&rdquo; check that only you can do. <strong>Please complete it yourself in the portal tab</strong> — I can&apos;t do this part. When you&apos;re finished, click below and I&apos;ll continue.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => agent.focusPortal()} className="flex-1 rounded-[--radius-md] border-2 border-review-100 bg-surface py-2.5 text-sm font-semibold text-review-700 hover:bg-review-50">
                      Open the portal
                    </button>
                    <button onClick={resumeFromCaptcha} className="flex-1 rounded-[--radius-md] bg-primary py-2.5 text-sm font-semibold text-on-primary hover:bg-primary-hover">
                      I&apos;ve filled it out — Continue
                    </button>
                  </div>
                </div>
              )}

              {/* Page couldn't be read — likely a verification step (reCAPTCHA)
                  or the page is still loading. Hand it to the user to finish,
                  then resume right where we left off (same path as captcha). */}
              {phase === "unreachable" && (
                <div className="mt-4 rounded-[--radius-md] border-2 border-review-100 bg-review-50 p-4">
                  <p className="text-sm font-semibold text-text">I can&apos;t read this page</p>
                  <p className="mt-1 text-sm text-text-muted">
                    The page didn&apos;t respond — it may still be loading, or it may have a step only you can do (like a &ldquo;verify you&apos;re not a robot&rdquo; check). <strong>Open the portal tab, finish anything it&apos;s asking for, and let it finish loading</strong> — then click Continue and I&apos;ll pick up where I left off.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => agent.focusPortal()} className="flex-1 rounded-[--radius-md] border-2 border-review-100 bg-surface py-2.5 text-sm font-semibold text-review-700 hover:bg-review-50">
                      Open the portal
                    </button>
                    <button onClick={resumeFromCaptcha} className="flex-1 rounded-[--radius-md] bg-primary py-2.5 text-sm font-semibold text-on-primary hover:bg-primary-hover">
                      Continue
                    </button>
                  </div>
                </div>
              )}

              {/* Review-and-submit gate. The agent never submits; before we send
                  the user to the official site to submit, they must review the
                  information Wayfinder used and confirm it — plus confirm an
                  attorney reviewed it, when the form needs one. The "continue"
                  button stays locked until those boxes are checked. */}
              {(phase === "review" || phase === "done") && (
                <div className="mt-4 rounded-[--radius-md] border-2 border-success-100 bg-success-50 p-4">
                  <p className="text-sm font-semibold text-success-700">{af.reviewTitle}</p>
                  <p className="mt-1 text-sm text-success-700">{af.reviewIntro}</p>

                  <div className="mt-3 rounded-[--radius-md] border border-success-100 bg-surface p-3">
                    <p className="mb-2 text-xs font-bold uppercase tracking-wider text-text-muted">{af.reviewInfoTitle}</p>
                    {infoRows.length === 0 ? (
                      <p className="text-sm text-text-muted">{af.reviewNoInfo}</p>
                    ) : (
                      <dl className="flex flex-col gap-1.5">
                        {infoRows.map((r) => (
                          <div key={r.label} className="flex justify-between gap-3 text-sm">
                            <dt className="text-text-muted">{r.label}</dt>
                            <dd className="text-right font-medium text-text">{r.value}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </div>

                  <label className="mt-3 flex items-start gap-2.5 text-sm text-text">
                    <input
                      type="checkbox"
                      checked={reviewedConfirmed}
                      onChange={(e) => setReviewedConfirmed(e.target.checked)}
                      className="mt-0.5 h-4 w-4 flex-shrink-0 accent-success-600"
                    />
                    <span>{af.reviewConfirm}</span>
                  </label>

                  {attorneyNeeded && (
                    <>
                      <div className="mt-2 rounded-[--radius-md] border border-review-100 bg-review-50 px-3 py-2 text-sm text-review-700">
                        {af.attorneyNote}
                      </div>
                      <label className="mt-2 flex items-start gap-2.5 text-sm text-text">
                        <input
                          type="checkbox"
                          checked={attorneyConfirmed}
                          onChange={(e) => setAttorneyConfirmed(e.target.checked)}
                          className="mt-0.5 h-4 w-4 flex-shrink-0 accent-success-600"
                        />
                        <span>{af.attorneyConfirm}</span>
                      </label>
                    </>
                  )}

                  <button
                    onClick={() => agent.focusPortal()}
                    disabled={!canSubmit}
                    className="mt-3 w-full rounded-[--radius-md] bg-success-600 py-2.5 text-sm font-semibold text-white transition hover:bg-success-700 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {af.proceedToSubmit}
                  </button>
                  <p className="mt-2 text-center text-xs text-text-faint">{af.neverSubmitNote}</p>
                </div>
              )}

              {phase === "error" && (
                <div className="mt-4 rounded-[--radius-md] border border-danger-100 bg-danger-50 px-4 py-3 text-sm text-danger-700">
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer / controls */}
        <div className="border-t border-border px-5 py-4">
          {phase === "ready" && (
            <button onClick={start} className="w-full rounded-[--radius-md] bg-primary py-3 text-base font-semibold text-on-primary shadow-sm hover:bg-primary-hover">
              Start filling {benefitName}
            </button>
          )}
          {(phase === "error" || phase === "done") && (
            <button onClick={start} className="w-full rounded-[--radius-md] border-2 border-harbor-300 bg-surface py-3 text-base font-semibold text-harbor-700 hover:bg-harbor-50">
              {phase === "error" ? "Try again" : "Run again"}
            </button>
          )}
          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-text-faint">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            Wayfinder never enters sensitive info or submits for you.
          </p>
        </div>
      </div>
    </div>
  );
}
