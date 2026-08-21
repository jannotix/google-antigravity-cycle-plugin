import type { Database, Row } from "./database.ts"
import { DIGEST_DOMAIN, digest, newId } from "./ids.ts"

export type GoalState =
  | "aborted"
  | "active"
  | "blocked"
  | "completed"
  | "completing"
  | "draft"
  | "paused"
  | "planning"
  | "ready"

export type MilestoneState = "abandoned" | "active" | "completed" | "pending"

export interface Amendment {
  readonly receivedAt: number
  readonly sequence: number
  readonly text: string
}

export interface Milestone {
  readonly createdAt: number
  readonly name: string
  readonly state: MilestoneState
  readonly workflowId: string | null
}

export interface Goal {
  readonly amendments: readonly Amendment[]
  readonly blockedFrom: GoalState | null
  readonly constraints: readonly string[]
  readonly continuations: number
  readonly createdAt: number
  readonly focused: boolean
  readonly id: string
  readonly maxContinuations: number
  readonly nonGoals: readonly string[]
  /** Immutable. A clarification is an appended amendment, never a rewrite. */
  readonly objective: string
  readonly objectiveDigest: string
  readonly pausedFrom: GoalState | null
  readonly projectId: string
  readonly state: GoalState
  readonly successCriteria: readonly string[]
  readonly updatedAt: number
}

export interface GoalDefinition {
  readonly constraints: readonly string[]
  readonly maxContinuations: number
  readonly nonGoals: readonly string[]
  readonly objective: string
  readonly successCriteria: readonly string[]
}

export interface PlanVersion {
  readonly content: string
  readonly createdAt: number
  readonly sourceSessionId: string | null
  readonly version: number
}

export function createGoal(
  database: Database,
  projectId: string,
  definition: GoalDefinition,
  now: number,
): string {
  const id = newId()
  database.run(
    `insert into goals (
       id, project_id, objective, objective_digest, state, constraints, non_goals,
       success_criteria, amendments, continuations, max_continuations, created_at, updated_at
     ) values (?, ?, ?, ?, 'draft', ?, ?, ?, '[]', 0, ?, ?, ?)`,
    id,
    projectId,
    definition.objective,
    digest(DIGEST_DOMAIN.goal, { objective: definition.objective }),
    JSON.stringify([...definition.constraints]),
    JSON.stringify([...definition.nonGoals]),
    JSON.stringify([...definition.successCriteria]),
    definition.maxContinuations,
    now,
    now,
  )
  return id
}

export function loadGoal(database: Database, id: string): Goal | undefined {
  const row = database.get<Row>("select * from goals where id = ?", id)
  return row === undefined ? undefined : toGoal(row)
}

export function listGoals(database: Database, projectId: string, limit = 50): Goal[] {
  return database
    .all<Row>(
      "select * from goals where project_id = ? order by updated_at desc limit ?",
      projectId,
      limit,
    )
    .map(toGoal)
}

/** One goal per project is focused at a time: focusing one releases whichever held it. */
export function focusGoal(database: Database, projectId: string, id: string, now: number): void {
  database.transaction(() => {
    database.run(
      "update goals set focused_session = null, updated_at = ? where project_id = ? and focused_session is not null",
      now,
      projectId,
    )
    database.run(
      "update goals set focused_session = 'project', updated_at = ? where id = ?",
      now,
      id,
    )
  })
}

export function focusedGoal(database: Database, projectId: string): Goal | undefined {
  const row = database.get<Row>(
    "select * from goals where project_id = ? and focused_session is not null limit 1",
    projectId,
  )
  return row === undefined ? undefined : toGoal(row)
}

export function saveGoalState(
  database: Database,
  id: string,
  state: GoalState,
  fields: { blockedFrom?: GoalState | null; continuations?: number; maxContinuations?: number; pausedFrom?: GoalState | null },
  now: number,
): void {
  const goal = loadGoal(database, id)
  if (goal === undefined) return
  database.run(
    `update goals set state = ?, continuations = ?, max_continuations = ?,
       paused_from = ?, blocked_from = ?, updated_at = ? where id = ?`,
    state,
    fields.continuations ?? goal.continuations,
    fields.maxContinuations ?? goal.maxContinuations,
    fields.pausedFrom === undefined ? goal.pausedFrom : fields.pausedFrom,
    fields.blockedFrom === undefined ? goal.blockedFrom : fields.blockedFrom,
    now,
    id,
  )
}

