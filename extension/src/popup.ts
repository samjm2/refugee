// Extension popup script.

const content = document.getElementById("content")!;

function html(s: string) {
  content.innerHTML = s;
}

async function init() {
  const res = await chrome.runtime.sendMessage({ type: "get-pairing-status" }) as {
    paired: boolean; pairedAt?: number;
  };

  if (!res.paired) {
    renderUnpaired();
  } else {
    renderPaired(res.pairedAt);
  }
}

function renderUnpaired() {
  html(`
    <p class="status">Connect to your Wayfinder account to fill forms automatically.</p>
    <button class="btn btn-primary" id="btn-pair">Connect Wayfinder Account</button>
  `);
  document.getElementById("btn-pair")!.addEventListener("click", startPairing);
}

function renderPaired(pairedAt?: number) {
  const date = pairedAt ? new Date(pairedAt).toLocaleDateString() : "Unknown";
  html(`
    <div class="success">✓ Connected to Wayfinder</div>
    <p class="paired-info">Paired on ${date}</p>
    <button class="btn btn-primary" id="btn-fill" style="margin-top:12px">Fill Detected Fields</button>
    <button class="btn btn-secondary" id="btn-disconnect">Disconnect</button>
  `);
  document.getElementById("btn-fill")!.addEventListener("click", fillCurrentPage);
  document.getElementById("btn-disconnect")!.addEventListener("click", disconnect);
}

async function startPairing() {
  const btn = document.getElementById("btn-pair") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Opening Wayfinder...";

  // Ask the background to fetch a code (proxy to the app).
  // The user must be logged in on the Wayfinder tab.
  try {
    // Direct user to Wayfinder settings to get a code — show code entry here.
    html(`
      <p class="status">Go to <strong>Wayfinder &gt; Settings</strong> and click "Connect browser extension". Enter the code shown there:</p>
      <div style="margin: 12px 0;">
        <input id="code-input" type="text" maxlength="8" placeholder="e.g. AB1C2D3E" style="width:100%;padding:10px;border:2px solid #e5e7eb;border-radius:8px;font-family:monospace;font-size:18px;letter-spacing:3px;text-align:center;text-transform:uppercase" />
      </div>
      <button class="btn btn-primary" id="btn-exchange">Confirm Code</button>
      <button class="btn btn-secondary" id="btn-cancel-pair">Cancel</button>
    `);
    document.getElementById("btn-exchange")!.addEventListener("click", () => {
      const code = (document.getElementById("code-input") as HTMLInputElement).value.trim().toUpperCase();
      void exchangeCode(code);
    });
    document.getElementById("btn-cancel-pair")!.addEventListener("click", renderUnpaired);
    document.getElementById("code-input")!.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        const code = (document.getElementById("code-input") as HTMLInputElement).value.trim().toUpperCase();
        void exchangeCode(code);
      }
    });
  } catch (err) {
    html(`<div class="error">Error: ${String(err)}</div>`);
    renderUnpaired();
  }
}

async function exchangeCode(code: string) {
  if (!code) return;
  const btn = document.getElementById("btn-exchange") as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = "Connecting..."; }

  const res = await chrome.runtime.sendMessage({ type: "exchange-code", code }) as {
    ok: boolean; error?: string;
  };

  if (!res.ok) {
    html(`<div class="error">Could not connect: ${res.error ?? "Unknown error"}</div>`);
    setTimeout(renderUnpaired, 2000);
  } else {
    renderPaired(Date.now());
  }
}

async function fillCurrentPage() {
  const btn = document.getElementById("btn-fill") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Loading your profile...";

  const profileRes = await chrome.runtime.sendMessage({ type: "get-profile-values" }) as {
    ok: boolean; values?: Record<string, string>; error?: string;
  };

  if (!profileRes.ok || !profileRes.values) {
    html(`<div class="error">${profileRes.error ?? "Failed to load profile"}</div>`);
    setTimeout(() => renderPaired(), 2500);
    return;
  }

  btn.textContent = "Filling fields...";
  const fillRes = await chrome.runtime.sendMessage({ type: "fill-fields", values: profileRes.values }) as {
    ok: boolean; filled?: number; error?: string;
  };

  if (!fillRes.ok) {
    html(`<div class="error">${fillRes.error ?? "Fill failed"}</div>`);
    setTimeout(() => renderPaired(), 2500);
  } else {
    html(`
      <div class="success">✓ Filled ${fillRes.filled ?? 0} field${(fillRes.filled ?? 0) !== 1 ? "s" : ""}</div>
      <p style="margin-top:8px;font-size:12px;color:#6b7280">Review every field before submitting. Sensitive fields (SSN, A-number) were skipped.</p>
      <button class="btn btn-secondary" id="btn-back" style="margin-top:12px">Back</button>
    `);
    document.getElementById("btn-back")!.addEventListener("click", () => renderPaired(Date.now()));
  }
}

async function disconnect() {
  await chrome.runtime.sendMessage({ type: "disconnect" });
  renderUnpaired();
}

void init();
