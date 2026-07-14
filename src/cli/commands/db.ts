import { Database } from "bun:sqlite"
import { logger } from "../../utils/logger.js"

let _dbPath = "./data/agent.db"

export function setDbPath(path: string): void {
  _dbPath = path
}

export async function handleDbQuery(args: string[]): Promise<void> {
  const sql = args.join(" ")
  if (!sql) { console.error("Usage: db:query <sql>"); return }
  const db = new Database(_dbPath)
  try {
    const rows = db.query(sql).all()
    console.log(JSON.stringify(rows, null, 2))
  } catch (e: unknown) {
    console.error("Query error:", e instanceof Error ? e.message : String(e))
  }
  db.close()
}

export async function handleDbTables(): Promise<void> {
  const db = new Database(_dbPath)
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
  db.close()
  console.log("Tables:", tables.map((t) => t.name).join(", "))
}

export async function handleDbVacuum(): Promise<void> {
  logger.info("Vacuuming database...")
  const db = new Database(_dbPath)
  db.run("VACUUM")
  db.close()
  logger.info("Vacuum complete")
}
