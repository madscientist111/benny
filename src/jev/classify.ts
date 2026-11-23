import { env } from 'cloudflare:workers'
import type { Message } from 'chat'
import type { WindowMessage } from '../thread-window'
import { log, type LogIds } from '../log'
import { STOP_YES, questions, replyWaitQuestions, stopQuestions } from './questions'
import { ABOUT_BENNY, buildReplyState, buildState, decide, noul, replyWaits, shapeOf, type Answer, type Answers, type Decision, type ReplyWaitAnswers, type ThreadInfo } from './decide'

// Asks the decision model about one message and turns its answers into a decision: ignore, react
// or reply to an unmentioned message (`classify`), whether a mention asks Benny to stop
// (`asksToStop`), and whether a posted reply waits for the requester (`askReplyWaits`). The
// questions and thresholds are in `./questions.ts`; the state and the rules are in `./decide.ts`.

export type { Decision, ThreadInfo }

// TypeSafe's Jev through OpenRouter's decisions endpoint (Jev is not on its chat endpoint, and
// `typesafe/jev-router` is a chat router that sends requests to other models). It beat
// clef-flash on vague messages (docs/decision-model/tuning-lessons.md, lesson 16).
const MODEL = 'typesafe/jev-1.13'
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions'

const askDecisionModel = async <Questions extends Record<string, unknown>>(
    state: unknown,
    questionSet: Questions,
): Promise<Record<keyof Questions, Answer>> => {
    const response = await fetch(DECISIONS_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.OPENROUTER_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, state, questions: questionSet }),
        // A reply waits on this call, and Jev answers in about a second.
        signal: AbortSignal.timeout(15_000),
    })
    const body = await response.text()
    if (!response.ok) throw new Error(`${MODEL} returned ${response.status}: ${body.slice(0, 500)}`)
    const answers = JSON.parse(body).answers
    for (const name of Object.keys(questionSet)) {
        if (!answers?.[name]) throw new Error(`${MODEL} response missing answer "${name}": ${body.slice(0, 500)}`)
    }
    return answers
}

export const classify = async (thread: ThreadInfo, messagesBefore: WindowMessage[], message: Message) => {
    const state = buildState(thread, messagesBefore, message)
    log('state', { requestId: message.id, state })
    let answers: Answers
    try {
        answers = await askDecisionModel(state, questions)
    } catch (error) {
        // Silence reads as being ignored, so a broken model still gets a visible answer.
        log('decision failed', { threadId: thread.threadId, requestId: message.id, error: String(error) })
        return { action: 'ack', reaction: 'confused' } satisfies Decision
    }
    const decision = decide(answers, shapeOf(messagesBefore, message.author.userName))
    log('decision', { threadId: thread.threadId, requestId: message.id, answers, decision })
    return decision
}

// Whether a mention asks Benny to stop the work it is doing (requirement 35), for a "stop" in any
// wording or language. Only the new message is sent: an old "stop" in the thread must not count again.
export const asksToStop = async (message: Message): Promise<boolean> => {
    const state = {
        about_benny: ABOUT_BENNY,
        new_message: { author: message.author.userName, text: message.text },
    }
    try {
        const answers = await askDecisionModel(state, stopQuestions)
        const probability = noul(answers.asks_to_stop)
        log('stop decision', { requestId: message.id, user: message.author.userName, noul: probability.toFixed(2) })
        return probability >= STOP_YES
    } catch (error) {
        // A broken model must never stop work.
        log('stop decision failed', { requestId: message.id, user: message.author.userName, error: String(error) })
        return false
    }
}

// Whether Benny's posted reply waits for the requester, for the waiting mark (plan rule 1). `PiAgent`
// asks after the reply is posted, so this call never delays it.
export const askReplyWaits = async ({ requestText, replyText, logIds }: { requestText: string; replyText: string; logIds: LogIds }): Promise<boolean> => {
    const state = buildReplyState(requestText, replyText)
    log('reply wait state', { ...logIds, state })
    let answers: ReplyWaitAnswers
    try {
        answers = await askDecisionModel(state, replyWaitQuestions)
    } catch (error) {
        // A broken model must never mark a thread, and the reply is already posted.
        log('reply wait decision failed', { ...logIds, error: String(error) })
        return false
    }
    const waits = replyWaits(answers)
    log('reply wait decision', {
        ...logIds,
        asksQuestion: noul(answers.asks_question).toFixed(2),
        waitsForGoAhead: noul(answers.waits_for_go_ahead).toFixed(2),
        waits,
    })
    return waits
}
