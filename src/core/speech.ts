/**
 * Deciding how a piece of text should be spoken. No browser APIs here.
 *
 * The card shows two things worth hearing and they are not in the same
 * language: the selection, in whatever the page is written in, and its
 * translation, in the language it was translated into. Speaking either one
 * with the wrong voice produces confident nonsense — an English voice
 * reading `bölme` is not a pronunciation of anything.
 *
 * The dictionary source carries IPA but no recordings, so this is
 * synthesised rather than played back. That is the better trade anyway: it
 * works for a whole sentence, for a term no dictionary lists, and offline.
 */

/**
 * A BCP-47 tag the speech engine will accept, or the fallback.
 *
 * Pages declare all sorts of things in `lang`, including empty strings and
 * whole sentences. Anything that is not shaped like a language tag is
 * discarded rather than passed on, because a bad tag makes the engine pick
 * a default voice silently and the reader has no way to tell.
 */
export function utteranceLanguage(declared: string | null | undefined, fallback = 'en'): string {
  const tag = (declared ?? '').trim();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(tag) ? tag : fallback;
}

/**
 * How long the text may be before it is not worth speaking.
 *
 * Long enough for any sentence a reader would select, short enough that a
 * mis-selected paragraph does not commit them to two minutes of audio they
 * have to hunt for a button to stop.
 */
export const MAX_SPEECH_CHARS = 400;

export function speakable(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_SPEECH_CHARS;
}
