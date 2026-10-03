/**
 * Re-hosting of expiring images. TikTok CDN URLs are signed and expire (hours to days), so an embed that
 * links them shows a broken image later. For those we download the image once and upload it with the
 * message as an attachment, which Discord keeps forever.
 */
import type { APIEmbed } from 'discord.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('discord.attachments');

/** Discord's default upload limit is 10 MB; stay well below it. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

export interface MessageFile {
  name: string;
  data: Buffer;
}

export type ImageFetcher = (url: string) => Promise<{ data: Buffer; contentType: string } | null>;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** Hosts whose image URLs expire and therefore need re-hosting. */
export function needsRehosting(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return /(^|\.)tiktokcdn(-[a-z]+)?\.com$/i.test(host) || /(^|\.)tiktokcdn\.[a-z.]+$/i.test(host) || /(^|\.)ibyteimg\.com$/i.test(host);
  } catch {
    return false;
  }
}

/** Downloads an image with a timeout and size cap. Never throws; returns null when it can't be used. */
export const fetchImage: ImageFetcher = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', referer: 'https://www.tiktok.com/' },
    });
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (!res.ok || !EXTENSIONS[contentType] || declared > MAX_IMAGE_BYTES) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return null;
    return { data, contentType };
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'Image download failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Replaces expiring embed images with uploaded attachments. Returns the rewritten embeds and the files to
 * upload; embeds are returned unchanged when nothing needs (or could be) re-hosted.
 */
export async function rehostExpiringImages(embeds: APIEmbed[], fetcher: ImageFetcher): Promise<{ embeds: APIEmbed[]; files: MessageFile[] }> {
  const files: MessageFile[] = [];
  const out: APIEmbed[] = [];
  for (const [index, embed] of embeds.entries()) {
    const url = embed.image?.url;
    if (!needsRehosting(url)) {
      out.push(embed);
      continue;
    }
    const image = await fetcher(url);
    if (!image) {
      out.push(embed);
      continue;
    }
    const name = `image-${index}.${EXTENSIONS[image.contentType] ?? 'jpg'}`;
    files.push({ name, data: image.data });
    out.push({ ...embed, image: { url: `attachment://${name}` } });
  }
  return { embeds: out, files };
}
