// What `PiAgent` needs from the harness that runs the model for its thread, so the harness can be
// pi-durable (`PiRun`) or Claude Code (`ClaudeCodeRun`). `harness.ts` builds one from `HARNESS`.
// No pi type crosses this contract: a request is a prompt string, a result is text and a reason.

/**
 * How one submitted request ended. `done`: answered, with the run's final text. `unanswered`:
 * failed, aborted or withdrawn; `reason` says why, and `'turn_limit'` means the run used every
 * tool round it may take, so `PiAgent` asks for a summary answer.
 */
export type RunResult = {
    status: 'done' | 'unanswered'
    reason?: string
    text?: string
}

/**
 * What the messages after one point of the conversation used, for a reply's footnote. A turn is
 * one model answer, and each turn sends the whole context again: `tokensIn` adds every turn's
 * input (cached tokens included, `cachedTokensIn` is that part), `peakContextTokens` is the
 * largest one turn sent. `toolCalls` counts every call the model made, refused ones too, and
 * `webSearches` / `webFetches` the calls to those two tools. The sandbox fields count the calls
 * that reached the thread's sandbox: `sandboxWallMs` the wall time it was in use, overlaps once.
 * `costUsd` is the list-price cost a harness reports (Claude Code's result event); pi leaves it out.
 * `claudeCodeTasks` and `claudeCodeCostUsd` count pi's `claude_code` tool calls that ran a task, and
 * those tasks' list-price cost; Claude Code as the harness leaves them 0.
 */
export type RunUsage = {
    tokensIn: number; cachedTokensIn: number; tokensOut: number; toolCalls: number
    turns: number; peakContextTokens: number
    webSearches: number; webFetches: number
    sandboxCalls: number; sandboxWallMs: number; sandboxStarts: number; sandboxInstallMs: number
    claudeCodeTasks: number; claudeCodeCostUsd: number
    costUsd?: number
}

/**
 * The thread's harness. A *run* is the model's work; several requests can share one, and each
 * submitted request has an `operationId` to wait on. Every method is durable: after an eviction,
 * `wait` on an id submitted before still settles.
 */
export type Harness = {
    /** Messages in the thread's conversation so far; a footnote counts only those after a request's count. */
    messageCount(): Promise<number>
    /**
     * Submits one request: it joins the running run in one step that cannot race the run's end,
     * or, when the thread is idle, starts a run of its own. `joined` says which happened.
     */
    submit(prompt: string): Promise<{ operationId: string; joined: boolean }>
    /** Starts a run of its own; throws, and keeps nothing, while another run is working. */
    startRunWhenIdle(prompt: string): Promise<{ operationId: string }>
    /** Waits until the request settles; for one that already did, answers at once. */
    wait(operationId: string): Promise<RunResult>
    /** Aborts one request (withdraws it if queued), or, with no id, every running and queued one. */
    abort(operationId?: string): Promise<void>
    /** The tools the model is not offered from now on, by name; an empty list offers every tool. */
    hideTools(toolNames: readonly string[]): Promise<void>
    /** What the messages after the first `messageCountBefore` used. */
    usageSince(messageCountBefore: number): Promise<RunUsage>
}
