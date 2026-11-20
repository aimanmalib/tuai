// The recorded demo on the home page. The file lives in docs/video so the repository plays it too; Vite copies it
// under a hashed name, so the CDN in front never serves an old copy after a new recording.
import videoUrl from '../../docs/video/tuai-demo.mp4';
import posterUrl from '../../docs/video/tuai-demo-poster.jpg';

export const VIDEO = { src: videoUrl, poster: posterUrl } as const;

export interface VideoLike {
  poster: string;
  src: string;
  controls: boolean;
  play(): Promise<void>;
  focus(): void;
}
export interface PlayButtonLike {
  hidden: boolean | string;
  addEventListener(type: 'click', listener: () => void): void;
}

/**
 * Shows the poster and a play button. Some browsers fetch a video even with preload="none", so the source is only
 * attached when the visitor presses play: a visit to the page costs the poster, never the recording.
 */
export function mountVideo(video: VideoLike, play: PlayButtonLike, download: { href: string }, urls: { src: string; poster: string } = VIDEO): void {
  video.poster = urls.poster;
  video.controls = false;
  download.href = urls.src;
  play.hidden = false;
  play.addEventListener('click', () => {
    if (video.src === '') video.src = urls.src;
    video.controls = true;
    play.hidden = true;
    video.focus();
    // A refused autoplay still leaves the native controls in place for a second press.
    video.play().catch(() => undefined);
  });
}

/** The banner link to the video also works from the activity view: show the home view first, then scroll to it. */
export function isVideoHash(hash: string): boolean {
  return hash === '#demo-video';
}
