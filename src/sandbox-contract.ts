import type { DirectoryBackupGatewayBinding } from '@cloudflare/sandbox'
import type { PrChanges } from './pi-agent'

// Shared types for the sandbox. Every caller reaches a thread's sandbox through `SandboxClient`,
// whether the sandbox runs in this Worker (a `SandboxDO` stub) or in the deployed sandbox Worker
// (`SandboxService`, every mode but production in `cloudflare.config.ts`).

/** What a run copies into its sandbox besides the repo archive `start` gets: the PR files on top. */
export type Sources = {
    prChanges: PrChanges | null
    /** The run these sources are for; its logs carry it. */
    runId: string
}

/** The repo's default branch as one ustar stream (`RepoDO.archive()`), handed over by the caller. */
export type StartRequest = { archive: ReadableStream<Uint8Array> }
/**
 * What a `start` did. `started` is true only when this call ran the start, never when it joined one
 * already in flight; `installMs` is the dependency install that start ran.
 */
export type StartResult = { started: boolean; installMs: number }

/**
 * A command's answer. `needs-start`: no container runs, so the caller fetches the archive, calls
 * `start` and asks again. The sandbox never fetches the code itself, so it needs no `RepoDO`.
 */
export type SandboxReply<T> = { kind: 'needs-start' } | { kind: 'done'; result: T }

export type ExecRequest = { command: string; cwd?: string; timeoutSeconds?: number }
export type ExecResult = { exitCode: number; stdout: string; stderr: string; truncated: boolean; ms: number }

export type ServerStartRequest = { command: string; port: number }
export type ServerStartResult = { started: boolean; log: string }

export type ServerRequestRequest = { port: number; path: string; method?: 'GET' | 'POST'; body?: string }
export type ServerResponse = { status: number; body: string; truncated: boolean }

/** Files to put into a running container's repo copy: the work branch's edits (batch 5 plan, 2.4). Paths are repo-relative. */
export type WriteFilesRequest = { files: { path: string; content: Uint8Array }[]; removedPaths: string[] }
export type WriteFilesResult = { written: number; removed: number }

/** Files to read back from the container's repo copy, for `sandbox_keep_changes`. Paths are repo-relative. */
export type ReadFilesRequest = { paths: string[]; maxBytes: number }
export type ReadFilesResult = { files: { path: string; content: Uint8Array }[]; missing: string[]; tooLarge: string[] }

/** One thread's sandbox, as `PiAgent` and the sandbox tools use it. */
export interface SandboxClient {
    setSources(sources: Sources): Promise<void>
    start(request: StartRequest): Promise<StartResult>
    exec(request: ExecRequest): Promise<SandboxReply<ExecResult>>
    serverStart(request: ServerStartRequest): Promise<SandboxReply<ServerStartResult>>
    serverRequest(request: ServerRequestRequest): Promise<SandboxReply<ServerResponse>>
    writeFiles(request: WriteFilesRequest): Promise<SandboxReply<WriteFilesResult>>
    readFiles(request: ReadFilesRequest): Promise<SandboxReply<ReadFilesResult>>
    shutdown(request: { reason: string }): Promise<void>
}

/** `SandboxService`'s RPC methods: each `SandboxClient` method with the thread's sandbox name first. */
export interface SandboxServiceMethods {
    setSources(sandboxName: string, sources: Sources): Promise<void>
    start(sandboxName: string, request: StartRequest): Promise<StartResult>
    exec(sandboxName: string, request: ExecRequest): Promise<SandboxReply<ExecResult>>
    serverStart(sandboxName: string, request: ServerStartRequest): Promise<SandboxReply<ServerStartResult>>
    serverRequest(sandboxName: string, request: ServerRequestRequest): Promise<SandboxReply<ServerResponse>>
    writeFiles(sandboxName: string, request: WriteFilesRequest): Promise<SandboxReply<WriteFilesResult>>
    readFiles(sandboxName: string, request: ReadFilesRequest): Promise<SandboxReply<ReadFilesResult>>
    shutdown(sandboxName: string, request: { reason: string }): Promise<void>
}

/** The binding `cloudflare.config.ts` sets outside production instead of `SANDBOX`. */
export const SANDBOX_SERVICE_BINDING = 'SANDBOX_SERVICE'

/** What `installDependencies` needs from the `SandboxDO` that calls it. */
export type InstallContext = {
    container: Container
    gateway: DirectoryBackupGatewayBinding
    bucket: R2Bucket
    repoDir: string
    /** The run the install is for, for its log lines. */
    runId: string
}
/** `cache` is `none` when the repo has no lockfile Benny knows. */
export type InstallResult = { manager: 'pnpm' | 'npm' | null; cache: 'hit' | 'miss' | 'none'; installMs: number }

/** Where the copy lands in the container. */
export const SANDBOX_REPO_DIR = '/workspace/repo'
/** Name of the R2 binding in `env` that holds the dependency stores (pnpm's and npm's), as `DirectoryBackup` reads it. */
export const CACHE_BUCKET_BINDING = 'DEPENDENCY_CACHE'
/** A run's sandbox stops after this long, whatever it is doing (requirements 28, 42). */
export const SANDBOX_RUN_LIMIT_MS = 30 * 60 * 1000
/** A container with no call for this long stops itself (requirement 10). */
export const SANDBOX_IDLE_MS = 5 * 60 * 1000
