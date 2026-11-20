import type { ToolHookCall, ToolHooks } from '@earendil-works/pi-durable'
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode'
import { log, type LogIds } from './log'

// Caps on the work code mode scripts do in one run (plan section 2). A run's `maxTurns` bounds the
// model's steps, not the tool calls a script makes inside one step: without these caps, 50 scripts
// of 100 calls would be 5,000 `RepoDO` calls in one run. A script's CPU is not `PiAgent`'s: each
// script runs in its own `CODEMODE_SANDBOX` object (`src/codemode.ts`), so the script cap bounds a
// run's latency and cost, and the nested cap alone bounds the `RepoDO` work.
const MAX_CALLS_PER_SCRIPT = 100
const MAX_CALLS_PER_RUN = 300
const MAX_SCRIPTS_PER_RUN = 50

// Each text names the cap it hit. A nested call's text is what the script's `await tools.read(...)`
// rejects with, so the script can print it; a script's text is the tool error the model reads.
const CALLS_PER_SCRIPT_TEXT = `Tool call limit reached: at most ${MAX_CALLS_PER_SCRIPT} tool calls per script. Stop calling tools and print what you have.`
const CALLS_PER_RUN_TEXT = `Tool call limit reached: at most ${MAX_CALLS_PER_RUN} tool calls from scripts per run. Stop calling tools and print what you have.`
const SCRIPTS_PER_RUN_TEXT = `Script limit reached: at most ${MAX_SCRIPTS_PER_RUN} scripts per run. Answer with what you have.`

/** What a counted call is: a script, or one of the tool calls a script made. */
export type CodemodeCallKind = 'script' | 'nested'

/** A call the caps refuse: the cap it hit, and the text that call's caller reads. */
export type CodemodeRefusal = { cap: 'calls-per-script' | 'calls-per-run' | 'scripts-per-run'; block: string }

/**
 * The number the script's VM gave one of its tool calls, read from the call id `<script call id>/c<n>`
 * (the part after the last `/`: a script's own id may contain `/`), or `undefined` for an id of
 * another shape. Read from the id alone because the VM numbers a script's calls 1, 2, ... in the
 * order it makes them, and a replay makes the same calls with the same numbers: the per-script cap
 * then holds after a restart with no stored count.
 */
export const scriptCallNumber = (callId: string): number | undefined => {
    const callKey = callId.slice(callId.lastIndexOf('/') + 1)
    const match = /^c(\d+)$/.exec(callKey)
    return match ? Number(match[1]) : undefined
}

/**
 * What a call is for the caps, or `undefined` for one of the model's own calls. Those are never
 * counted or blocked: each is a visible step of the run, already bounded by its `maxTurns`, and only
 * the calls a script repeats inside one step need a cap.
 */
const codemodeCallKind = (call: ToolHookCall): CodemodeCallKind | undefined => {
    if (call.parent) return 'nested'
    // A script cannot call `codemode` (`callers: ['model']`), so a `codemode` call is the model's.
    return call.name === CODEMODE_TOOL_NAME ? 'script' : undefined
}

/**
 * The refusal for a call, or `undefined` when it passes. `runCount` is the run's total for this
 * call's kind, this call included, as `countCodemodeCall` returns it.
 */
export const codemodeCallRefusal = (call: ToolHookCall, runCount: number): CodemodeRefusal | undefined => {
    const kind = codemodeCallKind(call)
    if (kind === undefined) return undefined
    if (kind === 'script') {
        // Counted before it runs, so the 51st script is the first one refused.
        if (runCount > MAX_SCRIPTS_PER_RUN) return { cap: 'scripts-per-run', block: SCRIPTS_PER_RUN_TEXT }
        return undefined
    }
    const callNumber = scriptCallNumber(call.id)
    if (callNumber !== undefined && callNumber > MAX_CALLS_PER_SCRIPT) {
        return { cap: 'calls-per-script', block: CALLS_PER_SCRIPT_TEXT }
    }
    // Known gap the plan accepts: a replay counts a script's calls into the run again, so this cap
    // can arrive a little early. The per-script cap above reads the id, so it never moves.
    if (runCount > MAX_CALLS_PER_RUN) return { cap: 'calls-per-run', block: CALLS_PER_RUN_TEXT }
    return undefined
}

/** What the hook needs from `PiAgent`: the run's counters, and the ids its log line carries. */
export type CodemodeLimitOptions = {
    /** Adds one to the run's counter for `kind` and returns the new total, this call included. */
    countCodemodeCall: (kind: CodemodeCallKind) => number
    /** The run's ids, so one `runId` finds this line with the rest of the run's story. */
    logIds: () => LogIds
}

/**
 * The `beforeTool` hook of `ToolTask`, for `hook(ToolTask, ...)` in a code mode extension: counts a
 * script or a nested call, then blocks it when `codemodeCallRefusal` says a cap is hit. Every
 * decision is in that function; this only counts, asks, logs, and answers.
 */
export const codemodeLimitHooks = ({ countCodemodeCall, logIds }: CodemodeLimitOptions): Pick<ToolHooks, 'beforeTool'> => ({
    beforeTool: (call) => {
        const kind = codemodeCallKind(call)
        if (kind === undefined) return undefined
        const refusal = codemodeCallRefusal(call, countCodemodeCall(kind))
        if (refusal === undefined) return undefined
        log('codemode call limit', { cap: refusal.cap, callId: call.id, ...logIds() })
        return { block: refusal.block }
    },
})
