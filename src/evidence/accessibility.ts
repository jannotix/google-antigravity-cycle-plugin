import type { DesignFinding } from "./design.ts"

/**
 * Detectors over the accessibility tree captured from the native Browser pane. The capture is the
 * host's; every rule below is arithmetic over the captured nodes, with no model call.
 *
 * A tree has no files and no lines, so a finding locates itself by the page URL and the node's
 * position in document order — the same two coordinates a reviewer needs to go and look at it.
 */

export interface AccessibilityNode {
  readonly children: readonly AccessibilityNode[]
  readonly level: number | null
  readonly name: string
  readonly role: string
}

export interface Snapshot {
  readonly capturedFlow: string
  readonly nodes: readonly AccessibilityNode[]
  readonly url: string
}

export class SnapshotRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SnapshotRejected"
  }
}

const MAX_NODES = 5_000
const MAX_DEPTH = 50
const MAX_TEXT = 1_024

/** Controls whose whole purpose is to be announced. An unnamed one is unusable, not imperfect. */
const MUST_BE_NAMED = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
])

const IMAGE_ROLES = new Set(["figure", "image", "img"])

export function parseSnapshot(raw: unknown): Snapshot {
  const root = exactKeys(raw, ["capturedFlow", "nodes", "url"])
  const url = text(root["url"], "url")
  if (!/^https?:\/\//iu.test(url) && !url.startsWith("file://")) {
    throw new SnapshotRejected("the snapshot url must be an http, https or file address")
  }

  let counted = 0
  const parseNode = (value: unknown, depth: number): AccessibilityNode => {
    if (depth > MAX_DEPTH) throw new SnapshotRejected(`the accessibility tree nests beyond ${MAX_DEPTH} levels`)
    counted += 1
    if (counted > MAX_NODES) throw new SnapshotRejected(`the accessibility tree exceeds ${MAX_NODES} nodes`)

    const node = exactKeys(value, ["children", "level", "name", "role"])
    const level = node["level"]
    if (level !== null && (!Number.isInteger(level) || (level as number) < 1 || (level as number) > 12)) {
      throw new SnapshotRejected("a node level must be null or an integer between 1 and 12")
    }
    if (!Array.isArray(node["children"])) {
      throw new SnapshotRejected("a node's children must be an array, empty when it has none")
    }

    return {
      children: (node["children"] as unknown[]).map((child) => parseNode(child, depth + 1)),
      level: (level as number | null) ?? null,
      name: optionalText(node["name"], "name"),
      role: text(node["role"], "role").toLowerCase(),
    }
  }

  if (!Array.isArray(root["nodes"]) || root["nodes"].length === 0) {
    throw new SnapshotRejected("a snapshot must carry at least one accessibility node")
  }

  return {
    capturedFlow: text(root["capturedFlow"], "capturedFlow"),
    nodes: (root["nodes"] as unknown[]).map((node) => parseNode(node, 1)),
    url,
  }
}

export function inspectAccessibility(snapshot: Snapshot): DesignFinding[] {
  const findings: DesignFinding[] = []
  const flat: AccessibilityNode[] = []
  const walk = (nodes: readonly AccessibilityNode[]): void => {
    for (const node of nodes) {
      flat.push(node)
      walk(node.children)
    }
  }
  walk(snapshot.nodes)

  const at = (position: number, rule: string, severity: DesignFinding["severity"], summary: string) => {
    findings.push({ file: snapshot.url, line: position, rule, severity, summary })
  }

  let previousHeading = 0
  flat.forEach((node, index) => {
    const position = index + 1
    const named = node.name.trim().length > 0

    if (MUST_BE_NAMED.has(node.role) && !named) {
      at(position, "a11y/unnamed-control", "high", `a ${node.role} has no accessible name`)
    }
    if (IMAGE_ROLES.has(node.role) && !named) {
      at(position, "a11y/unnamed-image", "medium", "an image has no accessible name")
    }
    if (node.role !== "heading") return

    if (!named) at(position, "a11y/empty-heading", "medium", "a heading has no text")
    const level = node.level ?? 0
    if (previousHeading > 0 && level > previousHeading + 1) {
      at(
        position,
        "a11y/heading-order",
        "low",
        `heading level jumps from ${previousHeading} to ${level}, leaving a gap in the outline`,
      )
    }
    if (level > 0) previousHeading = level
  })

  const mains = flat.filter((node) => node.role === "main").length
  if (mains === 0) {
    at(0, "a11y/no-main-landmark", "low", "the page has no main landmark to skip to")
  } else if (mains > 1) {
    at(0, "a11y/duplicate-main", "medium", `the page declares ${mains} main landmarks`)
  }

  return findings
}

function exactKeys(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SnapshotRejected("a snapshot node must be a JSON object")
  }
  const actual = Object.keys(raw).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new SnapshotRejected(
      `a snapshot object must have exactly these keys: ${expected.join(", ")} (received: ${actual.join(", ") || "none"})`,
    )
  }
  return raw as Record<string, unknown>
}

function text(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > MAX_TEXT) {
    throw new SnapshotRejected(`${field} must be non-empty text of at most ${MAX_TEXT} characters`)
  }
  return raw.trim()
}

function optionalText(raw: unknown, field: string): string {
  if (typeof raw !== "string" || raw.length > MAX_TEXT) {
    throw new SnapshotRejected(`${field} must be text of at most ${MAX_TEXT} characters, empty when absent`)
  }
  return raw
}
