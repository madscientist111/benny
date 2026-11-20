// Live probe for the decision model: sends each case with the real question set from
// src/jev/questions.ts and prints every answer next to the action decide() would take. Then it
// sends the stop cases with stopQuestions and prints asks_to_stop against the yes/no threshold.
// Costs a fraction of a cent per run. Payloads and responses are saved for reruns.
//
// Made-up cases are below; real ones, copied from `state` / `decision` log lines and labeled by
// hand, are in scripts/probe-cases/real.json. That file holds private issue text, so the public
// copy of the repo leaves it out and the probe runs the made-up cases alone.
//
// Usage: pnpm probe:decisions [out-dir]   (default out-dir: .cloudflare/probe)
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const outDir = resolve(process.argv[2] ?? join(repoRoot, '.cloudflare/probe'))
mkdirSync(outDir, { recursive: true })
const { questions, YES, NO, stopQuestions, STOP_YES } = await import(join(repoRoot, 'src/jev/questions.ts'))

type Msg = { author: string; text: string }
type Case = {
    name: string
    thread: { kind: 'issue' | 'pull request'; title: string }
    earlier: Msg[]
    message: Msg
    // 'ignore', 'ack' or 'reply'; 'a/b' when either is fine.
    expected: string
}

const BENNY = 'Benny (bot)'
const ABOUT_BENNY = 'Benny is an AI coding assistant that people can talk to in this GitHub thread. Its GitHub handle is @bobby-sb.'

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

const madeUp = (name: string, opening: keyof typeof openings, since: Msg[], message: Msg, expected: string): Case =>
    ({ name, thread: retryThread, earlier: [...openings[opening], ...since], message, expected })

const realCasesPath = join(import.meta.dirname, 'probe-cases/real.json')
const cases: Case[] = [
    madeUp('thanks', 'team', [], { author: 'alice', text: 'thanks, that fixed it!' }, 'ack'),
    madeUp('still_failing', 'team', [], { author: 'alice', text: 'still failing on CI with the same timeout error' }, 'reply'),
    madeUp('to_carol', 'team', [], { author: 'alice', text: '@carol can you review this when you get a chance?' }, 'ignore'),
    madeUp('follow_up_request', 'team', [], { author: 'alice', text: 'can you also add a test for the max-retries case?' }, 'reply'),
    madeUp('ok', 'team', [], { author: 'alice', text: 'ok' }, 'ack'),
    madeUp('team_note', 'team', [], { author: 'carol', text: 'LGTM, merging after CI goes green' }, 'ignore'),
    madeUp('carol_heading_out', 'team', [], { author: 'carol', text: 'heading out, back tomorrow' }, 'ignore'),
    madeUp('joke', 'team', [], { author: 'alice', text: 'lol the bot debugs faster than I do' }, 'ignore/ack'),
    madeUp('thanks_carol', 'team', [carolNote], { author: 'alice', text: 'thanks!' }, 'ignore'),
    madeUp('thanks_carol_named', 'team', [carolNote], { author: 'alice', text: 'thanks carol!' }, 'ignore'),
    madeUp('fail_after_carol', 'team', [carolNote], { author: 'alice', text: 'still failing on CI with the same timeout error' }, 'reply'),
    madeUp('solo_ok', 'solo', [], { author: 'alice', text: 'ok' }, 'ack'),
    madeUp('solo_nudge', 'solo', [{ author: 'alice', text: 'too long, keep it to 2 lines' }, { author: 'alice', text: 'where u at' }], { author: 'alice', text: 'hello??' }, 'ack/reply'),
    madeUp('solo_rude', 'solo', [], { author: 'alice', text: 'whatever, do better next time' }, 'ack'),
    ...(existsSync(realCasesPath) ? JSON.parse(readFileSync(realCasesPath, 'utf8')) : []),
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

// Mirrors buildState() in src/jev/classify.ts.
const buildState = ({ thread, earlier, message }: Case) => ({
    about_benny: ABOUT_BENNY,
    thread,
    people_in_thread: [...new Set([...earlier.filter((m) => m.author !== BENNY).map((m) => m.author), message.author])],
    earlier_messages: earlier,
    previous_message: earlier.at(-1),
    new_message: message,
})

// Mirrors asksToStop() in src/jev/classify.ts: no thread, no earlier messages.
const buildStopState = (message: Msg) => ({
    about_benny: ABOUT_BENNY,
    new_message: message,
})

// Mirrors decide() in src/jev/classify.ts.
const decide = (answers: any, shape: { solo: boolean; previousIsOther: boolean }) => {
    if (answers.expects_answer.noul >= YES) return 'reply'
    if (!shape.solo) {
        const forPeople = answers.for_people.noul
        const respondsToPrevious = shape.previousIsOther ? answers.responds_to_previous.noul : 0
        if (forPeople >= YES || respondsToPrevious >= YES) return 'ignore'
        if (forPeople >= NO && respondsToPrevious >= NO) return 'ignore'
    }
    return `ack:${answers.reaction.choice}`
}

const twoDecimals = (n: number) => n.toFixed(2)
const askModel = (name: string, body: unknown) => {
    const file = join(outDir, `req-${name}.json`)
    writeFileSync(file, JSON.stringify(body, null, 2))
    const raw = execFileSync('pnpm', ['exec', 'cf', 'ai', 'run', '@cf/cloudflare/clef-flash', '--body', `@${file}`], { cwd: repoRoot, encoding: 'utf8' })
    writeFileSync(join(outDir, `res-${name}.json`), raw)
    return JSON.parse(raw.slice(raw.indexOf('{'))).answers
}

let right = 0
for (const probeCase of cases) {
    const { name, earlier, message, expected } = probeCase
    const answers = askModel(name, { model: 'clef-flash', state: buildState(probeCase), questions })
    const noul = (question: string) => twoDecimals(answers[question].noul)
    const previous = earlier.at(-1)!
    const action = decide(answers, {
        solo: earlier.every((m) => m.author === BENNY || m.author === message.author),
        previousIsOther: previous.author !== BENNY && previous.author !== message.author,
    })
    const isRight = expected.split('/').includes(action.split(':')[0])
    if (isRight) right++
    console.log(
        isRight ? ' ' : 'x',
        name.padEnd(26),
        `prev=${noul('responds_to_previous')} forPeople=${noul('for_people')}`,
        `expects=${noul('expects_answer')} emoji=${answers.reaction.choice.padEnd(9)}`,
        '->', action.padEnd(14), `(want ${expected})`,
    )
}
console.log(`${right}/${cases.length} right`)

let stopRight = 0
for (const { name, message, expected } of stopCases) {
    const answers = askModel(`stop-${name}`, { model: 'clef-flash', state: buildStopState(message), questions: stopQuestions })
    const probability = answers.asks_to_stop.noul
    const answer = probability >= STOP_YES ? 'yes' : 'no'
    const isRight = answer === expected
    if (isRight) stopRight++
    console.log(
        isRight ? ' ' : 'x',
        name.padEnd(32),
        `noul=${twoDecimals(probability)}`,
        `-> ${answer.padEnd(3)}`,
        `(want ${expected})`,
    )
}
console.log(`${stopRight}/${stopCases.length} right (stop)`)
