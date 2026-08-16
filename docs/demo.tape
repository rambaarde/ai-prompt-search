# ai-prompt-search — ctrl-p inside a real Claude Code session.
#
# Prerequisites, since this one cannot be reproduced from a clean machine the
# way a plain CLI recording can: a throwaway project directory, and a history
# seeded with invented prompts filed against it. `docs/demo-fixture.sh` builds
# the same data; point it at wherever you want the sandbox to live.
#
# Everything before `Show` is hidden: the trust prompt, the account banner, and
# a warm-up whose output pushes that banner off screen. The visible portion is
# a live agent session with no account details on it.
#
# The picker is scoped to a sandbox project seeded with invented prompts, so it
# cannot show real work — the scope excludes every other project by design.

Output claude-demo.mp4
Output claude-demo.gif

Require aps

Set Shell bash
Set FontSize 15
Set Width 1000
Set Height 620
Set Padding 22
Set TypingSpeed 45ms
Set Theme { "name": "demo", "background": "#0d0d10", "foreground": "#d5d5db", "cursor": "#d5d5db", "selection": "#2a2a33", "black": "#0d0d10", "red": "#d98a8a", "green": "#8fbf8f", "yellow": "#d3a76b", "blue": "#7fa3d1", "magenta": "#c58fc5", "cyan": "#7fbcbc", "white": "#d5d5db", "brightBlack": "#5b5b66", "brightRed": "#e5a0a0", "brightGreen": "#a5d0a5", "brightYellow": "#e2bd85", "brightBlue": "#9dbce4", "brightMagenta": "#d9a8d9", "brightCyan": "#9ad2d2", "brightWhite": "#f0f0f4" }

Hide
Type "cd /tmp/aps-sandbox/code/atlas && unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_ENTRYPOINT && export PS1='❯ ' && clear"
Enter
Sleep 1s

Type "aps run claude"
Enter
Sleep 12s

# Trust the sandbox folder.
Enter
Sleep 8s

# Warm-up: its output is long enough to push the account banner off screen.
Type "print the numbers 1 to 40, one per line, nothing else"
Enter
Sleep 50s

# Dismiss the auto-mode offer.
Down
Enter
Sleep 6s
Show

Sleep 1500ms

# The hotkey, inside a live agent session.
Ctrl+P
Sleep 2s

Type "migration"
Sleep 2s

Down
Sleep 1200ms

Enter
Sleep 3s
