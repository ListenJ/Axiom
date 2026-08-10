export interface DistillationCandidate {
  ageDays: number;
  confidence: number;
  contentLength: number;
}

export interface DistillationWeights {
  age: number;
  confidence: number;
  richness: number;
}

export interface DistillationScore {
  score: number;
  shouldDistill: boolean;
  ageScore: number;
  confidenceScore: number;
  richnessScore: number;
}

export const DEFAULT_DISTILLATION_WEIGHTS: DistillationWeights = {
  age: 0.5,
  confidence: 0.3,
  richness: 0.2,
};

export function scoreDistillationCandidate(
  candidate: DistillationCandidate,
  weights: DistillationWeights = DEFAULT_DISTILLATION_WEIGHTS,
  options: { minAgeDays?: number; threshold?: number; maxAgeDays?: number; maxRichnessChars?: number } = {},
): DistillationScore {
  const minAgeDays = options.minAgeDays ?? 30;
  const threshold = options.threshold ?? 0.45;
  const maxAgeDays = options.maxAgeDays ?? 90;
  const maxRichnessChars = options.maxRichnessChars ?? 4000;

  const ageScore = Math.min(1, Math.max(0, candidate.ageDays / maxAgeDays));
  const confidenceScore = Math.min(1, Math.max(0, candidate.confidence));
  const richnessScore = Math.min(1, Math.max(0, candidate.contentLength / maxRichnessChars));
  const score = ageScore * weights.age + confidenceScore * weights.confidence + richnessScore * weights.richness;

  return {
    score,
    shouldDistill: candidate.ageDays >= minAgeDays && score >= threshold,
    ageScore,
    confidenceScore,
    richnessScore,
  };
}

export function selectDistillationCandidates(
  candidates: Array<DistillationCandidate & { id: string }>,
  limit: number,
  options?: { weights?: DistillationWeights; minAgeDays?: number; threshold?: number; maxAgeDays?: number },
): Array<{ id: string; score: DistillationScore }> {
  return candidates
    .map((c) => ({ id: c.id, score: scoreDistillationCandidate(c, options?.weights, options) }))
    .filter((c) => c.score.shouldDistill)
    .sort((a, b) => b.score.score - a.score.score)
    .slice(0, limit);
}