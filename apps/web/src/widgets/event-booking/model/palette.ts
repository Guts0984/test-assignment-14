export const TIER_COLORS: readonly string[] = ['#0ea5e9', '#a855f7', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#6366f1', '#e11d48'];
export const tierColor = (index: number): string => TIER_COLORS[((index % TIER_COLORS.length) + TIER_COLORS.length) % TIER_COLORS.length] ?? '#0ea5e9';
