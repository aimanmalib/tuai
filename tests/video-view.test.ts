// The demo video on the home page: poster and download link point at the built assets, the recording is only
// attached when the visitor presses play, and the banner link is recognised from any view.
import { describe, expect, it } from 'vitest';
import { statSync } from 'node:fs';
import { isVideoHash, mountVideo, VIDEO, type PlayButtonLike, type VideoLike } from '../web/src/video-view.ts';

const urls = { src: '/assets/v-abc.mp4', poster: '/assets/p-abc.jpg' };

function parts(playResult: Promise<void> = Promise.resolve()) {
  let onClick: (() => void) | undefined;
  const calls = { play: 0, focus: 0 };
  const video: VideoLike = {
    poster: '',
    src: '',
    controls: true,
    play: () => {
      calls.play++;
      return playResult;
    },
    focus: () => void calls.focus++,
  };
  const button: PlayButtonLike = { hidden: true, addEventListener: (_t, l) => void (onClick = l) };
  const link = { href: '' };
  return { video, button, link, calls, click: () => onClick?.() };
}

describe('demo video', () => {
  it('shows the poster, the play button and the download link, and attaches no source yet', () => {
    const p = parts();
    mountVideo(p.video, p.button, p.link, urls);
    expect(p.video.poster).toBe(urls.poster);
    expect(p.video.src).toBe('');
    expect(p.video.controls).toBe(false);
    expect(p.button.hidden).toBe(false);
    expect(p.link.href).toBe(urls.src);
    expect(p.calls.play).toBe(0);
  });

  it('attaches the recording, shows the controls and plays on the first press', () => {
    const p = parts();
    mountVideo(p.video, p.button, p.link, urls);
    p.click();
    expect(p.video.src).toBe(urls.src);
    expect(p.video.controls).toBe(true);
    expect(p.button.hidden).toBe(true);
    expect(p.calls).toEqual({ play: 1, focus: 1 });
  });

  it('keeps the controls when the browser refuses to start playing', async () => {
    const p = parts(Promise.reject(new Error('NotAllowedError')));
    mountVideo(p.video, p.button, p.link, urls);
    p.click();
    await Promise.resolve();
    expect(p.video.controls).toBe(true);
    expect(p.video.src).toBe(urls.src);
  });

  it('imports the tracked recording and poster within their size limits', () => {
    expect(VIDEO.src).toMatch(/tuai-demo\.mp4$/);
    expect(VIDEO.poster).toMatch(/tuai-demo-poster\.jpg$/);
    expect(statSync('docs/video/tuai-demo.mp4').size).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(statSync('docs/video/tuai-demo-poster.jpg').size).toBeLessThanOrEqual(150 * 1024);
  });

  it('knows its own anchor and nothing else', () => {
    expect(isVideoHash('#demo-video')).toBe(true);
    for (const h of ['', '#/', '#/activity', '#demo-video-x', '#stats']) expect(isVideoHash(h)).toBe(false);
  });
});
