# Benny

A coding agent in GitHub issues, on Cloudflare Workers. A mention starts a request in the
thread's own `PiAgent` Durable Object; a comment without a mention goes to the decision model,
which picks ignore, react or reply. The rules below apply to anyone changing the code, person
or agent.

- **Subscriptions are the gate for `PiAgent`.** Any call to a DO stub (`getAgentByName`, RPC)
  wakes the object and bills duration. The first mention calls `thread.subscribe()`; after that
  every message in the thread reaches `onSubscribedMessage`, and unsubscribed threads never
  touch a `PiAgent`.
- **All bot state lives in `ChatStateDO`** (`chat-state-cloudflare-do`, one shared object):
  SDK subscriptions, locks and dedupe, thread state (`{ title }`), and the decision model's
  message window (`src/thread-window.ts`). Values round-trip as JSON: store timestamps as
  numbers, never `Date`.
- **Decision model** (ignore / react / reply): before changing any question, state field, or
  threshold in `src/jev/`, read `docs/decision-model/`. After the change run `pnpm test` and
  `pnpm probe:decisions --runs 2 --record`, and commit `scripts/probe-baseline.json` (CI's
  `probe:check` fails without it). Record new lessons in `docs/decision-model/tuning-lessons.md`.
- **Names say what they hold**, scripts included: `answers`, not `a`; `twoDecimals`, not `f`.
  When a short name can't be avoided, add a comment saying what it is.
- **One word per thing, and names that describe.** Pick one word for each idea and use it in
  names, comments, logs and user text: a *request* is one comment asking Benny; a *run* is the
  model's work, which several requests can share; a *work branch* is the branch Benny commits to
  for a thread, and its *branch copy* is that branch's files in a `BranchDO` (GitHub holds the
  history). A name says what the code does to what:
  `#updatePendingRequests`, not `#changeRuns`; `#waitForAnswerAndReport`, not `#settle`.
- **Every function earns its name:** it is called from two or more places, or it names a step
  that is hard to read inline. Otherwise write the code where it is used. Logging, a renamed
  argument, or a `try`/`catch` goes inside the function it belongs to, not in a wrapper around it.
- **A file says what it is for.** A source file over about 50 lines opens, below its imports, with
  a two- or three-line comment: what the file owns, who calls it, and the one fact its name does
  not give. The names of what it holds stay in the code.
- **A linked public repo is read-only and bounded:** `public_import` reads only a link this run's
  `web_search` or the requester's own comment gave (`linkSource`, the `web_fetch` ledger), with no
  token, at 250 MB and 30,000 files, and at most 4 per thread. Its copy lives in its own `RepoDO`
  (`public:<owner>/<repo>`), and the thread's repo stays primary for every branch tool and PR.
- **A read of another repo needs every requester to be a member of it** (`readRepo` in
  `src/github/github-tools.ts`), and never reads a private repo from a public thread's repo: the reply is
  public, so it must not hold private content.
- **GitHub writes are gated:** a GitHub write or branch tool runs only when every pending request
  of the run is a mention from a member with write access (`#runMayWrite`), and only on the
  thread's repo. Benny opens PRs and never merges, approves or closes one.
- **Durable Object internals use `#`**, not TypeScript `private`: `private` methods are public at
  runtime, so any stub can call them over RPC. Every public method on a DO is an RPC endpoint.
- **Logs are one JSON object per line:** `log('label', { ...fields })` from `src/log.ts`, never
  `console.log`. A line about a request carries `requestId` (the GitHub comment id); a line about
  a run carries `runId` (the `requestId` that started it), so one id finds a request's whole story;
  a line about a push carries `deliveryId`, because a push has no request.
- **PR descriptions and explanations** for people follow `.claude/skills/writing-explanations/SKILL.md`.
- **Effort is counted in tasks, never in days or hours** (full steps and report format:
  `.claude/skills/effort-plan/SKILL.md`). Read the docs of what the work touches first, then split it into tasks
  that can each be checked on their own, splitting again as you learn. Sort each task: a *copy* task
  has a doc or example and its mistake fails loudly; a *find-out* task has no doc, but one run
  answers it, and may turn into a design task; a *design* task has no example and needs a person's
  decision, then a live test. A mistake that stays silent first needs a check that makes it loud:
  that check is a task.
  - **Undo:** mark every design decision easy or hard to undo. Hard means stored data, production,
    or something public.
  - **Only a person:** list accounts, secrets and servers on their own, each with the tasks it blocks.
  - **Report** the counts, the order with its wait points, and which check covers the work
    (`pnpm test`, `pnpm verify`) or is missing.
- **Learnings:** `docs/learnings/` holds project-wide gotchas, one page per topic (Durable
  Objects, chat SDK, D1 / cf CLI, models). Read the matching page before working in that area;
  when you hit a new non-obvious lesson, add it there (format: `docs/index.md`) and tell the user.
