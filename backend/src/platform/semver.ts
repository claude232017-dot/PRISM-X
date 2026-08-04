/**
 * A small, exact semantic-version implementation.
 *
 * Version comparison decides whether a stranger's code is allowed to replace
 * code that is currently running, so it is deliberately implemented here
 * rather than pulled in: the rules are short, the failure mode of a subtly
 * wrong `satisfies` is an unwanted upgrade, and the behaviour is pinned by
 * tests we own.
 *
 * Supported: `MAJOR.MINOR.PATCH` with an optional `-prerelease` and an
 * optional `+build`. Ranges accept `*`, `1.2.3`, `^1.2.3`, `~1.2.3`,
 * `>=1.2.3`, `>1.2.3`, `<=1.2.3`, `<1.2.3`, and space-separated conjunctions
 * (`>=1.2.0 <2.0.0`). Comma-separated and `||`-separated alternatives are
 * accepted too, which covers every range npm-style manifests actually use in
 * practice without pretending to implement the full grammar.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers, empty for a release build. */
  prerelease: string[];
  raw: string;
}

const PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parse(version: string): SemVer | null {
  const match = PATTERN.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    raw: version.trim(),
  };
}

export function isValid(version: string): boolean {
  return parse(version) !== null;
}

export function parseOrThrow(version: string): SemVer {
  const parsed = parse(version);
  if (!parsed) throw new Error(`"${version}" is not a valid semantic version`);
  return parsed;
}

/** -1, 0 or 1. Build metadata is ignored, as the specification requires. */
export function compare(a: string | SemVer, b: string | SemVer): number {
  const left = typeof a === 'string' ? parseOrThrow(a) : a;
  const right = typeof b === 'string' ? parseOrThrow(b) : b;

  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

  // A version with a prerelease tag ranks below the same version without one.
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;

    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) {
      if (Number(l) !== Number(r)) return Number(l) < Number(r) ? -1 : 1;
    } else if (lNumeric !== rNumeric) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return lNumeric ? -1 : 1;
    } else if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

export function gte(a: string, b: string): boolean {
  return compare(a, b) >= 0;
}

export function lt(a: string, b: string): boolean {
  return compare(a, b) < 0;
}

export function eq(a: string, b: string): boolean {
  return compare(a, b) === 0;
}

/** The highest version in a list, or null if none parse. */
export function highest(versions: readonly string[]): string | null {
  const valid = versions.filter(isValid);
  if (!valid.length) return null;
  return valid.reduce((best, next) => (gt(next, best) ? next : best));
}

export type ReleaseKind = 'MAJOR' | 'MINOR' | 'PATCH' | 'PRERELEASE' | 'NONE';

/** How `to` differs from `from`. Downgrades report the magnitude of the gap. */
export function classify(from: string, to: string): ReleaseKind {
  const a = parseOrThrow(from);
  const b = parseOrThrow(to);
  if (a.major !== b.major) return 'MAJOR';
  if (a.minor !== b.minor) return 'MINOR';
  if (a.patch !== b.patch) return 'PATCH';
  if (a.prerelease.join('.') !== b.prerelease.join('.')) return 'PRERELEASE';
  return 'NONE';
}

/**
 * Under semver, only a major bump is licensed to break callers — but 0.x is
 * the documented exception, where the minor position carries that meaning.
 * Getting this wrong would wave through exactly the upgrades most likely to
 * break something, since pre-1.0 is where extensions spend their early life.
 */
export function isBreakingUpgrade(from: string, to: string): boolean {
  const a = parseOrThrow(from);
  const b = parseOrThrow(to);
  if (a.major !== b.major) return true;
  if (a.major === 0 && a.minor !== b.minor) return true;
  return false;
}

export function next(version: string, kind: 'MAJOR' | 'MINOR' | 'PATCH'): string {
  const v = parseOrThrow(version);
  if (kind === 'MAJOR') return `${v.major + 1}.0.0`;
  if (kind === 'MINOR') return `${v.major}.${v.minor + 1}.0`;
  return `${v.major}.${v.minor}.${v.patch + 1}`;
}

// ------------------------------------------------------------------ ranges

interface Comparator {
  operator: '<' | '<=' | '>' | '>=' | '=';
  version: SemVer;
}

const COMPARATOR = /^(>=|<=|>|<|=)?\s*(.+)$/;

/** Expands `^`/`~`/bare versions into the pair of bounds they stand for. */
function expand(token: string): Comparator[] | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'x') return [];

  if (trimmed.startsWith('^')) {
    const v = parse(trimmed.slice(1));
    if (!v) return null;
    // ^1.2.3 → >=1.2.3 <2.0.0; ^0.2.3 → >=0.2.3 <0.3.0; ^0.0.3 → >=0.0.3 <0.0.4.
    const upper =
      v.major > 0
        ? { major: v.major + 1, minor: 0, patch: 0 }
        : v.minor > 0
          ? { major: 0, minor: v.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: v.patch + 1 };
    return [
      { operator: '>=', version: v },
      { operator: '<', version: parseOrThrow(`${upper.major}.${upper.minor}.${upper.patch}`) },
    ];
  }

  if (trimmed.startsWith('~')) {
    const v = parse(trimmed.slice(1));
    if (!v) return null;
    return [
      { operator: '>=', version: v },
      { operator: '<', version: parseOrThrow(`${v.major}.${v.minor + 1}.0`) },
    ];
  }

  const match = COMPARATOR.exec(trimmed);
  if (!match) return null;
  const version = parse(match[2]);
  if (!version) return null;
  return [{ operator: (match[1] as Comparator['operator']) ?? '=', version }];
}

function test(version: SemVer, comparator: Comparator): boolean {
  const order = compare(version, comparator.version);
  switch (comparator.operator) {
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    default:
      return order === 0;
  }
}

export function isValidRange(range: string): boolean {
  return range
    .split('||')
    .every((alternative) =>
      alternative
        .split(/[,\s]+/)
        .filter(Boolean)
        .every((token) => expand(token) !== null),
    );
}

/**
 * True when `version` falls inside `range`.
 *
 * An unparseable range returns false rather than throwing, and false is the
 * safe answer: a compatibility declaration nobody can read should block an
 * install, not wave it through.
 */
export function satisfies(version: string, range: string): boolean {
  const parsed = parse(version);
  if (!parsed) return false;
  if (!range.trim() || range.trim() === '*') return true;

  return range.split('||').some((alternative) => {
    const tokens = alternative.split(/[,\s]+/).filter(Boolean);
    if (!tokens.length) return true;

    const comparators: Comparator[] = [];
    for (const token of tokens) {
      const expanded = expand(token);
      if (!expanded) return false;
      comparators.push(...expanded);
    }
    return comparators.every((comparator) => test(parsed, comparator));
  });
}
