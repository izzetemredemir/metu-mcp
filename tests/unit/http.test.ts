import { afterEach, describe, expect, it } from 'vitest';
import { assertAllowedUrl, decodeBody, isPathAllowed, parseRobots, politeFetch, RobotsDisallowedError, setFetchImpl } from '../../src/collectors/http.js';

describe('robots.txt', () => {
  const rules = parseRobots(`User-agent: *\nCrawl-delay: 10\nAllow: /misc/*.css$\nDisallow: /misc/\nDisallow: /admin\n`);

  it('reads crawl-delay', () => {
    expect(rules.crawlDelayMs).toBe(10_000);
  });

  it('applies longest-match allow/disallow', () => {
    expect(isPathAllowed(rules, '/?date_filter[value][date]=05/10/2026')).toBe(true);
    expect(isPathAllowed(rules, '/misc/drupal.js')).toBe(false);
    expect(isPathAllowed(rules, '/misc/style.css')).toBe(true);
    expect(isPathAllowed(rules, '/admin/config')).toBe(false);
  });

  it('combines every group for the same agent (open.metu.edu.tr has two `*` groups)', () => {
    const twice = parseRobots('User-agent: *\nDisallow: /discover\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nCrawl-delay: 5\nDisallow: /member\n');
    expect(isPathAllowed(twice, '/oai/request?verb=ListRecords')).toBe(true);
    expect(isPathAllowed(twice, '/discover')).toBe(false);
    expect(isPathAllowed(twice, '/member/1')).toBe(false);
    expect(twice.crawlDelayMs).toBe(5_000);
  });

  it('treats "Disallow: /" as blocking everything (oibs2, sis, Koha)', () => {
    expect(isPathAllowed(parseRobots('User-agent: *\nDisallow: /'), '/View_Program_Course_Details_64/')).toBe(false);
  });
});

describe('domain allowlist', () => {
  it('only allows METU hosts', () => {
    expect(assertAllowedUrl('https://oidb.metu.edu.tr/tr/announcements').host).toBe('oidb.metu.edu.tr');
    expect(() => assertAllowedUrl('https://evil.example.com/')).toThrow(/not allowed/);
    expect(() => assertAllowedUrl('https://metu.edu.tr.evil.com/')).toThrow(/not allowed/);
    expect(() => assertAllowedUrl('file:///etc/passwd')).toThrow();
  });

  it('allows the one fixed Overpass host exactly, not its look-alikes', () => {
    expect(assertAllowedUrl('https://overpass.kumi.systems/api/interpreter').host).toBe('overpass.kumi.systems');
    expect(() => assertAllowedUrl('https://evil.overpass.kumi.systems/')).toThrow(/not allowed/);
    expect(() => assertAllowedUrl('https://overpass-api.de/api/interpreter')).toThrow(/not allowed/);
  });
});

describe('body decoding', () => {
  // "İŞĞ" in ISO-8859-9
  const latin5 = new Uint8Array([0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x22, ...Buffer.from('iso8859-9">'), 0xdd, 0xde, 0xd0]);

  it('uses <meta charset> when the header has none (catalog.metu.edu.tr)', () => {
    expect(decodeBody(latin5, 'text/html').endsWith('İŞĞ')).toBe(true);
  });

  it('prefers the header charset and falls back to UTF-8', () => {
    expect(decodeBody(Buffer.from('<meta charset="iso8859-9">İ'), 'text/html; charset=utf-8').endsWith('İ')).toBe(true);
    expect(decodeBody(Buffer.from('çay'), null)).toBe('çay');
    expect(decodeBody(Buffer.from('<meta charset="bogus">ç'), null).endsWith('ç')).toBe(true);
  });
});

describe('hosts whose robots.txt says "Disallow: /"', () => {
  const seen: string[] = [];
  const fake = (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push(url);
    if (url.endsWith('/robots.txt')) return Promise.resolve(new Response('User-agent: *\nDisallow: /\n'));
    return Promise.resolve(new Response('<html>ok</html>'));
  };

  afterEach(() => {
    seen.length = 0;
  });

  it('treat an unreachable or failing robots.txt as "Disallow: /"', async () => {
    for (const fail of [() => Promise.reject(new Error('timeout')), () => Promise.resolve(new Response('', { status: 503 }))]) {
      seen.length = 0;
      setFetchImpl(((input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        seen.push(url);
        return url.endsWith('/robots.txt') ? fail() : Promise.resolve(new Response('<html>ok</html>'));
      }) as typeof fetch, { noDelay: true });
      await expect(politeFetch(undefined, 'https://librarycatalog.metu.edu.tr/')).rejects.toBeInstanceOf(RobotsDisallowedError);
      expect(seen.every((u) => u.endsWith('/robots.txt'))).toBe(true);
    }
  });

  it('are never fetched (oibs2, SIS, Koha): only robots.txt is requested', async () => {
    setFetchImpl(fake as typeof fetch, { noDelay: true });
    for (const url of ['https://oibs2.metu.edu.tr/View_Program_Course_Details_64/', 'https://sis.metu.edu.tr/', 'https://librarycatalog.metu.edu.tr/']) {
      await expect(politeFetch(undefined, url)).rejects.toBeInstanceOf(RobotsDisallowedError);
    }
    expect(seen.every((u) => u.endsWith('/robots.txt'))).toBe(true);
  });
});
