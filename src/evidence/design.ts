/**
 * Deterministic design detectors over changed interface files. No model call, no API key, no token
 * cost: every rule here reads bytes and reports a line. A detector that fires on ordinary code is
 * one people learn to ignore, so each rule is narrow and each one names a defect that is wrong
 * regardless of the project's taste.
 *
 * Families of section 7.6, and the rules that cover them:
 * contrast and colour — contrast · typography — font-size · spacing and layout — viewport-width ·
 * focus and keyboard reachability — focus-not-visible, positive-tabindex, interactive-without-key,
 * image-without-alt · motion and easing — reduced-motion · responsive breakpoints — fixed-width ·
 * component nesting — invalid-nesting · loading and error states — no-error-state.
 */

export type DesignSeverity = "high" | "info" | "low" | "medium"

export interface DesignFinding {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly severity: DesignSeverity
  readonly summary: string
}

export interface InspectedFile {
  readonly content: string
  readonly path: string
}

const STYLE_FILE = /\.(css|scss|sass|less|vue|svelte|html?)$/iu
const MARKUP_FILE = /\.(html?|jsx|tsx|vue|svelte)$/iu

export function isInterfaceFile(path: string): boolean {
  return STYLE_FILE.test(path) || MARKUP_FILE.test(path)
}

export function inspectDesign(files: readonly InspectedFile[]): DesignFinding[] {
  const findings: DesignFinding[] = []
  for (const file of files) {
    if (STYLE_FILE.test(file.path)) {
      findings.push(...contrast(file))
      findings.push(...fontSize(file))
      findings.push(...focusNotVisible(file))
      findings.push(...reducedMotion(file))
      findings.push(...fixedWidth(file))
      findings.push(...viewportWidth(file))
    }
    if (MARKUP_FILE.test(file.path)) {
      findings.push(...positiveTabindex(file))
      findings.push(...interactiveWithoutKeyboard(file))
      findings.push(...imageWithoutAlt(file))
      findings.push(...invalidNesting(file))
      findings.push(...missingErrorState(file))
    }
  }
  return findings.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  )
}

// ---------------------------------------------------------------- colour and contrast

const NAMED_COLOURS: Readonly<Record<string, [number, number, number]>> = {
  black: [0, 0, 0],
  blue: [0, 0, 255],
  gray: [128, 128, 128],
  green: [0, 128, 0],
  grey: [128, 128, 128],
  red: [255, 0, 0],
  silver: [192, 192, 192],
  white: [255, 255, 255],
  yellow: [255, 255, 0],
}

export function parseColour(value: string): [number, number, number] | null {
  const text = value.trim().toLowerCase()

  const named = NAMED_COLOURS[text]
  if (named !== undefined) return named

  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/u.exec(text)
  if (short !== null) {
    return [0, 1, 2].map((index) => Number.parseInt(short[index + 1]!.repeat(2), 16)) as [
      number,
      number,
      number,
    ]
  }

  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/u.exec(text)
  if (long !== null) {
    return [0, 1, 2].map((index) => Number.parseInt(long[index + 1]!, 16)) as [number, number, number]
  }

  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/u.exec(text)
  if (rgb !== null) {
    const channels = [1, 2, 3].map((index) => Number(rgb[index]))
    return channels.every((channel) => channel <= 255)
      ? (channels as [number, number, number])
      : null
  }

  return null
}

