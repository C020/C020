import { EventEmitter } from 'node:events';
import type { AuditEntry } from '../db/models.js';
import type { Platform } from './types.js';

/** Application-wide events (consumed by the dashboard SSE stream and logging). */
export interface AppEventMap {
  /** Something about live state changed in a guild (dashboard should refresh "live now"). */
  'live.changed': { guildId: string; streamerId: number; status: 'live' | 'updated' | 'ended' };
  /** New content announced in a guild. */
  'content.announced': { guildId: string; streamerId: number; platform: Platform; title: string; url: string };
  /** An audit entry was recorded. */
  audit: AuditEntry;
  /** #9 — an application was created or decided. */
  'application.changed': { guildId: string; applicationId: number; status: 'pending' | 'approved' | 'rejected' | 'cancelled' };
  /** Provider health changed (errors / recovered). */
  'provider.health': { platform: Platform; ok: boolean; message: string | null };
}

export type AppEventName = keyof AppEventMap;

export class AppEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  emit<K extends AppEventName>(name: K, payload: AppEventMap[K]): void {
    this.emitter.emit(name, payload);
  }

  on<K extends AppEventName>(name: K, listener: (payload: AppEventMap[K]) => void): () => void {
    this.emitter.on(name, listener);
    return () => this.emitter.off(name, listener);
  }
}
