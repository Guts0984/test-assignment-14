/** Dependency-injection tokens for infrastructure clients. */
export const ENV = Symbol('ENV');
export const PG_POOL = Symbol('PG_POOL');
export const PRISMA = Symbol('PRISMA');
export const REDIS = Symbol('REDIS');
export const LIMITER = Symbol('LIMITER');
export const VIRTUAL_QUEUE = Symbol('VIRTUAL_QUEUE');
export const STUB_LIMITER = Symbol('STUB_LIMITER');
export const CLIENT_IP = Symbol('CLIENT_IP');
