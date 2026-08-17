# ai-prompt-search — ctrl-p inside a real Claude Code session.
#
#   sh docs/demo-fixture.sh /tmp/aps-sandbox   # invented prompts for the picker
#   vhs docs/demo.tape
#
# The session is *resumed* rather than started. That is the whole trick for
# keeping a recording clean: a fresh start prints a welcome banner carrying the
# account name and organisation, which cannot be turned off, cleared with
# ctrl-l, or scrolled away by a short exchange. A resumed session prints no
# banner at all — it opens straight into the conversation.
#
# The picker is scoped to a throwaway project seeded with invented prompts, so
# it cannot show real work: the scope excludes every other project by design.
#
# Four acts, in the order you meet them: find an old prompt, keep a new one you
# have not sent, clear the line, and get the kept one back.

Output claude-demo.mp4
Output claude-demo.gif

Require aps

Set Shell bash
Set FontSize 15
Set Width 1000
Set Height 500
Set Padding 22
Set TypingSpeed 45ms
Set Theme { "name": "demo", "background": "#0d0d10", "foreground": "#d5d5db", "cursor": "#d5d5db", "selection": "#2a2a33", "black": "#0d0d10", "red": "#d98a8a", "green": "#8fbf8f", "yellow": "#d3a76b", "blue": "#7fa3d1", "magenta": "#c58fc5", "cyan": "#7fbcbc", "white": "#d5d5db", "brightBlack": "#5b5b66", "brightRed": "#e5a0a0", "brightGreen": "#a5d0a5", "brightYellow": "#e2bd85", "brightBlue": "#9dbce4", "brightMagenta": "#d9a8d9", "brightCyan": "#9ad2d2", "brightWhite": "#f0f0f4" }

# Set the stage off camera. The unset matters only because this was recorded
# from inside another agent session, which would otherwise print a warning no
# ordinary user ever sees. The drafts store is emptied so the recording starts
# from nothing and every draft on screen is one the recording itself makes.
Hide
Type "cd /tmp/aps-sandbox/code/atlas && unset CLAUDE_CODE_CHILD_SESSION CLAUDECODE CLAUDE_CODE_ENTRYPOINT && rm -f $HOME/.aps/drafts.jsonl && export PS1='❯ ' && clear"
Enter
Sleep 1s

Type "aps run claude --continue"
Enter
Sleep 34s   # long enough for the transient usage notice to clear
Show

Sleep 1500ms

# ── One: the hotkey, mid-conversation. ───────────────────────────────────────
Ctrl+P
Sleep 1800ms

Type "migration"
Sleep 1800ms

Down
Sleep 1s

Enter
Sleep 2s

# ── Two: a line you have not sent is a draft. ────────────────────────────────
# Typed on the end of the prompt just inserted, which is what actually happens:
# you pull an old prompt back and then adjust it for today.
Type " and backfill the existing rows"
Sleep 1500ms

Ctrl+P
Sleep 2500ms   # long enough to read the draft row along the bottom

# ctrl-s keeps it. Nothing on screen changes, which is the point: it is a
# save, not an interruption.
Ctrl+S
Sleep 1800ms

# ── Three: ctrl-x clears the agent's line. ───────────────────────────────────
Ctrl+P
Sleep 1200ms

Ctrl+X
Sleep 2500ms   # the input box empties, on screen

# ── Four: the kept draft is now just another prompt. ─────────────────────────
Ctrl+P
Sleep 1200ms

Type "backfill"
Sleep 2500ms   # the row comes back labelled `draft`

Enter
Sleep 3s
