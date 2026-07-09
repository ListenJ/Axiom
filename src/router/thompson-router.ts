/**
 * src/router/thompson-router.ts - Contextual Thompson Sampling for adaptive model routing
 */
import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

export interface RouterArm {
  id: string; model: string; provider: string;
  alpha: number; beta: number; metadata?: Record<string, unknown>;
}
export interface RoutingContext {
  taskType: string; inputLength: number;
  timeWindow?: number; extra?: Record<string, unknown>;
}
export interface RoutingDecision {
  arm: RouterArm; confidence: number; reason: string;
  samples: Array<{ armId: string; value: number }>;
}
export interface ArmStats {
  id: string; alpha: number; beta: number; mean: number;
  variance: number; samples: number; lastUpdated: number;
}
export interface ThompsonRouterConfig {
  arms: RouterArm[]; minSamples: number; decayFactor: number;
  dbPath?: string; inMemory?: boolean;
}

// ============================================================================
// Lanczos Gamma approximation (g=7, n=9, relative error < 2e-10)
// ============================================================================
const LANCZOS_G = 7;
const LANCZOS_P: number[] = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = LANCZOS_P[0];
  for (let i = 1; i < LANCZOS_P.length; i++) x += LANCZOS_P[i] / (z + i);
  const t = z + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// ============================================================================
// Cold-start handling
//
// Thompson Sampling already provides principled cold-start exploration via the
// uninformative Beta(1,1) prior: arms with no observations sample ~uniformly,
// so they are naturally explored without disabling sampling for *all* arms.
// We therefore always run TS (see route()), rather than falling back to a
// static heuristic that previously turned off sampling until every arm warmed.
// ============================================================================


// ============================================================================
// ThompsonRouter class
// ============================================================================
export class ThompsonRouter {
  private arms: Map<string, RouterArm>;
  private minSamples: number;
  private decayFactor: number;
  private db: Database | null;
  private inMemory: boolean;
  private totalRounds: number = 0;
  private observations: Map<string, Array<{ success: boolean; round: number; weight: number }>> = new Map();

  constructor(config: ThompsonRouterConfig) {
    this.arms = new Map(config.arms.map((a) => [a.id, { ...a }]));
    this.minSamples = config.minSamples;
    this.decayFactor = Math.max(0, Math.min(1, config.decayFactor));
    this.inMemory = config.inMemory ?? false;
    if (!this.inMemory) {
      this.db = new Database(config.dbPath ?? "./data/thompson_router.db");
      this.initDatabase();
      this.loadState();
    } else { this.db = null; }
    logger.info("[ThompsonRouter] initialized", {
      arms: config.arms.map((a) => a.id), minSamples: config.minSamples,
      decayFactor: config.decayFactor, inMemory: this.inMemory,
    });
  }

