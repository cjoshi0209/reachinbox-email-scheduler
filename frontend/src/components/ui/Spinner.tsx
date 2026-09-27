import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cn('size-5 animate-spin', className)} />;
}

export function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center text-muted" role="status" aria-live="polite">
      <Spinner className="size-6 text-brand-500" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
