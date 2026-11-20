#!/usr/bin/env node
// Send a signed, synthetic GitHub `issue_comment` webhook to the local dev server.
// Useful for iterating on bot behaviour without hand-tagging issues on GitHub.
//
//   pnpm webhook:test owner/repo 31 "@bobby-sb ping"
//   pnpm webhook:test owner/repo 12 "hello" --port 8788 --installation 12345678
//
// The bot replies through the real GitHub API, so use a throwaway issue/PR.
// The installation id comes from GITHUB_INSTALLATION_ID in .env unless passed.

import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'

const args = process.argv.slice(2)
const flag = (name) => {
	const index = args.indexOf(`--${name}`)
	return index > -1 ? args[index + 1] : undefined
}

const port = flag('port') ?? '8787'
const skipIndexes = new Set()
for (const name of ['port', 'installation']) {
	const index = args.indexOf(`--${name}`)
	if (index > -1) skipIndexes.add(index + 1)
}
const positional = args.filter((arg, index) => !arg.startsWith('--') && !skipIndexes.has(index))
const [repoArg, numberArg, ...bodyParts] = positional

if (!repoArg || !numberArg) {
	console.error('usage: pnpm webhook:test <owner/repo> <issue-or-pr-number> [comment body] [--port 8787] [--installation <id>]')
	process.exit(1)
}

const [owner, repo] = repoArg.split('/')
if (!owner || !repo) {
	console.error(`expected owner/repo, got "${repoArg}"`)
	process.exit(1)
}

const vars = {}
const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf8')
// handles both `KEY=value` and multi-line `KEY="..."`
for (const match of envFile.matchAll(/^([A-Z0-9_]+)=("?)([\s\S]*?)\2(?=\n[A-Z0-9_]+=|\n*$)/gm)) {
	vars[match[1]] = match[3]
}

const secret = vars.GITHUB_WEBHOOK_SECRET
if (!secret) {
	console.error('GITHUB_WEBHOOK_SECRET not found in .env')
	process.exit(1)
}

const installationId = Number(flag('installation') ?? vars.GITHUB_INSTALLATION_ID)
if (!installationId) {
	console.warn('no installation id (set GITHUB_INSTALLATION_ID in .env or pass --installation); the reply will likely fail')
}

const now = new Date().toISOString()
const payload = {
	action: 'created',
	issue: { number: Number(numberArg), pull_request: { url: '' } },
	comment: {
		id: Number(String(Date.now()).slice(-9)),
		body: bodyParts.join(' ') || '@bobby-sb ping',
		user: { id: 1, login: 'local-tester', type: 'User' },
		created_at: now,
		updated_at: now,
	},
	repository: { name: repo, owner: { id: 1, login: owner, type: 'User' } },
	sender: { id: 1, login: 'local-tester', type: 'User' },
	...(installationId ? { installation: { id: installationId } } : {}),
}

const body = JSON.stringify(payload)
const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
const url = `http://localhost:${port}/api/webhooks/github`

const response = await fetch(url, {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		'x-github-event': 'issue_comment',
		'x-github-delivery': `local-${Date.now()}`,
		'x-hub-signature-256': signature,
	},
	body,
})

console.log(`POST ${url} -> ${response.status} ${await response.text()}`)
console.log(`handlers run in the background; watch the pnpm dev logs and https://github.com/${owner}/${repo}/issues/${numberArg}`)
