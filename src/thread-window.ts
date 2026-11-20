import { THREAD_STATE_TTL_MS, type Adapter, type Message, type StateAdapter } from 'chat'

// The last few messages of a subscribed thread, kept in the Chat SDK state (ChatStateDO)
// as input for the decision model. Values round-trip as JSON, so timestamps are numbers.
export type WindowMessage = {
    messageId: string
    author: string
    isBenny: boolean
    text: string
    createdAt: number
}

const WINDOW_SIZE = 20
const key = (threadId: string) => `benny:window:${threadId}`

const toWindowMessage = (m: Message): WindowMessage => ({
    messageId: m.id,
    author: m.author.userName,
    isBenny: m.author.isMe,
    text: m.text,
    createdAt: m.metadata.dateSent.getTime(),
})

// The TTL resets on every append, so the window only expires after 30 quiet days.
export const appendToWindow = (state: StateAdapter, threadId: string, msg: WindowMessage) =>
    state.appendToList(key(threadId), msg, { maxLength: WINDOW_SIZE, ttlMs: THREAD_STATE_TTL_MS })

// Reads the window; when it's empty (new subscription, or expired) it is refilled from GitHub,
// which also brings in comments posted before Benny was first mentioned.
const readWindow = async (state: StateAdapter, adapter: Adapter, threadId: string) => {
    const stored = await state.getList<WindowMessage>(key(threadId))
    if (stored.length > 0) return stored

    const { messages } = await adapter.fetchMessages(threadId, { limit: WINDOW_SIZE })
    const fetched = messages.map(toWindowMessage)
    for (const m of fetched) await appendToWindow(state, threadId, m)
    return fetched
}

// Records `message` in the window and returns the messages before it, oldest first.
export const recordMessage = async (state: StateAdapter, adapter: Adapter, threadId: string, message: Message) => {
    const window = await readWindow(state, adapter, threadId)
    if (!window.some((m) => m.messageId === message.id)) {
        await appendToWindow(state, threadId, toWindowMessage(message))
    }
    return window.filter((m) => m.messageId !== message.id)
}
