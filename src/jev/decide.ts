import type { WindowMessage } from '../thread-window'
import { ACK_REACTIONS, NO, REPLY_AFTER_BENNY, REPLY_WAITS_YES, YES, type AckReaction, type questions, type replyWaitQuestions } from './questions.ts'

// The deterministic half of the decision model: the state sent to Jev and the rules that turn its
// answers into ignore / react / reply, and into whether a posted reply waits for the requester.
// classify.ts and scripts/probe-decisions.ts call it, and decide.test.ts tests it; it has no
// Cloudflare imports so plain Node can run it.

// The parts of a chat Message the state reads, so the probe and tests can build one.
export type NewMessage = { text: string; author: { userName: string } }

export type ThreadInfo = { threadId: string; kind: 'issue' | 'pr'; title: string }

export type Decision =
    | { action: 'ignore' }
    // 'confused' only when the model call failed: Benny still answers, and the author can mention it.
    | { action: 'ack'; reaction: AckReaction | 'confused' }
    | { action: 'reply' }

export type NoulAnswer = { type: 'noul'; noul: number }
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number> }
export type Answer = NoulAnswer | ChoiceAnswer
export type Answers = Record<keyof typeof questions, Answer>

const BENNY = 'Benny (bot)'
export const ABOUT_BENNY = 'Benny is an AI coding assistant that people can talk to in this GitHub thread. Its GitHub handle is @bobby-sb.'

export const buildState = (thread: ThreadInfo, messagesBefore: WindowMessage[], message: NewMessage) => {
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

export const noul = (answer: Answer) => (answer as NoulAnswer).noul

// What the code knows about the thread, so the model doesn't have to guess it.
export type ThreadShape = {
    // Nobody but the author and Benny has posted, so there is nobody else to talk to.
    solo: boolean
    // The previous message is Benny's, so the new one most likely answers it.
    previousIsBenny: boolean
    // The previous message is by someone other than Benny and the author, so answering it
    // means joining someone else's exchange.
    previousIsOther: boolean
}

// In a subscribed thread Benny always answers in some way, because silence reads as being
// ignored. A message that expects an answer from Benny is for Benny, so it gets a reply even
// when it might also be for the team ("still failing on CI"). Otherwise Benny reacts, unless
// the message is for the people in the thread: clearly so, or possibly so while possibly
// answering someone else's message. Right after Benny in a solo thread, an unsure answer means a
// short comeback such as "huh" or "too long", which wants words, so the bar for a reply is lower.
export const decide = (answers: Answers, shape: ThreadShape): Decision => {
    const expectsAnswer = noul(answers.expects_answer)
    if (expectsAnswer >= YES) return { action: 'reply' }
    if (shape.solo && shape.previousIsBenny && expectsAnswer >= REPLY_AFTER_BENNY) return { action: 'reply' }
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

// Reads the thread facts `decide()` needs from the messages before the new one.
export const shapeOf = (messagesBefore: WindowMessage[], author: string): ThreadShape => {
    const previous = messagesBefore.at(-1)
    return {
        solo: messagesBefore.every((m) => m.isBenny || m.author === author),
        previousIsBenny: !!previous?.isBenny,
        previousIsOther: !!previous && !previous.isBenny && previous.author !== author,
    }
}

// A reply over this many characters is cut to its first and last parts: the question that makes it
// wait comes at the end, and the opening says what it is about.
const VISIBLE_REPLY_MAX = 5000
const VISIBLE_REPLY_HEAD = 2000
const VISIBLE_REPLY_TAIL = 3000
// The probe's real requests were cut here too, so the state stays the one that was measured.
const REQUEST_MAX = 1500

// The reply as the reader sees it: collapsed `<details>` blocks hold evidence, not what Benny
// asks, and with them in, "Merge: no" reviews scored 0.8 on `asks_question` instead of 0.18.
export const visibleReply = (reply: string) => {
    const visible = reply.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '[collapsed details]').trim()
    if (visible.length <= VISIBLE_REPLY_MAX) return visible
    return `${visible.slice(0, VISIBLE_REPLY_HEAD)}\n[...]\n${visible.slice(-VISIBLE_REPLY_TAIL)}`
}

export const buildReplyState = (requestText: string, replyText: string) => ({
    about_benny: ABOUT_BENNY,
    request: requestText.slice(0, REQUEST_MAX),
    reply: visibleReply(replyText),
})

export type ReplyWaitAnswers = Record<keyof typeof replyWaitQuestions, Answer>

// A reply waits when it asks something or proposes a step that waits for a yes; each question
// alone missed real asks (lesson 18).
export const replyWaits = (answers: ReplyWaitAnswers) =>
    noul(answers.asks_question) >= REPLY_WAITS_YES || noul(answers.waits_for_go_ahead) >= REPLY_WAITS_YES
