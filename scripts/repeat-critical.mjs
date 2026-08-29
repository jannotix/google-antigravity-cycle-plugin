import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readConfiguration } from '../dist/config.js'
import { Database } from '../dist/store/database.js'
import { arbitrate, control, freezeCandidate, reportTask, startWorkflow, submitPlan, submitReviewVerdict, verifyCandidate } from '../dist/workflow/service.js'

const output = join(process.cwd(), 'certification-artifacts')
mkdirSync(output, { recursive: true })
const runs = []

for (let iteration = 1; iteration <= 20; iteration += 1) {
  const startedAt = Date.now()
  const dataDirectory = mkdtempSync(join(tmpdir(), `cycle-repeat-${iteration}-`))
  const database = new Database({ path: ':memory:' })
  const ctx = { configuration: readConfiguration({}), database, dataDirectory, maxRepairCycles: 5, projectId: `repeat-${iteration}` }
  try {
    const started = startWorkflow(ctx, `repeat-critical workflow ${iteration}`, ['src/repeat.ts'], 'full')
    const workflowId = started.workflowId
    submitPlan(ctx, workflowId, plan())
    reportTask(ctx, workflowId, 'task-1', 'completed', 'deterministic executor result')
    freezeCandidate(ctx, workflowId, candidate(iteration, 1))
    verifyCandidate(ctx, workflowId, { evidenceIds: ['e1'], mandatoryPassed: true, reason: 'deterministic gates passed' })
    submitReviewVerdict(ctx, workflowId, 'functional_reviewer', approval())
    submitReviewVerdict(ctx, workflowId, 'security_reviewer', approval())

    let repaired = false
    if (iteration % 5 === 0) {
      const rejected = arbitrate(ctx, workflowId, rejection(), true)
      if (rejected.state !== 'repair') throw new Error(`expected repair, got ${rejected.state}`)
      const resumed = control(ctx, workflowId, 'repair')
      if (resumed.state !== 'execution') throw new Error(`expected execution repair, got ${resumed.state}`)
      reportTask(ctx, workflowId, 'task-1', 'completed', 'deterministic repaired result')
      freezeCandidate(ctx, workflowId, candidate(iteration, 2))
      verifyCandidate(ctx, workflowId, { evidenceIds: ['e2'], mandatoryPassed: true, reason: 'repair gates passed' })
      submitReviewVerdict(ctx, workflowId, 'functional_reviewer', approval())
      submitReviewVerdict(ctx, workflowId, 'security_reviewer', approval())
      repaired = true
    }

    const final = arbitrate(ctx, workflowId, approval(), true)
    if (final.state !== 'delivery') throw new Error(`expected delivery, got ${final.state}`)
    runs.push({ durationMs: Date.now() - startedAt, iteration, repaired, state: final.state, status: 'PASS', workflowId })
  } catch (error) {
    runs.push({ durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error), iteration, status: 'FAIL' })
  } finally {
    database.close()
    rmSync(dataDirectory, { recursive: true, force: true })
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  scope: 'deterministic-control-plane',
  limitations: ['does not invoke credentialed Antigravity models', 'does not replace Windows or Linux clean-install certification'],
  passed: runs.filter((run) => run.status === 'PASS').length,
  failed: runs.filter((run) => run.status === 'FAIL').length,
  runs,
}
writeFileSync(join(output, 'repeat-critical.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`repeat-critical: ${report.passed}/20 passed, ${report.failed} failed`)
if (report.failed !== 0) process.exit(1)

function plan() {
  return {
    assumptions: [], integration_checks: ['deterministic integration'], risks: [],
    requirements: [{ acceptance_criteria: ['recorded evidence'], id: 'REQ-1', statement: 'complete one governed change' }],
    tasks: [{ acceptance_criteria: ['recorded evidence'], dependencies: [], key: 'task-1', objective: 'exercise the workflow', requirement_ids: ['REQ-1'], title: 'Repeat task', verification_commands: ['node --version'], write_scopes: ['src/repeat.ts'] }],
  }
}
function approval() { return { decision: 'approved', findings: [], repair_target: null, requirements: [{ evidence_ids: [], requirement_id: 'REQ-1', status: 'satisfied' }] } }
function rejection() { return { decision: 'rejected', findings: [{ evidence_ids: [], severity: 'high', summary: 'forced repair exercise' }], repair_target: 'execution', requirements: [{ evidence_ids: [], requirement_id: 'REQ-1', status: 'unsatisfied' }] } }
function candidate(iteration, cycle) {
  return { manifest: { baseRevision: '0'.repeat(40), candidateDigest: `candidate-${iteration}-${cycle}`, configurationDigest: 'config', dependencyStateDigest: 'deps', diffDigest: `diff-${iteration}-${cycle}`, environmentDigest: 'environment', evidenceIds: [], files: [] }, payloads: new Map() }
}
