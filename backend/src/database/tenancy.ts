/**
 * Tenant scoping: the declaration, and the means to check it.
 *
 * `BaseRepository` merges `organizationId` into every query it issues, and a
 * repository that goes around it — `this.prisma.<model>` directly — steps
 * outside that guarantee. Sometimes that is exactly right: authenticating an
 * API key has no tenant yet, a liveness sweep is about the whole fleet, and
 * federation is *defined* as reaching another organization's rows. Those are
 * not bugs. They are decisions, and the problem with the previous arrangement
 * was not that they existed but that they were indistinguishable from
 * oversights: a doc comment and a naming convention that nothing enforced.
 *
 * So a query that leaves tenant scope must say so, out loud, with a reason.
 * `@Unscoped('...')` is that declaration. It does three things:
 *
 *  1. Makes the intent reviewable at the call site.
 *  2. Registers the reason at runtime, so `/ops/admin/access` can list every
 *     deliberate cross-tenant path in the codebase — an auditor's question
 *     answered from the running system rather than from a grep.
 *  3. Gives the architecture test something to check against, so a *new*
 *     unscoped query fails the build unless somebody declares it.
 *
 * The decorator grants nothing. It is a label on a query that was already
 * going to run; the authorization still lives wherever it lived before.
 */

export interface UnscopedDeclaration {
  /** `ClassName.methodName`. */
  readonly site: string;
  /** Why this query is allowed to leave tenant scope. */
  readonly reason: string;
}

const declarations = new Map<string, UnscopedDeclaration>();

/**
 * Declares that a repository method deliberately queries outside tenant scope.
 *
 * The reason is required and is held to a minimum length on purpose — "needed"
 * is not a reason, and a decorator that accepts it is a decorator that becomes
 * decoration.
 */
export function Unscoped(reason: string): MethodDecorator {
  if (!reason || reason.trim().length < 20) {
    throw new Error(
      '@Unscoped needs a real reason (at least 20 characters) explaining why ' +
        'this query may leave tenant scope',
    );
  }
  return (target, propertyKey) => {
    const owner = (target as { constructor?: { name?: string } })?.constructor?.name ?? 'Unknown';
    const site = `${owner}.${String(propertyKey)}`;
    declarations.set(site, { site, reason: reason.trim() });
  };
}

/** Every declared cross-tenant query, for the administration surface. */
export function unscopedDeclarations(): UnscopedDeclaration[] {
  return [...declarations.values()].sort((a, b) => a.site.localeCompare(b.site));
}

// ==========================================================================
// Static audit
// ==========================================================================

export interface TenancyFinding {
  file: string;
  line: number;
  repository: string;
  method: string;
  model: string;
  operation: string;
  snippet: string;
}

/** Prisma operations that read or write rows and therefore need a scope. */
const SCOPED_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Models carrying an `organizationId`, read from the Prisma schema.
 *
 * Derived rather than listed. A table added next year is covered without
 * anybody remembering to add it here, which is the only way a check like this
 * stays true.
 */
export function tenantModels(schema: string): Set<string> {
  const models = new Set<string>();
  const pattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(schema)) !== null) {
    const [, name, body] = match;
    if (/^\s*organizationId\s/m.test(body)) {
      // Prisma's client property is the model name with a lowercase initial.
      models.add(name.charAt(0).toLowerCase() + name.slice(1));
    }
  }
  return models;
}

/** Reads the argument object of a call whose opening paren is at `open`. */
function argumentSpan(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/** The method a character offset falls inside, and its owning class. */
function enclosing(source: string, offset: number): { repository: string; method: string } {
  let repository = 'Unknown';
  for (const match of source.slice(0, offset).matchAll(/export class (\w+)/g)) {
    repository = match[1];
  }

  let method = 'unknown';
  const signature =
    /^\s{2}(?:(?:public|private|protected|static|async|readonly)\s+)*([a-zA-Z_][\w$]*)\s*[(<]/gm;
  for (const match of source.slice(0, offset).matchAll(signature)) {
    method = match[1];
  }
  return { repository, method };
}

/**
 * Finds repository queries on tenant tables that neither carry a scope nor
 * declare that they are leaving it.
 *
 * A query is considered scoped when it mentions `organizationId`, builds its
 * predicate through `this.scope(...)`, or reuses a `scoped` variable. A method
 * is considered declared when it is annotated `@Unscoped(...)` or named with
 * the `Unscoped` suffix the codebase already uses.
 *
 * Deliberately textual rather than type-aware. A full TypeScript program
 * analysis would be more precise and would also be a thing that breaks on a
 * compiler upgrade; this reads the source the way a reviewer does, and its
 * false-positive mode is "somebody has to add a declaration", which is the
 * outcome we want anyway.
 */
export function auditTenancy(files: Array<{ path: string; source: string }>, schema: string): TenancyFinding[] {
  const models = tenantModels(schema);
  const findings: TenancyFinding[] = [];
  const call = /this\.prisma\.([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)\(/g;

  for (const { path, source } of files) {
    for (const match of source.matchAll(call)) {
      const [, model, operation] = match;
      if (!models.has(model) || !SCOPED_OPERATIONS.has(operation)) continue;

      const args = argumentSpan(source, match.index! + match[0].length - 1);
      const scoped =
        args.includes('organizationId') ||
        /\bthis\.scope\(/.test(args) ||
        /\bscoped\b/.test(args);
      if (scoped) continue;

      const { repository, method } = enclosing(source, match.index!);
      const declared =
        method.endsWith('Unscoped') ||
        declarations.has(`${repository}.${method}`) ||
        // The decorator has not necessarily been evaluated when the audit
        // runs from source, so the annotation is also recognised textually.
        new RegExp(
          `@Unscoped\\([\\s\\S]{0,400}?\\)\\s*(?:(?:public|private|protected|static|async|readonly)\\s+)*${method}\\s*[(<]`,
        ).test(source);
      if (declared) continue;

      findings.push({
        file: path,
        line: source.slice(0, match.index!).split('\n').length,
        repository,
        method,
        model,
        operation,
        snippet: args.replace(/\s+/g, ' ').slice(0, 120),
      });
    }
  }

  return findings;
}
