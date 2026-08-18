import { describe, it, expect } from 'vitest';
import { ReActStreamParser } from './ReActStreamParser.js';

describe('ReActStreamParser', () => {
  it('should successfully parse and split thoughts and answer using the sentinel trigger', () => {
    const rawText = `Evaluating memory nodes.
[Searching database...]
&&FINAL_RESPONSE&&
The operations are fully online.`;

    const result = ReActStreamParser.parse(rawText);

    expect(result.thoughts).toBe(`Evaluating memory nodes.\n[Searching database...]`);
    expect(result.content).toBe(`The operations are fully online.`);
  });

  it('should trigger on the last occurrence of the sentinel token when multiple exist', () => {
    const rawText = `Evaluating constraint sets. Must place the sentinel token &&FINAL_RESPONSE&& here.
Let's complete the final checks.
&&FINAL_RESPONSE&&
ReAct Pipeline Activated. Everything is correct.`;

    const result = ReActStreamParser.parse(rawText);

    expect(result.thoughts).toBe(`Evaluating constraint sets. Must place the sentinel token &&FINAL_RESPONSE&& here.\nLet's complete the final checks.`);
    expect(result.content).toBe(`ReAct Pipeline Activated. Everything is correct.`);
  });

  it('should fallback to legacy delimiters if sentinel trigger is not found', () => {
    const rawText = `<|think|>
Analyzing system performance thresholds...
</|think|>
Everything is stable.`;

    const result = ReActStreamParser.parse(rawText);

    expect(result.thoughts).toBe('Analyzing system performance thresholds...');
    expect(result.content).toBe('Everything is stable.');
  });

  it('should apply the EOF failsafe when no delimiters or sentinels are found', () => {
    const rawText = 'This is a simple direct response without reasoning.';

    const result = ReActStreamParser.parse(rawText);

    expect(result.thoughts).toBe('');
    expect(result.content).toBe(rawText);
  });

  it('should handle empty or null strings gracefully', () => {
    const result = ReActStreamParser.parse('');
    expect(result.thoughts).toBe('');
    expect(result.content).toBe('');
  });

  it('should handle consecutive whitespaces and clean up outputs', () => {
    const rawText = `   Thinking: parsing logic.   
&&FINAL_RESPONSE&&
   Done!   `;

    const result = ReActStreamParser.parse(rawText);
    expect(result.thoughts).toBe('Thinking: parsing logic.');
    expect(result.content).toBe('Done!');
  });
});
