/**
 * The card paints two things by hue: a site's mark and a part of speech.
 * Both palettes live in core as hue numbers, and the lightness that turns a
 * hue into ink lives in the card's stylesheet — so neither file on its own
 * knows whether the result can be read.
 *
 * That gap is not theoretical. The `free-dictionary` mark shipped at 4.36:1
 * on its own tile and `tatoeba` at 4.45:1, both under the 4.5:1 that text
 * this size asks for, and the part-of-speech palette was heading the same
 * way at 4.22:1 for an adverb. Nothing failed in either case; the colour was
 * simply too pale to read, which is how this kind of defect ships.
 *
 * So this test computes the contrast the browser will produce, for every
 * entry in both palettes, in both colour schemes. Every number it uses is
 * read out of the stylesheet rather than repeated here, because a copy would
 * keep passing after the stylesheet moved on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { namedMarks } from '../core/marks.ts';
import { partOfSpeechGroups } from '../core/part-of-speech.ts';

/**
 * WCAG 2.2 asks for 4.5:1 on body text and allows 3:1 only from 18.66px
 * bold upward. The mark's monogram is 9px bold and a part of speech is
 * 13.5px, so both are held to the higher figure.
 */
const AA = 4.5;

const CSS = readFileSync(new URL('./card-view.ts', import.meta.url), 'utf8');

type Rgb = [number, number, number];

/** `hsl(H S% L%)` to sRGB, 0-255 — the same conversion a browser does. */
function fromHsl(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const base = light - chroma / 2;
  const wheel: Rgb[] = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ];
  const sector = wheel[Math.floor((((h % 360) + 360) % 360) / 60)] ?? [0, 0, 0];
  return sector.map((channel) => (channel + base) * 255) as Rgb;
}

function fromHex(hex: string): Rgb {
  const digits = hex.replace('#', '');
  return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as Rgb;
}

/** WCAG relative luminance. */
function luminance(colour: Rgb): number {
  const [r, g, b] = colour.map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/**
 * A declaration read out of the stylesheet.
 *
 * `after` narrows the search to the rule in question: the same property is
 * declared once in the light block and again in the dark one, and reading
 * the wrong occurrence would silently test the wrong scheme.
 */
function declaration(after: string, pattern: RegExp): string {
  const from = CSS.indexOf(after);
  assert.notEqual(from, -1, `the stylesheet no longer contains ${JSON.stringify(after)}`);
  const found = pattern.exec(CSS.slice(from));
  assert.ok(found?.[1], `${pattern} did not match after ${JSON.stringify(after)}`);
  return found[1];
}

const lightnessOf = (after: string, property: string) =>
  Number(
    declaration(after, new RegExp(`${property}: hsl\\(var\\(--hue\\)[^;]*?(\\d+(?:\\.\\d+)?)%\\)`)),
  );

/** The card's own background, which a part of speech is written straight onto. */
const CARD = {
  light: fromHex(declaration('.card {', /--bg: (#[0-9a-f]{6})/)),
  dark: fromHex(declaration('@media (prefers-color-scheme: dark) {\n  .card {', /--bg: (#[0-9a-f]{6})/)),
};

test('every site mark can be read on its own tile', () => {
  const schemes = {
    light: { bg: lightnessOf('\n.mark {', 'background'), fg: lightnessOf('\n.mark {', 'color') },
    dark: {
      bg: lightnessOf('.mark { background', 'background'),
      fg: lightnessOf('.mark { background', 'color'),
    },
  };

  for (const [id, mark] of namedMarks()) {
    for (const [scheme, l] of Object.entries(schemes)) {
      const ratio = contrast(
        fromHsl(mark.hue, mark.sat, l.fg),
        fromHsl(mark.hue, mark.sat, l.bg),
      );
      assert.ok(ratio >= AA, `${id} in ${scheme}: ${ratio.toFixed(2)}:1, needs ${AA}`);
    }
  }
});

test('every part of speech can be read on the card', () => {
  // Saturation differs between the schemes as well as lightness, so both are
  // read from the rule they belong to.
  const saturationOf = (after: string) =>
    Number(declaration(after, /color: hsl\(var\(--hue\) (\d+)%/));
  const schemes = {
    light: {
      l: lightnessOf('.pos[data-hue]', 'color'),
      s: saturationOf('.pos[data-hue]'),
      paper: CARD.light,
    },
    dark: {
      l: lightnessOf('@media (prefers-color-scheme: dark) {\n  .pos', 'color'),
      s: saturationOf('@media (prefers-color-scheme: dark) {\n  .pos'),
      paper: CARD.dark,
    },
  };

  for (const group of partOfSpeechGroups()) {
    for (const [scheme, ink] of Object.entries(schemes)) {
      const ratio = contrast(fromHsl(group.hue, ink.s, ink.l), ink.paper);
      assert.ok(ratio >= AA, `${group.group} in ${scheme}: ${ratio.toFixed(2)}:1, needs ${AA}`);
    }
  }
});

test('the contrast arithmetic agrees with the ratios everyone knows', () => {
  // Without this the two tests above would pass just as happily on a
  // function that returned 99 for everything.
  const black: Rgb = [0, 0, 0];
  const white: Rgb = [255, 255, 255];
  assert.equal(Math.round(contrast(black, white) * 100) / 100, 21);
  assert.equal(contrast(white, white), 1);
  // #767676 on white is the published example of the AA boundary, at 4.54:1.
  assert.ok(Math.abs(contrast(fromHex('#767676'), white) - 4.54) < 0.01);
  // And the conversion has to agree with the browser: the dark card is
  // written as a hex, and the marks on it as hsl().
  assert.deepEqual(fromHsl(240, 12, 10).map(Math.round), [22, 22, 29]);
});
