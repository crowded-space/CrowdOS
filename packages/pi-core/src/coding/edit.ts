import * as fs from 'fs/promises';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';

export interface EditFileInput {
  path: string;
  targetContent: string;
  replacementContent: string;
  startLine?: number;
  endLine?: number;
  allowMultiple?: boolean;
}

export interface EditFileResult {
  success: boolean;
  diff: string;
  occurrencesReplaced: number;
  error?: string;
}

export async function editFile(input: EditFileInput, basePath = process.cwd()): Promise<EditFileResult> {
  const targetPath = path.isAbsolute(input.path) ? input.path : path.resolve(basePath, input.path);

  try {
    const originalContent = await fs.readFile(targetPath, 'utf8');

    let contentToSearch = originalContent;
    let prefix = '';
    let suffix = '';

    // If startLine / endLine are specified, bound the search scope
    if (input.startLine || input.endLine) {
      const lines = originalContent.split('\n');
      const start = input.startLine ? Math.max(1, input.startLine) - 1 : 0;
      const end = input.endLine ? Math.min(lines.length, input.endLine) : lines.length;

      prefix = lines.slice(0, start).join('\n') + (start > 0 ? '\n' : '');
      contentToSearch = lines.slice(start, end).join('\n');
      suffix = (end < lines.length ? '\n' : '') + lines.slice(end).join('\n');
    }

    const occurrences = (contentToSearch.match(new RegExp(escapeRegExp(input.targetContent), 'g')) || []).length;

    if (occurrences === 0) {
      // Try normalized line-ending fallback (CRLF vs LF)
      const normalizedSearch = contentToSearch.replace(/\r\n/g, '\n');
      const normalizedTarget = input.targetContent.replace(/\r\n/g, '\n');

      if (!normalizedSearch.includes(normalizedTarget)) {
        return {
          success: false,
          diff: '',
          occurrencesReplaced: 0,
          error: `Target content not found in ${input.path}${input.startLine ? ` (within lines ${input.startLine}-${input.endLine})` : ''}. Ensure whitespace and line numbers match exactly.`,
        };
      }
    }

    if (occurrences > 1 && !input.allowMultiple) {
      return {
        success: false,
        diff: '',
        occurrencesReplaced: 0,
        error: `Target content found ${occurrences} times in ${input.path}. Specify startLine/endLine or set allowMultiple: true to disambiguate.`,
      };
    }

    let modifiedSlice: string;
    if (input.allowMultiple) {
      modifiedSlice = contentToSearch.split(input.targetContent).join(input.replacementContent);
    } else {
      modifiedSlice = contentToSearch.replace(input.targetContent, input.replacementContent);
    }

    const finalContent = prefix + modifiedSlice + suffix;

    await fs.writeFile(targetPath, finalContent, 'utf8');

    const diff = createTwoFilesPatch(
      input.path,
      input.path,
      originalContent,
      finalContent,
      'original',
      'modified'
    );

    return {
      success: true,
      diff,
      occurrencesReplaced: occurrences || 1,
    };
  } catch (err: any) {
    return {
      success: false,
      diff: '',
      occurrencesReplaced: 0,
      error: `Failed to edit ${input.path}: ${err?.message || String(err)}`,
    };
  }
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
