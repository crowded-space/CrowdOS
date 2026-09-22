import { env } from "./src/shared/config/env.js";
(env as any).DATABASE_URL = undefined;
const { buildServer } = await import("./src/create-app.js");
const built = await buildServer({ skipTimers: true, skipListen: true });
const app = built.app;
const get = (headers: Record<string,string>, remoteAddress = "127.0.0.1") =>
  app.inject({ method: "GET", url: "/api/agents", headers, remoteAddress });
const a = await get({});
console.log("A no headers          ->", a.statusCode, a.body.slice(0,100));
const b = await get({ authorization: "Bearer 1234" });
console.log("B Bearer <pin>        ->", b.statusCode, b.body.slice(0,100));
const c = await get({ "x-pin": "1234" });
console.log("C x-pin only          ->", c.statusCode, c.body.slice(0,100));
const d = await get({ authorization: "Bearer 1234", "x-pin": "1234" });
console.log("D both (real client)  ->", d.statusCode, d.body.slice(0,100));
const e = await get({ "x-api-key": "crowd_bogus" });
console.log("E bogus x-api-key     ->", e.statusCode, e.body.slice(0,100));
await built.stop();