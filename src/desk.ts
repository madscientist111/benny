// The Desk's cards, built by plain code from GitHub search results (no model call): which lane an
// issue or PR goes in, its title and body text, and its age in words. `desk-list.ts` calls it. Pure,
// so `tests/desk.test.ts` runs it in Node without the Worker runtime.

export type DeskLane = 'needs_you' | 'fyi' | 'done'

/** One issue or PR from a search, with only the facts the lane depends on. */
export type DeskItem = {
    url: string
    /** `owner/repo`. */
    repo: string
    number: number
    isPullRequest: boolean
    isOpen: boolean
    isDraft: boolean
    /** Benny opened it (`bobby-sb[bot]`). */
    byBenny: boolean
    /** It carries the waiting mark's `input-required` label (`docs/input-required/plan.md`). */
    hasWaitingMark: boolean
    /** The title without the waiting mark's prefix. */
    title: string
    body: string
    updatedAt: number
    mergedAt: number | null
}

export type DeskCard = {
    lane: DeskLane
    title: string
    /** Why the card is here, in a few words, such as "Waits for your review". */
    why: string
    /** The issue or PR body as plain text. */
    body: string
    repo: string
    number: number
    url: string
    /** When the card's event happened: the merge for Done, the last update otherwise. */
    at: number
    /** `at` in words, such as "3 h ago". */
    age: string
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
/** FYI lists threads Benny answered in the last three days, and all of Benny's open drafts. */
export const FYI_DAYS = 3
/** Done lists Benny's PRs merged in the last seven days. */
export const DONE_DAYS = 7
const MAX_TITLE_CHARS = 110
const MAX_BODY_CHARS = 700

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/**
 * Markdown down to one plain line: no images, link targets, HTML comments or tags, heading, quote
 * and list markers, `**` or backticks. `#` and `_` stay inside a line, since `#12` and `public_read`
 * are what an issue or PR body names.
 */
export const plain = (markdown: string) =>
    markdown
        .replace(/<!--[\s\S]*?-->/g, '')
        // A tag has no attributes or `name=value` ones, so `a<b and c>d` stays.
        // A tag becomes a space, so `one<br>two` stays two words.
        .replace(/<\/?[a-z][a-z0-9-]*(\s+([\w:-]+=("[^"]*"|'[^']*'|[^\s>"']+)|open|hidden))*\s*\/?>/gi, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/^[ \t]*(#{1,6}|>+|[-*+•]|\d+\.)[ \t]+/gm, '')
        .replace(/__(\S(?:.*?\S)?)__/g, '$1')
        .replace(/\*\*|`/g, '')
        .replace(/\s+/g, ' ')
        .trim()

/** The first sentence (or line) of a text, as a card's title. */
export const titleOf = (markdown: string) => {
    const firstLine = markdown.split('\n').map(plain).find(Boolean) ?? ''
    // The period of `e.g.` or `i.e.` is not a sentence end; `!` and `?` always are.
    const sentence = /^(.*?(?:(?<!\b(?:e\.g|i\.e))\.|[!?]))(\s|$)/.exec(firstLine)?.[1] ?? firstLine
    return clip(sentence.replace(/[:.]$/, ''), MAX_TITLE_CHARS)
}

/** How long ago `at` was: "just now", "12 min ago", "3 h ago", "2 d ago", then the date. */
export const ageText = (at: number, now: number) => {
    const elapsed = Math.max(0, now - at)
    if (elapsed < 60_000) return 'just now'
    if (elapsed < HOUR_MS) return `${Math.floor(elapsed / 60_000)} min ago`
    if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`
    if (elapsed < 14 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)} d ago`
    // An old card from an earlier year needs the year, or `1 Nov` could be a year ago.
    const year = new Date(at).getUTCFullYear() === new Date(now).getUTCFullYear() ? undefined : 'numeric'
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year, timeZone: 'UTC' }).format(new Date(at))
}

/** The lane an item goes in and why, from what the work is. Null: it gets no card. */
export const laneOf = (item: DeskItem, now: number): { lane: DeskLane; why: string } | null => {
    if (item.isOpen && item.hasWaitingMark) {
        // The mark also means a question or a paused run, so only Benny's ready PR waits for a review.
        const waitsForReview = item.isPullRequest && item.byBenny && !item.isDraft
        return { lane: 'needs_you', why: waitsForReview ? 'Waits for your review' : 'Waits for your reply' }
    }
    if (item.isPullRequest && item.byBenny) {
        if (item.isOpen && !item.isDraft) return { lane: 'needs_you', why: 'Waits for your review' }
        // Every open draft, however old: a stalled draft is the one that needs noticing.
        if (item.isOpen) return { lane: 'fyi', why: 'Draft in progress' }
        if (item.mergedAt !== null && now - item.mergedAt < DONE_DAYS * DAY_MS) return { lane: 'done', why: 'Merged' }
        return null
    }
    if (item.isOpen && now - item.updatedAt < FYI_DAYS * DAY_MS) return { lane: 'fyi', why: 'Benny replied' }
    return null
}

/** The Desk's cards from every search's items: one card per issue or PR, newest first. */
export const deskCards = (items: DeskItem[], now: number): DeskCard[] => {
    const seen = new Set<string>()
    const cards: DeskCard[] = []
    for (const item of items) {
        if (seen.has(item.url)) continue
        seen.add(item.url)
        const placed = laneOf(item, now)
        if (!placed) continue
        const at = placed.lane === 'done' && item.mergedAt !== null ? item.mergedAt : item.updatedAt
        cards.push({
            lane: placed.lane,
            title: titleOf(item.title),
            why: placed.why,
            body: clip(plain(item.body), MAX_BODY_CHARS),
            repo: item.repo,
            number: item.number,
            url: item.url,
            at,
            age: ageText(at, now),
        })
    }
    return cards.sort((first, second) => second.at - first.at)
}
