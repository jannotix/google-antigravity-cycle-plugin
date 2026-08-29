import assert from "node:assert/strict"
import { test } from "node:test"

import { parseCommand, UnsafeCommand } from "../src/workflow/commands.ts"
import { parsePlan, PlanRejected } from "../src/workflow/plan.ts"
import { route } from "../src/workflow/routing.ts"
import { parseVerdict, VerdictRejected } from "../src/workflow/verdicts.ts"

const CONTEXT = { evidenceIds: ["e1", "e2"], requirementIds: ["REQ-1", "REQ-2"], role: "arbiter" }

const verdict = (overrides: Record<string, unknown> = {}) => ({
  decision: "approved",
  findings: [],
  repair_target: null,
  requirements: [
    { evidence_ids: ["e1"], requirement_id: "REQ-1", status: "satisfied" },
    { evidence_ids: ["e2"], requirement_id: "REQ-2", status: "satisfied" },
  ],
  ...overrides,
})

test("a well-formed verdict parses", () => {
  const parsed = parseVerdict(verdict(), CONTEXT)

  assert.equal(parsed.decision, "approved")
  assert.equal(parsed.requirements.length, 2)
})

test("an extra key is rejected rather than ignored", () => {
  assert.throws(() => parseVerdict(verdict({ confidence: 0.9 }), CONTEXT), VerdictRejected)
})

// Certification 6.10.
test("a missing key is rejected", () => {
  const { findings, ...rest } = verdict()
  void findings
  assert.throws(() => parseVerdict(rest, CONTEXT), VerdictRejected)
})

// Leaving a requirement undecided is how work quietly ships unjudged.
// Certification 6.10, 6.11.
test("every requirement must be decided exactly once", () => {
  assert.throws(
    () => parseVerdict(verdict({ requirements: [verdict().requirements[0]] }), CONTEXT),
    /did not decide: REQ-2/u,
  )
  assert.throws(
    () =>
      parseVerdict(
        verdict({ requirements: [verdict().requirements[0], verdict().requirements[0]] }),
        CONTEXT,
      ),
    /more than once/u,
  )
})

test("a requirement that is not in the plan is rejected", () => {
  assert.throws(
    () =>
      parseVerdict(
        verdict({
          requirements: [
            ...verdict().requirements,
            { evidence_ids: [], requirement_id: "REQ-9", status: "satisfied" },
          ],
        }),
        CONTEXT,
      ),
    /not in the plan/u,
  )
})

// Certification 6.9.
test("evidence that was never supplied cannot be cited", () => {
  assert.throws(
    () =>
      parseVerdict(
        verdict({
          requirements: [
            { evidence_ids: ["e404"], requirement_id: "REQ-1", status: "satisfied" },
            verdict().requirements[1],
          ],
        }),
        CONTEXT,
      ),
    /cited evidence e404/u,
  )
})

test("approving with an unsatisfied requirement is rejected", () => {
  assert.throws(
    () =>
      parseVerdict(
        verdict({
          requirements: [
            { evidence_ids: ["e1"], requirement_id: "REQ-1", status: "unsatisfied" },
            verdict().requirements[1],
          ],
        }),
        CONTEXT,
      ),
    /unsatisfied requirement/u,
  )
})

test("approving with an unresolved high finding is rejected", () => {
  assert.throws(
    () =>
      parseVerdict(
        verdict({ findings: [{ evidence_ids: ["e1"], severity: "high", summary: "auth bypass" }] }),
        CONTEXT,
      ),
    /critical or high finding/u,
  )
})

test("rejecting without naming a repair target is rejected", () => {
  assert.throws(() => parseVerdict(verdict({ decision: "rejected" }), CONTEXT), /repair target/u)
})

test("approving while naming a repair target is rejected", () => {
  assert.throws(() => parseVerdict(verdict({ repair_target: "execution" }), CONTEXT), VerdictRejected)
})

