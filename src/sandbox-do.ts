import { DurableObject } from 'cloudflare:workers'
import { Files } from '@cloudflare/sandbox'
import { log } from './log'
import { installDependencies } from './sandbox-cache'
import { registerEgress } from './sandbox-egress'
import {
    CACHE_BUCKET_BINDING,
    SANDBOX_IDLE_MS,
    SANDBOX_REPO_DIR,
    SANDBOX_RUN_LIMIT_MS,
    type ExecRequest,
    type ExecResult,
    type SandboxClient,
    type SandboxReply,
    type ServerRequestRequest,
    type ServerResponse,
    type ServerStartRequest,
    type ServerStartResult,
    type ReadFilesRequest,
    type ReadFilesResult,
    type Sources,
    type StartRequest,
    type StartResult,
    type WriteFilesRequest,
    type WriteFilesResult,
} from './sandbox-contract'
import { runCommand } from './sandbox-shell'
import { isSecretPath } from './secret-files'

// The thread's sandbox: `SandboxDO` owns one container per thread, copies the repo and the PR's
// files into it, and runs the model's commands and servers there. Callers reach it only through
// `SandboxClient` (`sandbox-client.ts`).

/** `exec` gives a command 2 minutes by default; a longer one has to ask, up to 10. */
const DEFAULT_TIMEOUT_SECONDS = 120
const MAX_TIMEOUT_SECONDS = 600
/** The copy is one tar extract and at most 300 PR files; a slow disk still beats this. */
const COPY_TIMEOUT_SECONDS = 300
/** `serverStart` polls the port for a minute, and every answer counts as started. */
const SERVER_START_WAIT_MS = 60 * 1000
const SERVER_START_POLL_MS = 1000
const SERVER_LOG_BYTES = 4096
/** A `serverRequest` answer is cut here; a stalled server gives up after 30 s. */
const SERVER_BODY_BYTES = 16 * 1024
const SERVER_REQUEST_TIMEOUT_MS = 30 * 1000

/** What the `sources` key holds; the PR files themselves are rows in `pr_files`, one per file. */
type StoredSources = { removedPaths: string[]; runId: string }

/**
 * A PR path is repo-relative. `/etc/passwd` and `../../etc/x` would leave the copy, so the copy
 * skips them the same way it skips a secret path.
 */
const isRepoRelativePath = (path: string) => !path.startsWith('/') && !path.split('/').includes('..')

/** `rm` removes the PR's paths 200 at a time; a bigger PR takes a second command. */
const REMOVED_PATHS_PER_COMMAND = 200

/** Puts a path in single quotes, so no byte in it can split the word or act as an option. */
const quoteShellWord = (word: string) => `'${word.replaceAll("'", "'\\''")}'`

/** Reads at most `capBytes` of a response body; `truncated` says the server sent more. */
const readResponseBody = async (response: Response, capBytes: number): Promise<{ body: string; truncated: boolean }> => {
    const reader = response.body?.getReader()
    if (!reader) return { body: '', truncated: false }
    const chunks: Uint8Array[] = []
    let keptBytes = 0
    let truncated = false
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (keptBytes + value.length > capBytes) {
            chunks.push(value.subarray(0, capBytes - keptBytes))
            keptBytes = capBytes
            truncated = true
            await reader.cancel()
            break
        }
        chunks.push(value)
        keptBytes += value.length
    }
    const bytes = new Uint8Array(keptBytes)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
    }
    return { body: new TextDecoder().decode(bytes), truncated }
}

// One object per thread, named by its `PiAgent` id. It owns the thread's container and starts it
// only with the code a caller hands over, so the first command of a run asks for that start
// (requirements 8, 10, 39). Every public method is an RPC endpoint; internals use `#`.
//
// It runs in two Workers, Benny's own and the deployed `bobby-sandbox-dev`
// (`sandbox/cloudflare.config.ts`, the `remote-sandbox` dev mode), so it may read only bindings
// both configs declare (`DEPENDENCY_CACHE`), never one only Benny has, such as `REPO`.
export class SandboxDO extends DurableObject<Env> implements SandboxClient {
    /**
     * The start in flight, so a `start` that lands meanwhile cancels its own archive instead of
     * starting the container a second time.
     */
    #starting: Promise<StartResult> | undefined

