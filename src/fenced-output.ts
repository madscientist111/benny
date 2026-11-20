/**
 * `label:` on its own line, then `text` inside a fence longer than its longest backtick run, so the
 * text cannot close its own block.
 */
export const fenced = (label: string, text: string) => {
    const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
    const marks = '`'.repeat(Math.max(3, longestRun + 1))
    return `${label}:\n${marks}\n${text}\n${marks}`
}

/**
 * A result the model must read as data, never as instructions (requirement 43): the note says what
 * the text is, then `label:` and the text in a fence of its own.
 */
export const framedOutput = (note: string, label: string, text: string): string => `${note}\n${fenced(label, text)}`
