import { describe, expect, it } from 'vitest';
import { TEMPLATE_VARIABLES } from '../../src/shared/api';
import { DEFAULT_TEMPLATES, draftFromSpec, insertAtCursor, isDefaultDraft, previewSpec, sameDraft, specFromDraft, unknownVariables } from '../src/lib/templates';

describe('templates', () => {
  it('inserts at the caret / replaces the selection', () => {
    expect(insertAtCursor('hello world', 6, 6, '{name} ')).toEqual({ text: 'hello {name} world', caret: 13 });
    expect(insertAtCursor('abc', 1, 2, 'X')).toEqual({ text: 'aXc', caret: 2 });
    expect(insertAtCursor('abc', null, null, '!')).toEqual({ text: 'abc!', caret: 4 });
    expect(insertAtCursor('abc', 99, 120, '!')).toEqual({ text: 'abc!', caret: 4 });
  });

  it('drops blank fields when saving and fills defaults for the preview', () => {
    const draft = { ...draftFromSpec(undefined), title: '  ', description: 'وصف', color: 0xff0000 };
    expect(specFromDraft(draft)).toEqual({ description: 'وصف', color: 0xff0000 });
    expect(previewSpec('live', draft)).toEqual({
      content: DEFAULT_TEMPLATES.live.content,
      title: DEFAULT_TEMPLATES.live.title,
      description: 'وصف',
      footer: DEFAULT_TEMPLATES.live.footer,
      color: 0xff0000,
    });
    expect(isDefaultDraft(draftFromSpec({}))).toBe(true);
    expect(sameDraft(draftFromSpec({ title: 'a' }), draftFromSpec({ title: 'a' }))).toBe(true);
  });

  it('flags unknown variables per message type', () => {
    expect(unknownVariables('{name} {Viewers} {oops} {kind}', TEMPLATE_VARIABLES.live)).toEqual(['oops', 'kind']);
    expect(unknownVariables('{kind}', TEMPLATE_VARIABLES.content)).toEqual([]);
  });
});
