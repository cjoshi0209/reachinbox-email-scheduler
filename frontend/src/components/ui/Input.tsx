import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-lg bg-surface px-3 text-sm text-ink placeholder:text-faint outline-none transition focus:ring-2 focus:ring-brand-500/30 disabled:opacity-60',
        className,
      )}
      {...rest}
    />
  );
}

/** Borderless field used on the compose screen (Figma: "Subject", "To"...). */
export function BareInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn('min-w-0 flex-1 bg-transparent text-sm text-ink placeholder:text-faint outline-none', className)}
      {...rest}
    />
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn('w-full resize-none bg-transparent text-sm leading-6 text-ink placeholder:text-faint outline-none', className)}
      {...rest}
    />
  );
}
