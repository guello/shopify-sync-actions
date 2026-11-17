import { readFile } from 'node:fs/promises'

export const workflows = ['sync-products.yml', 'sync-collections.yml']
export const parseFailureThreshold = value => {
  if (value === undefined || value === '') return 3
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 100)
    throw new Error('SYNC_FAILURE_THRESHOLD must be an integer between 1 and 100')
  return Number(value)
}
export const failureThreshold = parseFailureThreshold(process.env.SYNC_FAILURE_THRESHOLD)
export const staleAfterMs = 2 * 60 * 60 * 1000
export const retryDelaysMs = [5_000, 15_000, 30_000]
export const requestTimeoutMs = 20_000
export const runDeadline = Date.now() + 3 * 60 * 1000
export const monitorWorkflow = 'monitor.yml'
export const monitorJob = 'monitor'

const alertTag = /\[monitor:([^\]]+)\]/
export const skippedTag = '[monitor-skipped]'

export class TransientError extends Error {}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Returns the problem of a sync workflow, or undefined when it is healthy.
 */
export const checkWorkflow = async (workflow, runs, getJobs, now = Date.now(), threshold = failureThreshold) => {
  if (isStale(runs, now))
    return { key: `${workflow}:stale`, message: `${workflow} has not started for at least 2 hours` }
  if (hasStoppedCompleting(runs, now))
    return { key: `${workflow}:stopped`, message: `${workflow} has not completed for at least 2 hours` }
  const failures = await consecutiveFailures(runs, getJobs, threshold)
  console.log(`${workflow}: ${failures} consecutive unsuccessful runs`)
  if (failures < threshold) return
  const latest = runs.find(run => run.status === 'completed')
  return {
    key: `${workflow}:failing`,
    message: `${workflow} failed ${failures} consecutive runs: ${latest.html_url}`,
  }
}

/**
 * Reads the alert keys tagged in the annotations of a monitor run.
 */
export const alertKeys = annotations =>
  new Set(annotations.map(({ message }) => message?.match(alertTag)?.[1]).filter(Boolean))

/**
 * Formats problems as annotations: new problems are errors, problems already reported by the previous run are warnings.
 */
export const annotate = (problems, reported) =>
  problems.map(({ key, message }) =>
    reported.has(key) ? `::warning::[monitor:${key}] ${message} (already alerted)` : `::error::[monitor:${key}] ${message}`
  )

export const failedSync = jobs =>
  jobs.some(job => {
    const sync = job.steps?.find(step => step.name?.startsWith('Run sync-'))
    return job.conclusion !== 'success' || !sync || sync.conclusion !== 'success'
  })

export const consecutiveFailures = async (runs, getJobs, threshold = failureThreshold) => {
  let failures = 0
  for (const run of runs) {
    if (run.status !== 'completed') continue
    if (run.conclusion === 'success' && !failedSync(await getJobs(run.id, run.run_attempt))) break
    failures++
    if (failures === threshold) break
  }
  return failures
}

export const isStale = (runs, now = Date.now()) =>
  !runs.length || now - Math.max(...runs.map(run => Date.parse(run.created_at))) > staleAfterMs

export const hasStoppedCompleting = (runs, now = Date.now()) => {
  const completed = runs.find(run => run.status === 'completed')
  return !completed || now - Date.parse(completed.updated_at) > staleAfterMs
}

export const loadRunHistory = async (getPage, threshold = failureThreshold) => {
  const runs = []
  for (let page = 1; page <= 10; page++) {
    const next = await getPage(page)
    runs.push(...next)
    if (runs.filter(run => run.status === 'completed').length >= threshold || next.length < 100)
      return runs.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  }
  throw new Error('Cannot inspect enough completed workflow runs')
}

const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REF_NAME, GITHUB_RUN_ID } =
  process.env

/**
 * Retries a request on network errors, rate limits, and server errors, then throws a TransientError.
 */
export const withRetries = async (request, delays = retryDelaysMs, wait = sleep, deadline = runDeadline) => {
  for (let attempt = 0; ; attempt++) {
    let failure
    try {
      const response = await request()
      if (response.ok) return await response.json()
      failure = `GitHub API returned ${response.status} for ${response.url}`
      if (!isTransientStatus(response)) throw new Error(failure)
    } catch (error) {
      if (!(error instanceof TypeError) && !['TimeoutError', 'AbortError'].includes(error.name)) throw error
      failure = `GitHub API is unreachable: ${error.message}`
    }
    if (attempt >= delays.length || Date.now() + delays[attempt] > deadline) throw new TransientError(failure)
    await wait(delays[attempt])
  }
}

const isTransientStatus = ({ status, headers }) =>
  status === 429 ||
  status >= 500 ||
  (status === 403 && (headers?.get('retry-after') !== null || headers?.get('x-ratelimit-remaining') === '0'))

const api = path =>
  withRetries(() =>
    fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    })
  )

const runsFor = workflow =>
  loadRunHistory(async page => {
    const { workflow_runs: runs } = await api(
      `actions/workflows/${workflow}/runs?per_page=100&page=${page}&branch=${encodeURIComponent(GITHUB_REF_NAME)}`
    )
    return runs
  })

const jobsFor = async (id, attempt) => {
  const { jobs, total_count: count } = await api(`actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`)
  if (!jobs.length || count > jobs.length) throw new Error(`Cannot inspect all jobs for run ${id}`)
  return jobs
}

/**
 * Finds the alert keys reported by the last monitor job that checked the sync workflows before this run.
 */
export const reportedKeys = async (request = api, runId = GITHUB_RUN_ID, ref = GITHUB_REF_NAME) => {
  const { workflow_runs: runs } = await request(
    `actions/workflows/${monitorWorkflow}/runs?per_page=50&branch=${encodeURIComponent(ref)}`
  )
  for (const run of runs) {
    if (String(run.id) === runId || run.status !== 'completed') continue
    const { jobs } = await request(`actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`)
    const job = jobs.find(({ name }) => name === monitorJob)
    if (!['success', 'failure'].includes(job?.conclusion)) continue
    const annotations = await request(`check-runs/${job.id}/annotations?per_page=100`)
    if (annotations.some(({ message }) => message?.includes(skippedTag))) continue
    return alertKeys(annotations)
  }
  return new Set()
}

const main = async () => {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_EVENT_PATH || !GITHUB_REF_NAME || !GITHUB_RUN_ID)
    throw new Error('Missing GitHub event credentials')

  if (GITHUB_EVENT_NAME === 'workflow_run') {
    const { workflow_run: event } = JSON.parse(await readFile(GITHUB_EVENT_PATH, 'utf8'))
    if (event.head_branch !== GITHUB_REF_NAME) return console.log(`::notice::${skippedTag} run on another branch`)
  }

  const problems = []
  for (const workflow of workflows) {
    const problem = await checkWorkflow(workflow, await runsFor(workflow), jobsFor)
    if (problem) problems.push(problem)
  }

  if (!problems.length) return
  const reported = await reportedKeys().catch(error => {
    if (!(error instanceof TransientError)) throw error
    console.log(`::warning::Cannot read previous alerts, so ongoing problems may alert again: ${error.message}`)
    return new Set()
  })
  for (const line of annotate(problems, reported)) console.log(line)
  if (problems.some(({ key }) => !reported.has(key))) process.exitCode = 1
}

if (process.argv[1]?.endsWith('monitor.mjs')) {
  main().catch(error => {
    if (!(error instanceof TransientError)) {
      console.error(error)
      process.exitCode = 1
      return
    }
    console.log(`::warning::${skippedTag} ${error.message}; the next run checks again`)
  })
}
