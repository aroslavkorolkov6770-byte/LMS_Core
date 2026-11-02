import { defineConfig } from "drizzle-kit";

// Generation only: a separate history for empty installations, with no connection credentials.
export default defineConfig({
  schema: "./dist/src/schema/index.js",
  out: "./install-baseline",
  dialect: "postgresql"
});
