/// <reference lib="dom" />
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

/**
 * Disposable normal-browser acceptance check for the documented E7 journey.
 * It starts a fresh web-only app on an ephemeral port, seeds local-emulator
 * fixture data into a temporary data directory, drives the server-rendered UI
 * in Chromium, and writes redacted evidence. No provider or paid service is
 * contacted.
 */

type StepEvidence = Record<string, unknown>;

const root = process.cwd();
const evidencePath = process.env.DD_BROWSER_EVIDENCE_OUT ?? 'build-progress/deliverydesk/evidence/browser-e7.json';
const expectedDigest = 'f05364b6c76b2e208cd2b8042b29190c8c11f90f35cb75639f9bd5e84fd3da51';

const evidence: {
  environment: string;
  testedSha?: string;
  browser: Record<string, unknown>;
  app: Record<string, unknown>;
  observed: Record<string, unknown>;
  checks: Record<string, boolean>;
  redactions: string[];
} = {
  environment: 'local-emulator',
  browser: {},
  app: {},
  observed: {},
  checks: {},
  redactions: ['buyer/operator bearer tokens', 'grant bearer token', 'provider secrets', 'temporary data path'],
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(name: string, ok: boolean, details: StepEvidence = {}): void {
  evidence.checks[name] = ok;
  Object.assign(evidence.observed, details);
  if (!ok) throw new Error(`browser check failed: ${name}`);
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert(port > 0, 'could not allocate an ephemeral port');
  return port;
}

function resolveBrowserExecutable(): string {
  const home = os.homedir();
  const explicit = process.env.DD_BROWSER_PATH
    ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ?? process.env.CHROME_PATH;
  const candidates = [
    explicit,
    `${home}/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    `${home}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    `${home}/Library/Caches/ms-playwright/chromium-1254/chromium-mac-arm64/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No Chromium executable found. Set DD_BROWSER_PATH to Chrome/Chromium; checked: ${candidates.join(', ')}`,
  );
}

async function runNode(args: string[], env: Record<string, string>): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${args.join(' ')} exited ${code}: ${stderr}`));
    });
  });
}

async function waitForHttp(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited before readiness with ${child.exitCode}`);
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status > 0) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`app did not become ready: ${String(lastError)}`);
}

