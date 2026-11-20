// Caps every tool result at `TOOL_OUTPUT_CAP_CHARS`, keeping the shape of what it cuts. Every result
// stays in the context for every later turn of the run, so one big result is paid again on each of
// them: one 51,290-character grep answer rode along for 39 turns of a review run.
import type { PiToolResultContent } from "@cloudflare/computer/tools/pi-ai";

// Cuts a workspace tool's result to `TOOL_OUTPUT_CAP_CHARS` before the model reads it, and adds a
// note that says how to get the rest. A read page and a listing stay valid JSON after the cut.
// Called from `workspace-tools.ts`.

// The tools whose answer is a listing (see `Listing`), and how a cut one tells the model to ask for
// less, naming only the parameters that tool has. Their `pr_` versions call the same bare tool, so one
// map covers both, and no other tool's answer is read as a listing.
const LISTING_NARROWING: Record<'grep' | 'find' | 'ls', string> = {
    grep: 'narrow the path or query, lower context, or use limit',
    find: 'narrow the path or pattern, or use limit',
    ls: 'narrow the path, or use limit',
}

type ListingTool = keyof typeof LISTING_NARROWING

/**
 * Whether `toolName` answers with a listing: `in` would also find inherited names such as `toString`,
 * so the map's own keys are checked. It takes the bare tool name: the `pr_` tools pass the name of the
 * tool they forward to, never their prefixed one, which would return `false` and turn the secret
 * filter and the listing cut off.
 */
export const isListingTool = (toolName: string): toolName is ListingTool => Object.hasOwn(LISTING_NARROWING, toolName)

const TOOL_OUTPUT_CAP_CHARS = 16_000

// The cap as the notes below print it.
const CAP_TEXT = TOOL_OUTPUT_CAP_CHARS.toLocaleString('en-US')

const textEncoder = new TextEncoder()

// Bytes, because `read` counts `byteOffset` in bytes: a note that names one has to count that way.
const utf8ByteLength = (text: string) => textEncoder.encode(text).length

// A read answers with the file's own text when it covers the whole file. A read given an `offset`,
// and one the tool cut itself, answers with this JSON page instead, whose `nextOffset` and
// `nextByteOffset` already say where the rest is (`offset` is 1-based, the page's lines run from
// `startLine` to `endLine`).
type ReadPage = {
    content: string
    startLine: number
    endLine: number
    truncated: boolean
    nextOffset?: number
    nextByteOffset?: number
    /** A cut inside a long line whose byte is unknown: the rest of that line is out of reach. */
    note?: string
}

// A listing answers with JSON: grep `{ matches: [{ path, line, text }] }`, find and ls `{ entries }`,
// `count` items, and `nextOffset` when the tool has a further page. `note` is the secret filter's note,
// which a cut joins with its own (see `cutListing`).
type Listing = { count?: number; matches?: unknown[]; entries?: unknown[]; nextOffset?: number; note?: string }

/** One text result cut to the cap: what the model reads, and how much of the tool's answer it keeps. */
type CappedText = {
    text: string
    /**
     * How many characters of the tool's answer the cut keeps: the JSON the model reads, fields the cut
     * rewrote included, in the read-page and listing branches, and the lines above the note in the
     * plain-text branch. The note itself is not counted, so `cutChars` is what was left out.
     */
    keptChars: number
}

const isReadPage = (value: unknown): value is ReadPage => {
    if (typeof value !== 'object' || value === null) return false
    const page = value as Partial<ReadPage>
    return typeof page.content === 'string' && typeof page.startLine === 'number'
}

const isListing = (value: unknown): value is Listing => {
    if (typeof value !== 'object' || value === null) return false
    const listing = value as Listing
    return Array.isArray(listing.matches) || Array.isArray(listing.entries)
}

// The longest start of `items` whose cost fits `budget`. `costOf` measures one item the way it is
// written: raw characters in bare text, JSON-escaped characters inside JSON. Every item after the
// first also costs the `joinerChars` that join it to the one before (a newline, or a comma).
const itemsThatFit = <Item>(items: Item[], budget: number, costOf: (item: Item) => number, joinerChars: number) => {
    let shownItems = 0
    let usedChars = 0
    while (shownItems < items.length) {
        const usedWithItem = usedChars + costOf(items[shownItems]) + (shownItems === 0 ? 0 : joinerChars)
        if (usedWithItem > budget) break
        usedChars = usedWithItem
        shownItems += 1
    }
    return shownItems
}

