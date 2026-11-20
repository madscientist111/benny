import { SANDBOX_SERVICE_BINDING, type SandboxClient, type SandboxServiceMethods } from './sandbox-contract'
import type { SandboxDO } from './sandbox-do'

/**
 * One thread's sandbox. There are two ways to reach it, and `cloudflare.config.ts` is the switch:
 * `SANDBOX` (the `SandboxDO` stub, production and normal dev) or the `SANDBOX_SERVICE` binding
 * (the deployed sandbox Worker, `npm run dev:remote-sandbox`, for a machine whose local container
 * cannot start).
 */
export const sandboxClient = (env: Env, sandboxName: string): SandboxClient => {
    // `Env` types a binding to another Worker as a bare `Fetcher`, which carries no RPC methods,
    // so the cast names the methods `SandboxService` answers (the same fix as for a DO binding).
    const service = (env as unknown as { [SANDBOX_SERVICE_BINDING]?: SandboxServiceMethods })[SANDBOX_SERVICE_BINDING]
    if (service) {
        // One entrypoint serves every thread, so its methods take the sandbox name first; a
        // `SandboxDO` stub is already the thread's own object.
        return {
            setSources: (sources) => service.setSources(sandboxName, sources),
            start: (request) => service.start(sandboxName, request),
            exec: (request) => service.exec(sandboxName, request),
            serverStart: (request) => service.serverStart(sandboxName, request),
            serverRequest: (request) => service.serverRequest(sandboxName, request),
            writeFiles: (request) => service.writeFiles(sandboxName, request),
            readFiles: (request) => service.readFiles(sandboxName, request),
            shutdown: (request) => service.shutdown(sandboxName, request),
        }
    }
    const namespace = env.SANDBOX as unknown as DurableObjectNamespace<SandboxDO> | undefined
    // `SANDBOX` is the only way in when the service binding is absent, so having neither is a bug
    // in the config, not a state of this thread.
    if (!namespace) throw new Error(`No sandbox binding: the config sets neither SANDBOX nor ${SANDBOX_SERVICE_BINDING}`)
    // `SandboxDO` implements `SandboxClient`, so its stub is one: the cast only names the class,
    // which the generated binding type leaves out (docs/learnings/durable-objects.md).
    return namespace.getByName(sandboxName) as unknown as SandboxClient
}
