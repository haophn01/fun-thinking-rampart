import { z } from 'zod';
import { normalizePracticeId } from '../src/load';
import type { RequirementId, Scoring } from '../src/types';

const requirementType = z.enum(['basic', 'derived']);
const citation = z.string().min(1);

const pointsFileSchema = z.object({
  source: z.object({ title: z.string().min(1), url: z.url(), retrieved: z.iso.date() }),
  lists: z.array(
    z.object({
      points: z.union([z.literal(5), z.literal(3)]),
      type: requirementType,
      citation,
      ids: z.array(z.string()),
    }),
  ),
  remaining: z.object({ points: z.literal(1), type: requirementType, citation }),
  partialCredit: z.array(
    z.object({
      id: z.string(),
      points: z.literal(5),
      deduction: z.literal(3),
      label: z.string().min(1),
      citation,
    }),
  ),
  prerequisites: z.array(z.object({ id: z.string(), citation })),
});

/** The 32 CFR 170.24(c)(2) point lists, transcribed in `points.cfr170-24.json`. */
export type PointsFile = z.infer<typeof pointsFileSchema>;

export function parsePointsFile(json: unknown): PointsFile {
  const result = pointsFileSchema.safeParse(json);
  if (!result.success) throw new Error(`invalid points file: ${result.error.message}`);
  return result.data;
}

interface ScoredRequirement {
  id: RequirementId;
  type: 'basic' | 'derived';
}

/**
 * Gives every requirement its scoring from the regulation's lists. Throws when an id is
 * unknown, appears on two lists, sits on a list whose basic/derived label disagrees with
 * the catalog, or is a basic requirement the regulation never lists.
 */
export function assignScoring(
  requirements: readonly ScoredRequirement[],
  file: PointsFile,
): Map<RequirementId, Scoring> {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const scoring = new Map<RequirementId, Scoring>();

  const place = (raw: string, value: Scoring, listedType?: 'basic' | 'derived') => {
    const id = normalizePracticeId(raw);
    const requirement = byId.get(id);
    if (!requirement) throw new Error(`${id} is not in the catalog`);
    if (scoring.has(id)) throw new Error(`${id} is in two point lists`);
    if (listedType !== undefined && listedType !== requirement.type) {
      throw new Error(`${id} is ${requirement.type} in the catalog but listed as ${listedType}`);
    }
    scoring.set(id, value);
  };

  for (const list of file.lists) {
    for (const raw of list.ids) {
      place(
        raw,
        { kind: 'points', points: list.points, citation: list.citation, partialCredit: null },
        list.type,
      );
    }
  }
  for (const p of file.partialCredit) {
    place(p.id, {
      kind: 'points',
      points: p.points,
      citation: p.citation,
      partialCredit: { deduction: p.deduction, label: p.label, citation: p.citation },
    });
  }
  for (const p of file.prerequisites) {
    place(p.id, { kind: 'prerequisite', citation: p.citation });
  }

  for (const r of requirements) {
    if (scoring.has(r.id)) continue;
    if (r.type !== file.remaining.type) {
      throw new Error(`${r.id} is ${r.type} but is on no point list`);
    }
    scoring.set(r.id, {
      kind: 'points',
      points: file.remaining.points,
      citation: file.remaining.citation,
      partialCredit: null,
    });
  }
  return scoring;
}
