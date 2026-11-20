'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { loginRequestSchema, registerRequestSchema } from '@ticketing/shared';
import '@/shared/api/client';
import { authControllerLogin, authControllerRegister } from '@/shared/api/generated/sdk.gen';
import { applyFieldErrors, toProblem } from '@/shared/api/problem';
import { useRouter } from '@/shared/i18n';
import { setSession } from '@/shared/lib/session';
import { Alert, Button, TextField } from '@/shared/ui';

type LoginValues = z.infer<typeof loginRequestSchema>;
type RegisterValues = z.infer<typeof registerRequestSchema>;

const homeFor = (role: string): string => (role === 'organizer' ? '/organizer' : role === 'scanner' ? '/scanner' : role === 'finance' ? '/finance' : '/');

export const LoginForm = ({ next }: { readonly next?: string | undefined }) => {
  const t = useTranslations('auth');
  const router = useRouter();
  const form = useForm<LoginValues>({ resolver: zodResolver(loginRequestSchema), defaultValues: { email: '', password: '' } });
  const login = useMutation({
    mutationFn: async (values: LoginValues) => (await authControllerLogin({ body: values, throwOnError: true })).data,
    onSuccess: (pair) => {
      setSession(pair.accessToken, pair.user);
      router.push(next && next.startsWith('/') && !next.startsWith('//') ? next : homeFor(pair.user.role));
    },
    onError: (error) => applyFieldErrors(toProblem(error), form.setError),
  });
  const problem = login.error ? toProblem(login.error) : null;
  return (
    <form noValidate onSubmit={form.handleSubmit((v) => login.mutate(v))} className="flex max-w-sm flex-col gap-4" aria-label={t('loginTitle')}>
      <TextField label={t('email')} type="email" autoComplete="email" error={form.formState.errors.email ? t('invalidEmail') : undefined} {...form.register('email')} />
      <TextField label={t('password')} type="password" autoComplete="current-password" error={form.formState.errors.password ? t('required') : undefined} {...form.register('password')} />
      {problem ? <Alert tone="error">{problem.code === 'RATE_LIMITED' ? t('tooManyAttempts') : problem.code === 'UNAUTHENTICATED' ? t('badCredentials') : problem.message}</Alert> : null}
      <Button type="submit" busy={login.isPending}>
        {t('login')}
      </Button>
    </form>
  );
};

export const RegisterForm = () => {
  const t = useTranslations('auth');
  const router = useRouter();
  const form = useForm<RegisterValues>({ resolver: zodResolver(registerRequestSchema), defaultValues: { email: '', password: '', displayName: '' } });
  const register = useMutation({
    mutationFn: async (values: RegisterValues) => (await authControllerRegister({ body: values, throwOnError: true })).data,
    onSuccess: (pair) => {
      setSession(pair.accessToken, pair.user);
      router.push('/');
    },
    onError: (error) => {
      const p = toProblem(error);
      if (p.code === 'CONFLICT') form.setError('email', { type: 'server', message: t('emailTaken') });
      else applyFieldErrors(p, form.setError);
    },
  });
  const e = form.formState.errors;
  return (
    <form noValidate onSubmit={form.handleSubmit((v) => register.mutate(v))} className="flex max-w-sm flex-col gap-4" aria-label={t('registerTitle')}>
      <TextField label={t('displayName')} autoComplete="name" error={e.displayName ? t('required') : undefined} {...form.register('displayName')} />
      <TextField label={t('email')} type="email" autoComplete="email" error={e.email ? (e.email.type === 'server' ? e.email.message : t('invalidEmail')) : undefined} {...form.register('email')} />
      <TextField label={t('password')} type="password" autoComplete="new-password" hint={t('passwordHint')} error={e.password ? t('passwordTooShort') : undefined} {...form.register('password')} />
      {register.error && !e.email ? <Alert tone="error">{toProblem(register.error).message}</Alert> : null}
      <Button type="submit" busy={register.isPending}>
        {t('register')}
      </Button>
    </form>
  );
};
