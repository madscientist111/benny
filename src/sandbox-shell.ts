// Runs one shell command in a container with a time limit and capped output. Shared by
// `SandboxDO` (the model's commands) and `installDependencies` (the install steps).

export type CommandOptions = {
    cwd?: string
    timeoutSeconds: number
    /** Bytes of stdout kept: three quarters from the start, one quarter from the end. Default 8 KiB. */
    stdoutBytes?: number
    /** Same for stderr. Default 4 KiB. */
    stderrBytes?: number
}
/** `exitCode` 124 means the time limit killed the command. */
export type CommandResult = { exitCode: number; stdout: string; stderr: string; truncated: boolean; ms: number }

const DEFAULT_STDOUT_BYTES = 8 * 1024
const DEFAULT_STDERR_BYTES = 4 * 1024
/** Three quarters of a cap come from the start of the stream, the last quarter from its end. */
const HEAD_SHARE = 3 / 4
/** `timeout --kill-after=5` needs 5 s to kill, and the abort waits 15 s more before it fires. */
const ABORT_GRACE_SECONDS = 20

export type CappedText = { text: string; truncated: boolean }

const concatBytes = (chunks: Uint8Array[], totalBytes: number) => {
    const bytes = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
    }
    return bytes
}

/**
 * Reads a stream to its end, keeping the first three quarters of `capBytes` and the last
 * quarter. The bytes in between are counted, never held: a command can print gigabytes. Also
 * reads the agent runner's stderr (`agent-do.ts`).
 */
export const readCappedText = async (stream: ReadableStream<Uint8Array> | null, capBytes: number): Promise<CappedText> => {
    if (!stream) return { text: '', truncated: false }
    const headCap = Math.floor(capBytes * HEAD_SHARE)
    const tailCap = capBytes - headCap
    const headChunks: Uint8Array[] = []
    let headBytes = 0
    const tailChunks: Uint8Array[] = []
    let tailBytes = 0
    let cutBytes = 0

    for await (const chunk of stream) {
        let rest = chunk
        const headRoom = headCap - headBytes
        if (headRoom > 0) {
            const taken = rest.subarray(0, headRoom)
            headChunks.push(taken)
            headBytes += taken.length
            rest = rest.subarray(taken.length)
            if (rest.length === 0) continue
        }
        // The tail is a window over the end of the stream: its oldest bytes fall out first.
        tailChunks.push(rest)
        tailBytes += rest.length
        while (tailBytes > tailCap) {
            const excess = tailBytes - tailCap
            const oldest = tailChunks[0]
            if (oldest.length <= excess) {
                tailChunks.shift()
                tailBytes -= oldest.length
                cutBytes += oldest.length
            } else {
                tailChunks[0] = oldest.subarray(excess)
                tailBytes -= excess
                cutBytes += excess
            }
        }
    }

    const decoder = new TextDecoder()
    const head = decoder.decode(concatBytes(headChunks, headBytes))
    const cut = cutBytes > 0 ? `\n…[${cutBytes} bytes cut]…\n` : ''
    const tail = decoder.decode(concatBytes(tailChunks, tailBytes))
    return { text: head + cut + tail, truncated: cutBytes > 0 }
}

/**
 * Runs `command` with `bash -lc` (exec does not inherit the image's `ENV`; the login shell reads
 * `/etc/profile.d`), under `timeout`, and returns capped stdout and stderr.
 */
export const runCommand = async (container: Container, command: string, options: CommandOptions): Promise<CommandResult> => {
    const startedAt = Date.now()
    const controller = new AbortController()
    const execProcess = await container.exec(
        ['timeout', '--kill-after=5', String(options.timeoutSeconds), 'bash', '-lc', command],
        { cwd: options.cwd, env: { CI: '1' }, stdout: 'pipe', stderr: 'pipe', signal: controller.signal },
    )

    let exited = false
    const exitCode = execProcess.exitCode.finally(() => {
        exited = true
    })
    // `exec()` has no timeout of its own: `timeout` ends the command, and this abort is the last
    // resort. It must not fire after the exit, which logs a runtime error.
    const abortTimer = setTimeout(() => {
        if (!exited) controller.abort()
    }, (options.timeoutSeconds + ABORT_GRACE_SECONDS) * 1000)

    try {
        const [code, stdout, stderr] = await Promise.all([
            exitCode,
            readCappedText(execProcess.stdout, options.stdoutBytes ?? DEFAULT_STDOUT_BYTES),
            readCappedText(execProcess.stderr, options.stderrBytes ?? DEFAULT_STDERR_BYTES),
        ])
        return {
            exitCode: code,
            stdout: stdout.text,
            stderr: stderr.text,
            truncated: stdout.truncated || stderr.truncated,
            ms: Date.now() - startedAt,
        }
    } finally {
        clearTimeout(abortTimer)
    }
}
