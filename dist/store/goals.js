import { DIGEST_DOMAIN, digest, newId } from "./ids.js";
export function createGoal(database, projectId, definition, now) {
    const id = newId();
    database.run(`insert into goals (
       id, project_id, objective, objective_digest, state, constraints, non_goals,
       success_criteria, amendments, continuations, max_continuations, created_at, updated_at
     ) values (?, ?, ?, ?, 'draft', ?, ?, ?, '[]', 0, ?, ?, ?)`, id, projectId, definition.objective, digest(DIGEST_DOMAIN.goal, { objective: definition.objective }), JSON.stringify([...definition.constraints]), JSON.stringify([...definition.nonGoals]), JSON.stringify([...definition.successCriteria]), definition.maxContinuations, now, now);
    return id;
}
export function loadGoal(database, id) {
    const row = database.get("select * from goals where id = ?", id);
    return row === undefined ? undefined : toGoal(row);
}
export function listGoals(database, projectId, limit = 50) {
    return database
        .all("select * from goals where project_id = ? order by updated_at desc limit ?", projectId, limit)
        .map(toGoal);
}
export function focusGoal(database, projectId, id, now) {
    database.transaction(() => {
        database.run("update goals set focused_session = null, updated_at = ? where project_id = ? and focused_session is not null", now, projectId);
        database.run("update goals set focused_session = 'project', updated_at = ? where id = ?", now, id);
    });
}
export function focusedGoal(database, projectId) {
    const row = database.get("select * from goals where project_id = ? and focused_session is not null limit 1", projectId);
    return row === undefined ? undefined : toGoal(row);
}
export function saveGoalState(database, id, state, fields, now) {
    const goal = loadGoal(database, id);
    if (goal === undefined)
        return;
    database.run(`update goals set state = ?, continuations = ?, max_continuations = ?,
       paused_from = ?, blocked_from = ?, updated_at = ? where id = ?`, state, fields.continuations ?? goal.continuations, fields.maxContinuations ?? goal.maxContinuations, fields.pausedFrom === undefined ? goal.pausedFrom : fields.pausedFrom, fields.blockedFrom === undefined ? goal.blockedFrom : fields.blockedFrom, now, id);
}
export function amendGoal(database, id, text, now) {
    const goal = loadGoal(database, id);
    if (goal === undefined)
        throw new Error(`unknown goal: ${id}`);
    const amendment = {
        receivedAt: now,
        sequence: goal.amendments.length + 1,
        text,
    };
    database.run("update goals set amendments = ?, updated_at = ? where id = ?", JSON.stringify([...goal.amendments, amendment]), now, id);
    return amendment;
}
export function saveGoalPlan(database, id, content, sourceSessionId, now) {
    return database.transaction(() => {
        const head = database.get("select max(version) as version from goal_plans where goal_id = ?", id);
        const version = (head?.version ?? 0) + 1;
        database.run("insert into goal_plans (goal_id, version, content, source_session_id, created_at) values (?, ?, ?, ?, ?)", id, version, content, sourceSessionId, now);
        return version;
    });
}
export function goalPlans(database, id) {
    return database
        .all("select * from goal_plans where goal_id = ? order by version", id)
        .map((row) => ({
        content: String(row["content"]),
        createdAt: Number(row["created_at"]),
        sourceSessionId: row["source_session_id"] ?? null,
        version: Number(row["version"]),
    }));
}
export function addMilestone(database, id, name, workflowId, now) {
    database.run(`insert into goal_milestones (goal_id, name, workflow_id, state, created_at)
     values (?, ?, ?, ?, ?)
     on conflict (goal_id, name) do update set
       workflow_id = excluded.workflow_id, state = excluded.state`, id, name, workflowId, workflowId === null ? "pending" : "active", now);
}
export function goalMilestones(database, id) {
    return database
        .all(`select m.name, m.workflow_id, m.state, m.created_at, w.state as workflow_state
         from goal_milestones m
         left join workflows w on w.id = m.workflow_id
        where m.goal_id = ?
        order by m.rowid`, id)
        .map((row) => ({
        createdAt: Number(row["created_at"]),
        name: String(row["name"]),
        state: milestoneState(row["workflow_state"], String(row["state"])),
        workflowId: row["workflow_id"] ?? null,
    }));
}
function milestoneState(workflowState, stored) {
    if (workflowState === null)
        return stored === "abandoned" ? "abandoned" : "pending";
    if (workflowState === "completed")
        return "completed";
    if (workflowState === "cancelled")
        return "abandoned";
    return "active";
}
export function goalOfWorkflow(database, workflowId) {
    const row = database.get("select goal_id from goal_milestones where workflow_id = ? limit 1", workflowId);
    return row === undefined ? undefined : String(row["goal_id"]);
}
function toGoal(row) {
    return {
        amendments: JSON.parse(String(row["amendments"])),
        blockedFrom: row["blocked_from"] ?? null,
        constraints: JSON.parse(String(row["constraints"])),
        continuations: Number(row["continuations"]),
        createdAt: Number(row["created_at"]),
        focused: row["focused_session"] !== null,
        id: String(row["id"]),
        maxContinuations: Number(row["max_continuations"]),
        nonGoals: JSON.parse(String(row["non_goals"])),
        objective: String(row["objective"]),
        objectiveDigest: String(row["objective_digest"]),
        pausedFrom: row["paused_from"] ?? null,
        projectId: String(row["project_id"]),
        state: String(row["state"]),
        successCriteria: JSON.parse(String(row["success_criteria"])),
        updatedAt: Number(row["updated_at"]),
    };
}
