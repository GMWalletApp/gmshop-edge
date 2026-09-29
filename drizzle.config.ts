import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: [".env.local", ".env"] });

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
const token = process.env.CLOUDFLARE_D1_TOKEN;

export default defineConfig({
	out: "./drizzle",
	schema: "./src/db/schema/index.ts",
	dialect: "sqlite",
	...(accountId && databaseId && token
		? {
				driver: "d1-http" as const,
				dbCredentials: { accountId, databaseId, token },
			}
		: {}),
});
