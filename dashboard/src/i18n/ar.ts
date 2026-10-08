/** Arabic dictionary (default language) — assembled from the per-area files in ./messages. */
import { common } from './messages/common';
import { pages } from './messages/pages';
import { streamers } from './messages/streamers';
import { ui } from './messages/ui';
import { v2 } from './messages/v2';

export const ar = { ...common.ar, ...ui.ar, ...pages.ar, ...streamers.ar, ...v2.ar };
