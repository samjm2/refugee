# Publishing the Wayfinder extension to the Chrome Web Store

This gets judges a one-click **"Add to Chrome"** link (no developer-mode, no unzip).
Only YOU can do the submission (it needs your Google account + a one-time $5 fee).
The package is already built and store-ready: `wayfinder-extension.zip` (repo root).

## Steps (~15 min of your time, then Google review)
1. Go to the **Chrome Web Store Developer Dashboard**:
   https://chrome.google.com/webstore/devconsole
2. Pay the **one-time $5** developer registration fee (first time only).
3. Click **"Add new item"** → upload **`wayfinder-extension.zip`**.
4. Fill in the listing (copy below).
5. Under **Visibility**, choose **"Unlisted"** — it won't show in search, but anyone
   with the link can install it. Perfect for judges.
6. Submit for review. Approval is usually a few hours to a few days.
7. Share the resulting **"Add to Chrome"** link with judges.

## Before you submit — check the app domain
The extension talks to the Wayfinder web app via two entries in `manifest.json`:
- `host_permissions` and the first `content_scripts.matches`.

They currently list `https://wayfinder.app/*` (and `http://localhost:3000/*` for dev).
**If your deployed app is on a different domain** (e.g. a Vercel URL), add that domain
to BOTH places, rebuild (`npm run build`), and re-zip, or pairing won't connect.

## Listing copy (paste into the dashboard)
**Name:** Wayfinder Form Filler

**Summary (132 char max):**
Pre-fill U.S. government benefit forms from your Wayfinder profile. You always review and submit yourself.

**Description:**
Wayfinder helps refugees and immigrants apply for U.S. benefits. This companion
extension lets Wayfinder fill out official government benefit applications in your
browser using the information you already saved — so you don't retype it on every
form.

• Fills only non-sensitive fields. Your SSN, A-Number, passwords, verification codes,
  and consent checkboxes are never filled — you enter those yourself.
• Never submits anything. It stops at the review step; you review and submit.
• Pauses for CAPTCHAs and sign-ins so you complete them yourself.
• Your data stays in your browser; the extension only relays the non-sensitive facts
  needed to fill a field.

**Why the broad site permission?**
The extension can fill benefit applications on any government website you navigate to
(state portals like Iowa HHS, etc.), so it requests access to the pages you visit
while applying. It only reads/fills the form on the page you're actively using.

**Category:** Productivity
**Privacy:** Single purpose = "assist the user in filling out government benefit forms."
No data is sold or sent to third parties; sensitive identifiers are never collected.
