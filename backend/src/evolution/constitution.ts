import { createHash } from 'node:crypto';

/**
 * The PRISM-X Constitution.
 *
 * A self-modifying system needs a boundary it cannot move, or "adaptive"
 * eventually means "unpredictable". These are the laws the Evolution Engine
 * may never break, whatever the evidence says, whatever the confidence, and
 * whatever an organization has configured.
 *
 * Three properties make this a constraint rather than a comment:
 *
 *  1. **It lives in code, not in the database.** There is no table, no
 *     endpoint and no setting that amends it. Changing a law requires a code
 *     change, a review and a deploy — which is exactly the human process the
 *     laws exist to protect. A constitution stored in a row is one the system
 *     could evolve, and a constitution the system can evolve is not one.
 *
 *  2. **Every law is an executable predicate**, not a slogan. "Never expose
 *     another organization's data" is checked by walking the proposed change
 *     for foreign identifiers, not by asserting good intentions.
 *
 *  3. **It is checked at a chokepoint evolution cannot route around.** The
 *     only path from the Evolution Engine to production is
 *     `DeploymentService.deploy()`, and its first act is to submit the intent
 *     here. A refusal is recorded permanently, because an evolution engine
 *     repeatedly trying something illegal is a fact about the engine.
 *
 * The laws are deliberately about *process integrity* — permissions, tenancy,
 * reversibility, auditability, human consent — and never about outcomes. A
 * law saying "only deploy improvements" would be unenforceable and would give
 * false comfort; these are all decidable from the intent in front of us.
 */

export interface DeploymentIntent {
  /** Organization the change belongs to. */
  organizationId: string;
  /** Whoever is causing this. `system` for unattended paths. */
  actorId: string;
  /** Permissions the actor actually holds. */
  actorPermissions: string[];
  /** What is being changed. */
  subject: 'WORKER' | 'WORKFLOW' | 'PROVIDER' | 'PLANNING' | 'ORGANIZATION';
  subjectId: string;
  /** The organization that owns `subjectId`, resolved from the record. */
  subjectOrganizationId: string;
  kind: string;
  /** Field-level change being written. */
  change: Record<string, unknown>;
  /** State to restore. Empty means the change is irreversible. */
  rollback: Record<string, unknown>;
  /** Set when a person approved it, with their id. */
  approvedById?: string | null;
  approvedAt?: Date | null;
  /** Whether the organization's policy requires approval for this change. */
  policyRequiresApproval: boolean;
  /** Whether the organization's policy permits this change at all. */
  policySatisfied: boolean;
  /** Why the policy refused, when it did. */
  policyReason?: string;
  /** 0..1 evidence behind the change. */
  confidence: number;
  /** Benchmark verdict, when the change came through an experiment. */
  benchmarkVerdict?: 'BETTER' | 'WORSE' | 'INCONCLUSIVE' | 'INSUFFICIENT_DATA' | null;
  /** True when the deployment will be written to the archive. */
  auditable: boolean;
}

export interface LawVerdict {
  lawId: string;
  passed: boolean;
  reason?: string;
}

export interface ConstitutionVerdict {
  permitted: boolean;
  /** Laws that refused, in declaration order. */
  violations: LawVerdict[];
  checked: LawVerdict[];
  /** Hash of the constitution in force, recorded alongside every decision. */
  version: string;
}

export interface ConstitutionalLaw {
  id: string;
  statement: string;
  /** Why this is a law rather than a policy an organization could relax. */
  rationale: string;
  check(intent: DeploymentIntent): string | null;
}

/**
 * Permissions the Evolution Engine may never grant to itself or to anything
 * it deploys. Widening authority is the one change class where a mistake
 * compounds instead of merely being wrong.
 */
const AUTHORITY_FIELDS = ['permissions', 'roleKey', 'role', 'scopes', 'organizationId'];

