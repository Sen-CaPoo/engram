[繁體中文](../常見問題.md) · **English**

# FAQ

**Contents**: [Product](#product) · [Data and privacy](#data-and-privacy) · [Usage](#usage) · [Troubleshooting](#troubleshooting)

## Product

### Does Engram cost anything?

No. Engram is free under the [MIT license](../../LICENSE), and you can use it freely for personal and commercial purposes.

### Which systems are supported?

Currently **Windows 11** only. Background sync uses Windows Task Scheduler, and the installer uses winget to install missing tools.

### Which Claude plan do I need?

Any plan that lets you use Claude Code normally. Day to day, Engram makes no AI calls and uses none of your Claude quota. Your quota is used only when you type an `/engram` command yourself, or for the compatibility probe when Claude Code is updated (which you can turn off).

### How is Engram different from Claude Code's built-in memory?

Claude Code's automatic memory lives on one computer and follows the folder path. Engram keeps using the same memory format and adds cross-computer sync, project IDs, three scopes, conflict handling, health checks, and full undo. Engram doesn't modify Claude Code itself, and after you remove it, Claude Code keeps working as usual.

### Is Engram affiliated with Anthropic?

No. Engram is an independently developed third-party tool. Claude and Claude Code are trademarks of Anthropic.

## Data and privacy

### Where do my memories get sent?

Only to **your own private GitHub repo**, `engram-vault` (or the repo you specified when you installed). Engram has no server and collects no data. Conversation transcripts are never synced.

### What if my company doesn't allow work data on a personal GitHub account?

You have two options:

- Use a private repo under your company's GitHub organization: ask an administrator to create an empty repo, and add `--remote <repo URL>` when you install.
- Use Engram on a single computer only: add `--local` when you install, and your memories never leave this computer.

### What if Claude writes a memory that contains a password or key?

That memory isn't synced, and a card that says `"…" may contain a secret or password` appears in the inbox. Press **Remove secret**, then **Redact and resume sync**: syncing resumes only after the value in the memory has been replaced on this computer with `‹已遮蔽：…›` ("redacted"). After that, record "where the secret is kept and how to get it" instead. The core rules also tell Claude not to write down the value of a secret in the first place. Detection covers common formats (API keys and tokens from the major providers, connection strings, private keys, credentials inside URLs, and patterns such as `password: …`), but it can't promise to catch every way of writing one, so please don't deliberately put secrets into memories.

### My organization has Claude Code telemetry turned on. Does that matter?

If your Claude Code account is managed by an organization that has turned on telemetry (for example OpenTelemetry), conversation content is recorded according to your organization's settings. Engram doesn't change that, but when the content of a memory shows up in a conversation, it's recorded along with it.

### When I tidy with `/engram` commands, are my memories sent to AI?

Yes. They're sent to Claude just like in any other conversation, and they use your Claude quota. Possible secrets that were detected are redacted on your computer before anything is sent. Claude reads your memories for tidying only when you type those commands.

## Usage

### What happens if two computers are open at the same time?

No problem. Each one saves and syncs on its own, and edits to different memories are merged automatically; a conflict card appears only when the same section of the same memory was edited on both.

### What if my company network blocks GitHub?

Your memories are still saved locally, the status shows **Offline**, and everything syncs automatically once you're back on a network that can reach GitHub. If a corporate proxy or TLS inspection is the cause, the error message from `engram sync` tells you what to set, for example `git config --global http.sslBackend schannel`.

### What about a new computer, or after reinstalling Windows?

Install as described in the [Quick start](quick-start.md), and the new computer connects to your vault automatically. The new computer gets a new identity; the old computer's machine memories are still kept in the vault, and you can move them into the new computer's machine scope on the **Library** page.

### Will the working guidelines in my existing `~/.claude/CLAUDE.md` be moved away?

No. Installation only adds a two-line block at the end of the file. If you want your working guidelines to be the same on every computer: after you apply an import on the **Import memories** page, press **Sync working guidelines**. You first preview what the moved content will look like, it moves into the vault only after you approve, and you can restore it bit for bit later.

### If I switch permission modes during a conversation, can Claude still read my memories?

Yes, for conversations opened from the project root: no mode ever triggers a prompt. When a conversation is opened from a subfolder, memories are read and written through a link, and switching to acceptEdits or default mode triggers a prompt. In that case the start of the conversation warns you, and we recommend opening Claude Code from the project root instead.

### Will lots of memories slow Claude down?

Each time, Claude first reads only a very short index, and reads the full text only when it's needed. Engram keeps the global and machine indexes short, and memories that don't fit are still findable with `engram search`. When a project's index gets close to the 200-line limit, the inbox reminds you to tidy it.

### Why do you recommend setting Claude Code's default permission mode to auto?

It works without it: opening Claude Code from the project root is completely normal. When the mode is set to auto (or bypassPermissions), Engram additionally creates a memory link so that opening Claude Code from a subfolder can read and write the same set of memories too.

## Troubleshooting

Run `engram doctor` first. It checks git, merge settings, each project's link, the remote connection, the agent, and the sign-in task, one by one.

Error messages are shown below as they appear on screen (in Traditional Chinese for now), followed by an English gloss.

| Situation | Try this first |
| --- | --- |
| `setup.cmd` says it can't find winget | Update "App Installer" in the Microsoft Store, or manually install the tools listed on screen, then run `setup.cmd` again |
| A tool still isn't found after installing | Close the window and double-click `setup.cmd` again. Newly installed programs are only visible to newly opened windows |
| `Node.js 版本太舊` (Node.js is too old) | Run `winget upgrade --id OpenJS.NodeJS.LTS`, close the window, then run `setup.cmd` again |
| `無法執行 Claude Code` (cannot run Claude Code) | Claude Code isn't on the PATH, or was installed with npm (claude.cmd). In PowerShell, run `irm https://claude.ai/install.ps1 \| iex` to switch to the official installer, then open a new window and install Engram |
| `需要已登入的 GitHub CLI` (a signed-in GitHub CLI is required) | Run `gh auth login` and retry; or use `--remote` to specify a vault, or `--local` to use this computer only |
| `連接埠 4777 已被其他程式占用` (port 4777 is in use by another program) | Close the program that's using port 4777, then run `engram ui`. The dashboard's address is fixed and can't use a different port |
| The terminal can't find `engram` | Open a new terminal window. If that still doesn't work, in PowerShell use `node "$HOME/.engram/app/current/bin/engram.mjs" status` |
| Memories from the other computer aren't showing up | Run `engram sync` on both computers, then check the sync state in `engram status` |
| You need to sign in to GitHub again | Run `gh auth login` in a terminal to sign in again; if git's credentials aren't handed to GitHub CLI, run `git -C "$HOME/.engram/vault" fetch` in PowerShell and sign in when the browser opens |
| Permission prompts keep appearing when memories are read or written | First make sure you're opening Claude Code from the project root. If the inbox has a **Reading memory for "…" will trigger a permission prompt** card, press **Allow reading**; if it has a **Reading and writing memory will trigger permission prompts** card, press **Use settings-file links** |
| `/engram:inbox` and other commands don't appear | Run `/reload-plugins` in the open conversation, or start a new conversation |
| You want the detailed logs | `%USERPROFILE%\.engram\local\logs\` (you can paste it straight into File Explorer's address bar) |

Still stuck? Please report it on [GitHub Issues](https://github.com/Sen-CaPoo/engram/issues) and include the results of `engram doctor` (make sure it contains no personal information before you paste it).
