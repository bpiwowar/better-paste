/*
 * Better Paste - Plugin for Obsidian
 * Copyright (c) 2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { getFrontMatterInfo } from 'obsidian';
import { markdownCodeRanges, overlapsRange } from './markdownRanges';
import type { ProtectedRange } from './urlCleanup';

/*
 * Every pattern and replacement is built from escape strings rather than literal
 * characters, because the whole point of these rules is that the characters are invisible
 * or easily confused in a source file.
 *
 * Both rules convert toward plain ASCII only. Straight quotes and hyphens are what
 * Markdown's own syntax is made of, so this direction tends to repair pasted syntax
 * rather than break it. The protections below cover the places where the character is
 * part of a name or of data instead of prose.
 */

/** Em dash and en dash, both replaced by a hyphen. */
const DASHES = new RegExp('[\\u2013\\u2014]', 'g');

/**
 * Curly double quotes, including the low-9 form German uses as an opening quote.
 *
 * The guillemets \u00AB \u00BB are deliberately absent: they are the ordinary quotation marks of
 * French, Russian and several other languages, so replacing them would not be tidying up
 * pasted text, it would be rewriting correctly set text.
 */
const DOUBLE_QUOTES = new RegExp('[\\u201C\\u201D\\u201E\\u201F]', 'g');

/**
 * Curly single quotes. U+2019 matters most of the three: it is the character assistants
 * and web pages use for an apostrophe, so "don\u2019t" becomes "don't".
 */
const SINGLE_QUOTES = new RegExp('[\\u2018\\u2019\\u201A\\u201B]', 'g');

/**
 * Spaces that are not the ordinary space: no-break, narrow no-break, figure, punctuation,
 * and the en/em/thin/hair quad family. All become a plain space.
 *
 * The ideographic space U+3000 is left alone: it is the normal word space in CJK text and
 * is a full character wide, so swapping it for an ASCII space changes the layout of a
 * sentence that was set correctly.
 */
const EXOTIC_SPACE = new RegExp('[\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F]');

/**
 * Every character handled by the invisible-character pass. Bidirectional overrides are
 * included because they can make text render in an order unrelated to its source. Direction
 * marks, embeddings and isolates are kept because they carry meaning in mixed-direction text.
 * The zero-width joiner and non-joiner are also kept because they hold emoji and letters
 * together in scripts where removing them would corrupt the text.
 */
const NORMALIZED_CHARACTERS = new RegExp('[\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u00AD\\u200B\\uFEFF\\u202D\\u202E]', 'g');

/**
 * A Markdown link or embed destination, protected whole. One level of balanced
 * parentheses is allowed so a folder like ](Notes/(Draft)/x.md) is covered to its end.
 */
const LINK_DESTINATION = new RegExp('\\]\\([^()\\n]*(?:\\([^()\\n]*\\)[^()\\n]*)*\\)', 'g');

/**
 * Only the path part of a destination, stopping before an optional quoted title. One
 * level of balanced parentheses is allowed, for folders such as ](Notes/(Draft)/x.md).
 */
const LINK_DESTINATION_PATH = new RegExp('\\]\\(\\s*(?:<[^>\\n]*>|(?:[^()\\s\\n]|\\([^()\\s\\n]*\\))*)', 'g');

/**
 * A titled destination whose URL may carry one level of parentheses, the Wikipedia shape:
 * ](https://en.wikipedia.org/wiki/Foo_(film) "Foo (film)"). The plain LINK_DESTINATION
 * stops at the URL's inner closing paren, so both run.
 */
const LINK_DESTINATION_TITLED = new RegExp(
    '\\]\\(\\s*(?:<[^<>\\n]*>|(?:[^()<\\s\\n]|\\([^()<\\s\\n]*\\))+)' + '(?:[ \\t]+(?:"[^"\\n]*"|\'[^\'\\n]*\'|\\([^)\\n]*\\)))?[ \\t]*\\)',
    'g'
);

