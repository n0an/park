import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ParkEntry } from '../types'

type Engine = EngineInterface
type Paths = { file: string; archive: string }

const HEADER =
  '# Parked\n\nThoughts parked mid-session with `/park`. Each session sees only its own; click one in the Parked pane (or `/parked send`) to hand it to Claude. Sent and dropped ones move to `parked-archive.md`.\n'

const PANE = 'parked'

/** Where the two files live: the `folder` option, `~` expanded, else ~/.claude/parked. */
const resolvePaths = async ($: Engine, folder: string): Promise<Paths> => {
  const home = (await $.env.get('HOME')) ?? ''
  const raw = folder.trim() === '' ? '~/.claude/parked' : folder.trim()
  const dir = (raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw).replace(/\/+$/, '')
  return { file: `${dir}/parked.md`, archive: `${dir}/parked-archive.md` }
}

// This session's parked list as the pane and the band draw it; the file stays the truth.
const parked = atom({ plugin: 'park', key: 'entries' } as const, [] as ParkEntry[], {
  shape: 'entries-2',
})

type Entry = ParkEntry

/** The hidden line under an entry's heading that names the session it was parked in. */
const SESSION = /^<!--\s*session:\s*(\S+)\s*-->\s*/

const parse = (text: string): Entry[] =>
  text
    .split(/^## /m)
    .slice(1)
    .map(chunk => {
      const newline = chunk.indexOf('\n')
      const title = (newline < 0 ? chunk : chunk.slice(0, newline)).trim()
      const rest = newline < 0 ? '' : chunk.slice(newline + 1).trimStart()
      const tag = SESSION.exec(rest)
      const body = (tag ? rest.slice(tag[0].length) : rest).trim()
      return tag ? { title, body, session: tag[1] } : { title, body }
    })

const render = (entries: Entry[]): string =>
  HEADER +
  entries
    .map(one => {
      const tag = one.session ? `<!-- session: ${one.session} -->\n` : ''
      return `\n## ${one.title}\n${tag}\n${one.body}\n`
    })
    .join('')

/** The entries this session sees: its own, plus old ones parked before entries had a session. */
const mine = (entries: Entry[], session: string) =>
  entries.filter(one => one.session === undefined || one.session === session)

const load = async ($: Engine, at: Paths): Promise<Entry[]> => {
  const text = await $.fs.read(at.file).catch(() => '')
  return typeof text === 'string' ? parse(text) : []
}

/** Writes every session's entries; the pane and the band get this session's. */
const save = async ($: Engine, at: Paths, entries: Entry[]) => {
  await $.fs.write(at.file, render(entries))
  const session = await $.session.id()
  await update($, parked, () => mine(entries, session))
}

const refresh = async ($: Engine, folder: string) => {
  const entries = await load($, await resolvePaths($, folder))
  const session = await $.session.id()
  await update($, parked, () => mine(entries, session))
}

const isSame = (a: Entry, b: Entry) =>
  a.title === b.title && a.body === b.body && a.session === b.session

const openPane = ($: Engine) => $.ui.open({ id: PANE, title: 'Parked', columns: 44 })

/** Closes the pane while it is on screen; otherwise opens it (or brings its tab up). */
const togglePane = async ($: Engine): Promise<'opened' | 'closed' | 'waiting'> => {
  const pane = (await $.ui.panes()).find(one => one.id === PANE)
  if (pane?.isPlaced && pane.isShown) {
    await $.ui.close({ id: PANE })
    return 'closed'
  }
  return (await openPane($)).isPlaced ? 'opened' : 'waiting'
}

/** Takes one thought out of the file into the archive; closes the pane once none is left. */
const take = async ($: Engine, folder: string, one: Entry, how: string) => {
  const at = await resolvePaths($, folder)
  const entries = await load($, at)
  const rest = entries.filter(other => !isSame(other, one))
  if (rest.length === entries.length) return
  await archive($, at, [one], how)
  await save($, at, rest)
  if (mine(rest, await $.session.id()).length === 0) await $.ui.close({ id: PANE })
}

/** A click on a thought: into the prompt box at the cursor, then out of the list. */
const insert = async ($: Engine, folder: string, one: Entry) => {
  const box = await $.prompt.read()
  const gap = box.text !== '' && !/\s$/.test(box.text.slice(0, box.cursor)) ? ' ' : ''
  const filled = await $.prompt.fill({ text: gap + one.body, mode: 'insert' })
  if (!filled.isFilled) {
    $.ui.toast('The prompt box is busy: try again')
    return
  }
  await take($, folder, one, 'sent')
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

const clip = (body: string, max: number) => {
  const line = body.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const preview = (body: string) => clip(body, 100)

/** A prompt that ends in "/park", the thought before it. */
const TRAILING = /^([\s\S]*\S)\s+\/park\s*$/

/** Appends one thought, shows the toast, and returns how many this session has parked. */
const park = async ($: Engine, folder: string, body: string): Promise<number> => {
  const at = await resolvePaths($, folder)
  const entries = await load($, at)
  const session = await $.session.id()
  entries.push({ title: await stamp($), body, session })
  await save($, at, entries)
  const n = mine(entries, session).length
  $.ui.toast(`Parked (${n})`)
  void openPane($).catch(() => undefined)
  return n
}

const USAGE =
  '/parked: open or close the pane · /parked list · /parked all: every session\'s · /parked send [n ...]: hand them to Claude · /parked drop n ... · /parked clear'

/** When to look for the dropped prompt back in the box: the engine refills it a beat after the hook, later while a turn runs. */
const REFILL_CHECKS_MS = [0, 100, 250, 500, 1000, 2000]

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
      description: 'Open the Parked pane, or list, send or drop parked thoughts',
      argumentHint: '[list|send|drop|clear] [n ...]',
      immediate: true,
    })
    await refresh($, folder)
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
    // A dropped prompt goes back into the box, sometimes well after the hook
    // (a running turn delays it). Look for it a few times and empty the box
    // the first time it holds the parked prompt: text that still ends in
    // /park, which also matches a box that shows a paste as a placeholder
    // while e.text has it expanded. Anything else in the box was typed since
    // and is left alone, and the checks stop.
    let isDone = false
    const clear = async () => {
      if (isDone) return
      const box = await $.prompt.read()
      if (box.text.trim() === '') return
      isDone = true
      if (box.text.trim() === e.text.trim() || TRAILING.test(box.text)) {
        await $.prompt.fill({ text: '', mode: 'replace' })
      }
    }
    for (const ms of REFILL_CHECKS_MS) $.clock.after(ms, () => void clear().catch(() => undefined))
    return { drop: `Parked #${n}.` }
  })

  on('command.run', { command: 'parked' }, async ($, e) => {
    const [verb = '', ...args] = e.args.trim().split(/\s+/).filter(Boolean)
    const at = await resolvePaths($, folder)
    const all = await load($, at)
    const session = await $.session.id()
    const entries = mine(all, session)
    const others = all.filter(one => !entries.includes(one))
    await update($, parked, () => entries)

    if (verb === '') {
      const how = await togglePane($)
      if (how !== 'waiting') return { text: `Parked pane ${how}.` }
    }

    if (verb === '' || verb === 'list') {
      if (entries.length === 0) return { text: 'Nothing parked.' }
      const lines = entries.map((one, i) => `${i + 1}. ${preview(one.body)}  [${one.title}]`)
      const elsewhere = others.length > 0 ? [`${others.length} more from other sessions: /parked all`] : []
      return { text: [...lines, ...elsewhere, '', USAGE].join('\n') }
    }

    if (verb === 'all') {
      if (all.length === 0) return { text: 'Nothing parked.' }
      const row = (one: Entry) => `- ${preview(one.body)}  [${one.title}]`
      const text = [
        `This session (${entries.length}):`,
        ...(entries.length > 0 ? entries.map(row) : ['- none']),
        '',
        `Other sessions (${others.length}):`,
        ...(others.length > 0 ? others.map(row) : ['- none']),
        '',
        `All of them are in ${at.file}.`,
      ]
      return { text: text.join('\n') }
    }

    if (verb === 'send') {
      const { chosen, bad } = pick(entries, args)
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
      await save($, at, all.filter(one => !chosen.includes(one)))
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
      await save($, at, all.filter(one => !chosen.includes(one)))
      return { text: `Dropped ${chosen.length}; ${rest.length} left. Kept in parked-archive.md.` }
    }

    return { text: USAGE }
  })

  // The file is plain Markdown that may be edited by hand: re-count after each turn.
  on('turn.complete', async ($, e, next) => {
    await refresh($, folder)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const entries = await read($, parked)
    const width = Math.max(16, (e.viewport?.columns ?? 44) - 6)
    if (entries.length === 0) return <Text dimColor>Nothing parked.</Text>
    return (
      <Box flexDirection="column">
        {entries.map((one, i) => (
          <Box key={`row-${i}-${one.title}`} flexDirection="row" marginBottom={1}>
            <Box flexGrow={1} flexDirection="column">
              <Button key={`insert-${i}-${one.title}`} plain onPress={() => void insert($, folder, one)}>
                {clip(one.body, width * 2)}
              </Button>
              <Text dimColor>{one.title}</Text>
            </Box>
            <Button
              key={`drop-${i}-${one.title}`}
              plain
              label="×"
              onPress={() => void take($, folder, one, 'dropped')}
            />
          </Box>
        ))}
        <Text dimColor>Click to insert into the prompt · × to drop</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band holds one tree: keep whatever the plugins beneath drew.
    const below = await next(e)
    const n = (await read($, parked)).length
    if (n === 0 || e.props.hasSurvey) return below
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box>
        {below}
        <Text dimColor>{'  '}</Text>
        <Button key="park-open" plain onPress={() => void togglePane($).catch(() => undefined)}>
          <Text dimColor>💡 {n} parked</Text>
        </Button>
      </Box>
    )
  })
}
