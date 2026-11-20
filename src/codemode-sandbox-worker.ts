// The code mode sandbox Worker, `bobby-codemode-sandbox`: each script's QuickJS VM runs in a
// Durable Object of this Worker, never in `PiAgent`'s isolate, so a script that computes blocks
// this object instead of Benny (docs/learnings/code-mode.md, "Where scripts run"). The object
// keeps no state: it is a Durable Object only to get a thread of its own, and it never touches
// its storage. `cf dev` runs this Worker next to Benny (`vite.config.ts`); the deploy is
// `npm run codemode-sandbox:deploy`, before Benny's own.
import { CodemodeSandboxDurableObject } from '@earendil-works/pi-codemode/cloudflare'

/**
 * The remote end of `RemoteCodemodeSandbox`: runs one script's VM on this object's thread and
 * calls back into `PiAgent` for every tool call. It overrides nothing, so the package's limits
 * stand: 100,000 interrupt polls and 32 MiB of VM memory per script.
 */
export class CodemodeSandbox extends CodemodeSandboxDurableObject {}

// Reached only through the `CODEMODE_SANDBOX` binding: the Worker has no public route.
export default { fetch: () => new Response('Not found', { status: 404 }) }
