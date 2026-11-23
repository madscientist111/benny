// Live eval of the decision model: sends each case with the real question set and state from
// src/jev/ and prints every answer next to the action decide() takes, then the stop cases, then
// whether each posted reply waits for the requester (replyWaits()). CI
// runs it only when the decision model changes (.github/workflows/decision-eval.yml); every PR
// runs the free `--check`, which fails when the recorded baseline no longer matches the code.
//
// Made-up cases are below; real ones, copied from `state` / `decision` log lines and labeled by
// hand, are in scripts/probe-cases/real.json; my-style.json holds the owner's style, clear to vague;
// replies.json holds Benny's real replies with the request each answered, labeled wait or done.
// Those files hold private issue text, so the public copy of the repo leaves the folder and the
// baseline out: there the probe runs the made-up cases alone and `--check` has nothing to check.
//
// Usage: pnpm probe:decisions [--runs N] [--gate | --record | --check] [--out dir]
//   --gate    exit 1 when the lowest run scores under the baseline minimums, or any must-pass
//             case misses in any run
//   --record  gate, then write scripts/probe-baseline.json (scores, inputs hash, commit)
//   --check   no model calls: exit 1 when the inputs changed since the baseline was recorded
// Needs OPENROUTER_KEY. PROBE_MODEL=clef-flash sends to Workers AI instead, for comparison, and
// PROBE_SPLIT=1 sends each question in its own request.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { REPLY_WAITS_YES, STOP_YES, questions, replyWaitQuestions, stopQuestions } from '../src/jev/questions.ts'
import { ABOUT_BENNY, buildReplyState, buildState, decide, replyWaits, shapeOf } from '../src/jev/decide.ts'
import type { WindowMessage } from '../src/thread-window.ts'

const repoRoot = resolve(import.meta.dirname, '..')
const { values: options } = parseArgs({
    options: {
        runs: { type: 'string', default: '1' },
        gate: { type: 'boolean', default: false },
        record: { type: 'boolean', default: false },
        check: { type: 'boolean', default: false },
        out: { type: 'string', default: join(repoRoot, '.cloudflare/probe') },
    },
})
// An OpenRouter decisions model id, or 'clef-flash' (Workers AI, the model Benny used before).
const probeModel = process.env.PROBE_MODEL ?? 'typesafe/jev-1.13'
const oneQuestionPerRequest = process.env.PROBE_SPLIT === '1'

// Everything that can change an answer or a score. A change to any of these makes the baseline
// stale, so `--check` fails until someone re-runs the eval with `--record`.
const baselineFile = join(repoRoot, 'scripts/probe-baseline.json')
const probeCasesDir = join(repoRoot, 'scripts/probe-cases')
const hasProbeCases = existsSync(probeCasesDir)
const readProbeCases = (file: string) => hasProbeCases ? JSON.parse(readFileSync(join(probeCasesDir, file), 'utf8')) : []
const inputFiles = [
    'src/jev/questions.ts',
    'src/jev/decide.ts',
    'src/jev/classify.ts',
    'scripts/probe-decisions.ts',
    ...(hasProbeCases ? readdirSync(probeCasesDir).sort().map((file) => `scripts/probe-cases/${file}`) : []),
]
const inputsHash = createHash('sha256')
    .update(inputFiles.map((file) => `${file}\n${readFileSync(join(repoRoot, file), 'utf8')}`).join('\n'))
    .digest('hex')
type Baseline = {
    inputsHash: string
    commit: string
    model: string
    // Set by hand: the lowest score a run may get before the gate fails.
    minDecisions: number
    minStops: number
    minReplies: number
    runs: { decisions: string; stops: string; replies: string }[]
}
const baseline: Baseline | undefined = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, 'utf8')) : undefined

if (options.check) {
    if (!hasProbeCases) {
        console.log('No scripts/probe-cases in this copy of the repo, so there is no recorded eval to check.')
        process.exit(0)
    }
    if (baseline?.inputsHash === inputsHash) {
        console.log(`decision eval baseline is current (recorded at ${baseline.commit.slice(0, 7)})`)
        process.exit(0)
    }
    console.error('The decision model or its cases changed since the eval baseline was recorded.')
    console.error('Run `OPENROUTER_KEY=... pnpm probe:decisions --runs 2 --record` and commit scripts/probe-baseline.json.')
    console.error(`Inputs: ${inputFiles.join(', ')}`)
    process.exit(1)
}

type Msg = { author: string; text: string }
type Case = {
    name: string
    thread: { kind: 'issue' | 'pull request'; title: string }
    earlier: Msg[]
    message: Msg
    // 'ignore', 'ack' or 'reply'; 'a/b' when either is fine.
    expected: string
    // A miss in any run fails the gate, whatever the score: a reply to a teammate's message.
    mustPass?: boolean
}

