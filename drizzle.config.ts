/**
 * drizzle-kit config for projection schema migrations (ADR-0002).
 *
 * Only the Drizzle-managed projection tables (src/db/schema.ts) are tracked
 * here. The append-only `events` table (raw SQL) and the FTS5 / vec0 virtual
 * tables are created at init in src/db/connection.ts and are intentionally out
 * of drizzle-kit's scope. Projections are drop+rebuild friendly, so in-place
 * migrations are low-stakes — generated artifacts live in ./drizzle.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
