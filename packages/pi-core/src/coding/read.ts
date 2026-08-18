import * as fs from 'fs/promises';
import * as path from 'path';

export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
  maxBytes?: number;
}

export interface ReadFileResult {
  success: boolean;
  content: string;
  totalLines: number;
  linesReturned: number;
  error?: string;
}

export async function readFile(input: ReadFileInput, basePath = process.cwd()): Promise<ReadFileResult> {
  const targetPath = path.isAbsolute(input.path) ? input.path : path.resolve(basePath, input.path);

  try {
    const rawContent = await fs.readFile(targetPath, 'utf8');
    const allLines = rawContent.split('\n');
    const totalLines = allLines.length;

    let start = input.startLine ? Math.max(1, input.startLine) : 1;
    let end = input.endLine ? Math.min(totalLines, input.endLine) : totalLines;

    if (start > totalLines) {
      return {
        success: false,
        content: '',
        totalLines,
        linesReturned: 0,
        error: `Start line ${start} exceeds total lines (${totalLines}) in file ${input.path}`,
      };
    }

    if (start > end) {
      return {
        success: false,
        content: '',
        totalLines,
        linesReturned: 0,
        error: `Start line ${start} cannot be greater than end line ${end}`,
      };
    }

    const selectedLines = allLines.slice(start - 1, end);
    const numberedLines = selectedLines.map((line: string, idx: number) => `${start + idx}: ${line}`);

    let content = numberedLines.join('\n');

    if (input.maxBytes && content.length > input.maxBytes) {
      content = content.slice(0, input.maxBytes) + '\n... [Content Truncated due to size limit]';
    }

    return {
      success: true,
      content,
      totalLines,
      linesReturned: selectedLines.length,
    };
  } catch (err: any) {
    return {
      success: false,
      content: '',
      totalLines: 0,
      linesReturned: 0,
      error: `Failed to read file ${input.path}: ${err?.message || String(err)}`,
    };
  }
}
