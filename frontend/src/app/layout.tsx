import type { Metadata } from 'next';
import { Inter, Space_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/Toast';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const logo = Space_Mono({ subsets: ['latin'], weight: '700', variable: '--font-mono-logo' });

export const metadata: Metadata = {
  title: 'ReachInbox Scheduler',
  description: 'Schedule and track outbound emails',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${logo.variable}`}>
      <body className="font-sans">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
