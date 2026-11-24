import { z } from 'zod';
import type { Objective, RequirementId } from '../src/types';

const overridesFileSchema = z.object({
  overrides: z.array(
    z.object({
      /** A requirement id ("AU.L2-3.3.2") or an objective id ("3.1.9[b]"). */
      id: z.string().min(1),
      text: z.string().min(1),
      /** Why the parsed text was wrong; the README repeats it for the human to spot-check. */
      reason: z.string().min(1),
    }),
  ),
});

/** Hand fixes in `overrides.json`, keyed by requirement or objective id. */
export type OverridesFile = z.infer<typeof overridesFileSchema>;

export function parseOverridesFile(json: unknown): OverridesFile {
  const result = overridesFileSchema.safeParse(json);
  if (!result.success) throw new Error(`invalid overrides file: ${result.error.message}`);
  return result.data;
}

export interface TextTarget {
  id: RequirementId;
  text: string;
  objectives: Objective[];
}

/**
 * Returns copies of the requirements with each override's text in place. Throws for an id
 * that matches nothing, an id listed twice, or an override that would not change the text.
 */
export function applyOverrides<T extends TextTarget>(
  requirements: readonly T[],
  file: OverridesFile,
): T[] {
  const byId = new Map(file.overrides.map((o) => [o.id, o]));
  if (byId.size !== file.overrides.length) {
    const seen = new Set<string>();
    for (const o of file.overrides) {
      if (seen.has(o.id)) throw new Error(`override ${o.id} is listed twice`);
      seen.add(o.id);
    }
  }

  const used = new Set<string>();
  const fix = (id: string, parsed: string): string => {
    const override = byId.get(id);
    if (!override) return parsed;
    if (override.text === parsed) throw new Error(`override ${id} does not change the parsed text`);
    used.add(id);
    return override.text;
  };

  const result = requirements.map((r) => ({
    ...r,
    text: fix(r.id, r.text),
    objectives: r.objectives.map((o) => ({ id: o.id, text: fix(o.id, o.text) })),
  }));

  for (const o of file.overrides) {
    if (!used.has(o.id)) throw new Error(`override ${o.id} matches no requirement or objective`);
  }
  return result;
}
