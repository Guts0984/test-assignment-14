export interface SeedParams {
  readonly users: number;
  readonly organizers: number;
  readonly scanners: number;
  readonly finance: number;
  readonly venues: number;
  readonly events: number;
  readonly tickets: number;
  readonly arenaSeats: number;
  readonly arenaFloor: number;
  readonly venueMinSeats: number;
  readonly venueMaxSeats: number;
  /** One event in `soonMod` starts selling 10 minutes after the seed runs. */
  readonly soonMod: number;
  /** One event in `arenaMod` takes place in the big hall. */
  readonly arenaMod: number;
}

export const FULL_SEED: SeedParams = {
  users: 50_000,
  organizers: 30,
  scanners: 60,
  finance: 5,
  venues: 30,
  events: 2_000,
  tickets: 1_000_000,
  arenaSeats: 10_000,
  arenaFloor: 2_000,
  venueMinSeats: 600,
  venueMaxSeats: 1_800,
  soonMod: 100,
  arenaMod: 100,
};

/** CI-sized seed: same shape and invariants, ~5 000 tickets. */
export const SMALL_SEED: SeedParams = {
  users: 400,
  organizers: 6,
  scanners: 6,
  finance: 2,
  venues: 6,
  events: 60,
  tickets: 5_000,
  arenaSeats: 800,
  arenaFloor: 200,
  venueMinSeats: 60,
  venueMaxSeats: 150,
  soonMod: 15,
  arenaMod: 20,
};

export const paramsFor = (scale: 'full' | 'small'): SeedParams => (scale === 'full' ? FULL_SEED : SMALL_SEED);
