import { expect, test } from 'claude-code/testing'

const DIR = '/home/me/notes'

const engine = (on: any) => {
  const files = new Map<string, string>()
  const submitted: string[] = []
  on('command.register', (_: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.read', (_: any, e: any) => {
    if (!files.has(e.path)) throw new Error('ENOENT')
    return { value: files.get(e.path) }
  })
  on('fs.write', (_: any, e: any) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', (_: any, e: any) => {
    const stdout = e.argv[0] === 'date' ? '2026-11-06 15:00\n' : 'feature/x\n'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('session.root', () => ({ value: '/home/me/app' }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  return { files, submitted }
}

test('park stores, lists, sends and archives', { options: { folder: '~/notes/' } }, async ($, on) => {
  const { files, submitted } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await $.command.run({ command: 'park', args: 'first idea\nsecond line' })).text).toBe('Parked #1.')
  await $.command.run({ command: 'park', args: 'another one' })
  expect(files.get(`${DIR}/parked.md`)).toContain('## 2026-11-06 15:00 · app · feature/x')

  const list = await $.command.run({ command: 'parked', args: '' })
  expect(list.text).toContain('1. first idea second line')
  expect(list.text).toContain('2. another one')

  const sent = await $.command.run({ command: 'parked', args: 'send 2' })
  expect(sent.text).toBe('Sending 1 to Claude once it is idle.')
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(submitted[0]).toContain('another one')
  expect(files.get(`${DIR}/parked.md`)).not.toContain('another one')
  expect(files.get(`${DIR}/parked-archive.md`)).toContain('another one')

  expect((await $.command.run({ command: 'parked', args: 'drop 9' })).text).toBe('No such item: 9.')
  expect((await $.command.run({ command: 'parked', args: 'clear' })).text).toContain('Dropped 1; 0 left')
  expect((await $.command.run({ command: 'parked', args: '' })).text).toBe('Nothing parked.')
})

test('a blank folder falls back to ~/.claude/parked', async ($, on) => {
  const { files } = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'park', args: 'x' })
  expect(files.has('/home/me/.claude/parked/parked.md')).toBe(true)
})

test('the band keeps what other mods drew', async ($, on) => {
  engine(on)
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>meter</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'park', args: 'x' })
  const ui = await $.ui.mount({ plugin: 'park', component: 'AbovePrompt', surface: 'terminal', props: {} } as any)
  expect((await ui.find({ type: 'Text', text: /meter/ }))?.text).toBe('meter')
  expect((await ui.find({ type: 'Text', text: /parked/ }))?.text).toContain('1 parked')
  await ui.unmount()
})
