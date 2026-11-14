/**
 * One parked thought: `title` is its stamp (time · repo · branch), `body` the text,
 * `session` the id of the session it was parked in (absent on entries parked before 0.3.0).
 */
export type ParkEntry = { title: string; body: string; session?: string }

declare module 'claude-code' {
  interface PluginState {
    park: { entries: Shaped<ParkEntry[]> }
  }
}