/** A link reference or footnote definition line, with the label captured separately. */
const LINK_DEFINITION_LINE = new RegExp('^( {0,3}\\[[^\\]\\n]+\\]):[ \\t]*[^\\n]*$', 'gm');

/**
 * The colon-to-end tail of every definition line. The [label] itself is left out so it
 * converts exactly like its usages in the text, keeping the reference matched.
 */
function definitionTailRanges(input: string): ProtectedRange[] {
    const ranges: ProtectedRange[] = [];
    LINK_DEFINITION_LINE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LINK_DEFINITION_LINE.exec(input)) !== null) {
        ranges.push({ start: match.index + match[1].length, end: match.index + match[0].length });
    }
    return ranges;
}

/** An HTML tag with its attributes, whose paths and values are syntax rather than prose. */
const HTML_TAG = new RegExp('</?[A-Za-z][^<>\\n]*>', 'g');

/** A wikilink or embed. Its target, subpath and alias must survive to keep resolving. */
const WIKILINK = new RegExp('\\[\\[[^\\[\\]\\n]+\\]\\]', 'g');

/**
 * The frontmatter block leading the pasted text, whose values are data, not prose. The
 * boundary comes from Obsidian's own getFrontMatterInfo, so the protected block is
 * exactly what the app would read. Leading blank lines are skipped first, because the
 * trim rule removes them later, which turns the block into real frontmatter once it
 * lands in a note.
 */
export function frontmatterRanges(input: string): ProtectedRange[] {
    // Anything leading the block that this pipeline later removes or trims, such as a
    // BOM, zero-width characters or blank lines, is skipped before detection, because
    // once it is gone the block lands in the note as real frontmatter
    const prefix = new RegExp('^[\\s\\u00AD\\u200B\\u202D\\u202E]*').exec(input)?.[0].length ?? 0;
    const body = input.slice(prefix);
    let info = getFrontMatterInfo(body);
    // A closer carrying trailing whitespace at the document end fails detection, yet the
    // trim rule strips exactly that whitespace later, promoting the block
    if (!info.exists) info = getFrontMatterInfo(body.replace(/[ \t]+$/, ''));
    return info.exists ? [{ start: prefix, end: prefix + info.contentStart }] : [];
}

/**
 * The spans every text rule must leave alone: link syntax, HTML tags, definition tails
 * and frontmatter. The character rules add their own per-rule variations on top.
 */
export function markdownSyntaxRanges(input: string): ProtectedRange[] {
    return [
        ...syntaxRanges(input, [WIKILINK, LINK_DESTINATION, LINK_DESTINATION_TITLED, HTML_TAG]),
        ...frontmatterRanges(input),
        ...definitionTailRanges(input)
    ];
}

/** Spans whose spacing is a name or data: wikilink targets, link destinations, HTML tags. */
export function linkSyntaxRanges(input: string): ProtectedRange[] {
    return syntaxRanges(input, [WIKILINK, LINK_DESTINATION, HTML_TAG]);
}

/** The spans the given patterns occupy, collected as protected ranges. */
function syntaxRanges(input: string, patterns: readonly RegExp[]): ProtectedRange[] {
    const ranges: ProtectedRange[] = [];
    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(input)) !== null) {
            ranges.push({ start: match.index, end: match.index + match[0].length });
        }
    }
    return ranges;
}

export interface TypographyResult {
    text: string;
    changed: boolean;
}

/**
 * Replaces the characters that look ordinary but are not: exotic spaces become plain
 * spaces, selected zero-width characters and bidirectional overrides are dropped.
 *
 * Runs before the other text rules, because a no-break space is not whitespace to a
 * regular expression. Leaving one in place would defeat the terminal rule's blank-line
 * and indentation detection.
 */
