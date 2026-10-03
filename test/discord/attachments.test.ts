import { describe, expect, it, vi } from 'vitest';
import { type ImageFetcher, needsRehosting, rehostExpiringImages } from '../../src/discord/attachments.js';

describe('needsRehosting', () => {
  it('flags signed TikTok CDN hosts only', () => {
    expect(needsRehosting('https://p16-sign-va.tiktokcdn.com/obj/x.jpeg?x-expires=1')).toBe(true);
    expect(needsRehosting('https://p19-webcast.tiktokcdn-us.com/room-cover.webp')).toBe(true);
    expect(needsRehosting('https://p16-pu-sign-useast8.tiktokcdn-us.com/a.jpeg')).toBe(true);
    expect(needsRehosting('https://i.ytimg.com/vi/x/hqdefault.jpg')).toBe(false);
    expect(needsRehosting('https://static-cdn.jtvnw.net/previews-ttv/live_user_x-1280x720.jpg')).toBe(false);
    expect(needsRehosting('not a url')).toBe(false);
    expect(needsRehosting(null)).toBe(false);
  });
});

describe('rehostExpiringImages', () => {
  it('rewrites only embeds whose image could be downloaded', async () => {
    const fetcher = vi.fn<ImageFetcher>(async (url) => (url.endsWith('/ok.jpeg') ? { data: Buffer.from([1, 2]), contentType: 'image/jpeg' } : null));
    const { embeds, files } = await rehostExpiringImages(
      [
        { title: 'a', image: { url: 'https://p16-sign.tiktokcdn.com/ok.jpeg' } },
        { title: 'b', image: { url: 'https://p16-sign.tiktokcdn.com/fail.jpeg' } },
        { title: 'c', image: { url: 'https://i.ytimg.com/vi/x/hqdefault.jpg' } },
        { title: 'd' },
      ],
      fetcher,
    );
    expect(files).toEqual([{ name: 'image-0.jpg', data: Buffer.from([1, 2]) }]);
    expect(embeds.map((e) => e.image?.url)).toEqual([
      'attachment://image-0.jpg',
      'https://p16-sign.tiktokcdn.com/fail.jpeg',
      'https://i.ytimg.com/vi/x/hqdefault.jpg',
      undefined,
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
