import type { MessagePreview } from '../api/types';

export type EmbedField = NonNullable<MessagePreview['embeds'][number]['fields']>[number];

/** Discord packs up to three consecutive inline fields per row; a non-inline field takes a full row. */
export function layoutFields(fields: EmbedField[]): EmbedField[][] {
  const rows: EmbedField[][] = [];
  let row: EmbedField[] = [];
  for (const field of fields) {
    if (!field.inline) {
      if (row.length) rows.push(row);
      rows.push([field]);
      row = [];
      continue;
    }
    row.push(field);
    if (row.length === 3) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return rows;
}
