import * as fs from 'fs/promises';
import * as path from 'path';

export interface WriteFileInput {
  path: string;
  content: string;
  overwrite?: boolean;
}

export interface WriteFileResult {
  success: boolean;
  bytesWritten: number;
  error?: string;
}

export async function writeFile(input: WriteFileInput, basePath = process.cwd()): Promise<WriteFileResult> {
  const targetPath = path.isAbsolute(input.path) ? input.path : path.resolve(basePath, input.path);

  try {
    if (input.overwrite === false) {
      try {
        await fs.access(targetPath);
        return {
          success: false,
          bytesWritten: 0,
          error: `File ${input.path} already exists and overwrite is set to false.`,
        };
      } catch {
        // File does not exist, safe to write
      }
    }

    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(targetPath, input.content, 'utf8');

    return {
      success: true,
      bytesWritten: Buffer.byteLength(input.content, 'utf8'),
    };
  } catch (err: any) {
    return {
      success: false,
      bytesWritten: 0,
      error: `Failed to write to ${input.path}: ${err?.message || String(err)}`,
    };
  }
}
