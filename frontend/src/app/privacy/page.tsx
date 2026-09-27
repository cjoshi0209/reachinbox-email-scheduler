import Link from 'next/link';
import { Logo } from '@/components/icons';

export const metadata = { title: 'Privacy — ReachInbox Scheduler' };

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 text-sm leading-6 text-ink">
      <Logo />
      <h1 className="mt-6 text-2xl font-semibold">Privacy policy</h1>
      <p className="mt-2 text-muted">ReachInbox Scheduler is a demo built for the Outbox Labs SDE intern assignment.</p>

      <h2 className="mt-8 font-semibold">What we collect</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>From Google sign-in: your name, email address and profile picture, to show who is logged in.</li>
        <li>Emails you schedule (recipients, subject, body) and their delivery status.</li>
        <li>If you connect Slack: your workspace and channel name, plus an access token used only to post rate-limit alerts.</li>
      </ul>

      <h2 className="mt-8 font-semibold">How it is used</h2>
      <p className="mt-2">
        Only to run the scheduler for you. Emails are sent through Ethereal, a test SMTP service that captures messages and never delivers
        them. Nothing is sold or shared. Tokens and SMTP passwords are stored encrypted.
      </p>

      <h2 className="mt-8 font-semibold">Retention</h2>
      <p className="mt-2">This is a temporary demo deployment; its data is deleted when the demo environment is removed.</p>

      <p className="mt-10">
        <Link href="/login" className="text-brand-600 underline">
          Back to login
        </Link>
      </p>
    </main>
  );
}