// A cut read must leave a way to read the rest. When the cut falls between two lines the next line is
// enough. When it falls inside a line, the note names that line and the file byte where the kept text
// stops: `read` counts `byteOffset` from the file's first byte, and given `offset` with it, it resumes
// the line numbering there.
const readCutNote = (lastShownLine: number, keptStopsAtByte: number | undefined) =>
    keptStopsAtByte === undefined
        ? `Output cut at ${CAP_TEXT} characters (line ${lastShownLine} of the file is the last shown). ` +
          `Continue with offset ${lastShownLine + 1}, or read a smaller range.`
        : `Output cut at ${CAP_TEXT} characters (line ${lastShownLine} of the file is cut). ` +
          `Continue with offset ${lastShownLine}, byteOffset ${keptStopsAtByte}, or read a smaller range.`

// The start of one line that fits `budget` inside a JSON string: each character costs its own escape,
// so a line of `"` keeps half as many characters as it has.
const escapedPrefixThatFits = (line: string, budget: number) => {
    const characters = Array.from(line)
    return characters.slice(0, itemsThatFit(characters, budget, (character) => JSON.stringify(character).length - 2, 0)).join('')
}

// The start of one plain-text line that fits `budget`, cut by code point rather than by UTF-16 unit: a
// split surrogate pair would make `utf8ByteLength` of the kept text, and so the `byteOffset` the note
// names, point at the wrong byte.
const plainPrefixThatFits = (line: string, budget: number) => {
    const characters = Array.from(line)
    return characters.slice(0, itemsThatFit(characters, budget, (character) => character.length, 0)).join('')
}

// Keeps the page's shape and its own continuation fields: `nextOffset` and `nextByteOffset` say where
// the rest of the file is, so a cut page adds no note. A cut inside a line names that line again,
// with the byte where the kept text stops; when that byte is unknown, the page's note says the rest of
// that line cannot be read from here.
const cutReadPage = (page: ReadPage, call: { byteOffset?: unknown }): CappedText => {
    // Where the page's first line starts in the file. A continuation read names the byte it started
    // at, a page from line 1 starts at byte 0, and a page the tool cut itself can be measured back
    // from its `nextByteOffset`, which points at the line after the page: the page's own bytes plus the
    // one newline its content leaves out. A read that named only an `offset` and ran to the end of the
    // file leaves the byte unknown.
    let firstLineByte: number | undefined
    if (typeof call.byteOffset === 'number' && call.byteOffset > 0) firstLineByte = call.byteOffset
    else if (page.startLine === 1) firstLineByte = 0
    else if (typeof page.nextByteOffset === 'number') firstLineByte = page.nextByteOffset - utf8ByteLength(page.content) - 1
    const lines = page.content.split('\n')
    const lastLine = page.startLine + lines.length - 1
    // A cut inside the first line when its byte is unknown loses the rest of that line: this note names
    // the line and the reads that reach the rest.
    const firstLineTooLongNote =
        `Line ${page.startLine} is longer than ${CAP_TEXT} characters; the rest of it cannot be shown here. ` +
        `Read the file from line 1 and follow its nextByteOffset, or use grep to find what you need.`
    // What the page costs without its content, at its largest: `endLine`, `nextOffset` and
    // `nextByteOffset` hold no more digits than they do for the whole page, so this overhead is never
    // under-counted and the fields a cut writes always fit beside the content. A page whose first
    // line's byte is unknown can need the note above, so room for it is kept too.
    const pageWithoutContent = {
        ...page,
        content: '',
        endLine: lastLine,
        truncated: true,
        nextOffset: lastLine + 1,
        nextByteOffset: firstLineByte === undefined ? undefined : firstLineByte + utf8ByteLength(page.content) + lines.length,
    }
    const contentlessOverhead = JSON.stringify(pageWithoutContent).length
    const overhead = firstLineByte === undefined
        ? Math.max(contentlessOverhead, JSON.stringify({ ...pageWithoutContent, note: firstLineTooLongNote }).length)
        : contentlessOverhead
    const budget = TOOL_OUTPUT_CAP_CHARS - overhead
    // A line costs its JSON-escaped text, and the `\n` joining it to the line before costs two
    // characters, because a backslash is escaped too. A first line too long for the budget on its own
    // is kept in part, each character costing its own escape: a line of `"` keeps half as many.
    const shownLines = itemsThatFit(lines, budget, (line) => JSON.stringify(line).length - 2, 2)
    const keptContent = shownLines === 0 ? escapedPrefixThatFits(lines[0], budget) : lines.slice(0, shownLines).join('\n')
    const keptLines = Math.max(shownLines, 1)
    const endLine = page.startLine + keptLines - 1
    // A cut between lines names the next one. A cut inside a line names that line again, with the byte
    // it stops at, so the model reads on in that line; without a known byte for it, the rest of that
    // line is out of reach and the page moves on to the next.
    const cutInsideLine = shownLines === 0
    const cut: ReadPage = {
        ...page,
        content: keptContent,
        endLine,
        truncated: true,
        nextOffset: cutInsideLine && firstLineByte !== undefined ? endLine : endLine + 1,
    }
    // The page's own `nextByteOffset` names a line this cut may not reach, so it is replaced or gone.
    delete cut.nextByteOffset
    if (firstLineByte !== undefined) {
        // A cut between lines points at the byte after their last newline; a cut inside a line points
        // at the byte right after the kept text.
        cut.nextByteOffset = firstLineByte + utf8ByteLength(keptContent) + (cutInsideLine ? 0 : 1)
    }
    // Without the first line's byte there is no `nextByteOffset` to continue in that line, so the page
    // says in its own note why the text stops there.
    else if (cutInsideLine) cut.note = firstLineTooLongNote
    const kept = JSON.stringify(cut)
    return { text: kept, keptChars: kept.length }
}

