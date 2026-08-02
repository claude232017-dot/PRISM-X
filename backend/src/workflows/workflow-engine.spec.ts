import { BadRequestException } from '@nestjs/common';
import { countSteps, evaluateCondition } from './workflow-engine.service';
import { WorkflowService } from './workflow.service';
import { WorkflowStep } from './execution/execution-adapter.contract';

describe('workflow condition evaluation', () => {
  const scope = {
    input: { score: 82, tier: 'gold', tags: ['new', 'inbound'] },
    context: { step1: { ok: true }, empty: null },
  };

  it.each([
    ['eq', 82, true],
    ['neq', 50, true],
    ['gt', 50, true],
    ['gte', 82, true],
    ['lt', 100, true],
    ['lte', 82, true],
  ] as const)('evaluates %s', (operator, right, expected) => {
    expect(
      evaluateCondition({ left: '{{score}}', operator, right }, scope),
    ).toBe(expected);
  });

  it('resolves template references from input', () => {
    expect(evaluateCondition({ left: '{{tier}}', operator: 'eq', right: 'gold' }, scope)).toBe(true);
  });

  it('resolves template references from accumulated context', () => {
    expect(
      evaluateCondition({ left: '{{step1.ok}}', operator: 'truthy' }, scope),
    ).toBe(true);
  });

  it('treats a missing reference as not existing rather than throwing', () => {
    expect(evaluateCondition({ left: '{{nope.deep}}', operator: 'not_exists' }, scope)).toBe(true);
    expect(evaluateCondition({ left: '{{nope}}', operator: 'exists' }, scope)).toBe(false);
  });

  it('distinguishes a null value from an absent one for exists', () => {
    expect(evaluateCondition({ left: '{{empty}}', operator: 'exists' }, scope)).toBe(false);
  });

  it('handles array membership in both directions', () => {
    expect(
      evaluateCondition({ left: '{{tags}}', operator: 'contains', right: 'inbound' }, scope),
    ).toBe(true);
    expect(
      evaluateCondition({ left: '{{tier}}', operator: 'in', right: ['gold', 'platinum'] }, scope),
    ).toBe(true);
  });

  it('treats an absent condition as satisfied', () => {
    expect(evaluateCondition(undefined, scope)).toBe(true);
  });

  it('returns false for an unknown operator rather than throwing', () => {
    expect(
      evaluateCondition({ left: 1, operator: 'wat' as never, right: 1 }, scope),
    ).toBe(false);
  });
});

describe('countSteps', () => {
  it('counts nested children, branches and all', () => {
    const steps: WorkflowStep[] = [
      { id: 'a', type: 'transform', config: {} },
      {
        id: 'b',
        type: 'condition',
        config: {},
        onTrue: [{ id: 'c', type: 'transform', config: {} }],
        onFalse: [{ id: 'd', type: 'transform', config: {} }],
      },
      {
        id: 'e',
        type: 'parallel',
        config: {},
        steps: [
          { id: 'f', type: 'transform', config: {} },
          { id: 'g', type: 'transform', config: {} },
        ],
      },
    ];
    // a, b, c, d, e, f, g
    expect(countSteps(steps)).toBe(7);
  });

  it('counts an empty graph as zero', () => {
    expect(countSteps([])).toBe(0);
  });
});

describe('WorkflowService.validateSteps', () => {
  const step = (over: Partial<WorkflowStep>): WorkflowStep => ({
    id: 'x',
    type: 'transform',
    config: {},
    ...over,
  });

  it('accepts a well-formed graph', () => {
    expect(() =>
      WorkflowService.validateSteps([
        step({ id: 'one' }),
        step({ id: 'two', dependsOn: ['one'] }),
      ]),
    ).not.toThrow();
  });

  it('rejects a step with no id', () => {
    expect(() => WorkflowService.validateSteps([step({ id: '' })])).toThrow(
      BadRequestException,
    );
  });

  it('rejects duplicate ids, including across nesting', () => {
    expect(() =>
      WorkflowService.validateSteps([
        step({ id: 'dup' }),
        step({ id: 'outer', type: 'parallel', steps: [step({ id: 'dup' })] }),
      ]),
    ).toThrow(/Duplicate step id/);
  });

  it('rejects a dependency on a step that does not exist', () => {
    expect(() =>
      WorkflowService.validateSteps([step({ id: 'one', dependsOn: ['ghost'] })]),
    ).toThrow(/does not exist/);
  });

  it('requires a condition step to carry a predicate', () => {
    expect(() =>
      WorkflowService.validateSteps([step({ id: 'c', type: 'condition' })]),
    ).toThrow(/needs a `condition`/);
  });

  it('requires loop and parallel steps to have children', () => {
    expect(() => WorkflowService.validateSteps([step({ id: 'l', type: 'loop' })])).toThrow(
      /needs child steps/,
    );
    expect(() => WorkflowService.validateSteps([step({ id: 'p', type: 'parallel' })])).toThrow(
      /needs child steps/,
    );
  });

  it('requires a fallback when onError says to use one', () => {
    expect(() =>
      WorkflowService.validateSteps([step({ id: 'f', onError: 'fallback' })]),
    ).toThrow(/defines no `fallback`/);
  });
});
