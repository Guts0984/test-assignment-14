import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export const Card = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => <div className={cn('rounded-lg border border-slate-200 bg-white p-4 shadow-sm', className)} {...rest} />;

export const Alert = ({ tone = 'info', className, ...rest }: HTMLAttributes<HTMLDivElement> & { readonly tone?: 'info' | 'error' | 'success' | 'warning' }) => (
  <div
    role={tone === 'error' ? 'alert' : 'status'}
    className={cn(
      'rounded-md border px-3 py-2 text-sm',
      tone === 'info' && 'border-sky-200 bg-sky-50 text-sky-900',
      tone === 'error' && 'border-red-200 bg-red-50 text-red-900',
      tone === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-900',
      tone === 'warning' && 'border-amber-200 bg-amber-50 text-amber-900',
      className,
    )}
    {...rest}
  />
);

export const Badge = ({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { readonly tone?: 'neutral' | 'good' | 'bad' | 'warn' }) => (
  <span
    className={cn(
      'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
      tone === 'neutral' && 'bg-slate-100 text-slate-800',
      tone === 'good' && 'bg-emerald-100 text-emerald-900',
      tone === 'bad' && 'bg-red-100 text-red-900',
      tone === 'warn' && 'bg-amber-100 text-amber-900',
      className,
    )}
    {...rest}
  />
);

export const Spinner = ({ label }: { readonly label: string }) => (
  <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-slate-600">
    <span className="size-4 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600" aria-hidden />
    {label}
  </div>
);
