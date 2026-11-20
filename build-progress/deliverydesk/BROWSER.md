# DeliveryDesk · Browser acceptance check

This check replays the documented normal-browser E7 journey against a fresh,
disposable local app. It does not call the provider emulator, a live payment
rail, Kite Passport, a real refund provider, or any paid service.

## Prerequisites

- Node `>=22.18`
- `npm ci` in this checkout (installs `playwright-core`; no Playwright browser download is required)
- A Chrome/Chromium executable. Resolution order:
  1. `DD_BROWSER_PATH`
  2. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
  3. `CHROME_PATH`
  4. `~/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`
  5. `~/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`
  6. Playwright Chromium 1254, Google Chrome, Chromium, or common Linux paths

## Runnable command

```bash
npm ci
npm run check:browser
```

With an explicit browser:

```bash
DD_BROWSER_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
  npm run check:browser
```

Optional evidence destination:

```bash
DD_BROWSER_EVIDENCE_OUT=build-progress/deliverydesk/evidence/browser-e7.json \
  npm run check:browser
```

## What the check does

- Creates `data/browser-check-*` as a disposable SQLite/artifact directory.
- Chooses an ephemeral localhost port.
- Runs `src/bin/seed.ts` for merchant `pilot`, order `E7`, 250 USD cents, revision 4, and the 3 KB deterministic artifact.
- Starts `src/bin/serve.ts --web-only`.
- Drives Chromium through `/` → `/login` → `/buyer`.
- Signs in as buyer A through the form.
- Opens the E7 recovery case through the browser form.
- Issues a short-lived grant through `Recover original export`.
- Downloads `deliverydesk-export-*.bin` through the real browser download path.
- Verifies `3072` bytes and SHA-256 `f05364b6…da51`.
- Confirms receipt through the normal form and reloads the delivered case.
- Signs in as the operator in a separate browser context and opens E7 from `/console`.
- Verifies the payment → export → retrieval → authenticated-delivery timeline order.
- Opens the operator-only provider receipt evidence.
- Checks buyer B receives a visible `Access denied` HTML page for buyer A's case.
- Checks a buyer receives a visible `Sign in required` HTML page for `/console`.
- Checks visible keyboard focus and retrieval controls.
- Checks the delivered page at `320×568` for horizontal overflow and visible focus.
- Removes the temporary data directory.
- Writes redacted evidence to `build-progress/deliverydesk/evidence/browser-e7.json`.

No bearer token, grant token, provider secret, or temporary data path is written to the evidence file.

## Current execution result

In this command sandbox, Chromium was present at the requested Playwright cache
path but could not bootstrap its macOS process services (`MachPortRendezvousServer`, permission denied). The local evidence file records that launch block and the check exits non-zero. The UI form path is covered by `normal browser forms recover, download and acknowledge delivery` in `test/m06-console.test.ts`; replay the command above on the host to produce browser evidence.

Provider and human gates remain separate: this check proves only the local web UI and `local-emulator` fixture.
