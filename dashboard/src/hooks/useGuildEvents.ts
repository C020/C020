import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createInvalidationBatcher, keys, prependAuditEntry } from '../api/queries';
import type { AuditEntry, ContentEventData, LiveEventData, StreamerDto } from '../api/types';
import { actorUserId, touchesDiscordLookups, touchesSettings, touchesStreamers } from '../lib/audit';
import { PLATFORM_META } from '../lib/platforms';
import { toast } from '../lib/toast';
import { useLatest } from './useLatest';

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'paused';

export interface GuildEventsOptions {
  currentUserId: string;
  /** Show toasts for go-live / new content events. */
  notify: boolean;
}

/** No message (not even the 25s heartbeat) for this long means the connection is dead. */
const WATCHDOG_MS = 75_000;
/** Background tabs give their stream back after a while (the server caps streams per session). */
const HIDDEN_PAUSE_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Subscribes to the guild's server-sent events and turns them into cache updates. EventSource retries
 * on its own for network drops; when the server refuses the stream (401/429/503) we back off and
 * reconnect ourselves. Any reconnect resyncs the guild's queries, since events may have been missed.
 */
export function useGuildEvents(guildId: string, options: GuildEventsOptions): RealtimeStatus {
  const client = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');
  const opts = useLatest(options);

  useEffect(() => {
    const batcher = createInvalidationBatcher(client);
    let source: EventSource | null = null;
    let disposed = false;
    let attempts = 0;
    let connectedOnce = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let pauseTimer: ReturnType<typeof setTimeout> | null = null;

    const streamerName = (streamerId: number): string | null =>
      client.getQueryData<StreamerDto[]>(keys.streamers(guildId))?.find((s) => s.id === streamerId)?.displayName ??
      client.getQueryData<{ liveNow: Array<{ streamer: { id: number; displayName: string } }> }>(keys.overview(guildId))?.liveNow.find((l) => l.streamer.id === streamerId)
        ?.streamer.displayName ??
      null;

    const resync = (): void => {
      void client.invalidateQueries({ queryKey: keys.guild(guildId) });
    };

    const armWatchdog = (): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        // Half-open connection (proxy dropped it silently): start over.
        close();
        scheduleReconnect(0);
      }, WATCHDOG_MS);
    };

    const close = (): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
      source?.close();
      source = null;
    };

    const scheduleReconnect = (delayMs?: number): void => {
      if (disposed || retryTimer) return;
      const backoff = delayMs ?? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts) + Math.random() * 1000;
      attempts += 1;
      setStatus('reconnecting');
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, backoff);
    };

    const onLive = (data: LiveEventData): void => {
      batcher.add(keys.overview(guildId));
      if (data.status === 'updated') return;
      batcher.add(keys.streamers(guildId));
      batcher.add(keys.sessions(guildId));
      batcher.add(keys.leaderboard(guildId));
      if (data.status === 'live' && opts.current.notify) {
        const name = streamerName(data.streamerId);
        toast.live(name ? `${name} بدأ بث مباشر` : 'فيه ستريمر بدأ بث مباشر', { description: 'الإشعار انرسل في روم البث' });
      }
    };

    const onContent = (data: ContentEventData): void => {
      batcher.add(keys.overview(guildId));
      batcher.add(keys.content(guildId));
      if (opts.current.notify) {
        const name = data.streamer?.displayName ?? streamerName(data.streamerId);
        toast.info(`${name ?? 'ستريمر'} نزّل مقطع جديد على ${PLATFORM_META[data.platform].label}`, {
          description: data.title,
          action: data.url ? { label: 'فتح المقطع', href: data.url } : undefined,
        });
      }
    };

    const onAudit = (entry: AuditEntry): void => {
      prependAuditEntry(client, guildId, entry);
      // Our own edits already updated the cache; changes from slash commands or other admins did not.
      const byMe = actorUserId(entry.actor) === opts.current.currentUserId;
      if (!byMe && touchesStreamers(entry)) batcher.add(keys.streamers(guildId));
      if (!byMe && touchesSettings(entry)) batcher.add(keys.settings(guildId));
      if (touchesDiscordLookups(entry)) {
        batcher.add(keys.discord(guildId));
        batcher.add(keys.overview(guildId));
      }
    };

    const listen = <T,>(es: EventSource, name: string, handler: (data: T) => void): void => {
      es.addEventListener(name, (event) => {
        armWatchdog();
        try {
          handler(JSON.parse((event as MessageEvent<string>).data) as T);
        } catch {
          // A malformed event must never break the stream.
        }
      });
    };

    function connect(): void {
      if (disposed) return;
      close();
      setStatus(connectedOnce ? 'reconnecting' : 'connecting');
      const es = new EventSource(`/api/guilds/${encodeURIComponent(guildId)}/events`);
      source = es;
      es.onopen = () => {
        if (source !== es) return;
        setStatus('open');
        armWatchdog();
        if (connectedOnce) resync();
        connectedOnce = true;
        attempts = 0;
      };
      es.onerror = () => {
        if (source !== es) return;
        if (es.readyState === EventSource.CLOSED) {
          // The server answered with an error status: maybe the session expired.
          close();
          void client.invalidateQueries({ queryKey: keys.me });
          scheduleReconnect();
        } else {
          setStatus('reconnecting');
        }
      };
      listen<LiveEventData>(es, 'live', onLive);
      listen<ContentEventData>(es, 'content', onContent);
      listen<AuditEntry>(es, 'audit', onAudit);
      listen<unknown>(es, 'ping', () => undefined);
    }

    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        pauseTimer ??= setTimeout(() => {
          pauseTimer = null;
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = null;
          close();
          setStatus('paused');
        }, HIDDEN_PAUSE_MS);
        return;
      }
      if (pauseTimer) clearTimeout(pauseTimer);
      pauseTimer = null;
      if (!source && !retryTimer) {
        attempts = 0;
        connect();
      }
    };

    const onOnline = (): void => {
      if (source?.readyState === EventSource.OPEN) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      attempts = 0;
      connect();
    };

    connect();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);

    return () => {
      disposed = true;
      close();
      batcher.cancel();
      if (retryTimer) clearTimeout(retryTimer);
      if (pauseTimer) clearTimeout(pauseTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [client, guildId, opts]);

  return status;
}
