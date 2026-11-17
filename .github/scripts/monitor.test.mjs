import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  alertKeys,
  annotate,
  checkWorkflow,
  consecutiveFailures,
  failedSync,
  hasStoppedCompleting,
  isStale,
  loadRunHistory,
  parseFailureThreshold,
  reportedKeys,
  staleAfterMs,
  TransientError,
  withRetries,
} from './monitor.mjs'

const runs = (...conclusions) =>
  conclusions.map((conclusion, index) => ({
    id: index + 1,
    status: 'completed',
    conclusion,
  }))

test('detects a failed sync step even when the job and workflow succeed', async () => {
  const jobs = [
    {
      conclusion: 'success',
      steps: [{ name: 'Run sync-products action', conclusion: 'failure' }],
    },
  ]
  assert.equal(failedSync(jobs), true)
  assert.equal(await consecutiveFailures(runs('success', 'success', 'success'), async () => jobs), 3)
})

test('uses 3 by default and validates the configured threshold', () => {
  assert.equal(parseFailureThreshold(undefined), 3)
  assert.equal(parseFailureThreshold(''), 3)
  assert.equal(parseFailureThreshold('1'), 1)
  assert.equal(parseFailureThreshold('100'), 100)
  for (const value of ['0', '-1', '1.5', '3x', '101', '9007199254740992']) {
    assert.throws(() => parseFailureThreshold(value), /SYNC_FAILURE_THRESHOLD/)
  }
})

test('counts only up to the configured threshold', async () => {
  const history = runs('failure', 'failure', 'failure')
  assert.equal(await consecutiveFailures(history, async () => [], 2), 2)
  assert.equal(await consecutiveFailures(history, async () => [], 4), 3)
})

test('loads another page when unfinished runs displace failures at the threshold', async () => {
  const first = [
    { status: 'in_progress', updated_at: new Date(100).toISOString() },
    ...Array.from({ length: 99 }, (_, id) => ({
      id,
      status: 'completed',
      updated_at: new Date(99 - id).toISOString(),
    })),
  ]
  const second = [{ id: 100, status: 'completed', updated_at: new Date(0).toISOString() }]
  const pages = []
  const history = await loadRunHistory(async page => {
    pages.push(page)
    return page === 1 ? first : second
  }, 100)
  assert.deepEqual(pages, [1, 2])
  assert.equal(history.filter(run => run.status === 'completed').length, 100)
})

test('does not mistake a job without a sync step for a successful sync', () => {
  assert.equal(
    failedSync([
      {
        conclusion: 'success',
        steps: [{ name: 'Checkout', conclusion: 'success' }],
      },
    ]),
    true
  )
})

test('stops counting on a successful run and ignores incomplete runs', async () => {
  const history = runs('failure', 'failure', 'success', 'failure')
  history.splice(1, 0, { id: 5, status: 'in_progress' })
  const jobs = [
    {
      conclusion: 'success',
      steps: [{ name: 'Run sync-products action', conclusion: 'success' }],
    },
  ]
  assert.equal(await consecutiveFailures(history, async () => jobs), 2)
})

test('an older run rerun after a success counts in completion order', async () => {
  const jobs = [
    {
      conclusion: 'success',
      steps: [{ name: 'Run sync-products action', conclusion: 'success' }],
    },
  ]
  assert.equal(await consecutiveFailures(runs('failure', 'success', 'failure', 'failure'), async () => jobs), 1)
})

test('treats a failed setup and a cancellation as unsuccessful', async () => {
  assert.equal(await consecutiveFailures(runs('failure', 'cancelled', 'failure'), async () => []), 3)
})

test('alerts if no workflow started in the health window', () => {
  assert.equal(isStale([], 100000000), true)
  assert.equal(isStale([{ created_at: new Date(100000000 - staleAfterMs + 1).toISOString() }], 100000000), false)
  assert.equal(isStale([{ created_at: new Date(100000000 - staleAfterMs - 1).toISOString() }], 100000000), true)
  assert.equal(
    isStale(
      [
        { created_at: new Date(100000000 - staleAfterMs - 1).toISOString() },
        { created_at: new Date(100000000).toISOString() },
      ],
      100000000
    ),
    false
  )
})

test('alerts if recent runs have not completed', () => {
  const now = 100000000
  assert.equal(hasStoppedCompleting([{ status: 'in_progress' }], now), true)
  assert.equal(
    hasStoppedCompleting(
      [
        {
          status: 'completed',
          updated_at: new Date(now - staleAfterMs + 1).toISOString(),
        },
      ],
      now
    ),
    false
  )
  assert.equal(
    hasStoppedCompleting(
      [
        {
          status: 'completed',
          updated_at: new Date(now - staleAfterMs - 1).toISOString(),
        },
      ],
      now
    ),
    true
  )
})