const LAWS: ConstitutionalLaw[] = [
  {
    id: 'ORG_PERMISSIONS',
    statement: 'Never act beyond the permissions of the actor requesting the change.',
    rationale:
      'Evolution runs on behalf of someone. If it could exceed their authority, ' +
      'the permission model would describe what people can do rather than what ' +
      'the system can do on their behalf — which is not a permission model.',
    check(intent) {
      // The system actor is the unattended path. It is *more* constrained
      // than a person, not less: it may only act where policy already
      // permitted it without asking.
      if (intent.actorId === 'system') {
        if (intent.policyRequiresApproval && !intent.approvedById) {
          return 'the unattended actor cannot make a change this organization requires approval for';
        }
        return null;
      }

      const required = REQUIRED_PERMISSION[intent.subject];
      const held =
        intent.actorPermissions.includes('*') ||
        intent.actorPermissions.includes(required) ||
        intent.actorPermissions.includes('evolution:deploy');

      return held ? null : `actor lacks "${required}" for a ${intent.subject} change`;
    },
  },
  {
    id: 'NO_PRIVILEGE_ESCALATION',
    statement: 'Never widen its own authority or anyone else’s.',
    rationale:
      'A system that can grant permissions can grant itself permissions. This is ' +
      'the one change class where being wrong does not merely produce a bad ' +
      'outcome — it produces a system that can no longer be constrained.',
    check(intent) {
      const touched = Object.keys(intent.change).filter((field) =>
        AUTHORITY_FIELDS.includes(field),
      );
      if (touched.length > 0) {
        return `change touches authority field(s): ${touched.join(', ')}`;
      }

      // Tool permissions are authority too, but narrowing them is safe, so
      // the law forbids only growth rather than the field entirely.
      const proposed = intent.change.toolPermissions;
      const current = intent.rollback.toolPermissions;
      if (Array.isArray(proposed) && Array.isArray(current)) {
        const added = proposed.filter((tool) => !current.includes(tool));
        if (added.length > 0 && !intent.approvedById) {
          return `grants tool access (${added.join(', ')}) without human approval`;
        }
      }

      return null;
    },
  },
  {
    id: 'TENANT_ISOLATION',
    statement: 'Never touch, reference or expose another organization’s data.',
    rationale:
      'Every other guarantee in PRISM-X is scoped to an organization. A single ' +
      'cross-tenant write would make all of them conditional.',
    check(intent) {
      if (intent.subjectOrganizationId !== intent.organizationId) {
        return `subject belongs to a different organization (${intent.subjectOrganizationId})`;
      }

      // A change that names an organization is either a mistake or an
      // attempt; both are refused rather than distinguished.
      const foreign = findForeignOrganizationId(intent.change, intent.organizationId);
      if (foreign) return `change references organization "${foreign}"`;

      return null;
    },
  },
  {
    id: 'NO_AUTOMATIC_DELETION',
    statement: 'Never delete historical records automatically.',
    rationale:
      'History is what makes evolution auditable. A system that can prune its ' +
      'own record can quietly erase the evidence that it made things worse.',
    check(intent) {
      const destructive = Object.entries(intent.change).filter(
        ([field, value]) =>
          DESTRUCTIVE_FIELDS.includes(field) ||
          (field.endsWith('deletedAt') && value !== null),
      );
      if (destructive.length > 0) {
        return `change would delete or archive records via ${destructive
          .map(([field]) => field)
          .join(', ')}`;
      }
      return null;
    },
  },
  {
    id: 'POLICY_COMPLIANCE',
    statement:
      'Never deploy without satisfying the organization’s Evolution Policy.',
    rationale:
      'The Constitution sets the floor; the policy sets each organization’s own ' +
      'ceiling. A system that could ignore the policy would make the policy ' +
      'advisory, and an advisory safety control is not one.',
    check(intent) {
      if (intent.policySatisfied) return null;
      return intent.policyReason ?? 'the organization’s evolution policy refused this change';
    },
  },
  {
    id: 'HUMAN_CONSENT',
    statement: 'Never bypass human approval where it is required.',
    rationale:
      'Confidence is a measure of evidence, not of authority. However strong the ' +
      'numbers, a change an organization said needs a person needs a person.',
    check(intent) {
      if (!intent.policyRequiresApproval) return null;
      if (!intent.approvedById) return 'this change requires human approval and has none';
      if (intent.approvedById === 'system') {
        return 'approval was recorded by the system rather than by a person';
      }
      return null;
    },
  },
  {
    id: 'REVERSIBILITY',
    statement: 'Never deploy a change that cannot be undone.',
    rationale:
      'Every evolution is a bet. Bets are acceptable when losing them is ' +
      'recoverable; an irreversible bet on an automated inference is not.',
    check(intent) {
      if (Object.keys(intent.rollback).length === 0) {
        return 'no rollback state was captured, so the change could not be undone';
      }

      // The rollback has to cover what the change touches. A partial one
      // restores some fields and silently leaves others changed, which is
      // worse than none because it looks like it worked.
      const uncovered = Object.keys(intent.change).filter(
        (field) => !(field in intent.rollback),
      );
      if (uncovered.length > 0) {
        return `rollback does not cover ${uncovered.join(', ')}`;
      }

      return null;
    },
  },
  {
    id: 'AUDITABILITY',
    statement: 'Always leave a record of what changed, why, and on whose authority.',
    rationale:
      'An unrecorded change cannot be reviewed, explained or learned from. The ' +
      'archive is the difference between a system that evolves and one that ' +
      'merely drifts.',
    check(intent) {
      return intent.auditable
        ? null
        : 'the deployment would not be written to the evolution archive';
    },
  },
  {
    id: 'EVIDENCE_REQUIRED',
    statement: 'Never evolve on no evidence.',
    rationale:
      'PRISM-X evolves through measurement, not variation. A change with no ' +
      'benchmark and no confidence behind it is a guess, and a system that ' +
      'deploys guesses is evolving randomly however carefully it is governed.',
    check(intent) {
      if (intent.benchmarkVerdict === 'WORSE') {
        return 'the benchmark found this change performs worse than what it replaces';
      }
      // A measured tie or a half-finished experiment is not disqualifying on
      // its own — a person may still have good reason — but it cannot stand
      // in for evidence either, so it needs a human behind it.
      if (
        (intent.benchmarkVerdict === 'INSUFFICIENT_DATA' ||
          intent.benchmarkVerdict === 'INCONCLUSIVE') &&
        !intent.approvedById
      ) {
        return `the experiment was ${intent.benchmarkVerdict.toLowerCase().replace(/_/g, ' ')} and nobody approved it anyway`;
      }
      if (intent.confidence <= 0 && !intent.approvedById) {
        return 'no supporting evidence and no human decision';
      }
      return null;
    },
  },
];

