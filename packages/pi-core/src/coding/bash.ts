import { exec } from 'child_process';

export interface BashInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface BashResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

export async function executeBash(input: BashInput, basePath = process.cwd(), signal?: AbortSignal): Promise<BashResult> {
  const cwd = input.cwd || basePath;
  const timeoutMs = input.timeoutMs || 60000;

  return new Promise((resolve) => {
    exec(
      input.command,
      {
        cwd,
        timeout: timeoutMs,
        env: { ...process.env, ...input.env },
        signal,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error: any, stdout: string, stderr: string) => {
        if (error) {
          resolve({
            success: false,
            stdout: stdout ? stdout.toString() : '',
            stderr: stderr ? stderr.toString() : error.message,
            exitCode: typeof error.code === 'number' ? error.code : 1,
            error: error.message,
          });
        } else {
          resolve({
            success: true,
            stdout: stdout ? stdout.toString() : '',
            stderr: stderr ? stderr.toString() : '',
            exitCode: 0,
          });
        }
      }
    );
  });
}
