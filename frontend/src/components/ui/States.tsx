import { AlertCircle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './Button';

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center" data-testid="empty-state">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-brand-50">
        <Inbox className="size-6 text-brand-500" />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center" role="alert">
      <AlertCircle className="mb-3 size-8 text-red-500" />
      <p className="text-sm font-medium">Something went wrong</p>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul aria-busy="true" aria-label="Loading emails" data-testid="list-skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex animate-pulse items-center gap-4 border-b border-line px-4 py-4">
          <div className="h-3 w-28 rounded bg-surface" />
          <div className="h-5 w-32 rounded-full bg-surface" />
          <div className="h-3 flex-1 rounded bg-surface" />
        </li>
      ))}
    </ul>
  );
}
