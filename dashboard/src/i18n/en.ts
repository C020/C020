/** English dictionary — must have exactly the keys of ./ar.ts (enforced by the Dictionary type). */
import type { Dictionary } from './core';
import { common } from './messages/common';
import { pages } from './messages/pages';
import { streamers } from './messages/streamers';
import { ui } from './messages/ui';
import { v2 } from './messages/v2';

export const en: Dictionary = { ...common.en, ...ui.en, ...pages.en, ...streamers.en, ...v2.en };
