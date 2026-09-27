/**
 * Test-only helper: creates a user row and signs a session cookie for it with the app's
 * own SESSION_SECRET. The application itself never exposes a non-Google login.
 *
 * CLI usage (for Playwright / manual smoke tests):  npx tsx tests/helpers/testUser.ts [email]
 */
import { createSessionToken } from '../../src/auth/session';
import { prisma } from '../../src/lib/prisma';

export async function createTestUser(email = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`) {
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, googleId: `test-${email}`, name: 'Test User', avatarUrl: null },
    update: {},
  });
  return { user, token: await createSessionToken(user.id) };
}

if (require.main === module) {
  createTestUser(process.argv[2])
    .then(({ user, token }) => console.log(JSON.stringify({ userId: user.id, token })))
    .finally(() => prisma.$disconnect())
    .then(() => process.exit(0));
}
