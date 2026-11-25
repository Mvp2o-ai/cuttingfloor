// The iPhone app, Cutting Floor AI (ai.cuttingfloor.app, built in mobile-apifunnel-ai): editing
// video by voice. It is on the App Store; Android has no listing yet. The home page, /app, its
// Markdown twin, the strip under the nav and the connect and welcome pages all read these lines.
// The name, subtitle and promo text match the App Store listing.

export const APP_NAME = 'Cutting Floor AI';
export const APP_ID = '6832958273';
export const APP_SUBTITLE = 'Edit video by voice';

/**
 * The App Store page, which Apple redirects to the visitor's own storefront and language. `place`
 * is the campaign token (`ct`), so App Store Connect shows which page each install came from.
 */
export function appStoreUrl(place: string) {
  return `https://apps.apple.com/app/id${APP_ID}?ct=${place}`;
}

export const APP_TITLE = 'Edit video by voice, on your iPhone';
export const APP_DESCRIPTION =
  'Cutting Floor AI is the iPhone app that edits video by voice: say the edit, and watch it cut, caption, retime and finish on your phone. Free on the App Store.';
export const APP_HEADLINE = 'Edit video by talking to it.';
export const APP_LEAD =
  'Say the edit (“cut the pauses, add captions, make it a 15-second vertical”) and watch it happen on your phone. Cut, caption, retime and finish your videos by voice, with cuttingfloor’s editing tools behind every word.';

/** What it is like to use, in order. */
export const APP_POINTS = [
  { b: 'Say it.', text: 'Hold to talk, or go hands-free. Or type the edit if you’d rather.' },
  { b: 'Watch it happen.', text: 'The clip plays back in the app as each change lands.' },
  {
    b: 'Send your videos.',
    text: 'Pick them from your gallery or files. Your cuts and exports stay about a week.',
  },
] as const;

/** For anyone the app is not for yet. */
export const APP_ANDROID = 'Android is coming. On Android today, try it in Kazi.';

/** Screenshots from the app, taken on an iPhone 17 Pro Max. */
export const APP_SHOTS = [
  {
    src: '/app/playing.jpg',
    alt: 'A clip playing in the app, above the row of videos on the editing floor',
  },
  { src: '/app/typing.jpg', alt: 'Typing an edit in the app: "Tell it the edit…"' },
] as const;
