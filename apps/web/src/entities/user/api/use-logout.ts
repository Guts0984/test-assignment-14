'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authControllerLogout } from '@/shared/api/generated/sdk.gen';
import { clearSession } from '@/shared/lib/session';

export const useLogout = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await authControllerLogout({ body: {}, throwOnError: false });
    },
    onSettled: () => {
      clearSession();
      qc.clear();
    },
  });
};