// Keeps the listing's shape: the items that fit, the `count` of them, the `nextOffset` that continues
// the page, and a `note` of what the cut left out. The note counts the page the tool returned, not every
// match there is, and names the offset to ask from. A result too big for the cap on its own is left
// out like any other; when none fits, the note sends the model past the page instead of back to it.
const cutListing = (toolName: ListingTool, listing: Listing, callOffset: number): CappedText => {
    const itemsKey = Array.isArray(listing.matches) ? 'matches' : 'entries'
    const items = listing[itemsKey] ?? []
    // A cut listing stays one JSON object, so a script can parse it: the cut note goes in the `note`
    // field, after the secret filter's note when it set one, instead of ending the text on its own line.
    const withListingNote = (cutNote: string) => listing.note === undefined ? cutNote : `${listing.note} ${cutNote}`
    const noteForCut = (shownItems: number) =>
        `Output cut at ${CAP_TEXT} characters: ${shownItems} of ${items.length} results on this page shown. ` +
        `Continue with offset ${callOffset + shownItems}, or ${LISTING_NARROWING[toolName]}.`
    // Nothing on the page fits: a result is larger than the whole budget, so repeating the same offset
    // would return the same bytes. Point past this page and say to ask a narrower question instead.
    const noneShownNote =
        `Output cut at ${CAP_TEXT} characters: a result on this page is too large to show, ` +
        `so the page is skipped; ${LISTING_NARROWING[toolName]}.`
    // The note sits outside the items, so every item is measured beside the longest note the page can
    // hold: the one written when nothing fits, or the one naming the whole page.
    const noneShownFullNote = withListingNote(noneShownNote)
    const wholePageNote = withListingNote(noteForCut(items.length))
    const longestNote = noneShownFullNote.length >= wholePageNote.length ? noneShownFullNote : wholePageNote
    // Measuring the whole object keeps the note counted the way it is written inside the JSON.
    const overhead = JSON.stringify({
        ...listing,
        count: items.length,
        [itemsKey]: [],
        nextOffset: callOffset + items.length,
        note: longestNote,
    }).length
    const shownItems = itemsThatFit(items, TOOL_OUTPUT_CAP_CHARS - overhead, (item) => JSON.stringify(item).length, 1)
    const noneFit = shownItems === 0
    const cut: Listing = {
        ...listing,
        count: shownItems,
        // A page whose results all failed to fit must move past itself, or a script that follows `nextOffset` never ends.
        nextOffset: callOffset + (noneFit ? items.length : shownItems),
        note: withListingNote(noneFit ? noneShownNote : noteForCut(shownItems)),
    }
    cut[itemsKey] = items.slice(0, shownItems)
    const kept = JSON.stringify(cut)
    return { text: kept, keptChars: kept.length }
}

