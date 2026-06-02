/**
 * Pure helpers for comparing DHIS2 version labels and detecting when a
 * deployed instance is missing a hotfix within its MAJOR.MINOR line.
 *
 * DHIS2 version strings come in two shapes:
 *   - Legacy "2.X" prefixed, e.g. `2.41.3` or `2.41.8.1`
 *   - Bare from v40+, e.g. `41.2.0`
 * Both are normalised by stripping a leading `2.` and splitting on `.`.
 */

const toTuple = (v: string): number[] =>
  (v || '')
    .trim()
    .replace(/^2\./, '')
    .split('.')
    .map(p => parseInt(p, 10) || 0);

export function compareVersions(a: string, b: string): number {
  const at = toTuple(a);
  const bt = toTuple(b);
  const len = Math.max(at.length, bt.length);
  for (let i = 0; i < len; i++) {
    const da = at[i] ?? 0;
    const db = bt[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Find the recommended hotfix (highest version on the same MAJOR.MINOR
 * line, strictly greater than `current`) and the newest version on any
 * higher MAJOR.MINOR line (purely informational).
 */
export function findHotfix(
  current: string,
  catalog: string[],
): { hotfix: string | null; majorUpgrade: string | null } {
  const cur = toTuple(current);
  if (cur.length < 2 || !catalog || catalog.length === 0) {
    return { hotfix: null, majorUpgrade: null };
  }
  const [curMajor, curMinor] = cur;
  let hotfix: string | null = null;
  let majorUpgrade: string | null = null;
  for (const candidate of catalog) {
    const ct = toTuple(candidate);
    if (ct.length < 2) continue;
    const [cMajor, cMinor] = ct;
    if (cMajor === curMajor && cMinor === curMinor) {
      if (compareVersions(candidate, current) > 0) {
        if (!hotfix || compareVersions(candidate, hotfix) > 0) {
          hotfix = candidate;
        }
      }
    } else if (
      cMajor > curMajor ||
      (cMajor === curMajor && cMinor > curMinor)
    ) {
      if (!majorUpgrade || compareVersions(candidate, majorUpgrade) > 0) {
        majorUpgrade = candidate;
      }
    }
  }
  return { hotfix, majorUpgrade };
}