/** WCAG 2.1 relative luminance and contrast ratio. Arithmetic, not opinion. */
export function contrastRatio(
  foreground: readonly [number, number, number],
  background: readonly [number, number, number],
): number {
  const luminance = (colour: readonly [number, number, number]): number => {
    const [red, green, blue] = colour.map((channel) => {
      const ratio = channel / 255
      return ratio <= 0.039_28 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
    }) as [number, number, number]
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }

  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function contrast(file: InspectedFile): DesignFinding[] {
  const findings: DesignFinding[] = []

  for (const block of styleBlocks(file.content)) {
    const foreground = parseColour(declaration(block.body, "color") ?? "")
    const background =
      parseColour(declaration(block.body, "background-color") ?? "") ??
      parseColour(declaration(block.body, "background") ?? "")
    if (foreground === null || background === null) continue

    const ratio = contrastRatio(foreground, background)
    if (ratio >= 4.5) continue

    findings.push({
      file: file.path,
      line: block.line,
      rule: "design/contrast",
      severity: ratio < 3 ? "high" : "medium",
      summary: `text and background contrast at ${ratio.toFixed(2)}:1, below the 4.5:1 minimum`,
    })
  }

  return findings
}

interface StyleBlock {
  readonly body: string
  readonly line: number
}

function styleBlocks(content: string): StyleBlock[] {
  const blocks: StyleBlock[] = []
  const pattern = /\{([^{}]*)\}/gu
  let match: RegExpExecArray | null

  while ((match = pattern.exec(content)) !== null) {
    blocks.push({ body: match[1] ?? "", line: lineOf(content, match.index) })
  }
  return blocks
}

function declaration(body: string, property: string): string | null {
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`, "iu")
  return pattern.exec(body)?.[1]?.trim() ?? null
}

// ---------------------------------------------------------------- typography

function fontSize(file: InspectedFile): DesignFinding[] {
  return scan(file, /font-size\s*:\s*(\d+(?:\.\d+)?)(px|pt)/giu, (match) => {
    const size = Number(match[1])
    const pixels = match[2]?.toLowerCase() === "pt" ? size * (4 / 3) : size
    if (pixels >= 12) return null
    return {
      rule: "design/font-size",
      severity: "medium",
      summary: `${match[0]} is below the 12px floor for readable body text`,
    }
  })
}

// ---------------------------------------------------------------- focus and keyboard

function focusNotVisible(file: InspectedFile): DesignFinding[] {
  if (/:focus-visible/u.test(file.content)) return []
  return scan(file, /outline\s*:\s*(none|0)\b/giu, () => ({
    rule: "design/focus-not-visible",
    severity: "high",
    summary: "the focus outline is removed and no :focus-visible rule replaces it",
  }))
}

function positiveTabindex(file: InspectedFile): DesignFinding[] {
  return scan(file, /tabindex\s*=\s*[{"']?\s*(\d+)/giu, (match) =>
    Number(match[1]) > 0
      ? {
          rule: "design/positive-tabindex",
          severity: "high",
          summary: `tabindex ${match[1]} overrides document order for every other control on the page`,
        }
      : null,
  )
}

const PASSIVE_ELEMENTS = "div|span|li|td|tr|p|section|article|header|footer|nav|main|figure|label"

function interactiveWithoutKeyboard(file: InspectedFile): DesignFinding[] {
  return scan(
    file,
    new RegExp(`<(${PASSIVE_ELEMENTS})\\b([^>]*)>`, "gisu"),
    (match) => {
      const attributes = match[2] ?? ""
      if (!/\bon(?:Click|click)\b/u.test(attributes)) return null
      if (/\bon(?:KeyDown|KeyUp|KeyPress|keydown|keyup|keypress)\b/u.test(attributes)) return null
      if (/\brole\s*=/u.test(attributes)) return null
      return {
        rule: "design/interactive-without-key",
        severity: "high",
        summary: `<${match[1]}> handles a click but is not reachable or operable by keyboard`,
      }
    },
  )
}

function imageWithoutAlt(file: InspectedFile): DesignFinding[] {
  return scan(file, /<img\b([^>]*)>/gisu, (match) =>
    /\balt\s*=/u.test(match[1] ?? "")
      ? null
      : {
          rule: "design/image-without-alt",
          severity: "high",
          summary: "an image with no alt attribute is invisible to a screen reader",
        },
  )
}

// ---------------------------------------------------------------- motion

function reducedMotion(file: InspectedFile): DesignFinding[] {
  if (/prefers-reduced-motion/u.test(file.content)) return []
  const found = scan(file, /(?:^|[\s;{])(animation|transition)\s*:\s*(?!none)/gimu, (match) => ({
    rule: "design/reduced-motion",
    severity: "low",
    summary: `${match[1]} is declared with no prefers-reduced-motion alternative`,
  }))
  return found.slice(0, 1)
}

// ---------------------------------------------------------------- responsive and layout

function fixedWidth(file: InspectedFile): DesignFinding[] {
  if (/@media/u.test(file.content)) return []
  return scan(file, /(?:^|[\s;{])width\s*:\s*(\d{3,})px/gimu, (match) =>
    Number(match[1]) >= 600
      ? {
          rule: "design/fixed-width",
          severity: "low",
          summary: `a fixed ${match[1]}px width with no media query cannot fit a small viewport`,
        }
      : null,
  )
}

function viewportWidth(file: InspectedFile): DesignFinding[] {
  return scan(file, /(?:width|max-width|min-width)\s*:\s*100vw\b/giu, () => ({
    rule: "design/viewport-width",
    severity: "low",
    summary: "100vw includes the scrollbar width and overflows horizontally; use 100% instead",
  }))
}

// ---------------------------------------------------------------- nesting

const INTERACTIVE_TAGS = new Set(["a", "button"])
const BLOCK_IN_PARAGRAPH = new Set(["div", "ol", "p", "section", "ul"])

/**
 * A small tag matcher rather than a parser: only the tags these two rules care about are tracked, so
 * malformed markup elsewhere in the file cannot produce a false report.
 */
function invalidNesting(file: InspectedFile): DesignFinding[] {
  const findings: DesignFinding[] = []
  const open: { line: number; tag: string }[] = []
  const pattern = /<(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gisu
  let match: RegExpExecArray | null

  while ((match = pattern.exec(file.content)) !== null) {
    const closing = match[1] === "/"
    const tag = (match[2] ?? "").toLowerCase()
    const tracked = INTERACTIVE_TAGS.has(tag) || tag === "p"
    if (!tracked) continue

    if (closing) {
      const index = open.map((entry) => entry.tag).lastIndexOf(tag)
      if (index >= 0) open.splice(index, 1)
      continue
    }
    if ((match[3] ?? "").trimEnd().endsWith("/")) continue

    const line = lineOf(file.content, match.index)
    const inside = open.at(-1)
    if (inside !== undefined && INTERACTIVE_TAGS.has(inside.tag) && INTERACTIVE_TAGS.has(tag)) {
      findings.push({
        file: file.path,
        line,
        rule: "design/invalid-nesting",
        severity: "medium",
        summary: `<${tag}> inside <${inside.tag}>: nested interactive elements have no defined activation behaviour`,
      })
    }
    open.push({ line, tag })
  }

  // A paragraph that contains a block element is closed early by the parser, so what renders is not
  // what was written. Checked separately because <p> is implicitly closed rather than nested.
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/gisu
  while ((match = paragraph.exec(file.content)) !== null) {
    const inner = /<([a-z][a-z0-9]*)\b/isu.exec(match[1] ?? "")
    const tag = inner?.[1]?.toLowerCase()
    if (tag === undefined || !BLOCK_IN_PARAGRAPH.has(tag)) continue
    findings.push({
      file: file.path,
      line: lineOf(file.content, match.index),
      rule: "design/invalid-nesting",
      severity: "medium",
      summary: `<${tag}> inside <p>: the paragraph is closed before it, so the rendered tree differs from the source`,
    })
  }

  return findings
}

// ---------------------------------------------------------------- loading and error states

const FETCHES = /\bfetch\s*\(|\baxios\b|\buseQuery\b|\buseSWR\b/u
const HANDLES_FAILURE = /\bcatch\b|\berror\b|\bError\b|\bisError\b|\bfallback\b/u

function missingErrorState(file: InspectedFile): DesignFinding[] {
  if (!FETCHES.test(file.content) || HANDLES_FAILURE.test(file.content)) return []
  const line = lineOf(file.content, FETCHES.exec(file.content)?.index ?? 0)
  return [
    {
      file: file.path,
      line,
      rule: "design/no-error-state",
      severity: "medium",
      summary: "the component fetches data and renders no failure state anywhere in the file",
    },
  ]
}

// ---------------------------------------------------------------- shared

function scan(
  file: InspectedFile,
  pattern: RegExp,
  decide: (match: RegExpExecArray) => Omit<DesignFinding, "file" | "line"> | null,
): DesignFinding[] {
  const findings: DesignFinding[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(file.content)) !== null) {
    const decided = decide(match)
    if (decided !== null) {
      findings.push({ ...decided, file: file.path, line: lineOf(file.content, match.index) })
    }
    if (match.index === pattern.lastIndex) pattern.lastIndex += 1
  }
  return findings
}

function lineOf(content: string, index: number): number {
  let line = 1
  for (let position = 0; position < index && position < content.length; position += 1) {
    if (content[position] === "\n") line += 1
  }
  return line
}
