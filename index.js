/**
 * dsh-adhd-mode — enter the i-have-adhd output-style rules into a session once,
 * and enter them again only when billion-context folds them out of the request.
 *
 * `rules.md` is the body of the upstream skills/i-have-adhd/SKILL.md
 * (ayghri/i-have-adhd, MIT): frontmatter removed, everything else verbatim.
 *
 * The plugin imports nothing but Node built-ins on purpose: an installed plugin
 * resolves bare specifiers from its own directory, so the harness's internal
 * packages are not importable from here.
 *
 * @module dsh-adhd-mode
 */

import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Plugin name shown by the loader. */
export const name = 'adhd-mode'

/** Source kind stamped on every message this plugin enters. */
const SOURCE_KIND = 'adhd-mode'

/** First line of every rules message; the content check survives a lost source tag. */
const MARKER = 'ADHD MODE ACTIVE'

const RULES_PATH = join(dirname(fileURLToPath(import.meta.url)), 'rules.md')

/** billion-context appends one line per request to this log. */
const BILI_LOG = process.env.DSH_ADHD_BILI_LOG
  || join(homedir(), '.local', 'state', 'billion-context', 'bili.log')

/** The one line billion-context writes per fold. */
const BILI_FOLD_MARKER = 'acp-proxy: [Compressed'

/** The session tag billion-context puts on a line, bracketed with or without a `sess=` prefix. */
const BILI_SESSION_TAG = /\[(?:sess=)?((?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i

/** How much of the log tail to read when the file is first seen. */
const BILI_TAIL_BYTES = 2 << 20

/** Incremental reader state: bytes already counted, a partial line, and per-session fold counts. */
const logState = { offset: -1, pending: '', counts: new Map() }

/** Default plugin config; the profile may override any field by row id. */
const DEFAULTS = {
  enabled: true,
}

/**
 * Whether a message is one of ours.
 * @param {object} message - a claimed or composed message.
 * @returns {boolean} true for a message this plugin entered.
 */
function isRulesMessage(message) {
  if (message?.source?.kind === SOURCE_KIND) return true
  return Array.isArray(message?.content) && message.content.some(block => (
    block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(MARKER)
  ))
}

/**
 * Whether a rules message is still on the session surface.
 * @param {object} agent - the agent owning the step.
 * @returns {boolean} true when this session already carries the rules.
 */
function hasCommitted(agent) {
  const nodes = agent.session?.surface?.nodes
  if (!nodes) return false
  return nodes.some(seq => {
    const event = agent.session.eventAt(seq)
    return event?.type === 'user/message' && isRulesMessage(event.data)
  })
}

/**
 * Spellings a session id can take inside the billion-context log.
 * @param {string} id - the harness session id.
 * @returns {string[]} the id with and without the `session-` prefix.
 */
function idVariants(id) {
  const text = String(id)
  const bare = text.startsWith('session-') ? text.slice('session-'.length) : text
  return [...new Set([text, `session-${bare}`, bare])]
}

/**
 * Count the folds billion-context has performed for one session.
 *
 * billion-context compresses the outbound request, not the session log, so a
 * fold is invisible from the harness side; its log is the only local record.
 * The log only grows, so it is read once from the tail and then by appending
 * bytes: a model step never re-reads what an earlier step already counted.
 * @param {string} sessionId - the harness session id.
 * @returns {number} the fold count, or -1 when the log is unavailable.
 */
function foldCount(sessionId) {
  let size
  try {
    size = statSync(BILI_LOG).size
  } catch {
    return -1
  }
  if (logState.offset < 0 || size < logState.offset) {
    logState.offset = -1
    logState.pending = ''
    logState.counts.clear()
  }

  if (size > logState.offset) {
    const cold = logState.offset < 0
    const from = cold ? Math.max(0, size - BILI_TAIL_BYTES) : logState.offset
    const buffer = Buffer.alloc(size - from)
    let fd
    try {
      fd = openSync(BILI_LOG, 'r')
      readSync(fd, buffer, 0, buffer.length, from)
    } catch {
      return -1
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          // Nothing to close.
        }
      }
    }

    let text = buffer.toString('utf8')
    if (cold) {
      // A tail starts mid-line: drop the fragment before the first newline.
      text = text.slice(text.indexOf('\n') + 1)
      logState.pending = ''
    }
    const lines = (logState.pending + text).split('\n')
    logState.pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.includes(BILI_FOLD_MARKER)) continue
      const tagged = BILI_SESSION_TAG.exec(line)
      if (!tagged) continue
      logState.counts.set(tagged[1], (logState.counts.get(tagged[1]) ?? 0) + 1)
    }
    logState.offset = size
  }

  for (const id of idVariants(sessionId)) {
    const count = logState.counts.get(id)
    if (count !== undefined) return count
  }
  return 0
}

/**
 * Detach and deep-freeze a message, matching the harness's own message
 * construction: published messages are immutable so no consumer can rewrite a
 * committed value.
 * @param {object} message - the message to detach.
 * @returns {object} a frozen deep clone.
 */
function freezeMessage(message) {
  const clone = structuredClone(message)
  const stack = [clone]
  while (stack.length > 0) {
    const value = stack.pop()
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) continue
    Object.freeze(value)
    for (const entry of Object.values(value)) stack.push(entry)
  }
  return clone
}

/**
 * Build one user-role context message carrying the rules.
 * @param {string} text - the rules text.
 * @returns {object} a frozen user message owned by this producer.
 */
function rulesMessage(text) {
  return freezeMessage({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'instructions' },
  })
}

/**
 * Install the pre-step and compaction hooks.
 * @param {object} ctx - plugin context.
 * @param {object} [config] - plugin config; missing fields fall back to DEFAULTS.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config ?? {}) }
  if (settings.enabled === false) return
  const rules = readFileSync(RULES_PATH, 'utf8').trim()

  /** Fold count this session had when the rules last entered; a rise means a fold may have dropped them. */
  const enteredAt = new Map()

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    if (decision.messages.some(isRulesMessage)) return decision

    const sessionId = agent.session?.id
    const folds = sessionId === undefined ? -1 : foldCount(sessionId)
    const seen = sessionId === undefined ? undefined : enteredAt.get(sessionId)

    // Claimed input for this step is not the history: messages entered earlier
    // are only visible through the session surface.
    if (hasCommitted(agent)) {
      if (folds < 0 || sessionId === undefined) return decision
      // A resumed session starts with no baseline: adopt the count it already
      // has instead of treating every fold so far as new.
      if (seen === undefined) {
        enteredAt.set(sessionId, folds)
        return decision
      }
      // The log was rotated or truncated under us: the count restarts at zero,
      // so adopt the new lower count instead of waiting for a fold that never comes.
      if (folds < seen) {
        enteredAt.set(sessionId, folds)
        return decision
      }
      if (folds === seen) return decision
    }

    const message = rulesMessage(rules)
    // Entered only by returning it in the step decision: the driver commits these
    // messages to the session log. Queueing the same message in the inbox as well
    // would deliver it a second time at the next step.
    const lastClaimed = decision.messages.findLastIndex(entry => messages.includes(entry))
    const entered = decision.messages.toSpliced(lastClaimed + 1, 0, message)
    if (sessionId !== undefined && folds >= 0) enteredAt.set(sessionId, folds)
    try {
      ctx.logger?.info?.(
        'adhd-mode: entered the rules (%d chars) into session %s (%s)',
        rules.length,
        sessionId,
        seen === undefined ? 'first time' : `after billion-context fold #${folds}`,
      )
    } catch {
      // A silent plugin is better than a failed turn.
    }
    return { ...decision, messages: entered }
  })
}
