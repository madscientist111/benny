// The entry of the deployed `bobby-sandbox-dev` Worker, which serves `pnpm dev`: the same `SandboxDO` as Benny's own, without Benny's secrets.
import { WorkerEntrypoint } from 'cloudflare:workers'
import {
    type ExecRequest,
    type ExecResult,
    type SandboxReply,
    type SandboxServiceMethods,
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
import type { SandboxDO } from './sandbox-do'

export { SandboxDO } from './sandbox-do'
export { SandboxEgress } from './sandbox-egress'
// `DirectoryBackup` reaches R2 through this entrypoint, so the Worker must export it.
export { DirectoryBackupGateway } from '@cloudflare/sandbox'

/** The two bindings `sandbox/cloudflare.config.ts` gives this Worker. */
export type SandboxWorkerEnv = {
    /** One object per thread, named by the thread's `PiAgent` id. */
    SANDBOX: DurableObjectNamespace<SandboxDO>
    /** The pnpm and npm stores, keyed by lockfile hash. */
    DEPENDENCY_CACHE: R2Bucket
}

/** A thread's sandbox is named by its `PiAgent`'s Durable Object id: 64 hex characters, nothing else. */
const SANDBOX_NAME_PATTERN = /^[0-9a-f]{64}$/

/**
 * What Benny reaches in dev: each `SandboxClient` method with the thread's
 * sandbox name first. It only forwards; `SandboxDO` owns the container and does the work.
 */
export class SandboxService extends WorkerEntrypoint<SandboxWorkerEnv> implements SandboxServiceMethods {
    setSources(sandboxName: string, sources: Sources): Promise<void> {
        return this.#sandbox(sandboxName).setSources(sources)
    }

    start(sandboxName: string, request: StartRequest): Promise<StartResult> {
        return this.#sandbox(sandboxName).start(request)
    }

    exec(sandboxName: string, request: ExecRequest): Promise<SandboxReply<ExecResult>> {
        return this.#sandbox(sandboxName).exec(request)
    }

    serverStart(sandboxName: string, request: ServerStartRequest): Promise<SandboxReply<ServerStartResult>> {
        return this.#sandbox(sandboxName).serverStart(request)
    }

    serverRequest(sandboxName: string, request: ServerRequestRequest): Promise<SandboxReply<ServerResponse>> {
        return this.#sandbox(sandboxName).serverRequest(request)
    }

    writeFiles(sandboxName: string, request: WriteFilesRequest): Promise<SandboxReply<WriteFilesResult>> {
        return this.#sandbox(sandboxName).writeFiles(request)
    }

    readFiles(sandboxName: string, request: ReadFilesRequest): Promise<SandboxReply<ReadFilesResult>> {
        return this.#sandbox(sandboxName).readFiles(request)
    }

    shutdown(sandboxName: string, request: { reason: string }): Promise<void> {
        return this.#sandbox(sandboxName).shutdown(request)
    }

    /**
     * This thread's `SandboxDO` stub. `getByName` creates an object for any text it is given, so a
     * name that is not a Durable Object id string would quietly become a second, empty sandbox;
     * it is refused instead.
     */
    #sandbox(sandboxName: string): DurableObjectStub<SandboxDO> {
        if (!SANDBOX_NAME_PATTERN.test(sandboxName)) throw new Error(`Not a sandbox name: ${sandboxName}`)
        return this.env.SANDBOX.getByName(sandboxName)
    }
}

// Reached only through the service binding: the Worker has no public route.
export default { fetch: () => new Response('Not found', { status: 404 }) }
