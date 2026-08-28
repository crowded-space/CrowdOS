import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readFile } from './read.js';
import { editFile } from './edit.js';
import { writeFile } from './write.js';
import { executeBash } from './bash.js';

describe('Pi-Core Coding Primitives', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-core-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('should write and read files with line numbering', async () => {
    const filePath = path.join(tempDir, 'sample.txt');
    const content = 'Line 1: Hello\nLine 2: World\nLine 3: Foo\nLine 4: Bar';

    const writeRes = await writeFile({ path: filePath, content });
    expect(writeRes.success).toBe(true);
    expect(writeRes.bytesWritten).toBeGreaterThan(0);

    const readRes = await readFile({ path: filePath, startLine: 2, endLine: 3 });
    expect(readRes.success).toBe(true);
    expect(readRes.totalLines).toBe(4);
    expect(readRes.linesReturned).toBe(2);
    expect(readRes.content).toContain('2: Line 2: World');
    expect(readRes.content).toContain('3: Line 3: Foo');
  });

  it('should edit file with exact replacement and produce unified diff', async () => {
    const filePath = path.join(tempDir, 'code.ts');
    const initialCode = `function calculateTotal(items: number[]): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i];
  }
  return total;
}`;

    await writeFile({ path: filePath, content: initialCode });

    const editRes = await editFile({
      path: filePath,
      targetContent: '  for (let i = 0; i < items.length; i++) {\n    total += items[i];\n  }',
      replacementContent: '  return items.reduce((acc, curr) => acc + curr, 0);',
    });

    expect(editRes.success).toBe(true);
    expect(editRes.occurrencesReplaced).toBe(1);
    expect(editRes.diff).toContain('reduce');

    const updated = await readFile({ path: filePath });
    expect(updated.content).toContain('items.reduce');
  });

  it('should execute command via executeBash', async () => {
    const res = await executeBash({ command: 'node -e "console.log(\\"pi-bash-success\\")"' });
    expect(res.success).toBe(true);
    expect(res.stdout).toContain('pi-bash-success');
    expect(res.exitCode).toBe(0);
  });
});
