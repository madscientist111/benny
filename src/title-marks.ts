// Title marks: the prefixes Benny puts at the start of an issue or PR title, the waiting mark's
// (`input-required.ts`) and the scheduled mark's (`scheduled-mark.ts`). Both files and `bot.ts` call
// these; it imports nothing, so it adds no import cycle and is tested under plain Node.

export const INPUT_REQUIRED_PREFIX = '[INPUT_REQUIRED] '
export const SCHEDULED_PREFIX = '[SCHEDULED] '

/** Every mark's prefix, in the order a title shows them when it has more than one. */
const PREFIXES_IN_ORDER = [INPUT_REQUIRED_PREFIX, SCHEDULED_PREFIX]

type TitlePrefix = typeof INPUT_REQUIRED_PREFIX | typeof SCHEDULED_PREFIX

/** Splits the marks off the start of the title, in whatever order and however often they appear. */
const splitMarks = (title: string) => {
    const prefixesFound = new Set<string>()
    let bareTitle = title
    while (true) {
        const leadingPrefix = PREFIXES_IN_ORDER.find((prefix) => bareTitle.startsWith(prefix))
        if (!leadingPrefix) break
        prefixesFound.add(leadingPrefix)
        bareTitle = bareTitle.slice(leadingPrefix.length)
    }
    return { prefixesFound, bareTitle }
}

/** The title with each kept prefix once, in the fixed order, before the bare title. */
const joinMarks = (prefixesKept: Set<string>, bareTitle: string) =>
    PREFIXES_IN_ORDER.filter((prefix) => prefixesKept.has(prefix)).join('') + bareTitle

/** The title with `prefix` added; the other mark's prefix stays. */
export const withTitleMark = (title: string, prefix: TitlePrefix) => {
    const { prefixesFound, bareTitle } = splitMarks(title)
    return joinMarks(prefixesFound.add(prefix), bareTitle)
}

/** The title with `prefix` taken off; the other mark's prefix stays. */
export const withoutTitleMark = (title: string, prefix: TitlePrefix) => {
    const { prefixesFound, bareTitle } = splitMarks(title)
    prefixesFound.delete(prefix)
    return joinMarks(prefixesFound, bareTitle)
}

/** The title with no mark: what the decision model and the replies talk about. */
export const withoutTitleMarks = (title: string) => splitMarks(title).bareTitle
