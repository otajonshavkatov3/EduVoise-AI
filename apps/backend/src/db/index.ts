import { getServerEnv } from "@shared/env";
import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "./schema";

const env = getServerEnv();

export const db = drizzle(env.DATABASE_URL, { schema });

export { schema };
