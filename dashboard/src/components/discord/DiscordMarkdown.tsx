import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { customEmojiUrl } from '../../lib/discord';
import { formatDiscordTimestamp, parseInline, parseMarkdown, type BlockNode, type InlineNode } from '../../lib/discordMarkdown';

export interface MentionResolver {
  user?: (id: string) => string | null;
  role?: (id: string) => { name: string; color: string } | null;
  channel?: (id: string) => string | null;
}

interface RenderContext {
  resolver: MentionResolver;
  now: number;
}

function Spoiler({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={() => setRevealed(true)}
      onKeyDown={(e) => e.key === 'Enter' && setRevealed(true)}
      className={cn('rounded px-0.5 transition-colors', revealed ? 'bg-white/10' : 'cursor-pointer bg-[#1e1f22] text-transparent [&_*]:invisible')}
    >
      {children}
    </span>
  );
}

function renderInline(nodes: InlineNode[], ctx: RenderContext): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={i}>{node.value}</Fragment>;
      case 'br':
        return <br key={i} />;
      case 'bold':
        return (
          <strong key={i} className="font-semibold text-white">
            {renderInline(node.children, ctx)}
          </strong>
        );
      case 'italic':
        return <em key={i}>{renderInline(node.children, ctx)}</em>;
      case 'underline':
        return <u key={i}>{renderInline(node.children, ctx)}</u>;
      case 'strike':
        return <s key={i}>{renderInline(node.children, ctx)}</s>;
      case 'spoiler':
        return <Spoiler key={i}>{renderInline(node.children, ctx)}</Spoiler>;
      case 'code':
        return (
          <code key={i} className="rounded bg-[#1e1f22] px-1 py-0.5 font-mono text-[0.85em]" dir="ltr">
            {node.value}
          </code>
        );
      case 'link':
        return (
          <a key={i} href={node.url} target="_blank" rel="noopener noreferrer" className="text-discord-link hover:underline">
            {renderInline(node.children, ctx)}
          </a>
        );
      case 'mention': {
        if (node.kind === 'role') {
          const role = ctx.resolver.role?.(node.id);
          return (
            <span key={i} className="rounded px-0.5 font-medium" style={{ color: role?.color ?? '#c9cdfb', backgroundColor: `${role?.color ?? '#5865f2'}26` }}>
              @{role?.name ?? 'رتبة'}
            </span>
          );
        }
        const label = node.kind === 'user' ? `@${ctx.resolver.user?.(node.id) ?? 'مستخدم'}` : `#${ctx.resolver.channel?.(node.id) ?? 'روم'}`;
        return (
          <span key={i} className="rounded bg-[#5865f2]/30 px-0.5 font-medium text-[#c9cdfb]">
            {label}
          </span>
        );
      }
      case 'everyone':
        return (
          <span key={i} className="rounded bg-[#5865f2]/30 px-0.5 font-medium text-[#c9cdfb]" dir="ltr">
            {node.value}
          </span>
        );
      case 'timestamp':
        return (
          <span key={i} className="rounded bg-white/[0.08] px-1">
            {formatDiscordTimestamp(node.unix, node.style, ctx.now)}
          </span>
        );
      case 'emoji':
        return <img key={i} src={customEmojiUrl(node.id, node.animated)} alt={`:${node.name}:`} title={`:${node.name}:`} className="inline-block size-[1.375em] align-[-0.3em] object-contain" />;
    }
  });
}

function renderBlocks(blocks: BlockNode[], ctx: RenderContext): ReactNode[] {
  return blocks.map((block, i) => {
    switch (block.type) {
      case 'paragraph':
        return (
          <div key={i} dir="auto">
            {renderInline(block.children, ctx)}
          </div>
        );
      case 'heading': {
        const size = block.level === 1 ? 'text-[1.5em]' : block.level === 2 ? 'text-[1.25em]' : 'text-[1.1em]';
        return (
          <div key={i} dir="auto" className={cn('mb-1 mt-2 font-bold leading-tight text-white first:mt-0', size)}>
            {renderInline(block.children, ctx)}
          </div>
        );
      }
      case 'subtext':
        return (
          <div key={i} dir="auto" className="text-[0.8em] text-discord-muted">
            {renderInline(block.children, ctx)}
          </div>
        );
      case 'quote':
        return (
          <div key={i} className="flex gap-2">
            <div className="w-1 shrink-0 rounded bg-[#4e5058]" />
            <div className="min-w-0">{renderBlocks(block.children, ctx)}</div>
          </div>
        );
      case 'list':
        return (
          <ul key={i} dir="auto" className="my-0.5 list-disc space-y-0.5 ps-5">
            {block.items.map((item, j) => (
              <li key={j}>{renderInline(item, ctx)}</li>
            ))}
          </ul>
        );
      case 'codeblock':
        return (
          <pre key={i} dir="ltr" className="my-1 overflow-x-auto rounded-md border border-[#1e1f22] bg-[#2b2d31] p-2 font-mono text-[0.85em] leading-snug">
            {block.value}
          </pre>
        );
    }
  });
}

export interface DiscordMarkdownProps {
  text: string;
  /** Inline-only rendering (titles, field names, footers). */
  inline?: boolean;
  resolver?: MentionResolver;
  now?: number;
  className?: string;
}

export function DiscordMarkdown({ text, inline = false, resolver = {}, now, className }: DiscordMarkdownProps) {
  const ast = useMemo(() => (inline ? parseInline(text) : parseMarkdown(text)), [text, inline]);
  const ctx: RenderContext = { resolver, now: now ?? Date.now() };
  if (inline) {
    return (
      <span dir="auto" className={className}>
        {renderInline(ast as InlineNode[], ctx)}
      </span>
    );
  }
  return <div className={cn('space-y-0.5', className)}>{renderBlocks(ast as BlockNode[], ctx)}</div>;
}
