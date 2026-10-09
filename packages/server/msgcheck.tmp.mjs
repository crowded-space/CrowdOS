import postgres from "postgres";
const sql = postgres("postgresql://postgres:nemoid148@localhost:5432/Nightly", { prepare: false, connect_timeout: 4, max: 1 });
try {
  const dbs = await sql`select datname from pg_database where not datistemplate`;
  console.log(JSON.stringify(dbs));
  const t = await sql`select to_regclass('public.messages') as m, to_regclass('public.channels') as c`;
  console.log(JSON.stringify(t));
} catch (e) { console.log("ERR", e.message); }
await sql.end({ timeout: 3 });
