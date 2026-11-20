// The entry banner links: the slides served by this site, the source, and the line saying the project was started
// after the event opened, linked to the repository's first commit so anyone can check the date.

export interface BannerConfig {
  deckUrl: string;
  repoUrl: string;
  firstCommit: string;
  note: boolean;
}

export interface BannerLinks {
  deck: string;
  source: string;
  /** Null when the config turns the note off. */
  firstCommit: string | null;
}

export function bannerLinks(b: BannerConfig, deckVersion: string): BannerLinks {
  const repo = b.repoUrl.replace(/\/+$/, '');
  return {
    deck: deckVersion ? `${b.deckUrl}?v=${encodeURIComponent(deckVersion)}` : b.deckUrl,
    source: repo,
    firstCommit: b.note ? `${repo}/commit/${b.firstCommit}` : null,
  };
}

export interface LinkLike {
  href: string;
  hidden: boolean | string;
  title: string;
}

/** Fills the banner anchors; the note and the dot before it are hidden together when the note is off. */
export function mountBanner(
  els: { deck: LinkLike; source: LinkLike; note: LinkLike; noteDot: { hidden: boolean | string } },
  b: BannerConfig,
  deckVersion: string,
  t: (key: string, vars?: Record<string, string>) => string,
): void {
  const links = bannerLinks(b, deckVersion);
  els.deck.href = links.deck;
  els.source.href = links.source;
  els.note.hidden = links.firstCommit === null;
  els.noteDot.hidden = links.firstCommit === null;
  if (links.firstCommit !== null) {
    els.note.href = links.firstCommit;
    els.note.title = t('banner.firstCommit', { commit: b.firstCommit.slice(0, 7) });
  }
}
