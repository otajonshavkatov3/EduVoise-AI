import { sql } from "drizzle-orm";
import { db } from "./index";

async function reset() {
	console.log("⏳ Database reset qilinmoqda...");

	try {
		// Barcha jadvallarni (drizzle_migrations dan tashqari) truncate qilish
		await db.execute(sql`
      DO $$ 
      DECLARE 
          r RECORD;
      BEGIN
          FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '__drizzle_migrations') LOOP
              EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
          END LOOP;
      END $$;
    `);

		console.log("✅ Database muvaffaqiyatli reset qilindi.");
		process.exit(0);
	} catch (error) {
		console.error("❌ Reset qilishda xatolik yuz berdi:", error);
		process.exit(1);
	}
}

reset();
