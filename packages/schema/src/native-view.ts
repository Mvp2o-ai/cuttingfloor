import * as z from 'zod/v4';

// A tool whose result a chat app shows as a web view can also say that an app with its own
// built-in version of that view may show that instead. It is read by apps, not by the model.
// An app opens its component only when it has this component at this exact version; anything
// else (an older build, a newer version, a name it does not know) shows the web view, which
// always works. A change to what a component is sent or sends back gets a new version, so app
// builds already out fall back to the web view on their own.

export const NATIVE_VIEWS = {
  /** media.upload: pick or record a file and send it to the upload in the result. */
  upload: 1,
  /** score.record: pads or the microphone over a loop of a score. */
  record: 1,
} as const;
export type NativeViewComponent = keyof typeof NATIVE_VIEWS;

export const NativeView = z
  .object({
    component: z.enum(Object.keys(NATIVE_VIEWS) as [NativeViewComponent, ...NativeViewComponent[]]),
    version: z.number().int().positive(),
  })
  .describe(
    'For apps, nothing for you to act on: an app with its own built-in version of this view (this component, this version) shows that in place of the web view',
  );
export type NativeView = z.infer<typeof NativeView>;

/** The flag for a component at the version this server speaks. */
export function nativeView(component: NativeViewComponent): NativeView {
  return { component, version: NATIVE_VIEWS[component] };
}
