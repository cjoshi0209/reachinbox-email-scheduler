/**
 * Schedules a burst of emails through the same service the API uses, to demonstrate
 * behaviour under load and the hourly rate limit.
 *
 *   npm run load:schedule -- --user you@gmail.com --count 1000 --limit 20 [--delay 0] [--in 0]
 *
 * --user   email of an existing (logged-in once) user
 * --sender sender email to use (default: the user's first sender)
 * --count  number of emails (default 1000)
 * --limit  hourly limit for this campaign (default 20) -> the rest is rescheduled
 * --delay  ms between emails of the campaign (default 0 = all due at once)
 * --in     seconds from now until sending starts (default 0)
 */
import { parseArgs } from 'node:util';
import { scheduleCampaign } from '../emails/emailService';
import { prisma } from '../lib/prisma';
import { redis } from '../lib/redis';
import { closeEmailQueue, emailQueue } from '../queue/emailQueue';
import { es } from '../search/elastic';

async function main() {
  const { values } = parseArgs({
    options: {
      user: { type: 'string' },
      sender: { type: 'string' },
      count: { type: 'string', default: '1000' },
      limit: { type: 'string', default: '20' },
      delay: { type: 'string', default: '0' },
      in: { type: 'string', default: '0' },
    },
  });
  if (!values.user) throw new Error('--user <email> is required');
  const user = await prisma.user.findUniqueOrThrow({ where: { email: values.user } });
  const sender = await prisma.sender.findFirst({
    where: { userId: user.id, ...(values.sender ? { email: values.sender } : {}) },
    orderBy: { createdAt: 'asc' },
  });
  if (!sender) throw new Error('User has no sender yet - create one in the dashboard first');

  const count = Number(values.count);
  const stamp = new Date().toISOString().slice(11, 19);
  const t0 = Date.now();
  const res = await scheduleCampaign(user.id, {
    senderId: sender.id,
    subject: `Load test ${stamp} (${count} emails)`,
    body: 'This email was scheduled by the load-test script.',
    recipients: Array.from({ length: count }, (_, i) => `load-${stamp.replace(/:/g, '')}-${i}@example.com`),
    delayMs: Number(values.delay),
    hourlyLimit: Number(values.limit),
    startAt: new Date(Date.now() + Number(values.in) * 1000).toISOString(),
  });
  console.log(`Scheduled ${res.scheduled} emails in ${Date.now() - t0}ms (campaign ${res.campaignId}, ${res.hourlyLimit}/hour)`);
  console.log('Queue counts:', await emailQueue.getJobCounts('delayed', 'waiting', 'active', 'completed', 'failed'));
  console.log(`Watch it live: Bull Board at /admin/queues. Expect ${res.hourlyLimit} sends this hour; the rest is moved to later hours.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeEmailQueue();
    await es.close();
    await prisma.$disconnect();
    redis.disconnect();
  });
