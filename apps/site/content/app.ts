// The iPhone app, Cutting Floor AI (ai.cuttingfloor.app, built in mobile-apifunnel-ai). It is in
// beta, so it installs through Apple's TestFlight, not the App Store. The home page, /app, its
// Markdown twin and the phone strip under the nav all read these lines.

export const APP_NAME = 'Cutting Floor AI';
/** The public TestFlight invite: opening it on an iPhone offers to join the beta. */
export const TESTFLIGHT_URL = 'https://testflight.apple.com/join/TODO';
/** TestFlight itself, Apple's app for beta apps, on the App Store. */
export const TESTFLIGHT_APP_URL = 'https://apps.apple.com/app/testflight/id899247664';

export const APP_TITLE = 'cuttingfloor on your iPhone';
export const APP_DESCRIPTION =
  'The cuttingfloor iPhone app, in beta: send videos from your phone, say or type the edit, and watch the cut play back. Installs through Apple’s TestFlight.';
export const APP_LEAD =
  'Edit on the go. Send videos straight from your phone, hold to talk or type the edit you want, and watch the result play back in the app.';

/** Joining the beta, in order. */
export const APP_STEPS = [
  {
    text: 'Install TestFlight, Apple’s free app for trying beta apps, from the App Store.',
    href: TESTFLIGHT_APP_URL,
    link: 'Get TestFlight',
  },
  {
    text: 'Open the invite on your iPhone, then tap Accept and Install.',
    href: TESTFLIGHT_URL,
    link: 'Open the invite',
  },
  {
    text: `Open ${APP_NAME} and sign in with Apple or your email.`,
  },
] as const;

/** Screenshots from the app, taken on an iPhone 17 Pro Max. */
export const APP_SHOTS = [
  {
    src: '/app/playing.jpg',
    alt: 'A clip playing in the app, above the row of videos on the editing floor',
  },
  { src: '/app/typing.jpg', alt: 'Typing an edit in the app: "Tell it the edit…"' },
] as const;
