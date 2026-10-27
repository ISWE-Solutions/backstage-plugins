/** Glob ("sale_*", "*") to a whole-name matcher */
const globToRegExp = (glob: string) =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  );

/**
 * The modules a build installs: those of the tested repos that match one of
 * `include` (default all) and none of `exclude`, sorted.
 */
export function selectModules(
  available: string[],
  include: string[],
  exclude: string[],
): string[] {
  const inc = (include.length ? include : ['*']).map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return [...new Set(available)]
    .filter(m => inc.some(r => r.test(m)) && !exc.some(r => r.test(m)))
    .sort();
}

/** A database name for a build, safe for PostgreSQL */
export function buildDbName(buildId: number, suffix = 'all'): string {
  return `runbot_${buildId}_${suffix
    .replace(/[^a-z0-9_]/gi, '_')
    .toLowerCase()}`.slice(0, 63);
}
