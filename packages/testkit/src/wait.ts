/** Polls `check` until it returns a truthy value or the timeout passes. No fixed sleeps in tests. */
export const waitFor = async <T>(check: () => Promise<T | false | null | undefined> | T | false | null | undefined, timeoutMs = 15_000, intervalMs = 25): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
