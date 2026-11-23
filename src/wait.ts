/** Resolves after `ms` milliseconds. Used by `AgentDO` and `ClaudeCodeRun`, which poll. */
export const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
