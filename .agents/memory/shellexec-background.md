---
name: ShellExec background processes
description: Background jobs die with the shell session; run long resumable scripts in foreground chunks.
---
- `nohup cmd &` launched via ShellExec is killed when the tool call's session ends — it looks like the script "hangs" or silently stops.
- Also: `pkill -f <pattern>` matching the current command's own string kills the shell itself.
**Why:** lost two rounds of a long API pipeline to this before diagnosing.
**How to apply:** for long-running work, make the script resumable (state file) and run it in foreground chunks: `timeout 280 node script.mjs`, repeat until done.
