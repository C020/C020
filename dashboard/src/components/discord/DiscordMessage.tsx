import { ExternalLink } from 'lucide-react';
import type { ComponentProps } from 'react';
import type { MessagePreview } from '../../api/types';
import { cn } from '../../lib/cn';
import { customEmojiUrl, defaultAvatarUrl } from '../../lib/discord';
import { layoutFields } from '../../lib/embed';
import { colorIntToHex, formatCalendar } from '../../lib/format';
import { DiscordMarkdown, type MentionResolver } from './DiscordMarkdown';

type Embed = MessagePreview['embeds'][number];

/** Remote preview images (avatars, thumbnails) may 404; hide them instead of showing a broken icon. */
function Img(props: ComponentProps<'img'>) {
  return (
    <img
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={(e) => {
        e.currentTarget.style.visibility = 'hidden';
      }}
      {...props}
    />
  );
}
type Field = NonNullable<Embed['fields']>[number];

export interface DiscordMessageProps {
  message: MessagePreview;
  author: { name: string; avatarUrl: string | null; id?: string };
  resolver?: MentionResolver;
  timestamp?: number;
  className?: string;
}

/**
 * Renders a MessagePreview the way the Discord desktop client (dark theme) shows it. The surrounding
 * chrome is LTR like Discord; text blocks use dir="auto" so Arabic lines read naturally.
 */
export function DiscordMessage({ message, author, resolver, timestamp, className }: DiscordMessageProps) {
  const now = timestamp ?? Date.now();
  return (
    <div dir="ltr" className={cn('rounded-xl bg-discord-bg px-4 py-3 text-[15px] leading-[1.375rem] text-discord-text', className)}>
      <div className="flex gap-4">
        <Img src={author.avatarUrl ?? defaultAvatarUrl(author.id)} className="mt-0.5 size-10 shrink-0 rounded-full object-cover" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-1.5">
            <span className="font-medium text-white">{author.name}</span>
            <span className="inline-flex h-[15px] items-center rounded-[3px] bg-blurple px-1 text-[10px] font-semibold uppercase leading-none text-white">APP</span>
            <span dir="auto" className="text-xs text-discord-muted">
              {formatCalendar(now, now)}
            </span>
          </div>
          {message.content && <DiscordMarkdown text={message.content} resolver={resolver} now={now} className="mt-0.5 break-words" />}
          {message.embeds.map((embed, i) => (
            <EmbedView key={i} embed={embed} resolver={resolver} now={now} />
          ))}
          {message.buttons.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {message.buttons.map((button, i) => (
                <a
                  key={i}
                  href={button.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-discord-button px-3.5 text-sm font-medium text-white transition-colors hover:bg-[#6d6f78]"
                >
                  {button.emoji && <ButtonEmoji emoji={button.emoji} />}
                  <span dir="auto">{button.label}</span>
                  <ExternalLink className="size-3.5 opacity-80" />
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ButtonEmoji({ emoji }: { emoji: string }) {
  const custom = /^<(a)?:(\w+):(\d+)>$/.exec(emoji);
  if (custom?.[3]) return <img src={customEmojiUrl(custom[3], custom[1] === 'a')} alt={custom[2]} className="size-[18px] object-contain" />;
  return <span className="text-base leading-none">{emoji}</span>;
}

function EmbedView({ embed, resolver, now }: { embed: Embed; resolver?: MentionResolver; now: number }) {
  const color = colorIntToHex(embed.color) ?? '#1e1f22';
  const fields = embed.fields ?? [];
  const hasThumbnail = !!embed.thumbnail?.url;
  return (
    <div className="mt-1.5 grid max-w-[520px] rounded-[4px] border-l-4 bg-discord-embed" style={{ borderLeftColor: color }}>
      <div className={cn('grid gap-2 py-3 pe-4 ps-3', hasThumbnail && 'grid-cols-[minmax(0,1fr)_auto]')}>
        <div className="min-w-0 space-y-2">
          {embed.author && (
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              {embed.author.icon_url && <Img src={embed.author.icon_url} className="size-6 rounded-full object-cover" />}
              {embed.author.url ? (
                <a href={embed.author.url} target="_blank" rel="noopener noreferrer" dir="auto" className="hover:underline">
                  {embed.author.name}
                </a>
              ) : (
                <span dir="auto">{embed.author.name}</span>
              )}
            </div>
          )}
          {embed.title && (
            <div className="text-base font-semibold leading-snug text-white">
              {embed.url ? (
                <a href={embed.url} target="_blank" rel="noopener noreferrer" className="text-discord-link hover:underline">
                  <DiscordMarkdown text={embed.title} inline resolver={resolver} now={now} />
                </a>
              ) : (
                <DiscordMarkdown text={embed.title} inline resolver={resolver} now={now} />
              )}
            </div>
          )}
          {embed.description && <DiscordMarkdown text={embed.description} resolver={resolver} now={now} className="break-words text-sm leading-[1.125rem]" />}
          {fields.length > 0 && <FieldsGrid fields={fields} resolver={resolver} now={now} />}
        </div>
        {hasThumbnail && <Img src={embed.thumbnail!.url} className="ms-2 size-20 rounded-[4px] object-cover" />}
        {embed.image?.url && (
          <Img src={embed.image.url} className={cn('mt-1 max-h-[300px] w-full rounded-[4px] object-cover', hasThumbnail && 'col-span-2')} />
        )}
        {(embed.footer || embed.timestamp) && (
          <div className={cn('mt-0.5 flex items-center gap-2 text-xs text-discord-muted', hasThumbnail && 'col-span-2')}>
            {embed.footer?.icon_url && <Img src={embed.footer.icon_url} className="size-5 rounded-full object-cover" />}
            <span>
              {embed.footer && <DiscordMarkdown text={embed.footer.text} inline />}
              {embed.footer && embed.timestamp && <span className="mx-1">•</span>}
              {embed.timestamp && <span dir="auto">{formatCalendar(embed.timestamp, now)}</span>}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// Narrow previews (phones) fall back to fewer columns so field names don't collide.
const FIELD_COLUMNS: Record<number, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-2 sm:grid-cols-3' };

function FieldsGrid({ fields, resolver, now }: { fields: Field[]; resolver?: MentionResolver; now: number }) {
  return (
    <div className="space-y-2">
      {layoutFields(fields).map((row, i) => (
        <div key={i} className={cn('grid gap-2', FIELD_COLUMNS[row.length] ?? 'grid-cols-1')}>
          {row.map((field, j) => (
            <div key={j} className="min-w-0 text-sm leading-[1.125rem]">
              <div className="mb-0.5 break-words font-semibold text-white">
                <DiscordMarkdown text={field.name} inline resolver={resolver} now={now} />
              </div>
              <DiscordMarkdown text={field.value} resolver={resolver} now={now} className="break-words" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
