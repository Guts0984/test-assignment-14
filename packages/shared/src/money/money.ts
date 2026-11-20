/** Money is UAH in kopecks, always a safe integer. */
export type Kopecks = number;

export const isKopecks = (value: unknown): value is Kopecks =>
  typeof value === 'number' && Number.isSafeInteger(value);

export const addKopecks = (a: Kopecks, b: Kopecks): Kopecks => {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new RangeError('kopecks overflow');
  return sum;
};