export function amendGoal(database: Database, id: string, text: string, now: number): Amendment {
  const goal = loadGoal(database, id)
  if (goal === undefined) throw new Error(`unknown goal: ${id}`)

  const amendment: Amendment = {
    receivedAt: now,
    sequence: goal.amendments.length + 1,
    text,
  }
  database.run(
    "update goals set amendments = ?, updated_at = ? where id = ?",
    JSON.stringify([...goal.amendments, amendment]),
    now,
    id,
  )
  return amendment
}

export function saveGoalPlan(
  database: Database,
  id: string,
  content: string,
  sourceSessionId: string | null,
  now: number,
): number {
  return database.transaction(() => {
    const head = database.get<{ version: number }>(
      "select max(version) as version from goal_plans where goal_id = ?",
      id,
    )
    const version = (head?.version ?? 0) + 1
    database.run(
      "insert into goal_plans (goal_id, version, content, source_session_id, created_at) values (?, ?, ?, ?, ?)",
      id,
      version,
      content,
      sourceSessionId,
      now,
    )
    return version
  })
}

export function goalPlans(database: Database, id: string): PlanVersion[] {
  return database
    .all<Row>("select * from goal_plans where goal_id = ? order by version", id)
    .map((row) => ({
      content: String(row["content"]),
      createdAt: Number(row["created_at"]),
      sourceSessionId: (row["source_session_id"] as string | null) ?? null,
      version: Number(row["version"]),
    }))
}

export function addMilestone(
  database: Database,
  id: string,
  name: string,
  workflowId: string | null,
  now: number,
): void {
  database.run(
    `insert into goal_milestones (goal_id, name, workflow_id, state, created_at)
     values (?, ?, ?, ?, ?)
     on conflict (goal_id, name) do update set
       workflow_id = excluded.workflow_id, state = excluded.state`,
    id,
    name,
    workflowId,
    workflowId === null ? "pending" : "active",
    now,
  )
}

/**
 * Milestone state is read from the workflow that implements it, never from a column somebody could
 * set. A goal's completion gate depends on this being the truth rather than a claim about it.
 */
export function goalMilestones(database: Database, id: string): Milestone[] {
  return database
    .all<Row>(
      `select m.name, m.workflow_id, m.state, m.created_at, w.state as workflow_state
         from goal_milestones m
         left join workflows w on w.id = m.workflow_id
        where m.goal_id = ?
        order by m.rowid`,
      id,
    )
    .map((row) => ({
      createdAt: Number(row["created_at"]),
      name: String(row["name"]),
      state: milestoneState(row["workflow_state"] as string | null, String(row["state"])),
      workflowId: (row["workflow_id"] as string | null) ?? null,
    }))
}

function milestoneState(workflowState: string | null, stored: string): MilestoneState {
  if (workflowState === null) return stored === "abandoned" ? "abandoned" : "pending"
  if (workflowState === "completed") return "completed"
  if (workflowState === "cancelled") return "abandoned"
  return "active"
}

export function goalOfWorkflow(database: Database, workflowId: string): string | undefined {
  const row = database.get<Row>(
    "select goal_id from goal_milestones where workflow_id = ? limit 1",
    workflowId,
  )
  return row === undefined ? undefined : String(row["goal_id"])
}

function toGoal(row: Row): Goal {
  return {
    amendments: JSON.parse(String(row["amendments"])) as Amendment[],
    blockedFrom: (row["blocked_from"] as GoalState | null) ?? null,
    constraints: JSON.parse(String(row["constraints"])) as string[],
    continuations: Number(row["continuations"]),
    createdAt: Number(row["created_at"]),
    focused: row["focused_session"] !== null,
    id: String(row["id"]),
    maxContinuations: Number(row["max_continuations"]),
    nonGoals: JSON.parse(String(row["non_goals"])) as string[],
    objective: String(row["objective"]),
    objectiveDigest: String(row["objective_digest"]),
    pausedFrom: (row["paused_from"] as GoalState | null) ?? null,
    projectId: String(row["project_id"]),
    state: String(row["state"]) as GoalState,
    successCriteria: JSON.parse(String(row["success_criteria"])) as string[],
    updatedAt: Number(row["updated_at"]),
  }
}
