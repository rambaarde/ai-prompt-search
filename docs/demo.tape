# ai-prompt-search — README demo
#
#   sh docs/demo-fixture.sh && vhs docs/demo.tape
#
# Runs the real installed `aps` against a fixture history, so nothing personal
# appears: no username, no email, no real prompts, no paths outside /tmp. The
# wrapper is shown over a plain shell rather than an agent, because an agent's
# banner prints the account it is signed in as.
#
# Everything on screen is the tool's real output. The only thing staged is the
# data it reads.

Output demo.mp4
Output demo.gif

Require aps

Set Shell bash
Set FontSize 15
Set Width 1180
Set Height 660
Set Padding 26
Set TypingSpeed 42ms
Set Theme { "name": "demo", "background": "#0d0d10", "foreground": "#d5d5db", "cursor": "#d5d5db", "selection": "#2a2a33", "black": "#0d0d10", "red": "#d98a8a", "green": "#8fbf8f", "yellow": "#d3a76b", "blue": "#7fa3d1", "magenta": "#c58fc5", "cyan": "#7fbcbc", "white": "#d5d5db", "brightBlack": "#5b5b66", "brightRed": "#e5a0a0", "brightGreen": "#a5d0a5", "brightYellow": "#e2bd85", "brightBlue": "#9dbce4", "brightMagenta": "#d9a8d9", "brightCyan": "#9ad2d2", "brightWhite": "#f0f0f4" }

# Set the stage without filming it: a neutral prompt, a fixture home.
Hide
Type "export HOME=/tmp/aps-demo && export PS1='❯ ' && cd $HOME/code/atlas && clear"
Enter
Sleep 700ms
Show

Sleep 900ms

# 1. Agents are detected, never configured.
Type "aps --agents"
Sleep 400ms
Enter
Sleep 2s

Type "clear"
Enter
Sleep 400ms

# 2. The picker: scoped to this project, filtered live, copied on Enter.
Type "aps"
Sleep 400ms
Enter
Sleep 1500ms

Type "migration"
Sleep 1800ms

Down
Sleep 700ms
Down
Sleep 900ms

Enter
Sleep 2s

Type "clear"
Enter
Sleep 400ms

# 3. The hotkey: ctrl-p opens the picker over whatever is already running.
Type "aps run bash"
Sleep 400ms
Enter
Sleep 1600ms

Ctrl+P
Sleep 1400ms

Type "rollback"
Sleep 1600ms

Enter
Sleep 2200ms
