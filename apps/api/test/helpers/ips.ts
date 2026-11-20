/** A /24 of loopback addresses private to this test process: counters in Redis from earlier runs cannot interfere. */
const NET = `127.${2 + Math.floor(Math.random() * 240)}.${Math.floor(Math.random() * 250)}`;

export const ip = (last: number): string => `${NET}.${last}`;
export const ipPrefix = NET;