const BENNY = 'Benny (bot)'

// Made-up cases share one PR thread: alice asks Benny, Benny answers, then `since` happens. In
// the team thread carol has posted too; in the solo thread only alice and Benny have.
const retryThread = { kind: 'pull request' as const, title: 'Fix flaky retry test in webhook handler' }
const question: Msg = { author: 'alice', text: '@bobby-sb why does the retry test fail randomly?' }
const bennyReply: Msg = { author: BENNY, text: 'The test waits a fixed 100ms for the retry, but backoff adds jitter up to 150ms. I switched it to fake timers in the suggested patch below.' }
const openings = {
    team: [{ author: 'carol', text: 'the retry test failed on my branch too' }, question, bennyReply],
    solo: [question, bennyReply],
}
const carolNote: Msg = { author: 'carol', text: 'I also pushed a fix for the lint failure.' }

const madeUp = (name: string, opening: keyof typeof openings, since: Msg[], message: Msg, expected: string, mustPass = false): Case =>
    ({ name, thread: retryThread, earlier: [...openings[opening], ...since], message, expected, mustPass })

const cases: Case[] = [
    madeUp('thanks', 'team', [], { author: 'alice', text: 'thanks, that fixed it!' }, 'ack'),
    madeUp('still_failing', 'team', [], { author: 'alice', text: 'still failing on CI with the same timeout error' }, 'reply'),
    madeUp('to_carol', 'team', [], { author: 'alice', text: '@carol can you review this when you get a chance?' }, 'ignore', true),
    madeUp('follow_up_request', 'team', [], { author: 'alice', text: 'can you also add a test for the max-retries case?' }, 'reply'),
    madeUp('ok', 'team', [], { author: 'alice', text: 'ok' }, 'ack'),
    madeUp('team_note', 'team', [], { author: 'carol', text: 'LGTM, merging after CI goes green' }, 'ignore'),
    madeUp('carol_heading_out', 'team', [], { author: 'carol', text: 'heading out, back tomorrow' }, 'ignore'),
    madeUp('joke', 'team', [], { author: 'alice', text: 'lol the bot debugs faster than I do' }, 'ignore/ack'),
    madeUp('thanks_carol', 'team', [carolNote], { author: 'alice', text: 'thanks!' }, 'ignore'),
    madeUp('thanks_carol_named', 'team', [carolNote], { author: 'alice', text: 'thanks carol!' }, 'ignore', true),
    madeUp('fail_after_carol', 'team', [carolNote], { author: 'alice', text: 'still failing on CI with the same timeout error' }, 'reply'),
    madeUp('solo_ok', 'solo', [], { author: 'alice', text: 'ok' }, 'ack'),
    madeUp('solo_nudge', 'solo', [{ author: 'alice', text: 'too long, keep it to 2 lines' }, { author: 'alice', text: 'where u at' }], { author: 'alice', text: 'hello??' }, 'ack/reply'),
    madeUp('solo_rude', 'solo', [], { author: 'alice', text: 'whatever, do better next time' }, 'ack'),
    ...readProbeCases('real.json'),
    // Written in the owner's style, ordered from clear to vague; labels are guesses.
    ...readProbeCases('my-style.json'),
]

type StopCase = {
    name: string
    message: Msg
    expected: 'yes' | 'no'
}

// Mirrors asksToStop() in src/jev/classify.ts: only the new message, never the earlier ones.
const stopCases: StopCase[] = [
    { name: 'exact_stop', message: { author: 'alice', text: '@bobby-sb stop' }, expected: 'yes' },
    { name: 'cancel_wrong_question', message: { author: 'alice', text: '@bobby-sb cancel that, I asked the wrong question' }, expected: 'yes' },
    { name: 'hindi_ruk_ja', message: { author: 'alice', text: '@bobby-sb ruk ja' }, expected: 'yes' },
    { name: 'spanish_para', message: { author: 'alice', text: '@bobby-sb para, por favor' }, expected: 'yes' },
    { name: 'wrong_file', message: { author: 'alice', text: '@bobby-sb hold on, stop, I gave you the wrong file' }, expected: 'yes' },
    { name: 'abort', message: { author: 'alice', text: '@bobby-sb abort' }, expected: 'yes' },
    { name: 'question_about_stopping_server', message: { author: 'alice', text: '@bobby-sb how do I stop the dev server?' }, expected: 'no' },
    { name: 'coding_task_stop_using_any', message: { author: 'alice', text: '@bobby-sb stop using any in this file and fix the types' }, expected: 'no' },
    { name: 'question_about_stop_method', message: { author: 'alice', text: '@bobby-sb what does the stop() method in worker.ts do?' }, expected: 'no' },
    { name: 'keep_going', message: { author: 'alice', text: "@bobby-sb don't stop, keep going" }, expected: 'no' },
    { name: 'looks_good', message: { author: 'alice', text: '@bobby-sb looks good, thanks' }, expected: 'no' },
    { name: 'new_request', message: { author: 'alice', text: '@bobby-sb can you also check the retry logic?' }, expected: 'no' },
]

