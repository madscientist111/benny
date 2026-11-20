import { DirectoryBackup, type DirectoryBackupRecord } from '@cloudflare/sandbox'
import { log } from './log'
import { CACHE_BUCKET_BINDING, type InstallContext, type InstallResult } from './sandbox-contract'
import { runCommand } from './sandbox-shell'

// The dependency install of a sandbox start. The package store is cached in R2 under the
// lockfile's hash, so a repo whose lockfile did not change installs from the cache.

// One row per package manager: the lockfile, the store and the install commands differ only in
// these values.
const DEPENDENCY_MANAGERS = [
    {
        name: 'pnpm',
        lockfile: 'pnpm-lock.yaml',
        storeKind: 'pnpm-store',
        storeDir: '/var/pnpm-store',
        preferOfflineInstall: 'pnpm install --prefer-offline --frozen-lockfile --store-dir /var/pnpm-store',
        onlineInstall: 'pnpm install --frozen-lockfile --store-dir /var/pnpm-store',
    },
    {
        name: 'npm',
        lockfile: 'package-lock.json',
        storeKind: 'npm-cache',
        storeDir: '/root/.npm',
        // npm's install already prefers its cache, so a restore only saves it the downloads.
        preferOfflineInstall: 'npm ci --prefer-offline --cache /root/.npm',
        onlineInstall: 'npm ci --prefer-offline --cache /root/.npm',
    },
] as const

/**
 * Installs the repo's dependencies in a running container: from the R2 store keyed by the lockfile
 * hash when its record restores, else once through the registry proxy, then saves the new store
 * (requirements 11, 12).
 */
export const installDependencies = async (context: InstallContext): Promise<InstallResult> => {
    const installStartedAt = Date.now()
    const { container, gateway, bucket, repoDir, runId } = context

    // Exit code 1 only says the last lockfile is absent; the echoed names hold the answer.
    const lockfileCheck = await runCommand(
        container,
        DEPENDENCY_MANAGERS.map(({ name, lockfile }) => `test -f ${lockfile} && echo ${name}`).join('; '),
        { cwd: repoDir, timeoutSeconds: 600 },
    )
    const foundManagers = lockfileCheck.stdout.split('\n')
    const manager = DEPENDENCY_MANAGERS.find(({ name }) => foundManagers.includes(name))
    if (!manager) return { manager: null, cache: 'none', installMs: 0 }

    // Hashed in the container, so the key names the exact lockfile the install reads, PR edits included.
    const lockfileHash = await runCommand(container, `sha256sum ${manager.lockfile}`, { cwd: repoDir, timeoutSeconds: 600 })
    const key = lockfileHash.stdout.trim().split(/\s+/)[0] ?? ''
    if (lockfileHash.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(key)) {
        throw new Error(`Cannot hash ${manager.lockfile} (exit code ${lockfileHash.exitCode}): ${lockfileHash.stderr.trim()}`)
    }

    const prefix = `${manager.storeKind}/${key}/`
    const directoryBackup = new DirectoryBackup(container, gateway, { binding: CACHE_BUCKET_BINDING, prefix })

    // The record the restore read, kept so a save that replaces it can delete its object: one
    // lockfile key must never hold two stores. A record that does not parse names no object.
    let previousRecord: DirectoryBackupRecord | undefined
    // A missing, unreadable or failed record is a miss: the online install below still runs.
    const restoreStartedAt = Date.now()
    let restored = false
    try {
        const recordObject = await bucket.get(`${prefix}record.json`)
        if (recordObject) {
            const record = await recordObject.json<DirectoryBackupRecord>()
            previousRecord = record
            await directoryBackup.restore(record, { dir: manager.storeDir })
            restored = true
        }
    } catch (error) {
        log('install restore failed', { runId, manager: manager.name, key: key.slice(0, 12), error: String(error) })
    }
    // Covers the lookup and the restore: what the cache path costs before any install runs.
    const restoreMs = Date.now() - restoreStartedAt

    let saved = false
    let cache: 'hit' | 'miss' = 'miss'
    if (restored) {
        // The store holds the packages, so this install fetches only what it lacks: pnpm's own
        // binary, when the lockfile's `packageManager` names a version the image does not carry.
        const restoredInstall = await runCommand(container, manager.preferOfflineInstall, { cwd: repoDir, timeoutSeconds: 600 })
        if (restoredInstall.exitCode === 0) cache = 'hit'
    }

    if (cache === 'miss') {
        const onlineInstall = await runCommand(container, manager.onlineInstall, { cwd: repoDir, timeoutSeconds: 600 })
        if (onlineInstall.exitCode !== 0) {
            // pnpm prints its errors (`ERR_PNPM_...`) to stdout, so fall back to it when stderr is empty.
            const reason = (onlineInstall.stderr.trim() || onlineInstall.stdout).slice(-2048)
            throw new Error(`${manager.name} install failed (exit code ${onlineInstall.exitCode}): ${reason}`)
        }
        // A store that restored stays the one later runs read, so this run saves nothing: only a
        // run with no usable record fills the key, and it deletes the object its record replaced,
        // so one key never holds two 250 MB stores.
        if (!restored) {
            // The installed dependencies are correct even when the cache write fails.
            try {
                const record = await directoryBackup.backup({ dir: manager.storeDir })
                await bucket.put(`${prefix}record.json`, JSON.stringify(record))
                saved = true
            } catch (error) {
                log('install backup failed', { runId, manager: manager.name, key: key.slice(0, 12), error: String(error) })
            }
            if (saved && previousRecord) {
                try {
                    await directoryBackup.delete(previousRecord)
                } catch (error) {
                    log('install replaced backup delete failed', {
                        runId, manager: manager.name, key: key.slice(0, 12),
                        replacedRecordId: previousRecord.id,
                        error: String(error),
                    })
                }
            }
        }
    }

    const installMs = Date.now() - installStartedAt
    log('install', { runId, manager: manager.name, cache, key: key.slice(0, 12), restoreMs, installMs, saved })
    return { manager: manager.name, cache, installMs }
}
