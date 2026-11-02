import { readFile } from 'node:fs/promises'

export const workflows = ['sync-products.yml', 'sync-collections.yml']
export const parseFailureThreshold = value => {
  if (value === undefined || value === '') return 3
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 100)
    throw new Error('SYNC_FAILURE_THRESHOLD must be an integer between 1 and 100')
  return Number(value)
}
export const failureThreshold = parseFailureThreshold(process.env.SYNC_FAILURE_THRESHOLD)
export const staleAfterMs = 30 * 60 * 1000

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

const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REF_NAME } = process.env

const api = async path => {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${path}`)
  return response.json()
}

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

const main = async () => {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !GITHUB_EVENT_PATH || !GITHUB_REF_NAME)
    throw new Error('Missing GitHub event credentials')

  if (GITHUB_EVENT_NAME === 'schedule' || GITHUB_EVENT_NAME === 'workflow_dispatch') {
    for (const workflow of workflows) {
      const runs = await runsFor(workflow)
      if (isStale(runs)) throw new Error(`${workflow} has not started for at least 30 minutes`)
      if (hasStoppedCompleting(runs)) throw new Error(`${workflow} has not completed for at least 30 minutes`)
      const failures = await consecutiveFailures(runs, jobsFor)
      if (failures >= failureThreshold) throw new Error(`${workflow} has failed ${failures} consecutive runs`)
      console.log(`${workflow}: ${failures} consecutive unsuccessful runs`)
    }
    return
  }

  const { workflow_run: event } = JSON.parse(await readFile(GITHUB_EVENT_PATH, 'utf8'))
  if (event.head_branch !== GITHUB_REF_NAME) return
  const workflow = workflows.find(name => event.path?.includes(`.github/workflows/${name}`))
  if (!workflow) throw new Error(`Unexpected workflow: ${event.path}`)

  const history = await runsFor(workflow)
  const latest = history.find(run => run.status === 'completed')
  if (!latest) throw new Error(`Cannot find completed runs for ${workflow}`)
  if (latest.id !== event.id || latest.run_attempt !== event.run_attempt) {
    console.log(`Run ${event.id} was superseded by run ${latest.id}`)
    return
  }

  const failures = await consecutiveFailures(history, jobsFor)
  console.log(`${workflow}: ${failures} consecutive unsuccessful runs`)
  if (failures >= failureThreshold) {
    throw new Error(`${workflow} failed ${failures} consecutive runs: ${event.html_url}`)
  }
}

if (process.argv[1]?.endsWith('monitor.mjs')) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
