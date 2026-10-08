import type { PerceptionBudget } from "./types.js";

/** Conservative defaults: enough for local gaps, never a full-video VLM pass. */
export const DEFAULT_PERCEPTION_BUDGET: Readonly<PerceptionBudget> = Object.freeze({
  maxRequests: 8,
  maxFrames: 48,
  maxVisualSeconds: 120,
});

export interface PerceptionPolicy {
  enabled: boolean;
  budget: PerceptionBudget;
  maxRefinements: number;
}

export const DEFAULT_PERCEPTION_POLICY: Readonly<PerceptionPolicy> = Object.freeze({
  enabled: true,
  budget: { ...DEFAULT_PERCEPTION_BUDGET },
  maxRefinements: 2,
});

export function normalizePerceptionBudget(
  budget: Partial<PerceptionBudget> | undefined,
): PerceptionBudget {
  const maxRequests = positiveInteger(budget?.maxRequests, DEFAULT_PERCEPTION_BUDGET.maxRequests, "maxRequests");
  const maxFrames = positiveInteger(budget?.maxFrames, DEFAULT_PERCEPTION_BUDGET.maxFrames, "maxFrames");
  const maxVisualSeconds = budget?.maxVisualSeconds === undefined
    ? DEFAULT_PERCEPTION_BUDGET.maxVisualSeconds
    : positiveNumber(budget.maxVisualSeconds, "maxVisualSeconds");
  return {
    maxRequests,
    maxFrames,
    ...(maxVisualSeconds === undefined ? {} : { maxVisualSeconds }),
  };
}

export function normalizePerceptionPolicy(input: Partial<PerceptionPolicy> | undefined): PerceptionPolicy {
  return {
    enabled: input?.enabled ?? DEFAULT_PERCEPTION_POLICY.enabled,
    budget: normalizePerceptionBudget(input?.budget),
    maxRefinements: positiveInteger(input?.maxRefinements, DEFAULT_PERCEPTION_POLICY.maxRefinements, "maxRefinements"),
  };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return result;
}

function positiveNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
  return value;
}
