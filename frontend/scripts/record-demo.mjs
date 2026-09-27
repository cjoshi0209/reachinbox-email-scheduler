/**
 * Records the assignment demo video against the LIVE stack (API + worker + Next.js).
 *
 *   node scripts/record-demo.mjs <your-google-email>
 *
 * The user must have logged in with Google once (so the account exists); the script signs a
 * session for it with the backend's own helper, because Google's consent screen can't be
 * automated. Output: ../docs/demo.webm
 */
import { chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, openSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const backend = path.join(root, 'backend');
const email = process.argv[2];
if (!email) throw new Error('usage: node scripts/record-demo.mjs <google-email>');
const APP = 'http://localhost:3000';
const API = 'http://localhost:4000';
const BACKEND_LOG = path.join(root, '.infra', 'backend-demo.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { token } = JSON.parse(execSync(`npx tsx tests/helpers/testUser.ts ${email}`, { cwd: backend, encoding: 'utf8' }).trim().split('\n').pop());

// Run the backend under this script so its log (Slack / rate-limit lines) is ours.
stopBackend();
await startBackend();

const videoDir = path.join(root, '.infra', 'video');
rmSync(videoDir, { recursive: true, force: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 760 }, recordVideo: { dir: videoDir, size: { width: 1280, height: 760 } } });
const page = await context.newPage();

async function caption(text, ms = 3500) {
  await page.evaluate((t) => {
    if (!document.body) return;
    let el = document.getElementById('__demo_caption');
    if (!el) {
      el = document.createElement('div');
      el.id = '__demo_caption';
      el.style.cssText =
        'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483647;max-width:1100px;' +
        'background:rgba(17,24,39,.92);color:#fff;font:600 17px/1.45 Inter,system-ui,sans-serif;padding:12px 20px;' +
        'border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.25);text-align:center;pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text).catch(() => undefined);
  await sleep(ms);
}

async function card(title, lines, ms = 5000) {
  await page.setContent(`<body style="margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;
    background:linear-gradient(135deg,#0f172a,#14532d);color:#fff;font-family:Inter,system-ui,sans-serif;text-align:center">
    <h1 style="font-size:44px;margin:0 0 18px">${title}</h1>
    ${lines.map((l) => `<p style="font-size:21px;margin:6px 0;opacity:.9">${l}</p>`).join('')}</body>`);
  await sleep(ms);
}

async function goto(url, text, ms) {
  await page.goto(url, { waitUntil: 'networkidle' }).catch(() => undefined);
  if (text) await caption(text, ms);
}

function backendLog() {
  try {
    return readFileSync(BACKEND_LOG, 'utf8');
  } catch {
    return '';
  }
}

function stopBackend() {
  execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'src[\\\\/](server|worker)\\.ts|concurrently|dev:api|dev:worker' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
    { stdio: 'ignore' },
  );
}

async function startBackend() {
  const out = openSync(BACKEND_LOG, 'a');
  spawn('npm run dev', { cwd: backend, shell: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(1000);
  }
  throw new Error('backend did not come back');
}

async function waitForSent(subject, n, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await page.request.get(`${APP}/api/emails/search?q=${encodeURIComponent(subject)}&status=sent&limit=50`);
    const body = await res.json().catch(() => ({ total: 0 }));
    if (body.total >= n) return;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${n} sent: ${subject}`);
}

async function uploadCsv() {
  await page.getByTestId('csv-input').setInputFiles(path.join(root, 'samples', 'leads.csv'));
}

// ---------------------------------------------------------------- 1. intro + login
await card('ReachInbox — Email Job Scheduler', [
  'Express + TypeScript · BullMQ delayed jobs on Redis (no cron) · PostgreSQL + Prisma',
  'Ethereal SMTP · Elasticsearch search · Bull Board · Google OAuth · Slack OAuth',
  'Next.js + Tailwind dashboard built from the Figma',
]);
await goto(`${APP}/login`, 'Login page (Figma). Authentication is real Google OAuth 2.0 — no mock login.', 4000);
await page.getByRole('link', { name: 'Login with Google' }).click();
await page.waitForURL(/accounts\.google\.com/, { timeout: 15000 }).catch(() => undefined);
await caption('"Login with Google" → Google consent screen for our OAuth client (ID token verified server-side).', 4500);

await context.addCookies([{ name: 'rb_session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
await goto(`${APP}/dashboard`, 'Signed in: the header shows the Google name, email and avatar. Tabs: Scheduled / Sent, plus Compose.', 4500);
await page.getByTestId('user-menu').click();
await caption('User menu: live Bull Board link and Logout.', 3000);
await page.keyboard.press('Escape');

// ---------------------------------------------------------------- 2. compose
await page.getByRole('link', { name: 'Compose' }).first().click();
await page.waitForURL(/compose/);
await caption('Compose (Figma): sender, recipients, subject, delay between emails, hourly limit, body.', 3500);
await page.getByTestId('sender-select').click();
await page.getByRole('button', { name: 'New Ethereal sender' }).click();
await page.getByRole('dialog').getByRole('textbox').fill('Demo Sender');
await caption('Multiple senders: each gets its own real Ethereal SMTP inbox (credentials stored AES-256-GCM encrypted).', 3000);
await page.getByRole('dialog').getByRole('button', { name: 'Create sender' }).click();
await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 30000 });
await sleep(1500);
await uploadCsv();
await caption('CSV upload: 7 unique emails detected (1 duplicate removed, 1 invalid skipped).', 4000);
const subject = `Demo campaign ${new Date().toTimeString().slice(0, 5)}`;
await page.getByLabel('Subject').fill(subject);
await page.getByLabel('Email body').fill('Hi there,\n\nThis email was scheduled from the ReachInbox dashboard and delivered by a BullMQ worker via Ethereal SMTP.\n\nCheers!');
await page.locator('#delay').fill('3');
await page.locator('#hourly').fill('3');
await caption('Delay 3 s between emails, hourly limit 3 — so the limit will be hit and 4 emails must be rescheduled.', 4000);
await page.getByRole('button', { name: 'Schedule for later' }).click();
await caption('"Send Later" popover (Figma) for a custom start time — this campaign starts now instead.', 3000);
await page.getByRole('button', { name: 'Cancel' }).click();
await page.getByTestId('submit-schedule').click();
await page.waitForURL(/dashboard$/);
await caption('Saved in one Postgres transaction, then one BullMQ delayed job per email (deterministic job id = idempotency).', 4500);

// ---------------------------------------------------------------- 3. bull board
await goto(`${API}/admin/queues/queue/email-send?status=delayed`, 'Bull Board (protected: login session or basic auth) — live view of the BullMQ queue.', 5000);

// ---------------------------------------------------------------- 4. sent + limit
await goto(`${APP}/dashboard/sent`);
await caption('Worker sends them: ≥ 2 s apart per sender (distributed min-delay in Redis), concurrency 5…', 2000);
await waitForSent(subject, 3);
await page.reload({ waitUntil: 'networkidle' });
await caption('Sent tab: 3 delivered — exactly the hourly limit.', 3500);
await page.locator('[data-testid=email-row]').first().click();
await page.waitForURL(/emails\//);
await caption('Email detail: timestamps, attempts, campaign settings and the Ethereal preview link.', 4000);
const preview = await page.getByRole('link', { name: /Open in Ethereal/ }).getAttribute('href');
if (preview) {
  await goto(preview);
  if (!/login/.test(page.url())) await caption('The real message captured by Ethereal SMTP.', 4500);
}
await goto(`${APP}/dashboard`, 'Hourly limit reached → the other 4 are NOT dropped: rescheduled into the next hour windows, in order ("Rescheduled").', 6000);

const slackLines = backendLog()
  .split('\n')
  .filter((l) => /Hourly limit reached|Slack notification sent/.test(l))
  .slice(-5)
  .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim());
await card('Slack alert — sent the moment the limit was hit', [
  'User connected Slack via real OAuth (incoming-webhook + chat:write) from the sidebar.',
  'One Block Kit message per sender per hour window was posted to #new-channel:',
  '“Hourly send limit reached · Sender · Limit: 3 emails / hour · Next send … · No emails were dropped”',
  ...slackLines.map((l) => `<code style="font-size:15px;opacity:.8">${l.slice(0, 110)}</code>`),
], 7000);

// ---------------------------------------------------------------- 5. restart
await goto(`${APP}/compose`);
await uploadCsv();
await page.getByRole('button', { name: 'Clear all' }).click();
await page.getByLabel('Recipients').fill('restart-a@example.com, restart-b@example.com,');
await page.getByLabel('Recipients').press('Enter');
const restartSubject = `Restart proof ${new Date().toTimeString().slice(0, 8)}`;
await page.getByLabel('Subject').fill(restartSubject);
await page.getByLabel('Email body').fill('Scheduled before the backend was stopped.');
const sendAt = new Date(Date.now() + 75_000);
sendAt.setSeconds(0, 0);
if (sendAt.getTime() - Date.now() < 55_000) sendAt.setMinutes(sendAt.getMinutes() + 1);
await page.getByRole('button', { name: 'Schedule for later' }).click();
const pad = (n) => String(n).padStart(2, '0');
await page.getByTestId('send-later-input').fill(`${sendAt.getFullYear()}-${pad(sendAt.getMonth() + 1)}-${pad(sendAt.getDate())}T${pad(sendAt.getHours())}:${pad(sendAt.getMinutes())}`);
await page.getByRole('button', { name: 'Done' }).click();
await caption(`Restart test: 2 emails scheduled for ${sendAt.toLocaleTimeString()}.`, 3500);
await page.getByTestId('submit-schedule').click();
await page.waitForURL(/dashboard$/);
await caption('Now stopping the API and the worker processes (simulating a crash/redeploy)…', 3000);
stopBackend();
await goto(`${API}/health`);
await caption('Backend is down (connection refused). The delayed jobs are persisted in Redis (AOF) and the rows in Postgres.', 5000);
await card('Backend stopped', [`Emails due at ${sendAt.toLocaleTimeString()}`, 'Starting API + worker again…'], 4000);
await startBackend();
await goto(`${API}/health`, 'Back up. Worker start-up reconciliation runs once (no polling): any missing job would be re-created.', 5000);
await goto(`${APP}/dashboard`, `Still scheduled for ${sendAt.toLocaleTimeString()} — not re-sent, not restarted from scratch.`, 3000);
while (Date.now() < sendAt.getTime() - 3000) await sleep(1000);
await caption('Due time reached…', 1000);
await waitForSent(restartSubject, 2, 90_000);
await goto(`${APP}/dashboard/sent`, 'Both sent at their original time, exactly once, after the restart.', 6000);

// ---------------------------------------------------------------- 6. load
await card('Behaviour under load', ['Scheduling 1,000 emails due at the same moment, hourly limit 20…'], 3000);
execSync(`npm run load:schedule -- --user ${email} --count 1000 --limit 20`, { cwd: backend, stdio: 'ignore' });
await goto(`${API}/admin/queues/queue/email-send?status=delayed`, '1,000 jobs accepted in one request. 20 go out this hour (2 s apart), the rest are spread over the next hours — none dropped.', 7000);
await goto(`${APP}/dashboard`, 'The Scheduled tab shows the whole backlog with its rescheduled send times (paginated).', 5000);

// ---------------------------------------------------------------- 7. search
await goto(`${APP}/dashboard/sent`);
await page.getByLabel('Search emails').fill('dame@jmail.com');
await caption('Elasticsearch search: exact recipient match…', 3500);
await page.getByLabel('Search emails').fill(subject);
await caption('…and full-text search on subject/body.', 3500);

await card('Thanks for watching', [
  'Idempotent worker · distributed rate limit + min delay (Redis Lua) · restart-safe',
  '52 backend tests · 12 unit tests · 9 Playwright E2E tests',
  'github.com/cjoshi0209/reachinbox-email-scheduler',
], 5000);

await context.close();
await browser.close();
const video = (await import('node:fs')).readdirSync(videoDir).find((f) => f.endsWith('.webm'));
mkdirSync(path.join(root, 'docs'), { recursive: true });
copyFileSync(path.join(videoDir, video), path.join(root, 'docs', 'demo.webm'));
console.log('saved docs/demo.webm');
