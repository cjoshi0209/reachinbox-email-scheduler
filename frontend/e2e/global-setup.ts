import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Creates a fresh e2e user in the backend DB, signs a session cookie for it (backend
 * test helper, uses the backend .env), and provisions a real Ethereal sender via the API.
 */
export default async function globalSetup() {
  const backend = path.resolve(__dirname, '../../backend');
  const email = `e2e-${Date.now()}@example.com`;
  const out = execSync(`npx tsx tests/helpers/testUser.ts ${email}`, { cwd: backend, encoding: 'utf8' });
  const { token } = JSON.parse(out.trim().split('\n').pop()!) as { token: string };

  const res = await fetch('http://localhost:4000/api/senders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `rb_session=${token}` },
    body: JSON.stringify({ name: 'E2E Sender' }),
  });
  if (!res.ok) throw new Error(`Could not create sender: ${res.status} ${await res.text()}`);

  mkdirSync(path.join(__dirname, '.auth'), { recursive: true });
  writeFileSync(
    path.join(__dirname, '.auth/state.json'),
    JSON.stringify({
      cookies: [{ name: 'rb_session', value: token, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax', expires: -1 }],
      origins: [],
    }),
  );
  process.env.E2E_EMAIL = email;
}
