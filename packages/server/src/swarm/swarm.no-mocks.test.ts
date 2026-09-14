import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const swarmDir = path.resolve(__dirname);
const serverSrc = path.resolve(__dirname, '..');

function readIfExists(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

const bannedStrings = [
  'Task Output for',
  'export function runTask',
  'Subtask processed successfully',
  'Completed Worker code artifact',
  'Worker output failed standard verification checklist',
  'Worker output matches requirements',
  'setTimeout(resolve, 800)',
  // Additional mocked template artifacts
  'runTask()',
];

describe('Swarm SW-1 — no mocked template strings (grep ban)', () => {
  const swarmFiles = fs
    .readdirSync(swarmDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => path.join(swarmDir, f));

  const swarmRuntimePath = path.join(serverSrc, 'runtime', 'runtimes', 'swarm-runtime.ts');
  const allChecked = [...swarmFiles, swarmRuntimePath];

  for (const file of allChecked) {
    it(`bans mocked strings in ${path.basename(file)}`, () => {
      const content = readIfExists(file);
      expect(content, `file should be readable: ${file}`).not.toBe('');
      for (const banned of bannedStrings) {
        expect(content, `banned mocked string "${banned}" found in ${path.basename(file)} — Swarm must not contain template literals from old AgentSpawnManager`).not.toContain(banned);
      }
    });
  }

  it('legacy AgentSpawnManager file is retired', async () => {
    const spawnPath = path.join(serverSrc, 'agents', 'agent-spawn-manager.ts');
    expect(fs.existsSync(spawnPath)).toBe(false);
  });
});
