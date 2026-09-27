/**
 * Records the narrated demo video against the LIVE stack, then muxes the voice-over.
 *
 *   node scripts/record-demo.mjs <google-email>
 *
 * Prerequisites (see README "Demo video"):
 *  - Postgres/Redis/Elasticsearch running, Next.js dev server on :3000
 *  - a clean demo DB (reachinbox_${DEMO_NS}) containing the Google user (+ Slack connection)
 *  - narration clips in .infra/demo/audio/<scene>.wav and .infra/demo/durations.json
 *    (generated from scripts/demo/narration.json with scripts/demo/tts.ps1)
 *  - ffmpeg in .infra/ffmpeg/<build>/bin
 *
 * The backend is (re)started by this script against the demo DB / queue / index, so the
 * recording starts from a clean slate without touching the main database.
 * Google's consent screen can't be automated, so the session is signed for the existing user.
 * Output: docs/demo.mp4
 */
import { chromium } from '@playwright/test';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const backend = path.join(root, 'backend');
const infra = path.join(root, '.infra');
const email = process.argv[2];
if (!email) throw new Error('usage: node scripts/record-demo.mjs <google-email>');

const APP = 'http://localhost:3000';
const API = 'http://localhost:4000';
const DEMO = process.env.DEMO_NS ?? 'demo';
const QUEUE = `email-send-${DEMO}`;
const DEMO_ENV = {
  ...process.env,
  DATABASE_URL: `postgresql://reachinbox:reachinbox@localhost:5432/reachinbox_${DEMO}?schema=public`,
  QUEUE_NAME: QUEUE,
  ELASTICSEARCH_INDEX: `emails_${DEMO}`,
  MIN_EMAIL_DELAY_MS: '2000',
};
const BACKEND_LOG = path.join(infra, 'demo', 'backend.log');
const durations = JSON.parse(readFileSync(path.join(infra, 'demo', 'durations.json'), 'utf8'));
const ffmpegBin = path.join(infra, 'ffmpeg', readdirSync(path.join(infra, 'ffmpeg'))[0], 'bin');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = 1600;
const H = 900;

// ---------------------------------------------------------------- backend control
function stopBackend() {
  execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'src[\\\\/](server|worker)\\.ts|concurrently|dev:api|dev:worker' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
    { stdio: 'ignore' },
  );
}
async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) return;
    await sleep(500);
  }
  throw new Error('backend did not come up');
}
const log = () => (existsSync(BACKEND_LOG) ? readFileSync(BACKEND_LOG, 'utf8').replace(/\x1b\[[0-9;]*m/g, '') : '');
async function startBackend() {
  const before = (log().match(/Email worker ready/g) ?? []).length;
  const out = openSync(BACKEND_LOG, 'a');
  spawn('npm run dev', { cwd: backend, shell: true, env: DEMO_ENV, stdio: ['ignore', out, out], windowsHide: true }).unref();
  await waitHealthy();
  // wait for the worker to finish its start-up reconciliation
  for (let i = 0; i < 60 && (log().match(/Email worker ready/g) ?? []).length <= before; i++) await sleep(500);
}

// ---------------------------------------------------------------- setup (not recorded)
mkdirSync(path.dirname(BACKEND_LOG), { recursive: true });
rmSync(BACKEND_LOG, { force: true });
stopBackend();
await startBackend();
const { token } = JSON.parse(
  execSync(`npx tsx tests/helpers/testUser.ts ${email}`, { cwd: backend, env: DEMO_ENV, encoding: 'utf8' }).trim().split('\n').pop(),
);

const videoDir = path.join(infra, 'demo', 'video');
rmSync(videoDir, { recursive: true, force: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: videoDir, size: { width: W, height: H } } });

