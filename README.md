# OContinue

A plugin for [OpenCode](https://github.com/sst/opencode) that implements a self-referential AI loop - repeatedly feeding the same prompt until the AI signals completion.

Inspired by [Geoffrey Huntley's "Ralph" technique](https://ghuntley.com/ralph/).

## How It Works

1. You give the AI a task with clear completion criteria
2. The AI works on the task
3. When the session becomes idle, OContinue checks if the AI signaled completion
4. If not complete (and under max iterations), OContinue feeds the same prompt again
5. The AI sees its previous work in context and continues from where it left off
6. Loop continues until completion or max iterations reached

## Installation

Copy the `plugin/` and `command/` folders to your `.opencode` directory:

```bash
# Clone the repo
git clone https://github.com/d3vr/OContinue.git
cd OContinue

# Copy to your project's .opencode directory
cp -r plugin command /path/to/your/project/.opencode/

# Add state files to gitignore
echo "ocontinue-state.json" >> /path/to/your/project/.opencode/.gitignore
echo "ocontinue.log" >> /path/to/your/project/.opencode/.gitignore
```

Or install globally:

```bash
cp -r plugin command ~/.config/opencode/
```

Restart OpenCode to load the plugin.

## Usage

### Start a loop

```
/ocontinue "Your task description here"
```

With custom max iterations (default: 20):

```
/ocontinue "Fix all TypeScript errors" 10
```

With custom completion promise (default: "DONE"):

```
/ocontinue "Refactor the auth module" 10 COMPLETE
```

### Stop a loop

Press **Ctrl+C** (or **Esc**) to abort the current operation - this also stops the loop.

### Signaling Completion

The AI will see instructions to include `<promise>DONE</promise>` (or your custom promise text) when the task is complete. Once detected, the loop stops automatically.

## Features

- **Per-session loops** - Run multiple loops in different sessions
- **Abort detection** - Loop stops if you abort (Esc/Ctrl+C)
- **Toast notifications** - Visual feedback for loop events
- **Log file** - Detailed logs in `.opencode/ocontinue.log`
- **Persistent state** - Loop survives OpenCode restarts

## Configuration

| Parameter | Default | Description                                   |
| --------- | ------- | --------------------------------------------- |
| `max`     | 20      | Maximum iterations before stopping            |
| `promise` | "DONE"  | Text the AI must include to signal completion |

## How It Differs from Ralph

| Aspect            | [Ralph (Claude Code)](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-wiggum) | OContinue (OpenCode)                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Mechanism         | Stop hook blocks exit                                                                                       | session.idle event triggers continuation |
| Message injection | Blocks exit with prompt                                                                                     | Sends new message via SDK                |
| Result            | Same prompt fed repeatedly                                                                                  | Same prompt fed repeatedly               |

## License

MIT
