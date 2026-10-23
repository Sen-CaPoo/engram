[繁體中文](AI%20幫你快速安裝.md) · **English**

# Install Engram with AI

<p align="center">
  <img src="docs/assets/en/illustrations/install-with-ai.webp" alt="Three steps: 1 Copy one prompt, 2 Paste it into Claude Code, 3 Done: memories start syncing" width="880">
</p>

> **For you, the user**: open Claude Code and paste in the message below, all of it. Claude will follow this manual and install Engram for you. The whole thing takes about 10 minutes, and Claude asks you before every step that changes your computer.
>
> ```text
> Please install Engram (the memory sync tool for Claude Code) for me.
> Install guide: https://raw.githubusercontent.com/Sen-CaPoo/engram/main/INSTALL-WITH-AI.md
> Read the entire guide before you start and follow its steps. Before any step that changes my computer, explain it to me in plain language and get my approval.
> ```
>
> What you need: Windows 11, a signed-in Claude Code, and a GitHub account. Along the way you only answer a few questions and click a few times in the browser when you sign in to GitHub.
> Prefer to do it yourself? See the [Quick start](docs/en/quick-start.md).

---

Everything below is the installation manual for the AI assistant.

## Your task

Install **Engram** on this Windows computer for the user. Engram stores Claude Code's memory in the user's own private GitHub repo and syncs it automatically across their computers. The installation is complete when:

1. `engram status` shows this computer's name and the vault location;
2. `engram doctor` shows no unexpected ✗;
3. The user knows what to do next (import old memories, open a new conversation to confirm, how to install on a second computer).

## Ground rules (follow these without exception)

1. **Read the whole manual before you start.**
2. **Get approval before changing anything.** Before installing tools, downloading programs, running the installer, or importing memories, explain in plain language what you are about to do, what it changes, and how to undo it, then wait for the user's explicit approval. Commands that only query state can run right away.
3. **The user signs in themselves.** Signing in to GitHub needs a browser, so have the user do it. Never ask for, type in for them, or print any password or token.
4. **Stop at errors.** Quote the error message verbatim, check it against "Troubleshooting" below, explain it to the user, and only then decide the next step. Don't work around problems by deleting folders, using `--force`, or changing system settings.
5. **Speak plainly.** Use the user's language (English by default for this manual) and keep jargon to a minimum; after each step, report progress in one sentence. Engram's command-line output (the install plan, `doctor` results, error messages) and the setup script's prompts are in Traditional Chinese for now: where this manual quotes that output, it keeps the original Chinese text so you can match it, followed by an English gloss. Quote the original when you cite an error, and explain it in the user's language.

### How to write commands

