import { describe, expect, it } from 'vitest';
import { bannerLinks, mountBanner, type BannerConfig } from '../web/src/banner.ts';

// A frozen banner config, so the test does not lock the owner's repository or deck path.
const BANNER: BannerConfig = {
  deckUrl: '/deck/slides.pdf',
  repoUrl: 'https://example.org/owner/repo',
  firstCommit: 'a'.repeat(40),
  note: true,
};
const t = (key: string, vars: Record<string, string> = {}) => `${key}:${Object.values(vars).join(',')}`;
const link = () => ({ href: '', hidden: false as boolean | string, title: '' });

describe('banner links', () => {
  it('links the slides on this site with a content version, the source, and the first commit', () => {
    expect(bannerLinks(BANNER, 'abc123')).toEqual({
      deck: '/deck/slides.pdf?v=abc123',
      source: 'https://example.org/owner/repo',
      firstCommit: `https://example.org/owner/repo/commit/${'a'.repeat(40)}`,
    });
  });

  it('drops a trailing slash from the repository and leaves the deck bare without a version', () => {
    const links = bannerLinks({ ...BANNER, repoUrl: 'https://example.org/owner/repo/' }, '');
    expect(links.deck).toBe('/deck/slides.pdf');
    expect(links.firstCommit).toBe(`https://example.org/owner/repo/commit/${'a'.repeat(40)}`);
  });

  it('has no first commit link when the note is off', () => {
    expect(bannerLinks({ ...BANNER, note: false }, 'v').firstCommit).toBeNull();
  });

  it('fills the anchors and titles the note with the short commit', () => {
    const els = { deck: link(), source: link(), note: link(), noteDot: { hidden: false as boolean | string } };
    mountBanner(els, BANNER, 'v1', t);
    expect(els.deck.href).toBe('/deck/slides.pdf?v=v1');
    expect(els.source.href).toBe(BANNER.repoUrl);
    expect(els.note.href).toMatch(/\/commit\/a{40}$/);
    expect(els.note.title).toBe('banner.firstCommit:aaaaaaa');
    expect([els.note.hidden, els.noteDot.hidden]).toEqual([false, false]);
  });

  it('hides the note and its separator together when the note is off', () => {
    const els = { deck: link(), source: link(), note: link(), noteDot: { hidden: false as boolean | string } };
    mountBanner(els, { ...BANNER, note: false }, 'v1', t);
    expect([els.note.hidden, els.noteDot.hidden]).toEqual([true, true]);
    expect(els.note.href).toBe('');
  });
});
