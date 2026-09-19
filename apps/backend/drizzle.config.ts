import { defineConfig } from "drizzle-kit";

// Drizzle-kit uses esbuild which doesn't auto-load .env
// Use process.env directly - Bun loads .env automatically when running the app
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
	throw new Error("DATABASE_URL environment variable is required");
}

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema/index.ts",
	out: "./src/db/migrations",
	dbCredentials: {
		url: databaseUrl,
	},
	verbose: true,
	strict: true,
});
