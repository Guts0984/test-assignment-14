import type { FieldValues, Path, UseFormSetError } from 'react-hook-form';

/** The one error shape every endpoint returns (`ErrorResponseDto` in the generated client). */
export interface ApiProblem {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown> | undefined;
}

export const toProblem = (error: unknown): ApiProblem => {
  const body = error as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined;
  if (body?.error && typeof body.error.code === 'string') {
    return { code: body.error.code, message: typeof body.error.message === 'string' ? body.error.message : body.error.code, details: (body.error.details as Record<string, unknown> | undefined) ?? undefined };
  }
  return { code: 'NETWORK', message: 'Network error' };
};

/** Puts server-side validation messages next to the matching form fields. Returns true if any field was marked. */
export const applyFieldErrors = <T extends FieldValues>(problem: ApiProblem, setError: UseFormSetError<T>): boolean => {
  const issues = problem.details?.['issues'];
  if (!Array.isArray(issues)) return false;
  let marked = false;
  for (const issue of issues as { path?: string; message?: string }[]) {
    if (issue.path) {
      setError(issue.path as Path<T>, { type: 'server', message: issue.message ?? problem.message });
      marked = true;
    }
  }
  return marked;
};
