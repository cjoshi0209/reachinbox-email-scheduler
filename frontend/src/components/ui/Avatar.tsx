/* eslint-disable @next/next/no-img-element */
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';

export function Avatar({ name, src, className }: { name: string; src?: string | null; className?: string }) {
  if (src) {
    return <img src={src} alt={name} referrerPolicy="no-referrer" className={cn('size-8 rounded-full object-cover', className)} />;
  }
  return (
    <span
      aria-label={name}
      className={cn('inline-flex size-8 items-center justify-center rounded-full bg-brand-500 text-xs font-semibold text-white', className)}
    >
      {initials(name) || '?'}
    </span>
  );
}
