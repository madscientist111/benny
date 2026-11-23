import { httpStatus } from './github-contract'
import type { Octokit } from './github-tools'
import { log, type LogIds } from './log'
import { SCHEDULED_PREFIX, withoutTitleMark, withTitleMark } from './title-marks'

// The scheduled mark (`docs/crons/plan.md`, requirement 22): a `[SCHEDULED] ` title prefix plus a
// `scheduled` label on an issue whose cron will fire again. `PiAgent` puts it on or takes it off
// whenever its cron's status changes; the cron record says whether it is on, so no flag is kept.

const SCHEDULED_LABEL = 'scheduled'
const LABEL_COLOR = '0075ca'

/**
 * Puts the mark on the issue when `scheduled`, else takes it off; the waiting mark's prefix stays.
 * A failure is logged, never thrown, and `octokit` is called inside, so a missing installation
 * cannot throw either: the mark never fails `set_cron`, a firing or a reply.
 */
export const updateScheduledMark = async (
    octokit: () => Promise<Octokit>,
    target: { owner: string; repo: string; number: number },
    scheduled: boolean,
    logIds: LogIds & { cronId: string },
) => {
    const { owner, repo, number } = target
    try {
        const client = await octokit()
        const { data: issue } = await client.issues.get({ owner, repo, issue_number: number })
        const title = scheduled ? withTitleMark(issue.title, SCHEDULED_PREFIX) : withoutTitleMark(issue.title, SCHEDULED_PREFIX)
        if (title !== issue.title) await client.issues.update({ owner, repo, issue_number: number, title })
        if (scheduled) {
            try {
                await client.issues.createLabel({ owner, repo, name: SCHEDULED_LABEL, color: LABEL_COLOR, description: 'Benny has a cron here that will fire again' })
            } catch (error) {
                // 422: the label is already in the repo.
                if (httpStatus(error) !== 422) throw error
            }
            await client.issues.addLabels({ owner, repo, issue_number: number, labels: [SCHEDULED_LABEL] })
        } else {
            try {
                await client.issues.removeLabel({ owner, repo, issue_number: number, name: SCHEDULED_LABEL })
            } catch (error) {
                // 404: the label was not on the issue.
                if (httpStatus(error) !== 404) throw error
            }
        }
        log(scheduled ? 'scheduled mark set' : 'scheduled mark cleared', { ...logIds, repo: `${owner}/${repo}`, number })
    } catch (error) {
        log(scheduled ? 'scheduled mark set failed' : 'scheduled mark clear failed', { ...logIds, repo: `${owner}/${repo}`, number, error: String(error) })
    }
}
