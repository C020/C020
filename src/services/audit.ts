import type { AppEvents } from '../core/events.js';
import { childLogger } from '../core/logger.js';
import type { AuditEntry, AuditLevel } from '../db/models.js';
import type { Repositories } from '../db/repositories.js';
import type { Notifier } from './ports.js';

const log = childLogger('audit');

export interface AuditInput {
  guildId?: string | null;
  /** 'system' or 'user:<discordId>' */
  actor?: string;
  action: string;
  level?: AuditLevel;
  /** Arabic, user-facing. */
  message: string;
  details?: Record<string, unknown>;
  /** Also mirror to the guild's Discord log channel (default: true for warn/error and live/content events). */
  mirror?: boolean;
}

/** Records audit entries (DB + realtime event + optional Discord log channel). Never throws. */
export class AuditService {
  private notifier: Notifier | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly events: AppEvents,
  ) {}

  attachNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  record(input: AuditInput): AuditEntry | null {
    try {
      const entry = this.repos.audit.add(input);
      this.events.emit('audit', entry);
      const level = input.level ?? 'info';
      log[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info']({ guildId: input.guildId, action: input.action, ...input.details }, input.message);
      const mirror = input.mirror ?? level !== 'info';
      if (mirror && input.guildId && this.notifier) {
        this.notifier.log(input.guildId, level, input.message).catch(() => {});
      }
      return entry;
    } catch (err) {
      log.error({ err }, 'failed to record audit entry');
      return null;
    }
  }
}