type ReplyCase = {
    name: string
    // What makes a done case hard, such as "review, merge no".
    note?: string
    request: string
    // As posted, before the footnote; buildReplyState() collapses its <details> blocks.
    reply: string
    // 'wait/done' when a person could argue either way: counted apart, never scored or gated.
    expected: 'wait' | 'done' | 'wait/done'
    mustPass?: boolean
}

// Mirrors askReplyWaits() in src/jev/classify.ts: the request and the reply as posted.
const replyCases: ReplyCase[] = readProbeCases('replies.json')
const scoredReplyCases = replyCases.filter((replyCase) => replyCase.expected !== 'wait/done')

const toWindow = (messages: Msg[]): WindowMessage[] =>
    messages.map((m, index) => ({ messageId: String(index), author: m.author, isBenny: m.author === BENNY, text: m.text, createdAt: 0 }))
const newMessage = (m: Msg) => ({ author: { userName: m.author }, text: m.text })

const twoDecimals = (n: number) => n.toFixed(2)
let modelVersion = probeModel
const askModel = async (outDir: string, name: string, body: object) => {
    const file = join(outDir, `req-${name}.json`)
    writeFileSync(file, JSON.stringify({ ...body, model: probeModel }, null, 2))
    const raw = probeModel === 'clef-flash'
        ? execFileSync('pnpm', ['exec', 'cf', 'ai', 'run', '@cf/cloudflare/clef-flash', '--body', `@${file}`], { cwd: repoRoot, encoding: 'utf8' })
        : await fetch('https://openrouter.ai/api/alpha/decisions', {
            method: 'POST',
            headers: { authorization: `Bearer ${process.env.OPENROUTER_KEY}`, 'content-type': 'application/json' },
            body: readFileSync(file, 'utf8'),
        }).then((response) => response.text())
    writeFileSync(join(outDir, `res-${name}.json`), raw)
    const response = JSON.parse(raw.slice(raw.indexOf('{')))
    if (!response.answers) throw new Error(`${name}: no answers in ${raw.slice(0, 300)}`)
    modelVersion = response.model ?? modelVersion
    return response.answers
}
const askQuestions = async (outDir: string, name: string, state: unknown, questionSet: Record<string, unknown>) => {
    if (!oneQuestionPerRequest) return askModel(outDir, name, { state, questions: questionSet })
    const answerList = await Promise.all(Object.entries(questionSet).map(([questionName, question]) =>
        askModel(outDir, `${name}-${questionName}`, { state, questions: { [questionName]: question } })))
    return Object.assign({}, ...answerList)
}

type RunResult = { decisionsRight: number; stopsRight: number; repliesRight: number; eitherRepliesMarked: number; mustPassMisses: string[]; lines: string[] }

