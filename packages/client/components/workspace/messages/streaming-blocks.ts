// Pure splitter for streaming markdown: completed blocks (stable, safe to
// memoize) plus one trailing pending block (the only node that re-renders per
// flush). An unclosed code fence stays inside the pending block so its layout
// never changes mid-block. Splitting respects fence boundaries: blank lines
// inside a closed fence do not split a block apart.

export interface streamSplit {
  completed: string[];
  pending: string;
  pendingIsCode: boolean;
}

function splitOutsideFences(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  const push = () => {
    const joined = cur.join('\n').trim();
    if (joined) out.push(joined);
    cur = [];
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      cur.push(line);
      inFence = !inFence;
      continue;
    }
    if (!inFence && trimmed === '') {
      if (cur.length > 0) push();
      continue;
    }
    cur.push(line);
  }
  push();
  return out;
}

export function splitStreamBlocks(markdown: string): streamSplit {
  if (!markdown || !markdown.trim()) return { completed: [], pending: '', pendingIsCode: false };
  const fenceCount = (markdown.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    const lastFence = markdown.lastIndexOf('```');
    const before = markdown.slice(0, lastFence);
    return {
      completed: splitOutsideFences(before),
      pending: markdown.slice(before.length),
      pendingIsCode: true,
    };
  }
  const parts = splitOutsideFences(markdown);
  return {
    completed: parts.slice(0, -1),
    pending: parts[parts.length - 1] ?? '',
    pendingIsCode: false,
  };
}
