import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { auditTenancy, tenantModels, Unscoped, unscopedDeclarations } from './tenancy';

const REPOSITORY_DIR = join(__dirname, 'repositories');
const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

function repositorySources(): Array<{ path: string; source: string }> {
  return readdirSync(REPOSITORY_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => ({
      path: `src/database/repositories/${file}`,
      source: readFileSync(join(REPOSITORY_DIR, file), 'utf8'),
    }));
}

describe('tenant model detection', () => {
  it('reads the tenant tables from the schema rather than a hand-kept list', () => {
    const models = tenantModels(SCHEMA);
    // A representative spread across phases, so a schema refactor that breaks
    // the parser shows up here rather than as a silently empty audit.
    expect(models.has('mission')).toBe(true);
    expect(models.has('worker')).toBe(true);
    expect(models.has('extension')).toBe(true);
    expect(models.has('node')).toBe(true);
    expect(models.size).toBeGreaterThan(60);
  });

  it('does not treat platform-wide tables as tenant tables', () => {
    const models = tenantModels(SCHEMA);
    // These carry no organizationId: they belong to the deployment, not to a
    // customer, and scoping them would be meaningless rather than safer.
    expect(models.has('plan')).toBe(false);
    expect(models.has('instance')).toBe(false);
    expect(models.has('permission')).toBe(false);
    expect(models.has('marketplaceListing')).toBe(false);
  });
});

describe('@Unscoped', () => {
  it('refuses a declaration with no real reason', () => {
    expect(() => Unscoped('')).toThrow(/real reason/i);
    expect(() => Unscoped('needed')).toThrow(/real reason/i);
  });

  it('records the reason so it can be audited at runtime', () => {
    class Example {
      @Unscoped('Authentication happens before a tenant is known, by design.')
      lookup(): void {}
    }
    void new Example();

    const declared = unscopedDeclarations().find((entry) => entry.site === 'Example.lookup');
    expect(declared?.reason).toMatch(/before a tenant is known/);
  });
});

describe('repository tenancy', () => {
  /**
   * The check that makes the application layer's guarantee provable.
   *
   * Every repository query against a table carrying `organizationId` must
   * either scope itself to a tenant or declare — with a reason — that it is
   * deliberately not doing so. Without this, "the repository layer scopes
   * every query" was a claim about code nobody had counted, and the count is
   * the whole point: one forgotten predicate is a cross-tenant read.
   */
  it('has no query that leaves tenant scope without saying why', () => {
    const findings = auditTenancy(repositorySources(), SCHEMA);

    const report = findings
      .map(
        (finding) =>
          `${finding.file}:${finding.line} — ${finding.repository}.${finding.method} ` +
          `queries ${finding.model}.${finding.operation} with no tenant predicate\n` +
          `      ${finding.snippet}`,
      )
      .join('\n');

    expect(
      findings.length === 0 ? '' : `\n${report}\n\nAdd a tenant predicate, or declare the query with @Unscoped('why').`,
    ).toBe('');
  });

  it('flags a query that is genuinely unscoped', () => {
    // The audit has to be capable of failing, or passing it means nothing.
    const findings = auditTenancy(
      [
        {
          path: 'fixture.ts',
          source: [
            'export class LeakyRepository {',
            '  everyone(): Promise<unknown> {',
            "    return this.prisma.mission.findMany({ where: { status: 'RUNNING' } });",
            '  }',
            '}',
          ].join('\n'),
        },
      ],
      SCHEMA,
    );

    expect(findings).toHaveLength(1);
    expect(findings[0].repository).toBe('LeakyRepository');
    expect(findings[0].method).toBe('everyone');
  });

  it('accepts the same query once it is scoped or declared', () => {
    const scoped = auditTenancy(
      [
        {
          path: 'fixture.ts',
          source: [
            'export class ScopedRepository {',
            '  mine(): Promise<unknown> {',
            '    return this.prisma.mission.findMany({ where: { organizationId: this.organizationId } });',
            '  }',
            '}',
          ].join('\n'),
        },
      ],
      SCHEMA,
    );
    expect(scoped).toHaveLength(0);

    const declared = auditTenancy(
      [
        {
          path: 'fixture.ts',
          source: [
            'export class SweepRepository {',
            '  everyoneUnscoped(): Promise<unknown> {',
            "    return this.prisma.mission.findMany({ where: { status: 'RUNNING' } });",
            '  }',
            '}',
          ].join('\n'),
        },
      ],
      SCHEMA,
    );
    expect(declared).toHaveLength(0);
  });
});
