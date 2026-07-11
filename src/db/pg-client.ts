import { logger } from "../utils/logger.js";

export async function isPgAvailable(): Promise<boolean> {
  return false;
}

export function getPG(): any {
  throw new Error("PostgreSQL is not available — Axiom uses SQLite exclusively");
}

export async function initPgSchema(): Promise<void> {
  logger.info("[PG] PostgreSQL is disabled — using SQLite exclusively");
}

export async function closePg(): Promise<void> {
  // No-op
}

export async function pgQuery(sql: string, params?: unknown[]): Promise<unknown[]> {
  throw new Error("PostgreSQL is not available");
}

export async function pgExec(sql: string): Promise<void> {
  throw new Error("PostgreSQL is not available");
}
