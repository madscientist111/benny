import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { ACK_REACTIONS, NO, REPLY_AFTER_BENNY, REPLY_WAITS_YES, YES } from '../src/jev/questions.ts'
import { buildReplyState, buildState, decide, replyWaits, shapeOf, visibleReply, type Answers, type ReplyWaitAnswers, type ThreadShape } from '../src/jev/decide.ts'
import type { WindowMessage } from '../src/thread-window.ts'

// Free, deterministic checks of the decision model's code half: fixed examples of the truth
// table in src/jev/decide.ts, then rules that must hold for any answers Jev could return
// (fast-check generates thousands). The model itself is tested by scripts/probe-decisions.ts.

const answersWith = (nouls: { expects: number; forPeople: number; respondsToPrevious: number }, choice = 'thumbs_up'): Answers => ({
    expects_answer: { type: 'noul', noul: nouls.expects },
    for_people: { type: 'noul', noul: nouls.forPeople },
    responds_to_previous: { type: 'noul', noul: nouls.respondsToPrevious },
    reaction: { type: 'choice', choice, probabilities: {} },
})
const solo: ThreadShape = { solo: true, previousIsBenny: true, previousIsOther: false }
const team: ThreadShape = { solo: false, previousIsBenny: true, previousIsOther: false }
const teamAfterTeammate: ThreadShape = { solo: false, previousIsBenny: false, previousIsOther: true }

test('a message that expects an answer gets a reply', () => {
    assert.deepEqual(decide(answersWith({ expects: YES, forPeople: 0.9, respondsToPrevious: 0.9 }), teamAfterTeammate), { action: 'reply' })
})

test('an unsure comeback right after Benny in a solo thread gets a reply', () => {
    assert.deepEqual(decide(answersWith({ expects: 0.55, forPeople: 0.2, respondsToPrevious: 0.8 }), solo), { action: 'reply' })
    // Not after Benny (the author's own nudge came last): the lower bar does not apply.
    const afterOwnMessage = { ...solo, previousIsBenny: false }
    assert.equal(decide(answersWith({ expects: 0.55, forPeople: 0.2, respondsToPrevious: 0.8 }), afterOwnMessage).action, 'ack')
    // In a team thread the lower bar does not apply either.
    assert.equal(decide(answersWith({ expects: 0.55, forPeople: 0.1, respondsToPrevious: 0.1 }), team).action, 'ack')
})

test('a message for the team is ignored', () => {
    assert.deepEqual(decide(answersWith({ expects: 0.1, forPeople: 0.8, respondsToPrevious: 0.1 }), team), { action: 'ignore' })
    assert.deepEqual(decide(answersWith({ expects: 0.1, forPeople: 0.1, respondsToPrevious: 0.8 }), teamAfterTeammate), { action: 'ignore' })
    // Possibly for the team while possibly answering a teammate: stay out.
    assert.deepEqual(decide(answersWith({ expects: 0.1, forPeople: 0.4, respondsToPrevious: 0.4 }), teamAfterTeammate), { action: 'ignore' })
})

test('responds_to_previous only counts when a teammate posted last', () => {
    assert.equal(decide(answersWith({ expects: 0.1, forPeople: 0.1, respondsToPrevious: 0.9 }), team).action, 'ack')
})

test('an unknown emoji choice falls back to thumbs up', () => {
    assert.deepEqual(decide(answersWith({ expects: 0.1, forPeople: 0.1, respondsToPrevious: 0.1 }, 'confetti'), solo), { action: 'ack', reaction: 'thumbs_up' })
})

const windowMessage = (author: string, text: string, isBenny = false): WindowMessage => ({ messageId: text, author, isBenny, text, createdAt: 0 })

test('the state names Benny, lists the people and spells out the previous message', () => {
    const thread = { threadId: 't', kind: 'pr' as const, title: 'Fix retry' }
    const earlier = [windowMessage('alice', 'why does it fail?'), windowMessage('bobby-sb[bot]', 'jitter', true)]
    const state = buildState(thread, earlier, { author: { userName: 'carol' }, text: 'thanks' })
    assert.equal(state.thread.kind, 'pull request')
    assert.deepEqual(state.people_in_thread, ['alice', 'carol'])
    assert.deepEqual(state.previous_message, { author: 'Benny (bot)', text: 'jitter' })
    assert.equal('previous_message' in buildState(thread, [], { author: { userName: 'carol' }, text: 'hi' }), false)
})

test('shapeOf reads solo, previous-is-Benny and previous-is-other from the thread', () => {
    const benny = windowMessage('bobby-sb[bot]', 'answer', true)
    assert.deepEqual(shapeOf([windowMessage('alice', 'q'), benny], 'alice'), { solo: true, previousIsBenny: true, previousIsOther: false })
    assert.deepEqual(shapeOf([benny, windowMessage('sid', 'note')], 'alice'), { solo: false, previousIsBenny: false, previousIsOther: true })
    assert.deepEqual(shapeOf([], 'alice'), { solo: true, previousIsBenny: false, previousIsOther: false })
})

// Generated inputs: any probabilities, any thread shape.
const probability = fc.double({ min: 0, max: 1, noNaN: true })
const nouls = fc.record({ expects: probability, forPeople: probability, respondsToPrevious: probability })
const shape = fc.record({ solo: fc.boolean(), previousIsBenny: fc.boolean(), previousIsOther: fc.boolean() })
const choice = fc.oneof(fc.constantFrom(...ACK_REACTIONS), fc.string())

