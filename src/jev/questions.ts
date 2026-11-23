// All Jev wording and thresholds live here, so they can be audited and tuned in one place.
// Questions refer to fields of the state built in ./decide.ts by their backticked path.

export const YES = 0.7
export const NO = 0.3
// In a solo thread right after Benny's message, `expects_answer` at or above this gets a reply:
// "too long" and "huh" land at 0.51–0.56, "k" and "ok cool" at 0.39 or less (lesson 17).
export const REPLY_AFTER_BENNY = 0.5

export const ACK_REACTIONS = ['thumbs_up', 'heart', 'laugh', 'hooray', 'rocket'] as const
export type AckReaction = (typeof ACK_REACTIONS)[number]

// A wrong yes kills a running request, so a stop needs a clear answer, not a guess. With Jev
// every look-alike scores 0.10 or less. English stops score 0.92 or more; Hindi and Spanish ones
// fell to 0.67–0.79 when the name became Benny while the handle stayed `@bobby-sb`
// (docs/decision-model/tuning-lessons.md, lessons 16 and 20).
export const STOP_YES = 0.6

// Separate from `questions` so classify() requests keep their shape and cost.
export const stopQuestions = {
    asks_to_stop: {
        type: 'noul',
        instructions: 'Does the author of `new_message` tell Benny to stop or cancel the work it is doing now?',
        criteria: {
            true: 'The author is telling Benny to stop, cancel, abandon, or abort the work it is doing now, in any wording, often because the request, the input, or the next step was wrong.',
            false: 'The author is not telling Benny to end its current work. The message asks about stopping something in the code or infrastructure, such as a server, a process, a loop, or a function named stop. It uses stop as part of a coding instruction about how the code should be written. Messages that tell Benny to continue working also do not count.',
        },
    },
} as const

// A posted reply waits for the requester (the waiting mark, docs/input-required/plan.md rule 1)
// when either answer below is at or above this. On 146 hand-labeled real replies, two runs each:
// 0 of 21 that wait missed, 2 of 95 that are done marked, 13 of 30 that could go either way
// marked; 30 of 30 research replies that ended on questions marked. `asks_question` alone missed
// one of those 30 (0.68, with `waits_for_go_ahead` at 0.94), so both are asked (lesson 18).
export const REPLY_WAITS_YES = 0.7

// Asked about Benny's reply once it is posted, so the writing model never has to choose to mark
// it. Separate from `questions`, like `stopQuestions`.
export const replyWaitQuestions = {
    asks_question: {
        type: 'noul',
        instructions: 'Does `reply` ask the requester a question that Benny needs answered?',
        criteria: {
            true: 'Benny asks the requester to answer a question, choose between options, or confirm something, and the work depends on the answer.',
            false: 'Benny reports what it found or did and asks the requester nothing.',
        },
    },
    waits_for_go_ahead: {
        type: 'noul',
        instructions: 'Does `reply` propose a next step and wait for the requester to approve it?',
        criteria: {
            true: 'Benny says what it would do next and will only do it once the requester says yes.',
            false: 'Benny has done what was asked and proposes nothing that needs approval.',
        },
    },
} as const

export const questions = {
    // Benny acts by default; this and responds_to_previous find the messages it should stay out
    // of. There is no "is this for Benny?" question: every variant missed real messages to Benny
    // (lesson 13).
    for_people: {
        type: 'noul',
        instructions: 'Is `new_message` meant for the people in `people_in_thread` rather than for Benny?',
        criteria: {
            true: 'The author is replying to a teammate or posting an update for the team.',
            false: 'The author is answering Benny, thanking Benny, or asking Benny for something.',
        },
    },
    // Only read when `previous_message` is someone else's (not Benny's or the author's own): a
    // yes means the message belongs to someone else's exchange.
    responds_to_previous: {
        type: 'noul',
        instructions: 'Is `new_message` a response to `previous_message`?',
        criteria: {
            true: 'The author is reacting to or following up on `previous_message`, such as thanking its author or answering it.',
            false: 'The author is responding to an earlier message, or starting something new.',
        },
    },
    // Checked first: expecting an answer from Benny means the message is for Benny. Asks the goal
    // rather than "is it a question?", which missed demands like "tell me why" (lesson 14).
    expects_answer: {
        type: 'noul',
        instructions: 'Does the author of `new_message` expect Benny to answer in words?',
        criteria: {
            true: 'The author wants something from Benny that a reaction cannot give, such as an answer, an explanation, or a change to the code.',
            false: 'The author needs nothing more from Benny, such as when acknowledging, thanking, or making a passing comment.',
        },
    },
    // Read only when the decision is 'ack'; asked speculatively in the same request.
    reaction: {
        type: 'choice',
        instructions: 'Which emoji reaction best fits `new_message`?',
        criteria: {
            thumbs_up: 'A plain acknowledgement, such as "ok" or "got it".',
            heart: 'Thanks or appreciation, such as "thank you, this is great".',
            laugh: 'A joke or something meant to be funny.',
            hooray: 'Celebrating a success, such as "it works now!" or "merged".',
            rocket: 'Eagerness to ship or move fast, such as "let\'s ship it".',
        } satisfies Record<AckReaction, string>,
    },
} as const
