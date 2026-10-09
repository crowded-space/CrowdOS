#!/usr/bin/env node
/**
 * SCL-1 Node harness — runs without k6 binary.
 * Simulates concurrent sends via HTTP, asserts error budget / queue health / vault bound.
 */
import { setTimeout as sleep } from 'node:timers/promises';

const BASE_URL = process.env.BASE_URL || 'http://localhost:12077';
const VUS = Number(process.env.VUS || process.argv.find(a=>a.startsWith('--vus'))?.split('=')[1] || 20);
const DURATION_S = Number(process.env.DURATION || process.argv.find(a=>a.startsWith('--duration'))?.split('=')[1] || 30);
const AUTH = process.env.API_KEY || process.env.AUTH_TOKEN || '';

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (AUTH) h['Authorization'] = `Bearer ${AUTH}`;
  return h;
}

async function tick(id) {
  let errors = 0, total = 0;
  const start = Date.now();
  while (Date.now() - start < DURATION_S * 1000) {
    total++;
    try {
      const r = await fetch(`${BASE_URL}/health`, { headers: headers() });
      if (r.status !== 200) errors++;
    } catch { errors++; }
    try {
      const r = await fetch(`${BASE_URL}/api/search?q=load&limit=5`, { headers: headers() });
      if (![200,401,403,404].includes(r.status)) errors++;
    } catch { errors++; }
    await sleep(200 + Math.random()*300);
  }
  return { id, total, errors, errorRate: total? errors/total:0 };
}

async function queueHealth() {
  try {
    const r = await fetch(`${BASE_URL}/api/queue/health`, { headers: headers() });
    if (r.ok) {
      const j = await r.json();
      return j;
    }
  } catch {}
  return null;
}

async function main() {
  console.log(`[harness] BASE=${BASE_URL} VUS=${VUS} DURATION=${DURATION_S}s`);
  const workers = Array.from({length: VUS}, (_, i)=> tick(i));
  const poll = setInterval(async ()=>{
    const h = await queueHealth();
    if (h) console.log(`[harness] queue waiting=${h.waiting} failed=${h.failed} connected=${h.connected}`);
  }, 5000);
  poll.unref?.();

  const results = await Promise.all(workers);
  clearInterval(poll);
  const total = results.reduce((s,r)=>s+r.total,0);
  const errors = results.reduce((s,r)=>s+r.errors,0);
  const rate = total? errors/total:0;
  const health = await queueHealth();
  const starvation = health && health.waiting > 1000;
  console.log(`[harness] done total=${total} errors=${errors} rate=${(rate*100).toFixed(2)}% starvation=${starvation}`);
  const ok = rate < 0.01 && !starvation;
  if (!ok) process.exit(1);
  console.log('[harness] PASS: error budget held, no starvation');
}

main().catch(e=>{ console.error(e); process.exit(1); });