export function normalizeInvisibleCharacters(input: string, protect: readonly ProtectedRange[] = []): TypographyResult {
    // A link target or frontmatter value carries the character as part of a name or of
    // data, so those stay untouched. The whole destination is used here because the path
    // pattern would stop at the very no-break space this protects. Code is deliberately
    // not protected: an invisible character in pasted code is exactly the bug this
    // cleanup exists to remove.
    const protectedRanges = [
        ...protect,
        ...syntaxRanges(input, [WIKILINK, LINK_DESTINATION, HTML_TAG]),
        ...frontmatterRanges(input),
        ...definitionTailRanges(input)
    ];
    const text = input.replace(NORMALIZED_CHARACTERS, (match, offset: number) => {
        if (overlapsRange(protectedRanges, offset, offset + match.length)) return match;
        return EXOTIC_SPACE.test(match) ? ' ' : '';
    });
    return { text, changed: text !== input };
}

/**
 * Turns curly quotes and apostrophes into straight ones.
 *
 * A quote inside a wikilink target, a destination path, an HTML tag, a definition or
 * frontmatter is part of a name or of data, so it stays. Link titles are deliberately not
 * protected: straight quotes are their valid delimiters, so this repairs them.
 */
export function straightenQuotes(input: string, protect: readonly ProtectedRange[] = []): TypographyResult {
    const protectedRanges = [
        ...markdownCodeRanges(input),
        ...protect,
        ...syntaxRanges(input, [WIKILINK, LINK_DESTINATION_PATH, LINK_DESTINATION_TITLED, HTML_TAG]),
        ...frontmatterRanges(input),
        ...definitionTailRanges(input)
    ];
    const outsideCode = (match: string, offset: number, replacement: string): string =>
        overlapsRange(protectedRanges, offset, offset + match.length) ? match : replacement;

    const text = input
        .replace(DOUBLE_QUOTES, (match, offset: number) => outsideCode(match, offset, '"'))
        .replace(SINGLE_QUOTES, (match, offset: number) => outsideCode(match, offset, "'"));
    return { text, changed: text !== input };
}

/**
 * The spacing accents LaTeX PDFs put in front of a letter, mapped to the combining mark
 * that joins them to it. The last three are the ASCII look-alikes the old Computer Modern
 * fonts extract as, which also are Markdown, math and path syntax.
 */
const COMBINING_ACCENTS: Record<string, string> = {
    '\u00B4': '\u0301',
    '\u02DD': '\u030B',
    '\u02C6': '\u0302',
    '\u00A8': '\u0308',
    '\u02DC': '\u0303',
    '\u00B8': '\u0327',
    '\u02C7': '\u030C',
    '\u02D8': '\u0306',
    '\u02DA': '\u030A',
    '\u02DB': '\u0328',
    '\u02D9': '\u0307',
    '`': '\u0300',
    '^': '\u0302',
    '~': '\u0303'
};

/**
 * A spacing accent glued to the letter after it. Whether an ASCII look-alike counts
 * depends on its neighbours, which the replacement checks, since lookbehinds are not
 * available on older iOS.
 */
const SPLIT_ACCENT = new RegExp('([\\u00B4\\u02DD\\u02C6\\u00A8\\u02DC\\u00B8\\u02C7\\u02D8\\u02DA\\u02DB\\u02D9`^~])(\\p{L})', 'gu');

/** A backtick between two letters, which no code span written on purpose begins or ends with. */
const IN_WORD_BACKTICK = new RegExp('(\\p{L})`(?=\\p{L})', 'gu');

/** Inline and block TeX math, where a caret or tilde between letters is notation. */
const DOLLAR_MATH = new RegExp('\\$\\$[\\s\\S]*?\\$\\$|\\$[^$\\n]+\\$', 'g');

/** The character ending right before `offset`, a surrogate pair counted as one. */
function characterBefore(input: string, offset: number): string {
    const low = input.charCodeAt(offset - 1);
    return low >= 0xdc00 && low <= 0xdfff ? input.slice(offset - 2, offset) : input.slice(offset - 1, offset);
}

/**
 * Joins accents that PDFs typeset with LaTeX split off their letters, so d\u00B4etecter
 * becomes d\u00E9tecter. The dotless i and j those fonts accent stand in for the plain
 * letters. A pair that has no precomposed character, or an accent that follows its
 * letter, is ambiguous and stays as it is.
 *
 * A dedicated accent character always qualifies. An ASCII look-alike only does inside a
 * word, as in apr`es, or as a grave accent opening a one-letter word, the French and
 * Portuguese a with grave, so a backtick, caret or tilde that is syntax is never touched.
 */
