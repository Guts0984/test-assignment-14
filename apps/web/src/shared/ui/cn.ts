export const cn = (...parts: readonly (string | false | null | undefined)[]): string => parts.filter(Boolean).join(' ');
