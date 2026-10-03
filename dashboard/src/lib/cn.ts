type ClassValue = string | false | null | undefined | 0;

/** Joins truthy class names (tiny clsx). */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * Tailwind does not let a later class override an earlier one of the same utility (CSS order decides),
 * so components apply a default (e.g. "size-4") only when the caller did not pass one of that group.
 * `defaults` are [prefix, class] pairs; variant-prefixed caller classes (sm:, hover:) don't count.
 */
export function withDefaults(className: string | undefined, ...defaults: Array<[prefix: string, cls: string]>): string {
  const own = (className ?? '').split(/\s+/).filter(Boolean);
  const base = own.filter((c) => !c.includes(':'));
  const applied = defaults.filter(([prefix]) => !base.some((c) => c.startsWith(prefix))).map(([, cls]) => cls);
  return [...applied, ...own].join(' ');
}