const runOnce = async (outDir: string): Promise<RunResult> => {
    mkdirSync(outDir, { recursive: true })
    const result: RunResult = { decisionsRight: 0, stopsRight: 0, repliesRight: 0, eitherRepliesMarked: 0, mustPassMisses: [], lines: [] }
    for (const probeCase of cases) {
        const { name, thread, earlier, message, expected, mustPass } = probeCase
        const threadInfo = { threadId: name, kind: thread.kind === 'pull request' ? 'pr' as const : 'issue' as const, title: thread.title }
        const state = buildState(threadInfo, toWindow(earlier), newMessage(message))
        const answers = await askQuestions(outDir, name, state, questions)
        const decision = decide(answers, shapeOf(toWindow(earlier), message.author))
        const action = decision.action === 'ack' ? `ack:${decision.reaction}` : decision.action
        const isRight = expected.split('/').includes(decision.action)
        if (isRight) result.decisionsRight++
        else if (mustPass) result.mustPassMisses.push(name)
        const noul = (question: string) => twoDecimals(answers[question].noul)
        result.lines.push([
            isRight ? ' ' : 'x', name.padEnd(28),
            `prev=${noul('responds_to_previous')} forPeople=${noul('for_people')}`,
            `expects=${noul('expects_answer')}`, '->', action.padEnd(14), `(want ${expected})`,
        ].join(' '))
    }
    for (const { name, message, expected } of stopCases) {
        const state = { about_benny: ABOUT_BENNY, new_message: { author: message.author, text: message.text } }
        const answers = await askQuestions(outDir, `stop-${name}`, state, stopQuestions)
        const probability = answers.asks_to_stop.noul
        const answer = probability >= STOP_YES ? 'yes' : 'no'
        const isRight = answer === expected
        if (isRight) result.stopsRight++
        // A wrong yes kills a running request, so every look-alike must pass.
        else if (expected === 'no') result.mustPassMisses.push(`stop-${name}`)
        result.lines.push(`${isRight ? ' ' : 'x'} stop-${name.padEnd(28)} noul=${twoDecimals(probability)} -> ${answer.padEnd(3)} (want ${expected})`)
    }
    // Sent all at once (a hundred replies one by one take minutes), and read in file order.
    const replyAnswers = await Promise.all(replyCases.map(({ name, request, reply }) =>
        askQuestions(outDir, `reply-${name}`, buildReplyState(request, reply), replyWaitQuestions)))
    for (const [index, { name, expected, mustPass }] of replyCases.entries()) {
        const answers = replyAnswers[index]
        const answer = replyWaits(answers) ? 'wait' : 'done'
        const isEither = expected === 'wait/done'
        const isRight = isEither || answer === expected
        if (isEither && answer === 'wait') result.eitherRepliesMarked++
        else if (!isEither && isRight) result.repliesRight++
        else if (!isRight && mustPass) result.mustPassMisses.push(`reply-${name}`)
        result.lines.push([
            isRight ? ' ' : 'x', `reply-${name}`.padEnd(36),
            `ask=${twoDecimals(answers.asks_question.noul)} go=${twoDecimals(answers.waits_for_go_ahead.noul)}`,
            '->', answer.padEnd(4), `(want ${expected})`,
        ].join(' '))
    }
    return result
}

const runCount = Number(options.runs)
const results = await Promise.all(Array.from({ length: runCount }, (_, index) => runOnce(join(options.out, `run-${index + 1}`))))
results.forEach((result, index) => {
    console.log(`== run ${index + 1}${runCount > 1 ? ' (misses only)' : ''}`)
    for (const line of result.lines) if (runCount === 1 || line.startsWith('x')) console.log(line)
    console.log(`${result.decisionsRight}/${cases.length} decisions, ${result.stopsRight}/${stopCases.length} stops, ` +
        `${result.repliesRight}/${scoredReplyCases.length} replies (at ${REPLY_WAITS_YES}; ` +
        `${result.eitherRepliesMarked}/${replyCases.length - scoredReplyCases.length} either-way replies marked)`)
})

if (options.gate || options.record) {
    if (!baseline) throw new Error(`No ${baselineFile}: create it with minDecisions, minStops and minReplies first.`)
    const lowestDecisions = Math.min(...results.map((result) => result.decisionsRight))
    const lowestStops = Math.min(...results.map((result) => result.stopsRight))
    const lowestReplies = Math.min(...results.map((result) => result.repliesRight))
    const mustPassMisses = [...new Set(results.flatMap((result) => result.mustPassMisses))]
    const failures = [
        ...(lowestDecisions < baseline.minDecisions ? [`decisions ${lowestDecisions} < minimum ${baseline.minDecisions}`] : []),
        ...(lowestStops < baseline.minStops ? [`stops ${lowestStops} < minimum ${baseline.minStops}`] : []),
        ...(lowestReplies < baseline.minReplies ? [`replies ${lowestReplies} < minimum ${baseline.minReplies}`] : []),
        ...(mustPassMisses.length ? [`must-pass cases missed: ${mustPassMisses.join(', ')}`] : []),
    ]
    if (failures.length) {
        console.error(`Gate failed: ${failures.join('; ')}`)
        process.exit(1)
    }
    console.log(`Gate passed: lowest ${lowestDecisions}/${cases.length} decisions (min ${baseline.minDecisions}), ` +
        `${lowestStops}/${stopCases.length} stops (min ${baseline.minStops}), ${lowestReplies}/${scoredReplyCases.length} replies (min ${baseline.minReplies})`)
    if (options.record) {
        const recorded: Baseline = {
            ...baseline,
            inputsHash,
            commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(),
            model: modelVersion,
            runs: results.map((result) => ({
                decisions: `${result.decisionsRight}/${cases.length}`,
                stops: `${result.stopsRight}/${stopCases.length}`,
                replies: `${result.repliesRight}/${scoredReplyCases.length}`,
            })),
        }
        writeFileSync(baselineFile, JSON.stringify(recorded, null, 4) + '\n')
        console.log(`Recorded ${baselineFile}`)
    }
}