    /** The last command handed to the container: the next one waits for it, so none interleave. */
    #lastCommand: Promise<unknown> = Promise.resolve()

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        // One row per PR file, so a PR of many large files never has to fit in one storage value.
        ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS pr_files (path TEXT PRIMARY KEY, content TEXT NOT NULL)')
    }

    /** Stores what the next copy uses. Starts nothing. */
    async setSources(sources: Sources): Promise<void> {
        // A start in flight is copying the very rows this rewrite replaces, so it ends first.
        await this.#waitForStartInFlight()
        // `shutdown` is the only other place that clears the mark, and `PiAgent` only logs when it
        // fails, so one lost shutdown would refuse every command of this thread for good. A run past
        // its limit is over, so the next run's sources clear its mark. A mark under the limit belongs
        // to a run still going and stays, so this cannot open the 30-minute cap.
        const startedAt = await this.ctx.storage.get<number>('startedAt')
        if (startedAt !== undefined && Date.now() - startedAt > SANDBOX_RUN_LIMIT_MS) {
            // The container goes while the expired mark still refuses every command, so no command
            // can start a new one under this destroy, and the log keeps the run's real length.
            await this.ctx.storage.deleteAlarm()
            await this.#destroyContainer('expired run')
        }
        // The `sources` value names the run only; the files are the rows below, so it stays small
        // however big the PR is.
        const storedSources: StoredSources = {
            // The copy removes these from the branch copy, so they stay inside `/workspace/repo`.
            removedPaths: (sources.prChanges?.removedPaths ?? []).filter(isRepoRelativePath),
            // The run these sources are for: every line this object writes about them carries it.
            runId: sources.runId,
        }
        // `kv.put` is the synchronous form, so the value and the rows commit together or not at all.
        this.ctx.storage.transactionSync(() => {
            this.ctx.storage.kv.put('sources', storedSources)
            // Clear the mark with the sources, so the new copy never lands behind an expired mark.
            // The read is now, not the one above: a run that started in between wrote a fresh mark,
            // and that one stays.
            const currentStartedAt = this.ctx.storage.kv.get<number>('startedAt')
            if (currentStartedAt !== undefined && Date.now() - currentStartedAt > SANDBOX_RUN_LIMIT_MS) {
                this.ctx.storage.kv.delete('startedAt')
            }
            this.ctx.storage.sql.exec('DELETE FROM pr_files')
            for (const file of sources.prChanges?.files ?? []) {
                // A secret path is never stored, so the copy cannot write one by accident; a path
                // that leaves the repo is skipped the same way.
                if (isSecretPath(file.path) || !isRepoRelativePath(file.path)) continue
                this.ctx.storage.sql.exec('INSERT INTO pr_files (path, content) VALUES (?, ?)', file.path, file.content)
            }
        })
    }

    /**
     * Starts the container with the caller's archive: copies it, then the PR files from the last
     * `setSources`, then installs. Answers the start this call ran, and no start when the container
     * already ran or another call's start was in flight. An archive nothing needs is cancelled, so
     * the caller's `RepoDO` stops tarring.
     */
    async start({ archive }: StartRequest): Promise<StartResult> {
        // A run past its 30 minutes gets no start, as it gets no command. Nobody reads the archive
        // then, so it is cancelled and the caller's `RepoDO` stops tarring.
        try {
            await this.#refuseWhenOverRunLimit()
        } catch (error) {
            await this.#cancelArchive(archive)
            throw error
        }
        // The start in flight is this container's one start, and its archive is the copy in
        // progress: this call's code is not copied and this call ran no start of its own.
        if (this.#starting) {
            await this.#cancelArchive(archive)
            return { started: false, installMs: 0 }
        }
        if (this.#container().running) {
            await this.#cancelArchive(archive)
            return { started: false, installMs: 0 }
        }
        const promise = this.#startContainer(archive).finally(() => {
            // Cleared on success and on error, so a failed start is retried by the next `start`.
            this.#starting = undefined
        })
        this.#starting = promise
        return promise
    }

    async exec(request: ExecRequest): Promise<SandboxReply<ExecResult>> {
        return this.#enqueueCommand(async (): Promise<SandboxReply<ExecResult>> => {
            await this.#refuseWhenOverRunLimit()
            await this.#waitForStartInFlight()
            // A command never starts a container: it says so, and the caller's `start` copies the
            // code and installs before it asks again.
            if (!this.#container().running) return { kind: 'needs-start' }
            const result = await runCommand(this.#container(), request.command, {
                cwd: request.cwd ?? SANDBOX_REPO_DIR,
                timeoutSeconds: Math.max(1, Math.min(request.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)),
            })
            return { kind: 'done', result }
        })
    }

    async serverStart({ command, port }: ServerStartRequest): Promise<SandboxReply<ServerStartResult>> {
        this.#assertPort(port)
        return this.#enqueueCommand(async (): Promise<SandboxReply<ServerStartResult>> => {
            await this.#refuseWhenOverRunLimit()
            await this.#waitForStartInFlight()
            if (!this.#container().running) return { kind: 'needs-start' }
            const container = this.#container()
            const files = new Files(container)
            const serverDir = `/var/lib/servers/${port}`
            await files.mkdir(serverDir, { recursive: true })

            // The old server on this port runs in its own process group, named by the pid file.
            await runCommand(container, `if [ -s ${serverDir}/pid ]; then kill -TERM -"$(cat ${serverDir}/pid)" 2>/dev/null; fi; rm -f ${serverDir}/pid`, {
                cwd: SANDBOX_REPO_DIR,
                timeoutSeconds: 30,
            })
            // The command goes in a file, so model text never needs shell quoting.
            await files.writeFile(`${serverDir}/cmd.sh`, `${command}\n`)
            // `setsid` gives the server its own session, and the log file keeps it off the exec pipe,
            // so it outlives this call.
            await runCommand(container, `setsid bash ${serverDir}/cmd.sh > ${serverDir}/log 2>&1 & echo $! > ${serverDir}/pid`, {
                cwd: SANDBOX_REPO_DIR,
                timeoutSeconds: 30,
            })

            const pollUntil = Date.now() + SERVER_START_WAIT_MS
            let started = false
            while (Date.now() < pollUntil) {
                // Any HTTP answer means the server listens; only a refused connection means not yet.
                started = await container.getTcpPort(port).fetch('http://server/').then(() => true, () => false)
                if (started) break
                await new Promise((resolve) => setTimeout(resolve, SERVER_START_POLL_MS))
            }
            const serverLog = await runCommand(container, `tail -c ${SERVER_LOG_BYTES} ${serverDir}/log`, {
                cwd: SANDBOX_REPO_DIR,
                timeoutSeconds: 30,
            })
            return { kind: 'done', result: { started, log: serverLog.stdout } }
        })
    }

    async serverRequest({ port, path, method, body }: ServerRequestRequest): Promise<SandboxReply<ServerResponse>> {
        this.#assertPort(port)
        if (!path.startsWith('/')) throw new Error(`Path must start with /, not ${path}`)
        return this.#enqueueCommand(async (): Promise<SandboxReply<ServerResponse>> => {
            await this.#refuseWhenOverRunLimit()
            await this.#waitForStartInFlight()
            if (!this.#container().running) return { kind: 'needs-start' }
            const response = await this.#container().getTcpPort(port).fetch(`http://server${path}`, {
                method: method ?? 'GET',
                // A GET with a body is a TypeError in `fetch`, and the model often sends both.
                body: method === 'POST' ? body : undefined,
                signal: AbortSignal.timeout(SERVER_REQUEST_TIMEOUT_MS),
            })
            const answer = await readResponseBody(response, SERVER_BODY_BYTES)
            return { kind: 'done', result: { status: response.status, body: answer.body, truncated: answer.truncated } }
        })
    }

    /**
     * Puts the work branch's edits into the running container's repo copy, so a command runs the
     * code the model just wrote (batch 5 plan, 2.4). Without a container it answers `needs-start`:
     * the next start copies the whole branch anyway.
     */
    async writeFiles({ files: changedFiles, removedPaths }: WriteFilesRequest): Promise<SandboxReply<WriteFilesResult>> {
        return this.#enqueueCommand(async (): Promise<SandboxReply<WriteFilesResult>> => {
            await this.#refuseWhenOverRunLimit()
            await this.#waitForStartInFlight()
            if (!this.#container().running) return { kind: 'needs-start' }
            const container = this.#container()
            const files = new Files(container)
            // The paths come from the branch copy, but this writes into the container, so each is
            // checked again, as the PR files are: no path out of the repo, and no secret file.
            let written = 0
            for (const file of changedFiles) {
                if (!isRepoRelativePath(file.path) || isSecretPath(`${SANDBOX_REPO_DIR}/${file.path}`)) continue
                const target = `${SANDBOX_REPO_DIR}/${file.path}`
                await files.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
                await files.writeFile(target, file.content)
                written += 1
            }
            const removable = removedPaths.filter(isRepoRelativePath)
            for (let batchStart = 0; batchStart < removable.length; batchStart += REMOVED_PATHS_PER_COMMAND) {
                const batch = removable.slice(batchStart, batchStart + REMOVED_PATHS_PER_COMMAND)
                const remove = await runCommand(container, `rm -f -- ${batch.map(quoteShellWord).join(' ')}`, { cwd: SANDBOX_REPO_DIR, timeoutSeconds: COPY_TIMEOUT_SECONDS })
                if (remove.exitCode !== 0) throw new Error(`Removing the branch's deleted files failed (exit ${remove.exitCode}): ${remove.stderr.trim()}`)
            }
            return { kind: 'done', result: { written, removed: removable.length } }
        })
    }

    /**
     * Reads files a command changed in the container, for `sandbox_keep_changes`. Only the paths the
     * model names come back, so `node_modules` and build output never do; secret files and files over
     * `maxBytes` stay in the container.
     */
    async readFiles({ paths, maxBytes }: ReadFilesRequest): Promise<SandboxReply<ReadFilesResult>> {
        return this.#enqueueCommand(async (): Promise<SandboxReply<ReadFilesResult>> => {
            await this.#waitForStartInFlight()
            if (!this.#container().running) return { kind: 'needs-start' }
            const files = new Files(this.#container())
            const result: ReadFilesResult = { files: [], missing: [], tooLarge: [] }
            for (const path of paths) {
                const target = `${SANDBOX_REPO_DIR}/${path}`
                if (!isRepoRelativePath(path) || isSecretPath(target)) {
                    result.missing.push(path)
                    continue
                }
                // `lstat`, not `stat`: a link a command made could point out of the repo, so only a
                // plain file comes back, as `archive` takes only plain files.
                const stat = await files.lstat(target).catch(() => null)
                if (!stat || stat.type !== 'file') {
                    result.missing.push(path)
                    continue
                }
                if (stat.size > maxBytes) {
                    result.tooLarge.push(path)
                    continue
                }
                const response = await files.readFile(target)
                result.files.push({ path, content: new Uint8Array(await response.arrayBuffer()) })
            }
            return { kind: 'done', result }
        })
    }

    /** Destroys the container and clears the 30-minute mark. Safe to call when nothing runs. */
    async shutdown({ reason }: { reason: string }): Promise<void> {
        // A running command is not waited for, on purpose: a stop destroys the container under it.
        // A start in flight is still copying files into the container, so destroy it after that.
        await this.#starting?.catch(() => {})
        await this.#destroyContainer(reason)
        await this.ctx.storage.deleteAlarm()
        // Only the end of a run clears the mark, so the next run starts with its own 30 minutes.
        await this.ctx.storage.delete('startedAt')
    }

    async alarm(): Promise<void> {
        // The container goes, but `startedAt` stays: every command is refused until the run ends
        // and `shutdown` clears it, so the alarm cannot hand out a fresh 30 minutes.
        await this.#destroyContainer('run time limit')
    }

    /** The container this object owns. A missing one is a config error, not a runtime state. */
    #container(): Container {
        const container = this.ctx.container
        if (!container) throw new Error('SandboxDO has no container: the SandboxDO export needs `container` in the config')
        return container
    }

    /**
     * Runs `command` after the last one, because one container cannot run two commands at once. The
     * queue keeps a failed command's error from reaching the next one.
     */
    #enqueueCommand<T>(command: () => Promise<T>): Promise<T> {
        const result = this.#lastCommand.then(command)
        this.#lastCommand = result.catch(() => {})
        return result
    }

    /**
     * Waits for the start in flight. `container.running` is true from `start()` on, before the copy
     * and the install, so a command that read it then would run against a half-copied repo, and a
     * `setSources` would replace the very rows being copied.
     */
    async #waitForStartInFlight(): Promise<void> {
        // A failed start destroys the container, so the `running` check that follows this answers
        // `needs-start` and the caller starts again.
        await this.#starting?.catch(() => {})
    }

    /** Cancels an archive the start will not read. */
    async #cancelArchive(archive: ReadableStream<Uint8Array>): Promise<void> {
        // Best effort: `cancel()` rejects on a stream that already errored, and that error is not
        // this caller's news.
        await archive.cancel().catch(() => {})
    }

    /** Both server methods take a TCP port; anything else is a model mistake, not a state. */
    #assertPort(port: number): void {
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Port must be 1-65535, not ${port}`)
    }

    /** Destroys the running container and logs why; `startedAt` is the caller's to keep or clear. */
    async #destroyContainer(reason: string): Promise<void> {
        const startedAt = await this.ctx.storage.get<number>('startedAt')
        if (this.ctx.container?.running) await this.ctx.container.destroy()
        const ranMs = startedAt === undefined ? 0 : Date.now() - startedAt
        // `shutdown` clears `startedAt` but keeps the sources, so the line still names the run. Only
        // a `shutdown` that arrives before the first `setSources` finds none, and then no run to name.
        const sources = await this.ctx.storage.get<StoredSources>('sources')
        log('sandbox stopped', { runId: sources?.runId, reason, ranMs })
    }

    /**
     * The container's one start: registers the proxy, arms the run clock, copies the caller's
     * archive and the PR files in, then installs. Answers `started: true` and the install it ran.
     */
    async #startContainer(archive: ReadableStream<Uint8Array>): Promise<StartResult> {
        const container = this.#container()
        // Read before the container starts: every line about this start names its run, and the
        // egress proxy needs the id before the first request. A thread that never called
        // `setSources` fails here, before a container runs.
        const sources = await this.ctx.storage.get<StoredSources>('sources')
        if (!sources) throw new Error('No sources: the agent must call setSources first')
        const runId = sources.runId
        // The install saves its store here. Benny's `remote-sandbox` mode has no such binding,
        // because this object never runs there, so a missing one is a config error worth naming
        // before a container starts.
        const bucket = this.env.DEPENDENCY_CACHE
        if (!bucket) throw new Error(`SandboxDO has no ${CACHE_BUCKET_BINDING} binding: the dependency install needs its R2 bucket`)
        try {
            // The proxy has to be registered before the container starts, or its traffic is not
            // intercepted: there is no Internet, so it could not reach the registry at all.
            await registerEgress({ container, egress: this.ctx.exports.SandboxEgress({ props: { runId } }) })
            container.start({
                image: container.images.workspace,
                instance: 'standard-2',
                // Requirement 41: the only way out is the registry proxy, which `registerEgress` wires.
                enableInternet: false,
                // `Files` and `pnpm` need the platform CA that only exists at runtime, and `exec`
                // processes do not inherit the image's ENV, so the trust happens here and
                // `/etc/profile.d/10-benny-ca.sh` carries `NODE_EXTRA_CA_CERTS`.
                entrypoint: ['bash', '-c', 'cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt && update-ca-certificates >/dev/null; exec sleep infinity'],
            })
            // `start()` says nothing when the start fails, and the first command's error does not
            // name the cause; only `monitor()` reports it. Never awaited: it settles when the
            // container exits, which is after this start returns.
            container
                .monitor()
                .then(() => log('sandbox container exited', { runId }))
                .catch((error) => log('sandbox container exited', { runId, error: String(error) }))
            await container.setInactivityTimeout(SANDBOX_IDLE_MS)
            // The mark belongs to the run, which starts with its first start attempt: a retry after
            // a failed start finds the mark and keeps it, so starts that keep failing cannot push
            // the end of the run out. The alarm is armed with the mark, once.
            if ((await this.ctx.storage.get<number>('startedAt')) === undefined) {
                const startedAt = Date.now()
                await this.ctx.storage.put('startedAt', startedAt)
                await this.ctx.storage.setAlarm(startedAt + SANDBOX_RUN_LIMIT_MS)
            }

            const copyStartedAt = Date.now()
            await this.#copySources(container, archive, sources)
            const copyMs = Date.now() - copyStartedAt
            const install = await installDependencies({
                container,
                gateway: this.ctx.exports.DirectoryBackupGateway,
                bucket,
                repoDir: SANDBOX_REPO_DIR,
                runId,
            })
            log('sandbox started', {
                runId,
                copyMs,
                installMs: install.installMs,
                cache: install.cache,
                manager: install.manager,
            })
            return { started: true, installMs: install.installMs }
        } catch (error) {
            // Half a copy or a failed install leaves a state nobody can reason about: destroy it
            // and let the next start take a clean container. The mark and the alarm stay as they
            // are: the run did start, so its clock keeps running and the retry gets no fresh 30
            // minutes.
            log('sandbox start failed', { runId, error: String(error) })
            await container.destroy(error).catch(() => {})
            throw error
        }
    }

    /** Copies the caller's archive, then the PR's removals and its files, from the given sources. */
    async #copySources(container: Container, archive: ReadableStream<Uint8Array>, sources: StoredSources): Promise<void> {
        const files = new Files(container)
        // Written straight through from the `RepoDO` that tars the branch, so the archive never
        // has to fit in this object's memory.
        await files.writeFile('/tmp/src.tar', archive)
        const extract = await runCommand(container, `mkdir -p ${SANDBOX_REPO_DIR} && tar -xf /tmp/src.tar -C ${SANDBOX_REPO_DIR} && rm /tmp/src.tar`, {
            cwd: '/',
            timeoutSeconds: COPY_TIMEOUT_SECONDS,
        })
        if (extract.exitCode !== 0) throw new Error(`Copying the repo failed (exit ${extract.exitCode}): ${extract.stderr.trim()}`)

        // A file the PR deletes or renames is still in the branch copy, so it goes before the PR
        // versions land on top. A path the branch does not have is not an error. An entry stored
        // before PR removals existed has no list, so it removes nothing. The remove is destructive,
        // so every path is checked here again, not only when it was stored.
        const removedPaths = (sources.removedPaths ?? []).filter(isRepoRelativePath)
        for (let batchStart = 0; batchStart < removedPaths.length; batchStart += REMOVED_PATHS_PER_COMMAND) {
            const batch = removedPaths.slice(batchStart, batchStart + REMOVED_PATHS_PER_COMMAND)
            const remove = await runCommand(container, `rm -rf -- ${batch.map(quoteShellWord).join(' ')}`, {
                cwd: SANDBOX_REPO_DIR,
                timeoutSeconds: COPY_TIMEOUT_SECONDS,
            })
            if (remove.exitCode !== 0) throw new Error(`Removing the PR's deleted files failed (exit ${remove.exitCode}): ${remove.stderr.trim()}`)
        }

        // The PR head's files land on top of the branch copy. Nothing copied here goes back:
        // the sandbox is a scratch runner. The cursor hands over one row at a time, so the PR's
        // files are never held in memory together.
        const prFiles = this.ctx.storage.sql.exec<{ path: string; content: string }>('SELECT path, content FROM pr_files')
        for (const file of prFiles) {
            const target = `${SANDBOX_REPO_DIR}/${file.path}`
            await files.mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true })
            await files.writeFile(target, file.content)
        }
    }

    /**
     * The 30-minute alarm destroys the container and leaves `startedAt`; this keeps a command from
     * starting a new one, until the run ends and `shutdown` clears the mark.
     */
    async #refuseWhenOverRunLimit(): Promise<void> {
        const startedAt = await this.ctx.storage.get<number>('startedAt')
        if (startedAt === undefined || Date.now() - startedAt <= SANDBOX_RUN_LIMIT_MS) return
        throw new Error('The sandbox reached its 30-minute limit: stop running things and report what you have')
    }
}
