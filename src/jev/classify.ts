import { env } from 'cloudflare:workers'
import type { Message } from 'chat'
import type { WindowMessage } from '../thread-window'
import { log } from '../log'
import { ACK_REACTIONS, NO, STOP_YES, YES, questions, stopQuestions, type AckReaction } from './questions'

// Asks the decision model about one message and turns its answers into a decision: ignore, react
// or reply to an unmentioned message (`classify`), and whether a mention asks Benny to stop
// (`asksToStop`). The questions and thresholds are in `./questions.ts`.

export type ThreadInfo = { threadId: string; kind: 'issue' | 'pr'; title: string }

export type Decision =
    | { action: 'ignore' }
    | { action: 'ack'; reaction: AckReaction }
    | { action: 'reply' }

type NoulAnswer = { type: 'noul'; noul: number }
type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number> }
type Answer = NoulAnswer | ChoiceAnswer
type Answers = Record<keyof typeof questions, Answer>

const BENNY = 'Benny (bot)'
const ABOUT_BENNY = 'Benny is an AI coding assistant that people can talk to in this GitHub thread. Its GitHub handle is @bobby-sb.'

export const buildState = (thread: ThreadInfo, messagesBefore: WindowMessage[], message: Message) => {
    const messages = messagesBefore.map((m) => ({ author: m.isBenny ? BENNY : m.author, text: m.text }))
    const previous = messages.at(-1)
    return {
        about_benny: ABOUT_BENNY,
        thread: {
            kind: thread.kind === 'pr' ? 'pull request' : 'issue',
            title: thread.title,
        },
        // Facts the code knows, so the model doesn't have to work them out from the messages.
        people_in_thread: [...new Set([...messagesBefore.filter((m) => !m.isBenny).map((m) => m.author), message.author.userName])],
        earlier_messages: messages,
        // Spelled out because it shifted the other answers: without it, "thanks!" right after
        // a teammate's message read as a reply to Benny.
        ...(previous && { previous_message: previous }),
        new_message: { author: message.author.userName, text: message.text },
    }
}

// Cloudflare's own decision model, same System One request shape as Jev
// (typesafe/jev-1.14.0), but billed through Workers AI instead of AI Gateway credits.
// https://developers.cloudflare.com/workers-ai/models/clef-flash/
const MODEL = '@cf/cloudflare/clef-flash'

const askDecisionModel = async <Questions extends Record<string, unknown>>(
    state: unknown,
    questionSet: Questions,
): Promise<Record<keyof Questions, Answer>> => {
    const result = await (env.AI as any).run(MODEL, { model: 'clef-flash', state, questions: questionSet })
    const answers = result?.answers
    for (const name of Object.keys(questionSet)) {
        if (!answers?.[name]) throw new Error(`${MODEL} response missing answer "${name}": ${JSON.stringify(result)}`)
    }
    return answers
}

const noul = (answer: Answer) => (answer as NoulAnswer).noul

// What the code knows about the thread, so the model doesn't have to guess it.
export type ThreadShape = {
    // Nobody but the author and Benny has posted, so there is nobody else to talk to.
    solo: boolean
    // The previous message is by someone other than Benny and the author, so answering it
    // means joining someone else's exchange.
    previousIsOther: boolean
}

// In a subscribed thread Benny always answers in some way, because silence reads as being
// ignored. A message that expects an answer from Benny is for Benny, so it gets a reply even
// when it might also be for the team ("still failing on CI"). Otherwise Benny reacts, unless
// the message is for the people in the thread: clearly so, or possibly so while possibly
// answering someone else's message.
export const decide = (answers: Answers, shape: ThreadShape): Decision => {
    if (noul(answers.expects_answer) >= YES) return { action: 'reply' }
    if (!shape.solo) {
        const forPeople = noul(answers.for_people)
        const respondsToPrevious = shape.previousIsOther ? noul(answers.responds_to_previous) : 0
        if (forPeople >= YES || respondsToPrevious >= YES) return { action: 'ignore' }
        if (forPeople >= NO && respondsToPrevious >= NO) return { action: 'ignore' }
    }
    const choice = (answers.reaction as ChoiceAnswer).choice
    const reaction = (ACK_REACTIONS as readonly string[]).includes(choice) ? (choice as AckReaction) : 'thumbs_up'
    return { action: 'ack', reaction }
}

export const classify = async (thread: ThreadInfo, messagesBefore: WindowMessage[], message: Message) => {
    const state = buildState(thread, messagesBefore, message)
    log('state', { requestId: message.id, state })
    const answers = await askDecisionModel(state, questions)
    const author = message.author.userName
    const previous = messagesBefore.at(-1)
    const decision = decide(answers, {
        solo: messagesBefore.every((m) => m.isBenny || m.author === author),
        previousIsOther: !!previous && !previous.isBenny && previous.author !== author,
    })
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