test("a plan with a requirement no task implements is rejected", () => {
  assert.throws(
    () =>
      parsePlan({
        assumptions: [],
        integration_checks: [],
        risks: [],
        requirements: [
          { acceptance_criteria: ["a"], id: "REQ-1", statement: "one" },
          { acceptance_criteria: ["b"], id: "REQ-2", statement: "two" },
        ],
        tasks: [task({ requirement_ids: ["REQ-1"] })],
      }),
    /no task implements: REQ-2/u,
  )
})

test("a cyclic task graph is rejected", () => {
  assert.throws(
    () =>
      parsePlan(plan([
        task({ dependencies: ["task-2"], key: "task-1" }),
        task({ dependencies: ["task-1"], key: "task-2" }),
      ])),
    /cycle/u,
  )
})

// Two tasks writing the same place without an ordering means the second silently overwrites the
// first, and the candidate stops matching either task's evidence.
test("overlapping write scopes without an ordering are rejected", () => {
  assert.throws(
    () =>
      parsePlan(plan([
        task({ key: "task-1", write_scopes: ["src/billing"] }),
        task({ key: "task-2", write_scopes: ["src/billing/index.ts"] }),
      ])),
    /overlapping scopes/u,
  )
})

test("overlapping scopes with a dependency between them are accepted", () => {
  assert.doesNotThrow(() =>
    parsePlan(plan([
      task({ key: "task-1", write_scopes: ["src/billing"] }),
      task({ dependencies: ["task-1"], key: "task-2", write_scopes: ["src/billing/index.ts"] }),
    ])),
  )
})

test("a write scope outside the project is rejected", () => {
  for (const scope of ["/etc/passwd", "../secrets", "C:/Windows"]) {
    assert.throws(() => parsePlan(plan([task({ write_scopes: [scope] })])), PlanRejected)
  }
})

// Certification 5.13.
test("an unsafe verification command is rejected when the plan is validated", () => {
  for (const command of ["git push", "bash -c ls", "rm -rf build", "npm run deploy"]) {
    assert.throws(
      () => parsePlan(plan([task({ verification_commands: [command] })])),
      PlanRejected,
      command,
    )
  }
})

// Certification 5.12.
test("shell operators are rejected because no shell runs the command", () => {
  assert.throws(() => parseCommand("npm test && npm run lint"), UnsafeCommand)
  assert.throws(() => parseCommand("npm test | tee log"), UnsafeCommand)
})

test("a normal project command parses into program and arguments", () => {
  const parsed = parseCommand('npm run "test:integration"')

  assert.equal(parsed.program, "npm")
  assert.deepEqual(parsed.arguments, ["run", "test:integration"])
})

test("auto routing sends a localised change to the quick route", () => {
  const decision = route("rename the helper in the date utils", ["src/date.ts"], "auto")

  assert.equal(decision.mode, "quick")
  assert.deepEqual(decision.critical, [])
})

test("auto routing promotes a critical change to the full route", () => {
  assert.equal(route("add oauth login", ["src/auth.ts"], "auto").mode, "full")
  assert.equal(route("tidy up", ["migrations/003_add.sql"], "auto").mode, "full")
  assert.equal(route("bump deps", ["package.json"], "auto").mode, "full")
})

// A rule that fires on "api" or "update" would send everything to the full cycle and make the
// quick route decoration.
test("ordinary words do not trigger the full route", () => {
  for (const text of [
    "update the readme",
    "add an api endpoint that returns the build version",
    "install the new icon set",
  ]) {
    assert.equal(route(text, ["docs/readme.md"], "auto").mode, "quick", text)
  }
})

test("an explicit full request is honoured and marked as user-promoted", () => {
  const decision = route("rename a variable", ["src/a.ts"], "full")

  assert.equal(decision.mode, "full")
  assert.equal(decision.userPromoted, true)
})

test("a quick request over a critical change is honoured but the signal is recorded", () => {
  const decision = route("add oauth login", ["src/auth.ts"], "quick")

  assert.equal(decision.mode, "quick")
  assert.ok(decision.critical.includes("authentication"))
  assert.match(decision.rationale, /despite/u)
})