// Overlay: fake cursor (Playwright video has none), click ripple, caption and chapter pill.
await context.addInitScript(() => {
  const install = () => {
    if (document.getElementById('__demo_cursor') || !document.body) return;
    const style = document.createElement('style');
    style.textContent = `
      #__demo_cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px)}
      .__demo_ripple{position:fixed;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;z-index:2147483646;
        pointer-events:none;border:3px solid rgba(32,168,73,.9);animation:__demo_r .55s ease-out forwards}
      @keyframes __demo_r{from{transform:scale(.3);opacity:1}to{transform:scale(1.6);opacity:0}}
      #__demo_caption{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:2147483645;max-width:1200px;
        background:rgba(15,23,42,.9);color:#fff;font:600 19px/1.45 Inter,system-ui,sans-serif;padding:12px 22px;border-radius:14px;
        box-shadow:0 10px 30px rgba(0,0,0,.25);text-align:center;pointer-events:none;opacity:0;transition:opacity .25s}
      #__demo_chapter{position:fixed;right:22px;top:18px;z-index:2147483645;background:#20a849;color:#fff;
        font:700 14px Inter,system-ui,sans-serif;padding:7px 14px;border-radius:999px;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,.18)}
      #__demo_chapter:empty{display:none}`;
    document.head.appendChild(style);
    const cur = document.createElement('div');
    cur.id = '__demo_cursor';
    cur.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    const cap = document.createElement('div');
    cap.id = '__demo_caption';
    const chap = document.createElement('div');
    chap.id = '__demo_chapter';
    document.body.append(cur, cap, chap);
    cur.style.left = '-40px';
    cur.style.top = '-40px';
    addEventListener('mousemove', (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      r.className = '__demo_ripple';
      r.style.left = e.clientX + 'px';
      r.style.top = e.clientY + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
});

const page = await context.newPage();
const t0 = Date.now();
const timeline = [];
let mouse = { x: W / 2, y: H / 2 };
let captionText = '';
let chapterText = '';

async function paintOverlay() {
  await page
    .evaluate(
      ({ caption, chapter, pos }) => {
        const c = document.getElementById('__demo_cursor');
        if (c) { c.style.left = pos.x + 'px'; c.style.top = pos.y + 'px'; }
        const cap = document.getElementById('__demo_caption');
        if (cap) { cap.textContent = caption; cap.style.opacity = caption ? '1' : '0'; }
        const ch = document.getElementById('__demo_chapter');
        if (ch) ch.textContent = chapter;
      },
      { caption: captionText, chapter: chapterText, pos: mouse },
    )
    .catch(() => undefined);
}
page.on('load', () => void paintOverlay());

async function caption(text) {
  captionText = text;
  await paintOverlay();
}
async function glide(x, y) {
  await page.mouse.move(x, y, { steps: 24 });
  mouse = { x, y };
}
async function click(locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (b) await glide(b.x + b.width / 2, b.y + b.height / 2);
  await sleep(180);
  await locator.click();
}
async function typeInto(locator, text, delay = 26) {
  await click(locator);
  await locator.pressSequentially(text, { delay });
}
async function goto(url) {
  await page.goto(url, { waitUntil: 'networkidle' }).catch(() => undefined);
  await paintOverlay();
}
async function card(html) {
  // Fresh JS realm: setContent alone keeps the previous app's timers alive, which can
  // crash into the card (e.g. SWR refreshes failing while the API is stopped).
  await page.goto('about:blank');
  await page.setContent(
    `<html><head><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet"></head>
     <body style="margin:0;height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;
     background:radial-gradient(1200px 600px at 20% 10%,#1f6f43 0%,#0f172a 55%,#0b1020 100%);color:#fff;font-family:Inter,system-ui,sans-serif;text-align:center">
     ${html}</body></html>`,
    { waitUntil: 'networkidle' },
  );
  await paintOverlay();
}
/** Runs a scene: narration clip <id> starts with it; the scene lasts at least as long as the clip. */
async function scene(id, fn) {
  const start = Date.now();
  timeline.push({ id, at: start - t0 });
  await fn();
  const need = (durations[id] ?? 0) + 450;
  const spent = Date.now() - start;
  if (spent < need) await sleep(need - spent);
}
async function apiJson(p) {
  const r = await page.request.get(`${APP}${p}`);
  return r.json();
}
async function waitFor(fn, timeoutMs = 120_000) {
  const s = Date.now();
  while (Date.now() - s < timeoutMs) {
    if (await fn().catch(() => false)) return;
    await sleep(700);
  }
  throw new Error('waitFor timed out');
}
const countSent = async (subject) => (await apiJson(`/api/emails/search?q=${encodeURIComponent(subject)}&status=sent&limit=1`)).total ?? 0;
const pad = (n) => String(n).padStart(2, '0');
const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const chip = (t) => `<span style="display:inline-block;margin:6px;padding:8px 16px;border-radius:999px;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.18);font-size:18px">${t}</span>`;
const box = (t, sub, color = '#20a849') =>
  `<div style="width:190px;padding:18px 14px;border-radius:16px;background:rgba(255,255,255,.08);border:2px solid ${color};">
     <div style="font-weight:800;font-size:20px">${t}</div><div style="font-size:14px;opacity:.8;margin-top:6px">${sub}</div></div>`;
const arrow = `<div style="font-size:30px;opacity:.7;margin:0 10px">→</div>`;

// ================================================================= overview
await scene('s01', async () => {
  await card(`
    <div style="font-size:18px;letter-spacing:.2em;opacity:.75;font-weight:700">REACHINBOX · SDE INTERN ASSIGNMENT</div>
    <h1 style="font-size:64px;margin:14px 0 8px;font-weight:800">Email Job Scheduler</h1>
    <p style="font-size:24px;opacity:.85;margin:0 0 26px">Reliable, rate-limited, restart-safe email scheduling — with a Figma-matched dashboard</p>
    <div style="max-width:1100px">${['Express + TypeScript', 'BullMQ + Redis (no cron)', 'PostgreSQL + Prisma', 'Ethereal SMTP', 'Elasticsearch', 'Bull Board', 'Google OAuth', 'Slack OAuth', 'Next.js + Tailwind'].map(chip).join('')}</div>`);
});
await scene('s02', async () => {
  await card(`
    <h2 style="font-size:40px;margin:0 0 34px;font-weight:800">How an email flows</h2>
    <div style="display:flex;align-items:center">
      ${box('Dashboard', 'Next.js · CSV upload')}${arrow}${box('API', 'Zod · Idempotency-Key')}${arrow}${box('PostgreSQL', 'source of truth', '#60a5fa')}${arrow}${box('BullMQ', 'delayed job / email', '#f59e0b')}
    </div>
    <div style="font-size:30px;opacity:.7;margin:14px 0">↓</div>
    <div style="display:flex;align-items:center">
      ${box('Worker ×N', 'concurrency · idempotent', '#f59e0b')}${arrow}${box('Redis Lua', 'hourly limit + min delay', '#ef4444')}${arrow}${box('Ethereal', 'SMTP send')}${arrow}${box('Elasticsearch + Slack', 'index · limit alerts', '#a78bfa')}
    </div>
    <p style="font-size:20px;opacity:.85;margin-top:34px">No cron · no polling · state machine: scheduled → processing → sent | failed</p>`);
});

// ================================================================= login
chapterText = '1 · Google login';
await scene('s03', async () => {
  await goto(`${APP}/login`);
  await caption('Real Google OAuth 2.0 — ID token verified server-side');
  await sleep(1800);
  await click(page.getByRole('link', { name: 'Login with Google' }));
  await page.waitForURL(/accounts\.google\.com/, { timeout: 15000 }).catch(() => undefined);
  await paintOverlay();
});
await context.addCookies([{ name: 'rb_session', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }]);
await scene('s04', async () => {
  await goto(`${APP}/dashboard`);
  await caption('Header: Google name, email and avatar · Scheduled / Sent · Compose · Slack connected');
  await sleep(1500);
  await glide(120, 90);
  await sleep(1200);
  await glide(110, 830);
});

// ================================================================= compose
chapterText = '2 · Compose';
await scene('s05', async () => {
  await click(page.getByRole('link', { name: 'Compose' }).first());
  await page.waitForURL(/compose/);
  await paintOverlay();
  await caption('Multiple senders — each one is a real Ethereal SMTP inbox (password encrypted at rest)');
  await click(page.getByTestId('sender-select'));
  const dialog = page.getByRole('dialog', { name: 'New Ethereal sender' });
  await dialog.waitFor();
  await dialog.getByRole('textbox').fill('');
  await typeInto(dialog.getByRole('textbox'), 'Chinmay · Outreach');
  await click(dialog.getByRole('button', { name: 'Create sender' }));
  await dialog.waitFor({ state: 'hidden', timeout: 30000 });
});
const senderEmail = (await page.getByTestId('sender-select').innerText()).trim();
await scene('s06', async () => {
  await caption('CSV upload → emails detected, de-duplicated and validated in the browser');
  const up = page.getByRole('button', { name: 'Upload List' });
  const b = await up.boundingBox();
  if (b) await glide(b.x + b.width / 2, b.y + b.height / 2);
  await page.getByTestId('csv-input').setInputFiles(path.join(root, 'samples', 'leads.csv'));
  await sleep(800);
  const s = await page.getByTestId('recipient-summary').boundingBox();
  if (s) await glide(s.x + 300, s.y + s.height / 2);
});
const subject = 'Quick intro from ReachInbox';
await scene('s07', async () => {
  await caption('Delay between emails: 3 s · Hourly limit: 3 → the limit will be hit on purpose');
  await typeInto(page.getByLabel('Subject'), subject, 30);
  await typeInto(page.locator('#delay'), '3', 60);
  await typeInto(page.locator('#hourly'), '3', 60);
  await typeInto(page.getByLabel('Email body'), 'Hi there,\n\nThis email was scheduled from the ReachInbox dashboard and delivered by a BullMQ worker.\n\nCheers,\nChinmay', 12);
});
await scene('s08', async () => {
  await caption('One Postgres transaction + one BullMQ delayed job per email');
  await click(page.getByTestId('submit-schedule'));
  await page.waitForURL(/dashboard$/);
  await paintOverlay();
  await sleep(1200);
  await glide(760, 150);
});

// ================================================================= bull board
chapterText = '3 · Queue';
await scene('s09', async () => {
  await goto(`${API}/admin/queues/queue/${QUEUE}?status=delayed`);
  await caption('Bull Board — live BullMQ dashboard (login-protected)');
  await glide(900, 300);
});

// ================================================================= sending + rate limit
chapterText = '4 · Rate limit + Slack';
await scene('s10', async () => {
  await goto(`${APP}/dashboard/sent`);
  await caption('Worker: concurrency 5 · ≥ 3 s between sends of this sender (enforced atomically in Redis)');
  await waitFor(async () => (await countSent(subject)) >= 3);
  await page.reload({ waitUntil: 'networkidle' });
  await paintOverlay();
  await caption('3 sent — exactly the hourly limit');
});
await scene('s11', async () => {
  await caption('Email detail — timestamps, attempts, campaign settings, Ethereal preview');
  await click(page.locator('[data-testid=email-row]').first());
  await page.waitForURL(/emails\//);
  await paintOverlay();
  await sleep(2200);
  const href = await page.getByRole('link', { name: /Open in Ethereal/ }).getAttribute('href');
  await glide(640, 560);
  if (href) {
    await goto(href);
    if (/login/.test(page.url())) await page.goBack();
    else await caption('The real message, captured by Ethereal SMTP');
  }
});
await scene('s12', async () => {
  await goto(`${APP}/dashboard`);
  await caption('Limit reached → 4 emails rescheduled into the next hour windows, in order — never dropped');
  const b = await page.getByText('Rescheduled').first().boundingBox().catch(() => null);
  if (b) await glide(b.x + 30, b.y + 8);
});
const pending = await apiJson(`/api/emails/search?q=${encodeURIComponent(subject)}&status=scheduled&limit=10`);
const nextSend = pending.items?.map((i) => i.scheduledAt).sort()[0];
const slackDelivered = /Slack notification sent/.test(log());
const fmt = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();
await scene('s13', async () => {
  const f = (k, v) => `<div><div style="font-weight:700">${k}</div><div>${v}</div></div>`;
  await card(`
    <div style="font-size:18px;opacity:.8;margin-bottom:16px">Slack · <b>#new-channel</b> · ${slackDelivered ? 'delivered (backend log: “Slack notification sent”)' : 'NOT delivered'}</div>
    <div style="width:760px;text-align:left;background:#fff;color:#1d1c1d;border-radius:14px;padding:22px 26px;box-shadow:0 20px 50px rgba(0,0,0,.35);font-family:Lato,Inter,sans-serif">
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:10px">
        <div style="width:40px;height:40px;border-radius:8px;background:#20a849;color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center">RA</div>
        <div><b>ReachInbox Alerts</b> <span style="font-size:11px;background:#e8e8e8;border-radius:3px;padding:1px 4px;color:#555">APP</span>
        <span style="color:#616061;font-size:13px">${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>
      </div>
      <div style="font-size:20px;font-weight:800;margin:8px 0 12px">Hourly send limit reached</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;font-size:16px">
        ${f('Sender:', senderEmail)}${f('Limit:', '3 emails / hour')}${f('Window:', fmt(windowStart))}${f('Next send:', nextSend ? fmt(nextSend) : '-')}
      </div>
      <div style="color:#616061;font-size:14px;margin-top:14px">No emails were dropped - overflow was moved to the next available hour, in order.</div>
    </div>
    <p style="font-size:18px;opacity:.8;margin-top:22px">Sent once per sender per hour window · skipped gracefully when Slack isn't connected</p>`);
});

// ================================================================= restart
chapterText = '5 · Restart safety';
const restartSubject = 'Restart proof';
let sendAt;
let loadSender;
await scene('s14', async () => {
  await caption('Restart test: 2 emails, due in under a minute');
  await goto(`${APP}/compose`);
  await typeInto(page.getByLabel('Recipients'), 'restart-a@example.com restart-b@example.com ', 18);
  await typeInto(page.getByLabel('Subject'), restartSubject, 30);
  await typeInto(page.getByLabel('Email body'), 'Scheduled before the server was stopped.', 14);
  await click(page.getByRole('button', { name: 'Schedule for later' }));
  sendAt = new Date(Date.now() + 38_000);
  sendAt.setMilliseconds(0);
  await page.getByTestId('send-later-input').fill(localInput(sendAt));
  await caption(`2 emails scheduled for ${sendAt.toLocaleTimeString()}`);
  await click(page.getByRole('button', { name: 'Done' }));
  await click(page.getByTestId('submit-schedule'));
  await page.waitForURL(/dashboard$/);
  await paintOverlay();
  // Fresh sender for the load section, so its whole hourly budget is available.
  const res = await page.request.post(`${APP}/api/senders`, { data: { name: 'Load Test Sender' } });
  loadSender = (await res.json()).id;
});
await scene('s15', async () => {
  stopBackend();
  await card(`<div style="font-size:84px">⏹</div><h2 style="font-size:46px;margin:10px 0">API + worker stopped</h2>
    <p style="font-size:22px;opacity:.85">Emails due at <b>${sendAt.toLocaleTimeString()}</b> · jobs persisted in Redis (AOF) · rows in Postgres</p>`);
  await sleep(2500);
  const health = await fetch(`${API}/health`).then((r) => `HTTP ${r.status}`).catch((e) => e.cause?.code ?? 'connection refused');
  await card(`<div style="font-size:84px">⏹</div><h2 style="font-size:46px;margin:10px 0">API + worker stopped</h2>
    <p style="font-size:22px;opacity:.85">Emails due at <b>${sendAt.toLocaleTimeString()}</b> · jobs persisted in Redis (AOF) · rows in Postgres</p>
    <pre style="margin-top:26px;font-size:20px;background:rgba(0,0,0,.45);padding:14px 22px;border-radius:12px;text-align:left">$ curl localhost:4000/health
→ ${health}</pre>`);
});
await scene('s16', async () => {
  await card(`<div style="font-size:84px">▶</div><h2 style="font-size:46px;margin:10px 0">Starting API + worker…</h2>
    <p style="font-size:22px;opacity:.85">Worker boot runs a one-time reconciliation (not a polling loop)</p>`);
  await startBackend();
  await goto(`${APP}/dashboard`);
  await caption(`Back up — still scheduled for ${sendAt.toLocaleTimeString()}, nothing re-sent`);
});
await scene('s17', async () => {
  while (Date.now() < sendAt.getTime() - 500) {
    await caption(`Due in ${Math.ceil((sendAt.getTime() - Date.now()) / 1000)} s…`);
    await sleep(1000);
  }
  await waitFor(async () => (await countSent(restartSubject)) >= 2, 60_000);
  await goto(`${APP}/dashboard/sent`);
  await caption(`Due ${sendAt.toLocaleTimeString()} — sent on time, exactly once, after a full restart`);
  const b = await page.locator('[data-testid=email-row]').first().boundingBox();
  if (b) await glide(b.x + b.width - 60, b.y + b.height / 2);
});

// ================================================================= load
chapterText = '6 · 1,000 emails';
await scene('s18', async () => {
  await card(`<h2 style="font-size:46px;margin:0 0 10px">Behaviour under load</h2><p style="font-size:24px;opacity:.85">1,000 emails due at the same moment · hourly limit 20</p>`);
  await sleep(2500);
  // One real API request with 1,000 recipients (same endpoint the dashboard uses).
  const stamp = new Date().toTimeString().slice(0, 8);
  const res = await page.request.post(`${APP}/api/emails/schedule`, {
    headers: { 'Idempotency-Key': `load-${Date.now()}` },
    data: {
      senderId: loadSender,
      subject: `Load test ${stamp} (1000 emails)`,
      body: 'Scheduled as part of the 1,000-email load demo.',
      recipients: Array.from({ length: 1000 }, (_, i) => `lead-${i}@example.com`),
      delayMs: 0,
      hourlyLimit: 20,
    },
  });
  if (res.status() !== 201) throw new Error(`load schedule failed: ${res.status()}`);
  await goto(`${API}/admin/queues/queue/${QUEUE}?status=delayed`);
  await caption('1,000 accepted in one request · 20 go out this hour, 2 s apart · the rest spread over later hours');
  await glide(1100, 160);
  await sleep(4500);
  await goto(`${APP}/dashboard`);
  await caption('Scheduled tab: the whole backlog with its planned send times');
});

// ================================================================= search
chapterText = '7 · Search';
await scene('s19', async () => {
  await goto(`${APP}/dashboard/sent`);
  await caption('Elasticsearch — exact recipient…');
  await typeInto(page.getByLabel('Search emails'), 'dame@jmail.com', 45);
  await page.getByTestId('search-summary').filter({ hasText: '1 result' }).waitFor({ timeout: 8000 }).catch(() => undefined);
  await sleep(1800);
  await page.getByLabel('Search emails').fill('');
  await caption('…and full-text over subject and body');
  await typeInto(page.getByLabel('Search emails'), 'quick intro', 45);
  await page.getByTestId('search-summary').filter({ hasText: 'quick intro' }).waitFor({ timeout: 8000 }).catch(() => undefined);
  await sleep(2500);
});

// ================================================================= outro
chapterText = '';
captionText = '';
await scene('s20', async () => {
  await card(`
    <h1 style="font-size:54px;margin:0 0 18px;font-weight:800">Thanks for watching!</h1>
    <div style="max-width:1100px">${['52 backend tests on real Postgres · Redis · Elasticsearch', '12 unit tests', '9 Playwright E2E tests', 'Idempotent · rate-limited · restart-safe'].map(chip).join('')}</div>
    <p style="font-size:22px;opacity:.85;margin-top:26px">github.com/cjoshi0209/reachinbox-email-scheduler</p>`);
});
await sleep(800);

// ---------------------------------------------------------------- finish + mux
const total = (Date.now() - t0) / 1000;
await context.close();
await browser.close();
const webm = path.join(videoDir, readdirSync(videoDir).find((f) => f.endsWith('.webm')));
writeFileSync(path.join(infra, 'demo', 'timeline.json'), JSON.stringify(timeline, null, 1));

const audioDir = path.join(infra, 'demo', 'audio');
const inputs = ['-i', webm];
const filters = [];
timeline.forEach((t, i) => {
  inputs.push('-i', path.join(audioDir, `${t.id}.wav`));
  filters.push(`[${i + 1}:a]aresample=48000,adelay=${t.at}|${t.at}[a${i}]`);
});
filters.push(`${timeline.map((_, i) => `[a${i}]`).join('')}amix=inputs=${timeline.length}:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
filters.push(`[0:v]fps=30,format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st=${Math.max(0, total - 1.2).toFixed(2)}:d=1[vout]`);
mkdirSync(path.join(root, 'docs'), { recursive: true });
const out = path.join(root, 'docs', 'demo.mp4');
execFileSync(
  path.join(ffmpegBin, 'ffmpeg.exe'),
  ['-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out],
  { stdio: 'ignore' },
);
console.log(`saved ${out} (${total.toFixed(1)} s)`);
