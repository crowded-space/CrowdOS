import React, { useState, useMemo } from 'react';
import { Copy, Check, ChevronDown, ChevronUp, Code2 } from 'lucide-react';
import { useCrowdOSStore } from '@/stores/crowdOsStore';
import { stripToolCalls } from '@crowdspace/shared';
import { highlightCode } from '../code-highlight';
import { RedactedText } from './RedactedText';
import { countSecrets } from './secret-redaction';

interface MentionParserProps {
  text: string;
}

const CODE_BLOCK_REGEX = /```(\w*)\r?\n([\s\S]*?)(?:```|$)/g;
const INLINE_CODE_REGEX = /(`[^`]+`)/g;
const INLINE_FORMAT = /\*\*([^*]+)\*\*|\*([^*]+)\*|~~([^~]+)~~/g;
const DISPLAY_COPY_EM_DASH = /\s*\u2014\s*/g;

const ROLE_NAMES = [
  'Level0', 'Level 0', 'L0', 'Omniscient', 'Omniscient Monitor',
  'Level1', 'Level 1', 'L1', 'Admin', 'Executive Administrator', 'CEO',
  'Level2', 'Level 2', 'L2', 'Coordinator', 'Operation Coordinator',
  'Level3', 'Level 3', 'L3', 'Worker', 'Autonomic Worker', 'Supervisor'
];
const USER_NAMES = [
  'Human Operator', 'Operator', 'Juan Hamzah', 'User'
];

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMentionRegex(agentNames: string[]): RegExp {
  const candidateNames = Array.from(new Set([
    ...agentNames,
    ...ROLE_NAMES,
    ...USER_NAMES
  ])).filter(Boolean);
  candidateNames.sort((a, b) => b.length - a.length);

  if (candidateNames.length > 0) {
    const escapedNames = candidateNames.map(escapeRegExp).join('|');
    return new RegExp(`(@(?:${escapedNames}|[A-Za-z0-9_-]+))`, 'gi');
  }
  return /(@[A-Za-z0-9_-]+)/g;
}

function CodeSandboxBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const lines = code.split('\n');
  const isLong = lines.length > 20;
  const displayedLines = isLong && !isExpanded ? lines.slice(0, 20) : lines;
  const shownCode = displayedLines.join('\n');
  // One highlight pass over the visible slice; the gutter and the pre both
  // rely on inherited line-height (no per-line divs) so rows stay aligned.
  const highlighted = useMemo(() => highlightCode(shownCode, language), [shownCode, language]);
  // Phase E redaction (display-only): secrets render through RedactedText
  // (shown-as-redacted + click-reveal) instead of highlighted HTML so raw
  // values never hit dangerouslySetInnerHTML. Copy keeps explicit raw
  // behaviour (user action). Reveal buttons stay keyboard-reachable.
  const secretCount = useMemo(() => countSecrets(code), [code]);
  const shownHasSecrets = useMemo(() => countSecrets(shownCode) > 0, [shownCode]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-zinc-950 border border-zinc-850 rounded-lg overflow-hidden my-3 font-mono text-xs shadow-2xl group/code">
      {/* Code Header Bar */}
      <div className="bg-zinc-900/90 px-3.5 py-1.5 border-b border-zinc-850 text-[10px] text-zinc-400 font-mono font-semibold flex justify-between items-center select-none">
        <div className="flex items-center gap-2">
          <Code2 size={12} className="text-indigo-400" />
          <span className="text-zinc-300 font-semibold">{language || 'plaintext'}</span>
          <span className="text-[9px] text-zinc-600">({lines.length} lines)</span>
          {secretCount > 0 && (
            <span className="text-[9px] font-mono text-amber-300 border border-amber-500/30 bg-amber-500/10 rounded px-1.5 py-0.5">
              {secretCount} redacted
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 transition cursor-pointer text-[10px] focus:outline-none"
            title="Copy code to clipboard"
            aria-label={`Copy ${language || 'plaintext'} code to clipboard`}
          >
            {copied ? (
              <>
                <Check size={10} className="text-emerald-400" />
                <span className="text-emerald-400">Copied</span>
              </>
            ) : (
              <>
                <Copy size={10} />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Code Viewer with Line Numbers */}
      <div className="relative overflow-x-auto scrollbar-thin select-text">
        <div className="flex p-3 leading-relaxed text-indigo-200 font-mono text-xs">
          {/* Line Numbers */}
          <div className="select-none text-zinc-650 pr-3 border-r border-zinc-900 text-right min-w-[2.2rem]">
            {displayedLines.map((_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>

          {/* Code Text */}
          {shownHasSecrets ? (
            <pre className="pl-3 overflow-x-auto whitespace-pre-wrap break-words font-mono flex-1 m-0">
              <RedactedText text={shownCode} mono />
            </pre>
          ) : (
            <pre
              className="hljs pl-3 overflow-x-auto whitespace-pre font-mono flex-1 m-0"
              dangerouslySetInnerHTML={{ __html: highlighted }}
            />
          )}
        </div>

        {/* Collapsible toggle for long code */}
        {isLong && (
          <div className="border-t border-zinc-900 bg-zinc-950/90 p-1.5 text-center">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="inline-flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300 font-mono cursor-pointer focus:outline-none"
            >
              {isExpanded ? (
                <>
                  <ChevronUp size={12} />
                  <span>Collapse</span>
                </>
              ) : (
                <>
                  <ChevronDown size={12} />
                  <span>SHOW ALL {lines.length} LINES</span>
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MentionParser({ text }: MentionParserProps) {
  const agents = useCrowdOSStore((state) => state.agents);

  const cleanText = useMemo(() => stripToolCalls(text), [text]);

  const agentNames = useMemo(() => agents.map(a => a.name), [agents]);

  const mentionRegex = useMemo(() => buildMentionRegex(agentNames), [agentNames]);

  const parts = useMemo(() => {
    const result: Array<{ type: string; content?: string; language?: string }> = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    CODE_BLOCK_REGEX.lastIndex = 0;

    while ((match = CODE_BLOCK_REGEX.exec(cleanText)) !== null) {
      const textBefore = cleanText.slice(lastIndex, match.index);
      if (textBefore) {
        result.push({ type: 'markdown', content: textBefore });
      }
      result.push({
        type: 'codeblock',
        language: match[1] || 'plaintext',
        content: match[2].trim(),
      });
      lastIndex = CODE_BLOCK_REGEX.lastIndex;
    }

    const textAfter = cleanText.slice(lastIndex);
    if (textAfter) {
      result.push({ type: 'markdown', content: textAfter });
    }

    return result;
  }, [cleanText]);

  if (parts.length === 0) return null;

  return (
    <div className="space-y-3 font-sans text-zinc-300 select-text min-w-0 max-w-full overflow-hidden">
      {parts.map((part, index) => {
        if (part.type === 'codeblock') {
          return (
            <CodeSandboxBlock
              key={index}
              language={part.language || 'plaintext'}
              code={part.content || ''}
            />
          );
        }

        return (
          <div key={index} className="space-y-2 min-w-0 max-w-full overflow-hidden">
            {renderMarkdownParagraphs(part.content || '', mentionRegex)}
          </div>
        );
      })}
    </div>
  );
}

function renderMarkdownParagraphs(text: string, mentionRegex: RegExp): React.ReactNode {
  const lines = text.split('\n');
  const renderedElements: React.ReactNode[] = [];
  let currentList: React.ReactNode[] = [];
  let listType: 'ul' | 'ol' | null = null;

  let tableHeaders: string[] | null = null;
  let tableRows: string[][] = [];

  const isTableRow = (l: string) => l.trim().startsWith('|') && l.trim().endsWith('|');
  const isSeparatorRow = (l: string) => /^\|[\s|:-]+\|$/.test(l.trim());
  const splitCells = (l: string) => l.trim().slice(1, -1).split('|').map(c => c.trim());

  const flushTable = (key: number) => {
    if (!tableHeaders) return;
    renderedElements.push(
      <div key={`table-${key}`} className="my-3 rounded-lg border border-zinc-800/70 shadow-sm overflow-hidden max-w-full">
        <table className="w-full text-xs font-mono border-collapse table-fixed">
          <thead>
            <tr className="bg-zinc-900/80 border-b border-zinc-700/60">
              {tableHeaders.map((cell, ci) => (
                <th key={ci} className="px-3 py-2 text-left text-zinc-300 font-semibold tracking-wide whitespace-normal break-words align-top border-r border-zinc-800/50 last:border-r-0">
                  {renderInlineStyles(cell, mentionRegex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableRows.map((row, ri) => (
              <tr key={ri} className={`border-b border-zinc-800/40 last:border-b-0 ${ri % 2 === 0 ? 'bg-zinc-900/20' : 'bg-zinc-900/40'}`}>
                {row.map((cell, ci) => (
                  <td key={ci} className="px-3 py-1.5 text-zinc-300 border-r border-zinc-800/30 last:border-r-0 leading-relaxed whitespace-normal break-words align-top">
                    {renderInlineStyles(cell, mentionRegex)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    tableHeaders = null;
    tableRows = [];
  };

  const flushList = (key: number) => {
    if (currentList.length > 0 && listType) {
      const ListTag = listType;
      const listClass = listType === 'ul'
        ? 'list-disc pl-5 my-2 space-y-1.5 text-zinc-300'
        : 'list-decimal pl-5 my-2 space-y-1.5 text-zinc-300';
      renderedElements.push(
        <ListTag key={`list-${key}`} className={listClass}>
          {currentList}
        </ListTag>
      );
      currentList = [];
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Table detection: header row followed by separator row
    if (isTableRow(trimmed)) {
      const nextTrimmed = (lines[i + 1] || '').trim();
      if (!tableHeaders && isSeparatorRow(nextTrimmed)) {
        // This is the header row
        flushList(i);
        flushTable(i);
        tableHeaders = splitCells(trimmed);
        i++; // skip separator row
        continue;
      } else if (tableHeaders) {
        // Continuation data row
        tableRows.push(splitCells(trimmed));
        continue;
      }
    } else if (tableHeaders) {
      // Non-table line after table rows — flush table first
      flushTable(i);
    }

    if (trimmed.startsWith('#')) {
      flushList(i);
      const headerMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        const headerText = headerMatch[2];
        const HeaderTag = `h${Math.min(level + 1, 6)}` as any;
        let sizeClass = 'text-base font-semibold text-zinc-200 mt-3 mb-1 font-sans';
        if (level === 1) sizeClass = 'text-xl font-extrabold text-indigo-400 mt-4 mb-2 border-b border-zinc-800/50 pb-1 font-sans';
        if (level === 2) sizeClass = 'text-lg font-bold text-zinc-100 mt-3.5 mb-1.5 font-sans';
        if (level === 3) sizeClass = 'text-base font-bold text-zinc-250 mt-3 mb-1 font-sans';

        renderedElements.push(
          <HeaderTag key={i} className={sizeClass}>
            {renderInlineStyles(headerText, mentionRegex)}
          </HeaderTag>
        );
        continue;
      }
    }

    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (listType !== 'ul') {
        flushList(i);
        listType = 'ul';
      }
      const itemText = trimmed.slice(2);
      currentList.push(
        <li key={`li-${i}`} className="text-sm text-zinc-300 pl-1">
          {renderInlineStyles(itemText, mentionRegex)}
        </li>
      );
      continue;
    }

    const olMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (olMatch) {
      if (listType !== 'ol') {
        flushList(i);
        listType = 'ol';
      }
      const itemText = olMatch[2];
      currentList.push(
        <li key={`li-${i}`} className="text-sm text-zinc-300 pl-1">
          {renderInlineStyles(itemText, mentionRegex)}
        </li>
      );
      continue;
    }

    if (!trimmed) {
      flushList(i);
      continue;
    }

    flushList(i);
    renderedElements.push(
      <p key={i} className="text-sm text-zinc-300 leading-relaxed font-sans">
        {renderInlineStyles(line, mentionRegex)}
      </p>
    );
  }

  flushList(lines.length);
  flushTable(lines.length);

  return renderedElements;
}

function renderInlineStyles(text: string, mentionRegex: RegExp): React.ReactNode {
  if (!text) return null;

  const inlineCodeParts = text.split(INLINE_CODE_REGEX);

  return inlineCodeParts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      const codeText = part.slice(1, -1);
      return (
        <code key={`code-${index}`} className="px-1.5 py-0.5 rounded bg-zinc-950 font-mono text-[11px] text-indigo-300 border border-zinc-850/60 mx-0.5 shadow-inner">
          <RedactedText text={codeText} mono />
        </code>
      );
    }

    return (
      <React.Fragment key={`fmt-${index}`}>
        {renderFormattedText(part.replace(DISPLAY_COPY_EM_DASH, ', '), index, mentionRegex)}
      </React.Fragment>
    );
  });
}

function renderFormattedText(text: string, parentKey: number, mentionRegex: RegExp): React.ReactNode {
  if (!text) return null;

  const nodes: React.ReactNode[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let subIdx = 0;

  INLINE_FORMAT.lastIndex = 0;
  while ((match = INLINE_FORMAT.exec(text)) !== null) {
    if (match.index > lastIdx) {
      const plain = text.slice(lastIdx, match.index);
      nodes.push(<React.Fragment key={`${parentKey}-p-${subIdx++}`}>{renderMentions(plain, `${parentKey}-${subIdx}`, mentionRegex)}</React.Fragment>);
    }
    if (match[1] !== undefined) {
      nodes.push(
        <strong key={`${parentKey}-b-${subIdx++}`} className="font-bold text-zinc-100">
          {renderMentions(match[1], `${parentKey}-${subIdx}`, mentionRegex)}
        </strong>
      );
    } else if (match[2] !== undefined) {
      nodes.push(
        <em key={`${parentKey}-i-${subIdx++}`} className="italic text-zinc-300">
          {renderMentions(match[2], `${parentKey}-${subIdx}`, mentionRegex)}
        </em>
      );
    } else if (match[3] !== undefined) {
      nodes.push(
        <del key={`${parentKey}-s-${subIdx++}`} className="line-through text-zinc-500">
          {renderMentions(match[3], `${parentKey}-${subIdx}`, mentionRegex)}
        </del>
      );
    }
    lastIdx = INLINE_FORMAT.lastIndex;
  }

  if (lastIdx < text.length) {
    const remaining = text.slice(lastIdx);
    nodes.push(<React.Fragment key={`${parentKey}-r-${subIdx}`}>{renderMentions(remaining, `${parentKey}-${subIdx}`, mentionRegex)}</React.Fragment>);
  }

  if (nodes.length === 0) {
    return renderMentions(text, `${parentKey}-plain`, mentionRegex);
  }

  return <>{nodes}</>;
}

function renderMentions(text: string, keyPrefix: string, mentionRegex: RegExp): React.ReactNode {
  if (!text) return null;

  const localRegex = new RegExp(mentionRegex.source, mentionRegex.flags);
  const parts = text.split(localRegex);

  if (parts.length === 1) {
    return <RedactedText text={text} />;
  }

  return parts.map((part, idx) => {
    const key = `${keyPrefix}-${idx}`;
    if (!part) return null;
    if (part.startsWith('@')) {
      const mentionTarget = part.slice(1);
      const isUser = USER_NAMES.some(u => u.toLowerCase() === mentionTarget.toLowerCase()) ||
                     mentionTarget.toLowerCase().includes('juan') ||
                     mentionTarget.toLowerCase().includes('user') ||
                     mentionTarget.toLowerCase().includes('operator');

      const style = isUser
        ? 'bg-amber-500/10 text-amber-300 border-amber-500/25 hover:bg-amber-500/20'
        : 'bg-indigo-500/10 text-indigo-300 border-indigo-500/20 hover:bg-indigo-500/20';

      return (
        <span
          key={key}
          className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[11px] font-mono font-medium mx-0.5 select-none transition cursor-pointer shadow-sm ${style}`}
          title={isUser ? 'Human Operator' : `Agent: ${mentionTarget}`}
        >
          {part}
        </span>
      );
    }
    return <RedactedText key={key} text={part} />;
  });
}
