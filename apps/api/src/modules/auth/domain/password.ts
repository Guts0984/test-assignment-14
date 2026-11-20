import { hash, verify } from '@node-rs/argon2';

export const hashPassword = (password: string): Promise<string> => hash(password);

let dummy: Promise<string> | undefined;

/**
 * Verifies a password. For an unknown account it still burns a real argon2 verification, so the response time
 * does not reveal whether the account exists.
 */
export const verifyPasswordConstantTime = async (storedHash: string | null, password: string): Promise<boolean> => {
  dummy ??= hash('dummy-password-for-timing');
  const target = storedHash ?? (await dummy);
  const matches = await verify(target, password).catch(() => false);
  return storedHash !== null && matches;
};