/** Permission a change to each subject requires of its actor. */
const REQUIRED_PERMISSION: Record<DeploymentIntent['subject'], string> = {
  WORKER: 'worker:update',
  WORKFLOW: 'workflow:update',
  PROVIDER: 'provider:update',
  PLANNING: 'evolution:deploy',
  ORGANIZATION: 'organization:update',
};

/** Fields whose presence in a change would destroy history. */
const DESTRUCTIVE_FIELDS = ['delete', 'purge', 'truncate', 'archivedAt', 'destroy'];

/**
 * The laws, frozen.
 *
 * Deep-frozen rather than merely `readonly`, because `readonly` is a
 * compile-time courtesy and this needs to survive contact with code that
 * does not typecheck against it.
 */
export const CONSTITUTION: readonly ConstitutionalLaw[] = Object.freeze(
  LAWS.map((law) => Object.freeze(law)),
);

/**
 * Identifies the constitution in force, recorded with every decision.
 *
 * Derived from the law text rather than a hand-maintained version number, so
 * it cannot fall out of step with what the laws actually say — and so an
 * archive entry from six months ago can be checked against the constitution
 * that was in force when it was written.
 */
export const CONSTITUTION_VERSION: string = createHash('sha256')
  .update(CONSTITUTION.map((law) => `${law.id}:${law.statement}`).join('|'))
  .digest('hex')
  .slice(0, 16);

/**
 * Submits an intent to every law.
 *
 * All laws are evaluated rather than short-circuiting on the first refusal:
 * an operator fixing one violation only to hit another is a worse experience
 * than being told all of them at once, and a candidate that breaks four laws
 * is a different kind of problem from one that breaks one.
 */
export function review(intent: DeploymentIntent): ConstitutionVerdict {
  const checked: LawVerdict[] = CONSTITUTION.map((law) => {
    const reason = law.check(intent);
    return reason ? { lawId: law.id, passed: false, reason } : { lawId: law.id, passed: true };
  });

  const violations = checked.filter((verdict) => !verdict.passed);

  return {
    permitted: violations.length === 0,
    violations,
    checked,
    version: CONSTITUTION_VERSION,
  };
}

/** The laws, as data, for the API and the documentation. */
export function describe(): Array<{ id: string; statement: string; rationale: string }> {
  return CONSTITUTION.map(({ id, statement, rationale }) => ({ id, statement, rationale }));
}

/**
 * Walks a change for an organization id that is not the acting one.
 *
 * Recursive because a foreign id nested three levels inside a workflow step
 * config is exactly as dangerous as one at the top level, and considerably
 * more likely to be missed by a reviewer.
 */
function findForeignOrganizationId(
  value: unknown,
  organizationId: string,
  depth = 0,
): string | null {
  if (depth > 8 || value === null || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findForeignOrganizationId(entry, organizationId, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      /organizationid$/i.test(key) &&
      typeof entry === 'string' &&
      entry.length > 0 &&
      entry !== organizationId
    ) {
      return entry;
    }
    const found = findForeignOrganizationId(entry, organizationId, depth + 1);
    if (found) return found;
  }

  return null;
}