function task(overrides: Record<string, unknown> = {}) {
  return {
    acceptance_criteria: ["it works"],
    dependencies: [],
    key: "task-1",
    objective: "do the thing",
    requirement_ids: ["REQ-1"],
    title: "Task",
    verification_commands: ["npm test"],
    write_scopes: ["src"],
    ...overrides,
  }
}

function plan(tasks: unknown[]) {
  return {
    assumptions: [],
    integration_checks: [],
    requirements: [{ acceptance_criteria: ["a"], id: "REQ-1", statement: "one" }],
    risks: [],
    tasks,
  }
}

const SECURITY = {
  evidenceIds: ["e1", "e2", "proof-1"],
  proofIds: ["proof-1"],
  requirementIds: ["REQ-1", "REQ-2"],
  requiresProof: true,
  role: "security_reviewer",
}

const alarm = (evidenceIds: string[]) =>
  verdict({
    decision: "rejected",
    findings: [{ evidence_ids: evidenceIds, severity: "critical", summary: "sql injection in login" }],
    repair_target: "execution",
    requirements: [
      { evidence_ids: [], requirement_id: "REQ-1", status: "unsatisfied" },
      { evidence_ids: [], requirement_id: "REQ-2", status: "satisfied" },
    ],
  })

// Section 7.7: a vulnerability class nobody demonstrated is a suspicion, and it is reported as one.
test("an unproven critical from the security reviewer is downgraded, not deleted", () => {
  const parsed = parseVerdict(alarm(["e1"]), SECURITY)

  assert.equal(parsed.findings[0]?.severity, "info")
  assert.equal(parsed.findings[0]?.summary, "unproven: sql injection in login")
})

test("a critical backed by a demonstrated proof keeps its severity", () => {
  const parsed = parseVerdict(alarm(["proof-1"]), SECURITY)

  assert.equal(parsed.findings[0]?.severity, "critical")
  assert.equal(parsed.findings[0]?.summary, "sql injection in login")
})

// The rule exists because the security reviewer can execute proofs. It does not gag anyone else.
test("the proof requirement applies to the security reviewer alone", () => {
  const parsed = parseVerdict(alarm(["e1"]), { ...SECURITY, requiresProof: false, role: "arbiter" })

  assert.equal(parsed.findings[0]?.severity, "critical")
})

test("a downgraded finding no longer blocks an approval", () => {
  const parsed = parseVerdict(
    verdict({
      findings: [{ evidence_ids: ["e1"], severity: "high", summary: "possible xss" }],
    }),
    SECURITY,
  )

  assert.equal(parsed.decision, "approved")
  assert.equal(parsed.findings[0]?.severity, "info")
})

test("a proven high finding still blocks an approval", () => {
  assert.throws(
    () =>
      parseVerdict(
        verdict({ findings: [{ evidence_ids: ["proof-1"], severity: "high", summary: "xss" }] }),
        SECURITY,
      ),
    /critical or high finding/u,
  )
})

// Routing ran on English keywords and on a path list no caller ever supplied, so a payments change
// described in any other language, or a migration named in the request itself, took the quick route
// with no independent review and nothing anywhere saying a guard had been skipped.
test("a critical signal is read in the language the request was written in", () => {
  assert.deepEqual(route("aggiungi il pagamento con Stripe", [], "auto").critical, ["payments"])
  assert.deepEqual(route("corrige la autenticacion del usuario", [], "auto").critical, ["authentication"])
  assert.equal(route("update the readme typo", [], "auto").mode, "quick")
})

test("a path named in the request is routed on", () => {
  assert.deepEqual(route("apply db/migrations/003_users.sql", [], "auto").critical, ["persistence"])
  assert.deepEqual(route("bump package.json", [], "auto").critical, ["dependencies"])
  assert.equal(route("rename the local variable", [], "auto").mode, "quick")
})
