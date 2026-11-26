// Small pieces every SSP section shares.
import type { Family } from '@rampart/catalog';
import type { SspBlock } from './types';

export const NOT_PROVIDED = 'Not provided';
export const NONE_RECORDED = 'None recorded.';

/** Whether a text is missing: null, empty or only whitespace. */
export function isBlank(text: string | null | undefined): text is null | undefined | '' {
  return text === null || text === undefined || text.trim() === '';
}

/** A text, or `fallback` when it is blank. */
export function orElse(text: string | null | undefined, fallback: string): string {
  return isBlank(text) ? fallback : text;
}

/** A table cell: the text, or empty. */
export function cell(text: string | null | undefined): string {
  return text ?? '';
}

export type Owner = { displayName: string; active: boolean } | null;

export function ownerName(owner: Owner): string {
  if (owner === null) return 'Unassigned';
  return owner.active ? owner.displayName : `${owner.displayName} (inactive)`;
}

export function familyHeading(family: Family): string {
  return `${family.nistSection} ${family.name} (${family.code})`;
}

/** A `Field | Value` table; a null value reads "Not provided". */
export function fieldTable(rows: readonly (readonly [string, string | null])[]): SspBlock {
  return {
    kind: 'table',
    columns: ['Field', 'Value'],
    rows: rows.map(([label, value]) => [label, value ?? NOT_PROVIDED]),
  };
}

export const heading = (level: 1 | 2 | 3, text: string): SspBlock => ({
  kind: 'heading',
  level,
  text,
});

export const paragraph = (text: string): SspBlock => ({ kind: 'paragraph', text });

export const field = (label: string, value: string): SspBlock => ({ kind: 'field', label, value });