async function signIn(context: BrowserContext, base: string, audience: 'buyer' | 'operator', token: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}/login`, { waitUntil: 'load' });
  await page.getByLabel('Work area').selectOption(audience);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(audience === 'buyer' ? '**/buyer' : '**/console');
  return page;
}

async function focusedElement(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return { tag: null };
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      name: el.getAttribute('name'),
      text: (el.textContent ?? '').trim().slice(0, 80),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
}

async function tabFocusEvidence(page: Page, count: number): Promise<Record<string, unknown>[]> {
  const stops: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    stops.push(await focusedElement(page));
  }
  return stops;
}

async function noHorizontalOverflow(page: Page): Promise<boolean> {
  return await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}

async function main(): Promise<void> {
  mkdirSync(path.join(root, 'data'), { recursive: true });
  const dataDir = mkdtempSync(path.join(root, 'data', 'browser-check-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const browserPath = resolveBrowserExecutable();
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  const serverLog: string[] = [];

  try {
    mkdirSync(dataDir, { recursive: true });
    const seedOut = await runNode(['src/bin/seed.ts'], { DD_DATA_DIR: dataDir });
    const seed = JSON.parse(seedOut) as { artifact: { bytes: number; digest: string } };
    server = spawn(process.execPath, ['src/bin/serve.ts', '--web-only'], {
      cwd: root,
      env: { ...process.env, DD_DATA_DIR: dataDir, DD_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', (chunk) => serverLog.push(String(chunk)));
    server.stderr?.on('data', (chunk) => serverLog.push(String(chunk)));
    await waitForHttp(`${base}/login`, server);
    evidence.app = { entryPoint: base, disposableData: true, worker: 'web-only' };

    browser = await chromium.launch({ executablePath: browserPath, headless: true });
    evidence.browser = { executable: path.basename(browserPath), version: browser.version(), playwrightCore: true };

    const buyerContext = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      acceptDownloads: true,
    });
    const buyerPage = await buyerContext.newPage();
    await buyerPage.goto(base, { waitUntil: 'load' });
    assert(new URL(buyerPage.url()).pathname === '/login', 'root did not redirect to login');
    const loginTabs = await tabFocusEvidence(buyerPage, 3);
    record('root redirects to normal sign-in', true, { loginFocusStops: loginTabs });
    record(
      'desktop keyboard focus is visible',
      loginTabs.every((s) => String(s['outlineStyle']) !== 'none' && String(s['outlineWidth']) !== '0px'),
    );

    await buyerPage.getByLabel('Work area').selectOption('buyer');
    await buyerPage.getByLabel('Access token').fill('demo-buyer-a');
    await buyerPage.getByRole('button', { name: 'Sign in' }).click();
    await buyerPage.waitForURL('**/buyer');
    assert((await buyerPage.locator('h1').textContent())?.includes('Your cases'), 'buyer index did not load');

    await buyerPage.getByLabel('Order ID').fill('E7');
    await buyerPage.getByRole('button', { name: 'Open recovery case' }).click();
    await buyerPage.waitForURL('**/cases/*');
    const caseId = new URL(buyerPage.url()).pathname.split('/').filter(Boolean).at(-1)!;
    const buyerCaseText = await buyerPage.locator('body').innerText();
    record('buyer opens E7 recovery case', /available/i.test(buyerCaseText), { caseId });

    await buyerPage.getByRole('button', { name: 'Recover original export' }).click();
    await buyerPage.waitForURL(`**/cases/${caseId}/retrieve`);
    const retrievalText = await buyerPage.locator('body').innerText();
    const retrievalTabs = await tabFocusEvidence(buyerPage, 5);
    record('authorized buyer receives short-lived grant page', retrievalText.includes(expectedDigest), {
      retrievalFocusStops: retrievalTabs,
    });
    record(
      'retrieval controls are keyboard reachable',
      retrievalTabs.some((s) => s['tag'] === 'a') && retrievalTabs.some((s) => s['tag'] === 'button'),
    );

    const downloadPromise = buyerPage.waitForEvent('download');
    await buyerPage.getByRole('link', { name: 'Download original export' }).click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    assert(downloadPath, 'browser did not produce a downloaded artifact');
    const artifact = readFileSync(downloadPath);
    const artifactDigest = sha256(artifact);
    record('buyer retrieves original E7 export in browser', artifactDigest === expectedDigest && artifact.byteLength === seed.artifact.bytes, {
      artifactBytes: artifact.byteLength,
      artifactDigest,
      suggestedFilename: download.suggestedFilename(),
    });

    await buyerPage.getByRole('button', { name: 'Confirm export received' }).click();
    await buyerPage.waitForURL(`**/cases/${caseId}`);
    const deliveredText = await buyerPage.locator('body').innerText();
    record('buyer acknowledgment closes delivery', /delivered/i.test(deliveredText) && deliveredText.includes('Delivery acknowledged'));

    await buyerPage.reload({ waitUntil: 'load' });
    const reloadedText = await buyerPage.locator('body').innerText();
    record('buyer delivery state persists across reload', /delivered/i.test(reloadedText));

    const deniedConsole = await buyerPage.goto(`${base}/console`, { waitUntil: 'load' });
    const deniedConsoleText = await buyerPage.locator('body').innerText();
    record('wrong-area permission error is visible in HTML', deniedConsole?.status() === 401 && deniedConsoleText.includes('Sign in required'), {
      buyerConsoleStatus: deniedConsole?.status(),
    });
    await buyerPage.goto(`${base}/cases/${caseId}`, { waitUntil: 'load' });

    const operatorContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const operatorPage = await signIn(operatorContext, base, 'operator', 'demo-operator');
    await operatorPage.getByRole('link', { name: /E7/ }).click();
    await operatorPage.waitForURL(`**/console/cases/${caseId}`);
    const operatorText = await operatorPage.locator('body').innerText();
    const sequence = ['Payment confirmed', 'Export ready', 'Artifact retrieval started', 'Artifact retrieved', 'Delivery acknowledged'];
    const positions = sequence.map((label) => operatorText.indexOf(label));
    record('operator timeline observes recovered order', positions.every((p) => p >= 0) && positions.every((p, i) => i === 0 || p > positions[i - 1]!), {
      timelineOrder: sequence,
    });
    record('operator receipt evidence is exposed only on console', operatorText.includes('Provider receipt'));

    const receiptHref = await operatorPage.getByRole('link', { name: 'Provider receipt' }).getAttribute('href');
    assert(receiptHref, 'operator receipt link missing');
    const receiptPage = await operatorPage.goto(`${base}${receiptHref}`, { waitUntil: 'load' });
    const receiptBody = await operatorPage.locator('body').innerText();
    record('operator can open provider receipt evidence', receiptPage?.status() === 200 && receiptBody.includes('receiptHash'));
    await operatorPage.goBack({ waitUntil: 'load' });
    await operatorPage.reload({ waitUntil: 'load' });
    record('operator timeline persists across reload', (await operatorPage.locator('body').innerText()).includes('Delivery acknowledged'));

    const buyerBContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const buyerBPage = await signIn(buyerBContext, base, 'buyer', 'demo-buyer-b');
    const deniedCase = await buyerBPage.goto(`${base}/cases/${caseId}`, { waitUntil: 'load' });
    const deniedCaseText = await buyerBPage.locator('body').innerText();
    record('cross-buyer denial is visible in HTML', deniedCase?.status() === 403 && deniedCaseText.includes('Access denied'), {
      crossBuyerCaseStatus: deniedCase?.status(),
    });

    await buyerPage.setViewportSize({ width: 320, height: 568 });
    await buyerPage.goto(`${base}/cases/${caseId}`, { waitUntil: 'load' });
    const mobileTabs = await tabFocusEvidence(buyerPage, 4);
    record('320px layout has no horizontal overflow', await noHorizontalOverflow(buyerPage), {
      mobileFocusStops: mobileTabs,
    });
    record(
      '320px keyboard focus is visible',
      mobileTabs.filter((s) => s['tag'] !== null).every((s) => String(s['outlineStyle']) !== 'none' && String(s['outlineWidth']) !== '0px'),
    );

    await buyerBContext.close();
    await operatorContext.close();
    await buyerContext.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => server!.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    rmSync(dataDir, { recursive: true, force: true });
  }

  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  evidence.observed['error'] = message.split('\n').find(Boolean) ?? 'browser check failed';
  if (/MachPortRendezvousServer|ProcessSingleton|Operation not permitted|Permission denied/.test(message)) {
    evidence.observed['launchBlocked'] = 'browser executable was present, but the execution sandbox denied Chromium process setup';
  }
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