test('rule: expects_answer at or above YES always replies', () => {
    fc.assert(fc.property(nouls, shape, choice, (generated, threadShape, emoji) => {
        fc.pre(generated.expects >= YES)
        return decide(answersWith(generated, emoji), threadShape).action === 'reply'
    }))
})

test('rule: Benny never replies when expects_answer is under REPLY_AFTER_BENNY', () => {
    fc.assert(fc.property(nouls, shape, choice, (generated, threadShape, emoji) => {
        fc.pre(generated.expects < REPLY_AFTER_BENNY)
        return decide(answersWith(generated, emoji), threadShape).action !== 'reply'
    }))
})

test('rule: raising expects_answer never turns a reply into something else', () => {
    fc.assert(fc.property(nouls, probability, shape, (generated, higher, threadShape) => {
        fc.pre(higher >= generated.expects)
        const before = decide(answersWith(generated), threadShape).action
        const after = decide(answersWith({ ...generated, expects: higher }), threadShape).action
        return before !== 'reply' || after === 'reply'
    }))
})

test('rule: in a solo thread Benny never ignores a message', () => {
    fc.assert(fc.property(nouls, shape, choice, (generated, threadShape, emoji) =>
        decide(answersWith(generated, emoji), { ...threadShape, solo: true }).action !== 'ignore'))
})

test('rule: in a team thread, a message clearly for the team that expects nothing is ignored', () => {
    fc.assert(fc.property(nouls, shape, (generated, threadShape) => {
        fc.pre(generated.forPeople >= YES && generated.expects < YES)
        return decide(answersWith(generated), { ...threadShape, solo: false }).action === 'ignore'
    }))
})

test('rule: a reaction is always one of ACK_REACTIONS', () => {
    fc.assert(fc.property(nouls, shape, choice, (generated, threadShape, emoji) => {
        const decision = decide(answersWith(generated, emoji), threadShape)
        return decision.action !== 'ack' || (ACK_REACTIONS as readonly string[]).includes(decision.reaction)
    }))
})

test('rule: NO is below REPLY_AFTER_BENNY, which is below YES', () => {
    assert.ok(NO < REPLY_AFTER_BENNY && REPLY_AFTER_BENNY < YES)
})

// Whether a posted reply waits: the reply as the reader sees it, and the either-answer rule.

test('visibleReply keeps a reply with no details block as it is', () => {
    assert.equal(visibleReply('  Which option do you want, A or B?\n'), 'Which option do you want, A or B?')
})

test('visibleReply collapses one details block', () => {
    const reply = 'Merge: no.\n\n<details><summary>Evidence</summary>\n\nDo you want X? Should I do Y?\n</details>\n\nDone.'
    assert.equal(visibleReply(reply), 'Merge: no.\n\n[collapsed details]\n\nDone.')
})

test('visibleReply collapses several details blocks, each on its own', () => {
    const reply = 'Start\n<details>\none\n</details>\nmiddle\n<details open><summary>two</summary>two</details>\nend'
    assert.equal(visibleReply(reply), 'Start\n[collapsed details]\nmiddle\n[collapsed details]\nend')
})

test('visibleReply keeps the first 2000 and last 3000 characters of a reply over 5000', () => {
    const reply = `${'a'.repeat(2000)}${'b'.repeat(1000)}${'c'.repeat(3000)}`
    const visible = visibleReply(reply)
    assert.equal(visible, `${'a'.repeat(2000)}\n[...]\n${'c'.repeat(3000)}`)
    // At the cap nothing is cut.
    assert.equal(visibleReply('x'.repeat(5000)), 'x'.repeat(5000))
})

test('buildReplyState sends the request and the visible reply', () => {
    const state = buildReplyState('@bobby-sb review this', 'Merge: yes.<details>Should I also fix Z?</details>')
    assert.equal(state.request, '@bobby-sb review this')
    assert.equal(state.reply, 'Merge: yes.[collapsed details]')
    assert.match(state.about_benny, /@bobby-sb/)
})

const replyAnswers = (asksQuestion: number, waitsForGoAhead: number): ReplyWaitAnswers => ({
    asks_question: { type: 'noul', noul: asksQuestion },
    waits_for_go_ahead: { type: 'noul', noul: waitsForGoAhead },
})

test('a reply waits when either answer reaches REPLY_WAITS_YES', () => {
    assert.equal(replyWaits(replyAnswers(REPLY_WAITS_YES, 0.1)), true)
    assert.equal(replyWaits(replyAnswers(0.1, REPLY_WAITS_YES)), true)
    // The research reply asks_question missed alone (lesson 18).
    assert.equal(replyWaits(replyAnswers(0.68, 0.94)), true)
    assert.equal(replyWaits(replyAnswers(0.9, 0.9)), true)
})

test('a reply does not wait when both answers are under REPLY_WAITS_YES', () => {
    assert.equal(replyWaits(replyAnswers(0.69, 0.69)), false)
    assert.equal(replyWaits(replyAnswers(0.02, 0.02)), false)
})

test('rule: a reply waits exactly when the higher answer reaches REPLY_WAITS_YES', () => {
    fc.assert(fc.property(probability, probability, (asksQuestion, waitsForGoAhead) =>
        replyWaits(replyAnswers(asksQuestion, waitsForGoAhead)) === (Math.max(asksQuestion, waitsForGoAhead) >= REPLY_WAITS_YES)))
})
