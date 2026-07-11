import { logger } from "../utils/logger.js";

async function main() {
  logger.info("[PG] PostgreSQL is disabled — Axiom uses SQLite exclusively");
  logger.info("All knowledge graph and structured data storage uses SQLite.");
  process.exit(0);
}

main().catch(console.error);