test('reports the problem of an unhealthy workflow with a stable key', async () => {
  const now = 100000000
  const recent = new Date(now).toISOString()
  const history = ['failure', 'failure', 'failure'].map((conclusion, id) => ({
    id,
    status: 'completed',
    conclusion,
    created_at: recent,
    updated_at: recent,
    html_url: `run-${id}`,
  }))
  assert.deepEqual(await checkWorkflow('sync-products.yml', history, async () => [], now, 3), {
    key: 'sync-products.yml:failing',
    message: 'sync-products.yml failed 3 consecutive runs: run-0',
  })
  assert.equal(await checkWorkflow('sync-products.yml', history, async () => [], now, 4), undefined)
  assert.equal((await checkWorkflow('sync-products.yml', [], async () => [], now)).key, 'sync-products.yml:stale')
})

test('fails only for problems the previous monitor run did not report', () => {
  const problems = [
    { key: 'sync-products.yml:failing', message: 'products failed' },
    { key: 'sync-collections.yml:stale', message: 'collections stale' },
  ]
  const reported = alertKeys([
    { message: '[monitor:sync-products.yml:failing] products failed' },
    { message: 'Process completed with exit code 1.' },
  ])
  assert.deepEqual([...reported], ['sync-products.yml:failing'])
  assert.deepEqual(annotate(problems, reported), [
    '::warning::[monitor:sync-products.yml:failing] products failed (already alerted)',
    '::error::[monitor:sync-collections.yml:stale] collections stale',
  ])
})

test('alerts again after a problem clears and returns', () => {
  const problems = [{ key: 'sync-products.yml:failing', message: 'products failed' }]
  assert.deepEqual(annotate(problems, alertKeys([])), ['::error::[monitor:sync-products.yml:failing] products failed'])
})

test('tolerates the schedule delays of GitHub Actions', () => {
  const now = 100000000
  const delayed = { status: 'completed', created_at: new Date(now - 40 * 60 * 1000).toISOString() }
  delayed.updated_at = delayed.created_at
  assert.equal(isStale([delayed], now), false)
  assert.equal(hasStoppedCompleting([delayed], now), false)
})

const headers = values => ({ get: name => values[name] ?? null })

test('retries transient GitHub API errors', async () => {
  const responses = [
    () => Promise.reject(new TypeError('fetch failed')),
    () => ({ ok: false, status: 502, headers: headers({}) }),
    () => ({ ok: false, status: 429, headers: headers({}) }),
    () => ({ ok: false, status: 403, headers: headers({ 'x-ratelimit-remaining': '0' }) }),
    () => ({ ok: true, json: () => Promise.reject(new TypeError('terminated')) }),
    () => ({ ok: true, json: async () => 'body' }),
  ]
  const waits = []
  const request = async () => (responses.shift() ?? (() => Promise.reject(new TypeError('fetch failed'))))()
  assert.equal(await withRetries(request, [1, 2, 3, 4, 5], async ms => waits.push(ms), Infinity), 'body')
  assert.deepEqual(waits, [1, 2, 3, 4, 5])
  await assert.rejects(withRetries(request, [1], async () => {}, Infinity), TransientError)
})

test('gives up on transient errors at the run deadline', async () => {
  const waits = []
  const request = async () => ({ ok: false, status: 503, headers: headers({}) })
  await assert.rejects(withRetries(request, [1000], async ms => waits.push(ms), Date.now()), TransientError)
  assert.deepEqual(waits, [])
})

test('does not retry client errors', async () => {
  let calls = 0
  const request = async () => {
    calls++
    return { ok: false, status: 403, url: 'runs', headers: headers({}) }
  }
  await assert.rejects(withRetries(request, [1], async () => {}, Infinity), error => !(error instanceof TransientError))
  assert.equal(calls, 1)
})

test('reads alerts from the last monitor run that checked the sync workflows', async () => {
  const runs = [7, 6, 5, 4, 3, 2].map(id => ({ id, run_attempt: 1, status: 'completed' }))
  runs[1].status = 'in_progress'
  const jobs = {
    5: [],
    4: [{ id: 40, name: 'monitor', conclusion: 'success' }],
    3: [{ id: 30, name: 'monitor', conclusion: 'failure' }],
  }
  const annotations = {
    40: [{ message: '[monitor-skipped] GitHub API returned 502' }],
    30: [{ message: '[monitor:sync-products.yml:failing] products failed' }],
  }
  const request = async path => {
    if (path.startsWith('actions/workflows/')) return { workflow_runs: runs }
    const jobsPath = path.match(/^actions\/runs\/(\d+)\//)
    if (jobsPath) return { jobs: jobs[jobsPath[1]] }
    return annotations[path.match(/^check-runs\/(\d+)\//)[1]]
  }
  assert.deepEqual([...(await reportedKeys(request, '7', 'main'))], ['sync-products.yml:failing'])
})