  private initDatabase(): void {
    if (!this.db) return;
    this.db.exec("CREATE TABLE IF NOT EXISTS thompson_arms (id TEXT PRIMARY KEY, alpha REAL NOT NULL DEFAULT 1, beta REAL NOT NULL DEFAULT 1, total_count INTEGER NOT NULL DEFAULT 0, last_updated INTEGER NOT NULL DEFAULT 0)");
    this.db.exec("CREATE TABLE IF NOT EXISTS thompson_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, arm_id TEXT NOT NULL, success INTEGER NOT NULL, round INTEGER NOT NULL, weight REAL NOT NULL DEFAULT 1.0, created_at INTEGER NOT NULL, FOREIGN KEY (arm_id) REFERENCES thompson_arms(id))");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_obs_arm ON thompson_observations(arm_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_obs_round ON thompson_observations(round)");
    logger.debug("[ThompsonRouter] database tables initialized");
  }

  private loadState(): void {
    if (!this.db) return;
    try {
      const rows = this.db.query("SELECT id, alpha, beta, total_count, last_updated FROM thompson_arms").all() as Array<{id:string;alpha:number;beta:number;total_count:number;last_updated:number}>;
      for (const row of rows) {
        const arm = this.arms.get(row.id);
        if (arm) { arm.alpha = row.alpha; arm.beta = row.beta; }
        const obsRows = this.db.query("SELECT success, round, weight FROM thompson_observations WHERE arm_id = ? ORDER BY round").all(row.id) as Array<{success:number;round:number;weight:number}>;
        if (obsRows.length > 0) {
          this.observations.set(row.id, obsRows.map((o) => ({ success: o.success === 1, round: o.round, weight: o.weight })));
        }
        if (row.total_count > this.totalRounds) this.totalRounds = row.total_count;
      }
      logger.debug("[ThompsonRouter] state loaded", { loadedArms: rows.length, totalRounds: this.totalRounds });
    } catch (err) { logger.error("[ThompsonRouter] state load failed", err as Error); }
  }

  private saveArmState(armId: string): void {
    if (!this.db) return;
    const arm = this.arms.get(armId);
    if (!arm) return;
    try {
      this.db.run("INSERT INTO thompson_arms (id, alpha, beta, total_count, last_updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET alpha = excluded.alpha, beta = excluded.beta, total_count = excluded.total_count, last_updated = excluded.last_updated", [armId, arm.alpha, arm.beta, this.totalRounds, Date.now()]);
    } catch (err) { logger.error("[ThompsonRouter] save arm state failed: " + armId, err as Error); }
  }

  private saveObservation(armId: string, success: boolean, round: number, weight: number): void {
    if (!this.db) return;
    try { this.db.run("INSERT INTO thompson_observations (arm_id, success, round, weight) VALUES (?, ?, ?, ?)", [armId, success ? 1 : 0, round, weight]); }
    catch (err) { logger.error("[ThompsonRouter] save observation failed: arm=" + armId, err as Error); }
  }


  // --------------------------------------------------------------------------
  // Beta distribution sampling
  // Uses Gamma ratio method for alpha>=1, beta>=1; Johnk algorithm otherwise.
  // --------------------------------------------------------------------------
  sampleBeta(alpha: number, beta: number): number {
    if (alpha <= 0 || beta <= 0) throw new Error("Beta params must be > 0: alpha=" + alpha + ", beta=" + beta);
    if (alpha >= 1 && beta >= 1) {
      const x = this.sampleGamma(alpha);
      const y = this.sampleGamma(beta);
      return x / (x + y);
    }
    return this.sampleBetaJohnk(alpha, beta);
  }

  private sampleGamma(shape: number): number {
    if (shape < 1) return this.sampleGamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number; let v: number;
      do { x = this.normalRandom(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  private sampleBetaJohnk(alpha: number, beta: number): number {
    const MAX_ITER = 200;
    for (let iter = 0; iter < MAX_ITER; iter++) {
      const u = Math.pow(Math.random(), 1 / alpha);
      const v = Math.pow(Math.random(), 1 / beta);
      if (u + v <= 1) return u / (u + v);
    }
    return alpha / (alpha + beta);
  }

  private normalRandom(): number {
    let u = 0; let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // --------------------------------------------------------------------------
  // Time decay: alpha_eff = 1 + sum decayFactor^(T-t) * I[success]
  // --------------------------------------------------------------------------
  private getEffectiveParams(armId: string): { alpha: number; beta: number } {
    const obs = this.observations.get(armId);
    if (!obs || obs.length === 0) {
      const arm = this.arms.get(armId);
      if (!arm) return { alpha: 1, beta: 1 };
      return { alpha: arm.alpha, beta: arm.beta };
    }
    // Single source of truth: derive posterior params from the observation log.
    // With decayFactor >= 1 this reduces to the raw success/failure counts,
    // which is consistent with reportFeedback's arm.alpha/beta increments.
    let effectiveAlpha = 1; let effectiveBeta = 1;
    for (const o of obs) {
      const w = o.weight * Math.pow(this.decayFactor, this.totalRounds - o.round);
      if (o.success) effectiveAlpha += w; else effectiveBeta += w;
    }
    return { alpha: effectiveAlpha, beta: effectiveBeta };
  }

  private applyDecay(): void {
    if (this.decayFactor >= 1) return;
    for (const [armId, obs] of this.observations) {
      const arm = this.arms.get(armId);
      if (!arm) continue;
      let alpha = 1; let beta = 1;
      for (const o of obs) {
        const w = Math.pow(this.decayFactor, this.totalRounds - o.round);
        if (o.success) alpha += w; else beta += w;
      }
      arm.alpha = alpha; arm.beta = beta;
      this.saveArmState(armId);
    }
  }

  // --------------------------------------------------------------------------
  // Core routing: Thompson Sampling with cold-start fallback
  // Regret bound: O(sqrt(N * T * log T)) for N arms over T rounds
  // --------------------------------------------------------------------------
  async route(context: RoutingContext): Promise<RoutingDecision> {
    const samples: Array<{ armId: string; value: number }> = [];
    // Thompson Sampling runs unconditionally. Cold arms (alpha+beta-2 < minSamples)
    // carry the uninformative Beta(1,1) prior and are explored naturally; we no
    // longer disable sampling for every arm just because one is still warming up.
    let bestArm: RouterArm | null = null; let bestValue = -1;
    for (const arm of this.arms.values()) {
      const { alpha, beta } = this.getEffectiveParams(arm.id);
      const sampleValue = this.sampleBeta(alpha, beta);
      samples.push({ armId: arm.id, value: sampleValue });
      if (sampleValue > bestValue) { bestValue = sampleValue; bestArm = arm; }
    }
    if (!bestArm) throw new Error("[ThompsonRouter] TS selected no arm");
    logger.debug("[ThompsonRouter] TS routing decision", { selectedArm: bestArm.id, confidence: bestValue, taskType: context.taskType });
    return { arm: bestArm, confidence: bestValue, reason: "Thompson Sampling: p=" + bestValue.toFixed(4) + " (max over " + samples.length + " arms)", samples: samples.sort((a, b) => b.value - a.value) };
  }


  // --------------------------------------------------------------------------
  // Feedback: success -> alpha++, failure -> beta++
  // --------------------------------------------------------------------------
  reportFeedback(armId: string, success: boolean): void {
    const arm = this.arms.get(armId);
    if (!arm) { logger.warn("[ThompsonRouter] unknown arm: " + armId); return; }
    this.totalRounds++;
    const obs = this.observations.get(armId) ?? [];
    obs.push({ success, round: this.totalRounds, weight: 1.0 });
    this.observations.set(armId, obs);
    if (success) arm.alpha++; else arm.beta++;
    this.saveArmState(armId);
    this.saveObservation(armId, success, this.totalRounds, 1.0);
    if (this.totalRounds % 100 === 0) this.applyDecay();
    const mean = arm.alpha / (arm.alpha + arm.beta);
    logger.debug("[ThompsonRouter] feedback recorded", { armId, success, alpha: arm.alpha.toFixed(2), beta: arm.beta.toFixed(2), mean: mean.toFixed(4), totalRounds: this.totalRounds });
  }

  // --------------------------------------------------------------------------
  // Stats: posterior mean = alpha/(alpha+beta), variance = alpha*beta/((alpha+beta)^2*(alpha+beta+1))
  // --------------------------------------------------------------------------
  getArmStats(): ArmStats[] {
    const stats: ArmStats[] = [];
    for (const arm of this.arms.values()) {
      const { alpha, beta } = this.getEffectiveParams(arm.id);
      const total = alpha + beta;
      const mean = alpha / total;
      const variance = (alpha * beta) / (total * total * (total + 1));
      const samples = total - 2;
      stats.push({ id: arm.id, alpha: Math.round(alpha*100)/100, beta: Math.round(beta*100)/100, mean: Math.round(mean*10000)/10000, variance: Math.round(variance*1000000)/1000000, samples: Math.max(0, Math.round(samples*100)/100), lastUpdated: Date.now() });
    }
    return stats;
  }

  addArm(arm: RouterArm): void {
    if (this.arms.has(arm.id)) { logger.warn("[ThompsonRouter] arm exists: " + arm.id); return; }
    this.arms.set(arm.id, { ...arm });
    this.saveArmState(arm.id);
    logger.info("[ThompsonRouter] added arm: " + arm.id);
  }

  removeArm(armId: string): void {
    this.arms.delete(armId); this.observations.delete(armId);
    if (this.db) {
      try { this.db.run("DELETE FROM thompson_arms WHERE id = ?", [armId]); this.db.run("DELETE FROM thompson_observations WHERE arm_id = ?", [armId]); }
      catch (err) { logger.error("[ThompsonRouter] remove arm failed: " + armId, err as Error); }
    }
    logger.info("[ThompsonRouter] removed arm: " + armId);
  }

  getArm(armId: string): RouterArm | undefined { return this.arms.get(armId); }
  getArmIds(): string[] { return Array.from(this.arms.keys()); }
  getTotalRounds(): number { return this.totalRounds; }

  reset(): void {
    for (const arm of this.arms.values()) { arm.alpha = 1; arm.beta = 1; }
    this.observations.clear(); this.totalRounds = 0;
    if (this.db) {
      try { this.db.run("DELETE FROM thompson_arms"); this.db.run("DELETE FROM thompson_observations"); }
      catch (err) { logger.error("[ThompsonRouter] reset failed", err as Error); }
    }
    logger.info("[ThompsonRouter] stats reset");
  }

  close(): void {
    this.applyDecay();
    if (this.db) { this.db.close(); this.db = null; }
    logger.info("[ThompsonRouter] closed");
  }
}

// ============================================================================
// Convenience factory
// ============================================================================
export function createThompsonRouter(
  config: Partial<ThompsonRouterConfig> & { arms: RouterArm[] },
): ThompsonRouter {
  return new ThompsonRouter({
    arms: config.arms,
    minSamples: config.minSamples ?? 10,
    decayFactor: config.decayFactor ?? 0.95,
    dbPath: config.dbPath,
    inMemory: config.inMemory ?? false,
  });
}
