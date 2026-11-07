/** One parked thought: `title` is its stamp (time · repo · branch), `body` the text. */
export type ParkEntry = { title: string; body: string }

declare module 'claude-code' {
  interface PluginState {
    park: { entries: Shaped<ParkEntry[]> }
  }
}