- The commands below run in **both PowerShell and Git Bash**: `$HOME` works in both, and paths always use `/`.
- A tool that was just installed with winget may not be found in this conversation yet (the PATH hasn't updated). In that case use the full paths in [Appendix B](#appendix-b-full-paths-to-the-tools); if that still fails, ask the user to reopen Claude Code and then say "continue installing Engram".
- Wherever the text below says `engram`: before installation is complete, write it as `node "$HOME/engram/app/bin/engram.mjs"`; after installation, write it as `node "$HOME/.engram/app/current/bin/engram.mjs"` (in a newly opened terminal you can also just type `engram`).

## Step 1: Check the environment (read-only, safe to run right away)

```bash
powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).Caption"
claude --version
git --version
node --version
gh --version
gh auth status
winget --version
node "$HOME/.engram/app/current/bin/engram.mjs" status
```

Judge by the results:

| Item | Passes when | If it doesn't pass |
| --- | --- | --- |
| Operating system | The first line shows Windows 11 | **Stop.** Engram supports Windows 11 only; tell the user |
| Claude Code | `claude --version` prints a version number | **Stop.** Ask the user to install Claude Code and sign in first |
| Git | Prints a version number | Install in Step 3 |
| Node.js | `v22` or later | Install or upgrade in Step 3 |
| GitHub CLI | Prints a version number | Install in Step 3 |
| GitHub sign-in | `gh auth status` shows Logged in | Step 4 |
| winget | Prints a version number | See "winget not found" in Troubleshooting |
| Existing installation | The last command **fails** (meaning Engram isn't installed yet) | Already installed: follow ["Already installed"](#already-installed-update-repair-or-remove) instead |

Summarize the results in a table for the user.

## Step 2: Confirm three things with the user

Ask all three at once, then wait for the answers:

1. **What should this computer be called?** For example "Work PC", "Home PC", or "Laptop". The name appears in Engram's status for every computer.
2. **Where should the memories sync to?**
   - **A (recommended)**: a private repo named `engram-vault` under your GitHub account. The first computer creates it automatically, and later computers connect to it automatically.
   - **B**: a private repo your company specifies. This suits companies that don't allow work data on a personal GitHub account; have an administrator create an empty private repo first and give you its URL.
   - **C**: use it on this computer only, with no sync.

   Mention while you're at it: memories may contain customer or project details, so check whether company policy allows option A.
3. **Where should the Engram program live?** The default is `$HOME/engram` (for example `C:\Users\YourName\engram`). Keep it after installation; you'll need it for updates.

## Step 3: Install any missing tools (needs approval)

Install only the items Step 1 found missing:

```bash
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements
```

If Node.js is older than version 22, use `winget upgrade --id OpenJS.NodeJS.LTS -e --source winget` instead. After installing, rerun the matching command from Step 1 to confirm (using the full path if necessary).

Windows may show a User Account Control (UAC) prompt asking whether to allow the app to make changes to your device. Warn the user in advance to choose "Yes".

## Step 4: Sign in to GitHub (the user does this)

This is needed only if the user chose A or B **and** `gh auth status` shows they're not signed in. Ask the user to:

1. Open a separate PowerShell window;
2. Run `gh auth login --hostname github.com --git-protocol https --web`;
3. Follow the on-screen instructions: copy the one-time code, press Enter to open the browser, paste the code, and authorize;
4. Come back here and say "done".

Then run `gh auth status` again to confirm it shows Logged in.

## Step 5: Get the Engram program (needs approval)

```bash
git clone https://github.com/Sen-CaPoo/engram.git "$HOME/engram"
```

- If the folder already exists and contains `app/bin/engram.mjs`: run `git -C "$HOME/engram" pull` instead to get the latest version.
- If the folder already exists but isn't Engram: ask the user to choose a different location, and don't overwrite it.
- If the user chose a different location: replace `$HOME/engram` with that location in every command from here on.

## Step 6: Preview the install plan (changes nothing, safe to run right away)

```bash
node "$HOME/engram/app/bin/engram.mjs" install --dry-run --label "<computer name>"
```

Add parameters according to the choice in Step 2: for B add `--remote <repo URL>`, for C add `--local`, and for A add nothing.

The output format:

- Lines starting with `✗` are **problems that must be solved first**; no plan is listed in that case. Handle them as described in Troubleshooting, then preview again.
- The numbered list under `Engram 安裝計畫：` ("Engram installation plan:") is what will be done.
- Lines starting with `!` are notices and don't block the installation.

Please:

1. Translate the plan line by line into plain language for the user; [Appendix A](#appendix-a-what-the-installation-changes) can help;
2. Call out any notices. The most common is the notice that begins `你的 Claude Code 預設權限模式是「…」` ("your Claude Code default permission mode is '…'"): it means that opening Claude Code from the project root works completely normally, and only when it is opened from a subfolder will Engram's memory not be used. **Don't change the user's Claude Code settings yourself**; help only if the user asks;
3. Ask the user: "Do you want to install according to this plan?"

## Step 7: Install (needs explicit approval)

```bash
node "$HOME/engram/app/bin/engram.mjs" install --label "<computer name>" --yes
```

Use the same parameters as in Step 6. `--yes` only skips the program's built-in 「要開始安裝嗎？」 ("Start installing?") prompt, because you already got approval in Step 6; without `--yes`, when the session isn't an interactive terminal, the program exits after printing the plan. It usually takes about 1 minute, but creating the GitHub repo and installing the plugin for the first time can take longer, so run it with a long timeout (for example 5 minutes). On success, the output ends with 「安裝完成」 ("Installation complete").

For the second and later computers, the installer automatically discovers that `engram-vault` already exists on GitHub and connects to it, and it downloads the memories the other computers have already synced. No extra parameters are needed.

## Step 8: Verify

```bash
node "$HOME/.engram/app/current/bin/engram.mjs" status
node "$HOME/.engram/app/current/bin/engram.mjs" doctor
```

- `status` should show this computer's name, the vault location, and the sync state.
- `doctor` checks the vault, the GitHub connection, the agent, and the sign-in task one by one; everything should show ✓. These ✗ results are expected:
  - With option C (this computer only), `遠端連線：尚未設定遠端` ("Remote connection: no remote set") is always ✗, and `doctor`'s exit code will be 1. That **does not mean the installation failed**.
  - `常駐程式：沒有在執行` ("Agent: not running"): run `node "$HOME/.engram/app/current/bin/engram.mjs" ui` to start it; after that it also starts automatically every time you sign in to Windows.
- Any other ✗: give the user that line verbatim and check it against Troubleshooting.

## Step 9: Import existing memories (recommended, needs approval)

If the user has been using Claude Code for a while, there will be old memories on the computer. First generate a plan (this writes nothing):

```bash
node "$HOME/.engram/app/current/bin/engram.mjs" import plan
```

Summarize the result for the user: how many folders, how many memories, how many of each will be copied or skipped (duplicates or older versions), and which are recommended for global or machine scope. Then let the user choose:

- **Review in the dashboard (recommended for first-time use)**: run `node "$HOME/.engram/app/current/bin/engram.mjs" ui`, and the browser opens `http://127.0.0.1:4777`. Ask the user to go to **Import memories**: review each item, then click **Start rehearsal** (it runs a complete import, verification, and restore on a copy, without touching any real files), and once all four checks pass, click **Apply plan**. Wait for the user to finish. (The dashboard is available in English and Traditional Chinese: the language switch is in the top bar or in Settings.)
- **You apply it directly**: after the user explicitly approves, run `node "$HOME/.engram/app/current/bin/engram.mjs" import apply --yes`. Tell the user the **restore point** (the value after `還原點：` in the output); if needed, they can restore with `engram import undo <restore point>`. If the output contains `延後：…正有對話在使用` ("Deferred: … a conversation is using it"), that folder is in the middle of a conversation (usually including this one), and the agent connects it automatically once the conversation ends; until then, it's normal for `doctor` to show ✗ for that folder's link.

Original memory files are always kept and never deleted. A brand-new user with only one computer, or a second computer with no old memories, can skip this step.

## Step 10: Wrap up and hand over

Report back in this format:

```text
✓ Engram is installed on "<computer name>"
· Vault: <GitHub repo URL, or "this computer only">
· Import: <N memories, restore point …> or "not imported yet"
· Next:
  1. Open a new Claude Code conversation and ask "Can you see Engram's status?"
     It should answer with something like "<computer name> · project: … · bound"
     (the status text Engram injects is in Traditional Chinese for now, so Claude may quote it as "專案：… · 已綁定")
  2. Memory pane: type /engram-memories in Claude Code (or select "◆ Engram" at the bottom) to see which memories this conversation read
  3. Dashboard: type engram ui in a terminal (Edge is recommended; from its menu choose "Apps › Install this site as an app")
  4. Tidy-up: under Tidy-up in the dashboard, pick a scope and paste the copied command into Claude Code; after Claude makes suggestions, you decide each item on the page
  5. Second computer: paste the same message into Claude Code on that computer and give it a different name
  6. Please keep <Engram folder>; you'll need it for updates
```

Also remind them: in a Claude Code conversation that is already open, run `/reload-plugins` or start a new conversation before commands such as `/engram:inbox` appear. (The instructions inside these commands are in Traditional Chinese for now; Claude normally replies in the language you write in.)

## Already installed (update, repair, or remove)

If Step 1 finds Engram already installed, first ask the user what they want to do:

| What they want | How |
| --- | --- |
| Update to the latest version | Confirm where the Engram folder is, run `git -C "<Engram folder>" pull`, then run `engram update`. For a ZIP install, have the user download the new version's ZIP over the old folder, then run `engram update` (ZIPs are told apart by version number, so unpacking the same version again doesn't update anything) |
| Check that it's healthy | `engram doctor`, then check the results against Troubleshooting |
| Add this computer's old memories | Step 9 |
| Remove | First run `engram uninstall --dry-run` to list the removal plan and explain it; after the user approves, run `engram uninstall --yes`. By default the **vault is kept**; add `--purge` only if the user explicitly asks to delete the local vault too, and confirm once more (the repo on GitHub isn't affected) |

## Troubleshooting

| Situation | What to do |
| --- | --- |
| winget not found | Ask the user to update "App Installer" in the Microsoft Store; or manually install the missing tools from git-scm.com, nodejs.org (LTS version), and cli.github.com |
| A tool is installed but "not found" | Use the full paths in [Appendix B](#appendix-b-full-paths-to-the-tools); if that still fails, ask the user to reopen Claude Code |
| `需要已登入的 GitHub CLI` (a signed-in GitHub CLI is required) | Go back to Step 4 |
| `無法執行 Claude Code` (cannot run Claude Code) | Claude Code isn't on the PATH, or was installed with npm (claude.cmd). Ask the user to run `irm https://claude.ai/install.ps1 \| iex` in PowerShell to switch to the official installer, reopen Claude Code, and then say "continue installing Engram" |
| `無法查詢你 GitHub 上的記憶庫` (cannot query your vault on GitHub) | Usually a network or corporate proxy problem. Confirm `gh auth status` works and github.com opens, then retry; if it still fails, switch to B (`--remote`) or C (`--local`) |
| A certificate or TLS error when connecting to GitHub | Common on company networks with TLS inspection. With the user's approval, set `git config --global http.sslBackend schannel` and retry |
| `連接埠 4777 已被其他程式占用` (port 4777 is in use by another program) | Ask the user to close the program using it, then run `engram ui`. The dashboard always uses port 4777 |
| `npm 全域已經有另一個 engram` (npm already has a different global engram) | Harmless. In the terminal, use `node "$HOME/.engram/app/current/bin/engram.mjs"` instead |
| `engram` isn't found in a newly opened terminal | Open yet another new window; if it still isn't found, use the full form from the previous row |
| Any other uncertain error | Run `engram doctor`; detailed logs are in `$HOME/.engram/local/logs/`. Give the user the original error text and the doctor results, and suggest reporting it on GitHub Issues |

## Appendix A: What the installation changes

| Location | What it does |
| --- | --- |
| `$HOME/.engram/` | The vault, the program itself, local state, and backups |
| `$HOME/.claude/CLAUDE.md` | Adds a two-line Engram block at the end of the file and leaves the existing content alone; backed up before the change |
| Claude Code plugin `engram` | Hooks at the start and end of conversations, the `/engram:` commands, and the memory pane (watches which memory files the conversation loads and reads, and adds a **◆ Engram** button at the bottom of Claude Code and the `/engram-memories` command) |
| npm global command `engram` | Lets you type `engram` in an ordinary terminal (add `--no-cli` during installation to skip it) |
| Windows Task Scheduler `\Engram\Agent` | Starts Engram in the background at sign-in and syncs every 10 minutes |
| Project folders bound during import | `.claude\settings.local.json` gets one line pointing to the memory location; folders that aren't git repos also get a `.claude\engram.json` marker |
| `$HOME/.claude/settings.json` and the memory folder | Only when the default permission mode is auto or bypassPermissions: the original memory folder is backed up and replaced with a link, and Claude is allowed to read that link |

Every item is recorded in the installation record, and `engram uninstall` reverts them one by one.

## Appendix B: Full paths to the tools

winget's default install locations:

| Tool | Full path |
| --- | --- |
| Git | `C:/Program Files/Git/cmd/git.exe` |
| Node.js | `C:/Program Files/nodejs/node.exe` |
| GitHub CLI | `C:/Program Files/GitHub CLI/gh.exe` |

Usage examples: `& "C:/Program Files/nodejs/node.exe" --version` (PowerShell) or `"/c/Program Files/nodejs/node.exe" --version` (Git Bash).
