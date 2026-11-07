import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

type Engine = EngineInterface
type Paths = { file: string; archive: string }

const HEADER =
  '# Parked\n\nThoughts parked mid-session with `/park`. `/parked send` hands them to Claude; sent and dropped ones move to `parked-archive.md`.\n'

/** Where the two files live: the `folder` option, `~` expanded, else ~/.claude/parked. */
const resolvePaths = async ($: Engine, folder: string): Promise<Paths> => {
  const home = (await $.env.get('HOME')) ?? ''
  const raw = folder.trim() === '' ? '~/.claude/parked' : folder.trim()
  const dir = (raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw).replace(/\/+$/, '')
  return { file: `${dir}/parked.md`, archive: `${dir}/parked-archive.md` }
}

const count = atom({ plugin: 'park', key: 'count' } as const, 0)

type Entry = { title: string; body: string }

const parse = (text: string): Entry[] =>
  text
    .split(/^## /m)
    .slice(1)
    .map(chunk => {
      const newline = chunk.indexOf('\n')
      const title = (newline < 0 ? chunk : chunk.slice(0, newline)).trim()
      const body = newline < 0 ? '' : chunk.slice(newline + 1).trim()
      return { title, body }
    })

const render = (entries: Entry[]): string =>
  HEADER + entries.map(one => `\n## ${one.title}\n\n${one.body}\n`).join('')

const load = async ($: Engine, at: Paths): Promise<Entry[]> => {
  const text = await $.fs.read(at.file).catch(() => '')
  return typeof text === 'string' ? parse(text) : []
}

const save = async ($: Engine, at: Paths, entries: Entry[]) => {
  await $.fs.write(at.file, render(entries))
  await update($, count, () => entries.length)
}

const run = async ($: Engine, argv: string[]): Promise<string> => {
  const result = await $.process.run(argv, { timeoutMs: 5000 }).catch(() => undefined)
  return result?.exitCode === 0 ? result.stdout.trim() : ''
}

const stamp = async ($: Engine): Promise<string> => {
  const root = await $.session.root()
  const repo = root.split('/').filter(Boolean).pop() ?? root
  const [time, branch] = await Promise.all([
    run($, ['date', '+%Y-%m-%d %H:%M']),
    run($, ['git', '-C', root, 'branch', '--show-current']),
  ])
  return [time, repo, branch].filter(part => part !== '').join(' · ')
}

const archive = async ($: Engine, at: Paths, entries: Entry[], how: string) => {
  if (entries.length === 0) return
  const existing = await $.fs.read(at.archive).catch(() => '')
  const head =
    typeof existing === 'string' && existing !== ''
      ? existing.trimEnd() + '\n'
      : '# Parked archive\n'
  const when = await run($, ['date', '+%Y-%m-%d %H:%M'])
  const rows = entries
    .map(one => `\n## ${one.title} (${how} ${when})\n\n${one.body}\n`)
    .join('')
  await $.fs.write(at.archive, head + rows)
}

/** Picks 1-based indexes from args; none given means all. */
const pick = (entries: Entry[], args: string[]) => {
  if (args.length === 0) return { chosen: entries, rest: [] as Entry[], bad: [] as string[] }
  const wanted = new Set<number>()
  const bad: string[] = []
  for (const arg of args) {
    const n = Number(arg)
    if (Number.isInteger(n) && n >= 1 && n <= entries.length) wanted.add(n - 1)
    else bad.push(arg)
  }
  return {
    chosen: entries.filter((_, i) => wanted.has(i)),
    rest: entries.filter((_, i) => !wanted.has(i)),
    bad,
  }
}

const preview = (body: string) => {
  const line = body.replace(/\s+/g, ' ').trim()
  return line.length > 100 ? `${line.slice(0, 99)}…` : line
}

/** A prompt that ends in "/park", the thought before it. */
const TRAILING = /^([\s\S]*\S)\s+\/park\s*$/

/** Appends one thought, shows the toast, and returns how many are parked. */
const park = async ($: Engine, folder: string, body: string): Promise<number> => {
  const at = await resolvePaths($, folder)
  const entries = await load($, at)
  entries.push({ title: await stamp($), body })
  await save($, at, entries)
  $.ui.toast(`Parked (${entries.length})`)
  return entries.length
}

const USAGE =
  '/parked: list · /parked send [n ...]: hand them to Claude · /parked drop n ... · /parked clear'

export const register: Register = (on, options) => {
  const folder = typeof options.folder === 'string' ? options.folder : ''
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'park',
      description: 'Park a thought for later without sending it to Claude',
      argumentHint: '<thought>',
      immediate: true,
    })
    await $.command.register({
      name: 'parked',
      description: 'List parked thoughts, send them to Claude, or drop them',
      argumentHint: '[send|drop|clear] [n ...]',
      immediate: true,
    })
    const entries = await load($, await resolvePaths($, folder))
    await update($, count, () => entries.length)
    return next(e)
  })

  on('command.run', { command: 'park' }, async ($, e) => {
    const body = e.args.trim()
    if (body === '') return { text: 'Usage: /park <thought>' }
    const n = await park($, folder, body)
    return { text: `Parked #${n}.` }
  })

  // "<thought> /park": a slash command only works at the start of the line,
  // so a prompt that ends in /park is parked here and never enters the session.
  on('prompt.submit', async ($, e, next) => {
    const match = TRAILING.exec(e.text)
    const body = match?.[1]?.trim() ?? ''
    if (e.command || e.origin.kind !== 'composer' || body === '') return next(e)
    const n = await park($, folder, body)
    // A dropped prompt goes back into the box. Empty it once the drop has
    // landed, but only while it still holds the parked text, so nothing typed
    // since is lost. Two tries: the box may be refilled a beat after the hook.
    const clear = async () => {
      const box = await $.prompt.read()
      if (box.text.trim() === e.text.trim()) await $.prompt.fill({ text: '', mode: 'replace' })
    }
    for (const ms of [0, 150]) $.clock.after(ms, () => void clear().catch(() => undefined))
    return { drop: `Parked #${n}.` }
  })

  on('command.run', { command: 'parked' }, async ($, e) => {
    const [verb = '', ...args] = e.args.trim().split(/\s+/).filter(Boolean)
    const at = await resolvePaths($, folder)
    const entries = await load($, at)
    await update($, count, () => entries.length)

    if (verb === '' || verb === 'list') {
      if (entries.length === 0) return { text: 'Nothing parked.' }
      const lines = entries.map((one, i) => `${i + 1}. ${preview(one.body)}  [${one.title}]`)
      return { text: [...lines, '', USAGE].join('\n') }
    }

    if (verb === 'send') {
      const { chosen, rest, bad } = pick(entries, args)
      if (bad.length > 0) return { text: `No such item: ${bad.join(', ')}. ${USAGE}` }
      if (chosen.length === 0) return { text: 'Nothing parked.' }
      const intro =
        chosen.length === 1
          ? 'A thought I parked earlier in the session, now ready to discuss:'
          : 'Thoughts I parked earlier in the session, now ready to discuss:'
      const text = [
        intro,
        ...chosen.map((one, i) => `\n${i + 1}. (${one.title})\n${one.body}`),
      ].join('\n')
      await archive($, at, chosen, 'sent')
      await save($, at, rest)
      // A command.run hook may not submit itself (the turn would wait on it):
      // a timer submits once the hook has returned, and the prompt then
      // waits for the session to go idle.
      $.clock.after(0, () => void $.prompt.submit({ text }))
      return { text: `Sending ${chosen.length} to Claude once it is idle.` }
    }

    if (verb === 'drop' || verb === 'clear') {
      if (verb === 'drop' && args.length === 0) return { text: 'Usage: /parked drop n ...' }
      const { chosen, rest, bad } = pick(entries, verb === 'clear' ? [] : args)
      if (bad.length > 0) return { text: `No such item: ${bad.join(', ')}.` }
      await archive($, at, chosen, 'dropped')
      await save($, at, rest)
      return { text: `Dropped ${chosen.length}; ${rest.length} left. Kept in parked-archive.md.` }
    }

    return { text: USAGE }
  })

  // The file is plain Markdown that may be edited by hand: re-count after each turn.
  on('turn.complete', async ($, e, next) => {
    const entries = await load($, await resolvePaths($, folder))
    await update($, count, () => entries.length)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band holds one tree: keep whatever the plugins beneath drew.
    const below = await next(e)
    const n = await read($, count)
    if (n === 0 || e.props.hasSurvey) return below
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        {below}
        <Text dimColor>
          {'  '}💡 {n} parked · /parked
        </Text>
      </Box>
    )
  })
}