// A text result with no shape this file knows: a bare-text read is the whole file from line 1, so a
// line's number is its index plus one (a read with an `offset` answers with its JSON page instead).
// A first line too long for the budget is cut inside it, and the note names the byte it stops at.
const cutPlainText = (text: string): CappedText => {
    const lines = text.split('\n')
    // The note ends the text, so it comes out of the budget: fitting the lines under the longest note
    // this file can ask for keeps the real one under the cap too.
    const noteRoom = Math.max(
        readCutNote(lines.length, undefined).length,
        readCutNote(1, utf8ByteLength(lines[0])).length,
    )
    const budget = TOOL_OUTPUT_CAP_CHARS - noteRoom - 1
    const shownLines = itemsThatFit(lines, budget, (line) => line.length, 1)
    const kept = shownLines === 0 ? plainPrefixThatFits(lines[0], budget) : lines.slice(0, shownLines).join('\n')
    const note = shownLines === 0 ? readCutNote(1, utf8ByteLength(kept)) : readCutNote(shownLines, undefined)
    return { text: `${kept}\n${note}`, keptChars: kept.length }
}

// A script has no file lines to continue from, so its note says only what was left out and what to
// do instead: print less, or split the work into more scripts. `shownLines` 0 means the first line
// alone is over the cap and only its start is shown.
const scriptCutNote = (shownLines: number, totalLines: number) =>
    `Output cut at ${CAP_TEXT} characters ` +
    `(${shownLines === 0 ? `line 1 of ${totalLines} is cut` : `${shownLines} of ${totalLines} lines shown`}). ` +
    `Print less, or split the work into more scripts.`

// One script's output, cut to the cap: like a tool's answer it stays in the context for every later
// turn of the run, and it needs its own note because it has no lines in a file to continue from.
// Whole lines are kept from the head; a first line too long for the budget is cut inside it.
export const capScriptOutput = (text: string): string => {
    if (text.length <= TOOL_OUTPUT_CAP_CHARS) return text
    const lines = text.split('\n')
    // The note ends the text, so it comes out of the budget: fitting the lines under the longest note
    // this file can ask for keeps the real one under the cap too.
    const noteRoom = Math.max(scriptCutNote(0, lines.length).length, scriptCutNote(lines.length, lines.length).length)
    const budget = TOOL_OUTPUT_CAP_CHARS - noteRoom - 1
    const shownLines = itemsThatFit(lines, budget, (line) => line.length, 1)
    const kept = shownLines === 0 ? plainPrefixThatFits(lines[0], budget) : lines.slice(0, shownLines).join('\n')
    return `${kept}\n${scriptCutNote(shownLines, lines.length)}`
}

// One text result, cut to the cap. The shape the tool answered in is kept, so a cut listing is still a
// listing and a cut read still names its lines and bytes. Only a listing tool's answer is cut as one:
// a read of a JSON file that happens to hold `count` and `entries` is still a read. A read page is one
// only when the call was positioned or the tool cut it, so a file whose own text looks like a page keeps
// its words.
const cappedText = (toolName: string, text: string, args: unknown): CappedText => {
    let parsed: unknown
    try {
        parsed = JSON.parse(text)
    } catch {
        // Text that is not JSON takes the plain cut below.
        parsed = undefined
    }
    const call = (typeof args === 'object' && args !== null ? args : {}) as { offset?: unknown; byteOffset?: unknown }
    // The page the call asked for: a cut listing continues from its own offset plus what it shows.
    const callOffset = typeof call.offset === 'number' ? call.offset : 0
    const callWasPositioned = typeof call.offset === 'number' || typeof call.byteOffset === 'number'
    if (isListingTool(toolName) && isListing(parsed)) return cutListing(toolName, parsed, callOffset)
    if (toolName === 'read' && isReadPage(parsed) && (callWasPositioned || parsed.truncated === true)) return cutReadPage(parsed, call)
    return cutPlainText(text)
}

// Applies the cap to a whole result: text over the cap is cut, and an image block or a text block
// that fits is left byte for byte as the tool wrote it.
export const capOutput = (toolName: string, content: PiToolResultContent[], args: unknown) => {
    let cutChars = 0
    const capped = content.map((block) => {
        if (block.type !== 'text' || block.text.length <= TOOL_OUTPUT_CAP_CHARS) return block
        const cut = cappedText(toolName, block.text, args)
        cutChars += block.text.length - cut.keptChars
        return { ...block, text: cut.text }
    })
    return { content: capped, cutChars }
}
