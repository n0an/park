<h1 align="center">Park</h1>

<p align="center">
    <img src="https://img.shields.io/badge/Claude%20Code-mod-D97757.svg" alt="Claude Code mod" />
    <img src="https://img.shields.io/badge/version-0.3.0-blueviolet.svg" alt="Version 0.3.0" />
    <img src="https://img.shields.io/badge/surface-terminal-2980b9.svg" alt="Terminal" />
    <img src="https://img.shields.io/badge/license-MIT-lightgrey.svg" alt="MIT License" />
</p>

A Claude Code mod for thoughts that arrive too early. Type `/park` in front of the idea and press Enter. The idea goes into a Markdown file, not into the conversation, and Claude keeps working on what it was doing. When the time is right, click the idea in the Parked pane and it lands in your prompt box, ready to send.

```
/park Once this works, check the same race in the upload retry path
```

A mod changes Claude Code's own interface, unlike a skill, which changes what the agent knows. This one adds two slash commands, a pane and one line above the prompt.


## The Idea

In a long, active session with an agent, new thoughts often come in before their time. The agent is halfway through a refactor, and you suddenly see what should come after it, or a side question that matters later. If you send that thought now, it lands in the middle of the agent's turn and can pull it off course.

The usual workarounds both cost something:

- **Fork the session.** This works, but it is heavy for a one-line thought, and now you have one more session to track.
- **Copy the thought to a notes app, delete it from the prompt, and remember to come back.** This is what I did most of the time. The thought leaves the place where it will be used, and nothing reminds you that it is waiting.

Park is the small tool between those two. The thought stays next to the session, in a plain file. A counter above the prompt reminds you it is there, and one click returns it to the prompt when you are ready.


## What It Does

- **`/park <thought>`** - saves the thought and shows a `Parked (N)` toast. The command runs at once, even while Claude is in the middle of a turn, and does not interrupt that turn.
- **`<thought> /park`** - the same from the end of the line. Already typed the thought? Add ` /park` and press Enter: the prompt is parked, never sent, and the prompt box is emptied for the next one.
- **One list per session** - each session sees only the thoughts parked in it, so two terminals on the same project keep separate lists. `claude --resume` brings a session's thoughts back with it.
- **The Parked pane** - opens beside the conversation when you park something. Each thought is one row with the time, the project and the git branch it was parked from. Click a thought to insert it into the prompt box at the cursor; it moves to the archive. Click `×` to drop it. The pane closes when the list is empty. Clicks need the fullscreen terminal (`"tui": "fullscreen"` in settings.json).
- **A reminder above the prompt** - a dim `💡 N parked` line while anything is parked; click it to open or close the pane. It shares the band with other mods (a context meter, a button) and does not push them out.
- **`/parked`** - opens the pane, or closes it if it is open. `/parked list` prints the numbered list instead.
- **`/parked all`** - lists the thoughts of every session, this one first.
- **`/parked send [n ...]`** - sends all parked thoughts, or only the numbers you give, to Claude as one prompt. If Claude is busy, the prompt waits until the turn ends.
- **`/parked drop n ...` and `/parked clear`** - removes thoughts you no longer need.
- **Nothing is lost** - sent and dropped thoughts move to `parked-archive.md`, with the time and how they left.
- **Plain Markdown** - `parked.md` is a normal file that holds every session's thoughts. Put it in your notes vault, edit it by hand, and the counter catches up after the next turn. Under each heading a hidden `<!-- session: ... -->` line names the session the thought belongs to; delete that line and the thought shows in every session.


## Installing

At the prompt of a Claude Code terminal session:

```
/plugin install park --marketplace n0an/park
```

Answer `y` to add the marketplace, then choose whether the mod is installed for you or for one project.

From a shell:

```bash
claude plugin install park --marketplace n0an/park
```

Then start a new session, or run `/reload-plugins` in an open one.

To remove it:

```bash
claude plugin uninstall park
```


## Choosing Where Thoughts Go

By default the files are in `~/.claude/parked/`. To keep them somewhere else, such as a folder in your notes vault, set the `folder` option: run `/plugin`, pick **park**, and fill in the folder. Or set it in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "park@park": {
      "options": { "folder": "~/Notes/Inbox" }
    }
  }
}
```

The folder is created on the first `/park`. A leading `~` means your home folder.


## Using Park

1. While Claude works, a thought comes in. Type `/park` and the thought, then press Enter. If you already typed the thought, add ` /park` at the end instead.
2. Continue with the session. The line above the prompt shows how many thoughts are waiting.
3. When you are ready, click a thought in the Parked pane. It lands in the prompt box at the cursor; edit it or press Enter. Closed the pane? Click `💡 N parked` or run `/parked` to bring it back.
4. Prefer the keyboard? `/parked list` prints the numbered list, `/parked send` sends all of them, and `/parked send 2` sends one.


## What Reaches the Model

The text after `/park` does not go to Claude: the command answers for itself, and the model sees only the short `Parked #N.` result. A prompt that ends in `/park` is dropped before it enters the session, so the model sees nothing of it.

The Parked pane is not part of the conversation either: Claude does not see it. A thought you click goes into the prompt box, and reaches Claude only when you send that prompt.

The output of `/parked list` is different. The list is printed in the transcript, and Claude can read it on its next turn. If you want a thought to stay out of the conversation completely, use the pane or `parked.md` instead of listing it.


## How It Works

Everything is one hooks module, [`hooks/register.tsx`](hooks/register.tsx):

- `session.start` registers `/park` and `/parked` with `immediate: true`, so they run during a turn instead of waiting for it to end;
- a `prompt.submit` hook catches a prompt that ends in `/park`, parks the text before it, and answers `{ drop }`, so the prompt never enters the session; the engine puts a dropped prompt back in the box, sometimes a second or two later while a turn runs, so timers look for it over two seconds and empty the box with `$.prompt.fill` the first time it holds the parked prompt (text that still ends in `/park`, which also covers a paste shown as a placeholder); anything else in the box was typed since and is left alone;
- each entry carries the id of the session it was parked in (`$.session.id()`), and the pane, the counter and `/parked` show only the current session's; entries with no id, parked before 0.3.0, show in every session;
- `command.run` hooks answer both commands themselves, so nothing goes on to the model, and read and write the two Markdown files with `$.fs`;
- `/parked send` submits the prompt with `$.prompt.submit` from a zero-delay timer, because a command hook cannot submit a prompt while the turn waits on it;
- a `ui.render` hook on `Pane` draws the Parked pane, opened with `$.ui.open`: each thought is a `Button` whose press inserts its text with `$.prompt.fill({ mode: 'insert' })` and moves it to the archive;
- a `ui.render` hook on `AbovePrompt` draws what the other mods drew (`next(e)`) and adds the counter after it, as a button that opens or closes the pane;
- the list the pane and the counter draw lives in `$.state`, so a redraw follows each change;
- `turn.complete` reads the file again, so hand edits show up.

The time and branch in each entry come from `date` and `git branch --show-current`.


## Contributing

Contributions are welcome - bug fixes, new surfaces, or better ways to sort and search parked thoughts.

- Keep the module small. It runs in every session the mod is installed in.
- Run `claude plugin validate .` and `claude plugin test .` before opening a pull request.
- All work must be licensed under the MIT license.


## License

Available under the [MIT License](LICENSE), which permits commercial use, modification, distribution, and private use.