export function joinSplitAccents(input: string, protect: readonly ProtectedRange[] = []): TypographyResult {
    // A grave accent inside a word cannot delimit code, yet two of them in a paragraph
    // pair up as a code span and would protect each other. Masking them first, with a
    // placeholder of the same length, keeps the ranges aligned with the input.
    const codeSource = input.replace(IN_WORD_BACKTICK, '$1x');
    const protectedRanges = [...markdownCodeRanges(codeSource), ...protect, ...markdownSyntaxRanges(input)];
    const mathRanges = syntaxRanges(input, [DOLLAR_MATH]);

    const text = input.replace(SPLIT_ACCENT, (match, accent: string, letter: string, offset: number) => {
        const end = offset + match.length;
        if (overlapsRange(protectedRanges, offset, end)) return match;
        if (/[`^~]/.test(accent)) {
            const inWord = /\p{L}/u.test(characterBefore(input, offset));
            const graveWord =
                accent === '`' && !/[\p{L}\p{N}`]/u.test(characterBefore(input, offset)) && !/[\p{L}\p{N}`]/u.test(input.charAt(end));
            if (!inWord && !graveWord) return match;
            if (overlapsRange(mathRanges, offset, end)) return match;
        }
        const base = letter === '\u0131' ? 'i' : letter === '\u0237' ? 'j' : letter;
        const composed = (base + COMBINING_ACCENTS[accent]).normalize('NFC');
        return [...composed].length === 1 ? composed : match;
    });
    return { text, changed: text !== input };
}

/**
 * Turns em and en dashes into hyphens, including the ones that join ranges.
 *
 * Runs after the terminal rule, not before it. A hyphen is a list marker, so converting
 * a leading long dash to a hyphen first would make the terminal rule read that line as a
 * bullet: it would refuse to rejoin the wrapped paragraph and would render the sentence
 * as a list item. Doing it last means the dash is still a dash while line structure is
 * decided.
 */
export function straightenDashes(input: string, protect: readonly ProtectedRange[] = []): TypographyResult {
    // A dash inside [[2013\u201314 Premier League]] or a destination is part of the name, and
    // changing it breaks the link. Frontmatter values are data.
    const protectedRanges = [
        ...markdownCodeRanges(input),
        ...protect,
        ...syntaxRanges(input, [WIKILINK, LINK_DESTINATION, LINK_DESTINATION_TITLED, HTML_TAG]),
        ...frontmatterRanges(input),
        ...definitionTailRanges(input)
    ];

    let text = input.replace(DASHES, (match, offset: number) =>
        overlapsRange(protectedRanges, offset, offset + match.length) ? match : '-'
    );

    // A long dash at the start of a line is prose. Escaping the replacement keeps it from
    // becoming a list item, a thematic break or a setext underline when Obsidian renders
    // the Markdown.
    const sourceLines = input.split('\n');
    text = text
        .split('\n')
        .map((line, index) => {
            // The prefix covers blockquote markers and an existing list marker, because a
            // dash converted right after "- " would nest a second list inside the item.
            // It is matched against the source line, where a converted dash cannot be
            // mistaken for a marker.
            const opening = new RegExp('^((?: {0,3}>[ \\t]?)* {0,3}(?:[-*+][ \\t]+|\\d{1,9}[.)][ \\t]+)?)[\\u2013\\u2014]').exec(
                sourceLines[index] ?? ''
            );
            if (!opening) return line;
            // Two hyphens already underline the paragraph above as a setext heading, and
            // the trailing \r of a CRLF paste would defeat the $ anchors
            const tail = line.replace(/\r$/, '').slice(opening[1].length);
            if (!/^(?:-(?:[ \t]|$)|-{2,}[ \t]*$)/.test(tail)) return line;
            return `${opening[1]}\\${line.slice(opening[1].length)}`;
        })
        .join('\n');

    return { text, changed: text !== input };
}
