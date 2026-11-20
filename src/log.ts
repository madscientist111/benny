import { env } from 'cloudflare:workers'

/**
 * The ids that tie a log line to GitHub. A *request* is one comment asking Benny: `requestId` is
 * that comment's id, the same value the code keeps as `requestMessageId` (a stored field, so not
 * renamed). A *run* is the model's work, which several requests can share: `runId` is the
 * `requestId` of the request that started it. `deliveryId` is GitHub's `x-github-delivery` id,
 * for webhook work that has no request (a push).
 */
export type LogIds = { requestId?: string; runId?: string; deliveryId?: string }

// Fields that hold private text: `args` holds tool arguments (file content, comment bodies) and
// `state` the thread's comments for the decision model. Production logs leave Cloudflare
// (`logpush`), so these are written only where `.dev.vars` sets `ENVIRONMENT=development`.
const PRIVATE_FIELDS = ['args', 'state']

/**
 * Writes one log line as one JSON object, so Workers Logs can filter on every field
 * (`requestId = 6921062300`) and a local `grep` still finds the whole line.
 */
export const log = (message: string, fields: Record<string, unknown> = {}): void => {
    // The generated type is the config's literal `'production'`; `.dev.vars` changes it at run time.
    const keptFields = (env.ENVIRONMENT as string) === 'development'
        ? fields
        : Object.fromEntries(Object.entries(fields).filter(([name]) => !PRIVATE_FIELDS.includes(name)))
    let line: string
    try {
        // The label goes last, so a field named `message` cannot replace it.
        line = JSON.stringify({ ...keptFields, message })
    } catch (error) {
        // A circular or BigInt field throws here, and `request started` is logged where nothing
        // may throw: the line without the fields still tells the story.
        line = JSON.stringify({ logError: String(error), message })
    }
    console.log(line)
}
