import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from './cn';

interface FieldFrameProps {
  readonly label: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
  readonly children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label, control and an error message tied together for screen readers: errors appear next to the field. */
export const FieldFrame = ({ label, error, hint, children }: FieldFrameProps) => {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-800">
        {label}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint ? (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </div>
  );
};

const control = 'min-h-10 w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly label: string;
  readonly error?: string | undefined;
  readonly hint?: string | undefined;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(({ label, error, hint, className, ...rest }, ref) => (
  <FieldFrame label={label} error={error} hint={hint}>
    {({ id, describedBy, invalid }) => <input ref={ref} id={id} aria-invalid={invalid || undefined} aria-describedby={describedBy} className={cn(control, invalid ? 'border-red-600' : 'border-slate-300', className)} {...rest} />}
  </FieldFrame>
));
TextField.displayName = 'TextField';

export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly label: string;
  readonly error?: string | undefined;
}

export const TextAreaField = forwardRef<HTMLTextAreaElement, TextAreaFieldProps>(({ label, error, className, ...rest }, ref) => (
  <FieldFrame label={label} error={error}>
    {({ id, describedBy, invalid }) => <textarea ref={ref} id={id} aria-invalid={invalid || undefined} aria-describedby={describedBy} className={cn(control, 'font-mono', invalid ? 'border-red-600' : 'border-slate-300', className)} {...rest} />}
  </FieldFrame>
));
TextAreaField.displayName = 'TextAreaField';

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly label: string;
  readonly error?: string | undefined;
}

export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(({ label, error, className, children, ...rest }, ref) => (
  <FieldFrame label={label} error={error}>
    {({ id, describedBy, invalid }) => (
      <select ref={ref} id={id} aria-invalid={invalid || undefined} aria-describedby={describedBy} className={cn(control, invalid ? 'border-red-600' : 'border-slate-300', className)} {...rest}>
        {children}
      </select>
    )}
  </FieldFrame>
));
SelectField.displayName = 'SelectField';
