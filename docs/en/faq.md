[繁體中文](../常見問題.md) · **English**

# FAQ

**Contents**: [Product](#product) · [Data and privacy](#data-and-privacy) · [Usage](#usage) · [Troubleshooting](#troubleshooting)

## Product

### Does Engram cost anything?

No. Engram is free under the [MIT license](../../LICENSE), and you can use it freely for personal and commercial purposes.

### Which systems are supported?

Currently **Windows 11** only. Background sync uses Windows Task Scheduler, and the installer uses winget to install missing tools.

### Which Claude plan do I need?

Any plan that lets you use Claude Code normally. Day to day, Engram makes no AI calls and uses none of your Claude quota. Your quota is used only when you type an `/engram` command yourself, for the compatibility probe when Claude Code is updated (which you can turn off), and when you turn autopilot on. Context recall, guardrails, the environment check, and automatic updates all run on your computer and use no quota.

### How is Engram different from Claude Code's built-in memory?

Claude Code's automatic memory lives on one computer and follows the folder path. Engram keeps using the same memory format and adds cross-computer sync, project IDs, three scopes, conflict handling, health checks, and full undo. From 2.0, Engram also looks after the whole Claude Code environment: it makes important memories show up at the right time, turns pitfalls you've hit into guardrails, checks the environment, and lets several computers share one set of settings. Engram doesn't modify Claude Code itself, and after you remove it, Claude Code keeps working as usual.

### What should I know about upgrading to 2.0?

The upgrade is free. Updating works the same as before (`git pull`, `engram update`). What happens the first time after upgrading, and each feature's default, are in [section 15 of the user guide](user-guide.md#15-updating). 1.x has no automatic updates, so every computer still on 1.x must be updated to 2.0.0 by hand once; versions after 2.0.0 then catch up on their own. The three most important things: the new index rules (corrections and preferences always listed, project indexes shortened automatically, index layers) start only once every computer is on 2.0.0, so please update them all; autopilot no longer splits or condenses memories; and environment settings, skills, and "block" guardrail rules that sync from another computer take effect only after you approve them once on each computer.

### I updated only one computer and the other is still on an older version. What happens?

Nothing is lost and nothing breaks; the new 2.0 index rules just don't apply for now:

- The shared indexes (the global `INDEX.md` and each project's `MEMORY.md`) go into "compatibility mode" and stay laid out the old way, so the computers don't rewrite the same index in turn. The new index rules and index layers start only once every computer is updated.
- The older computer doesn't update itself (1.x has no such feature); run `git pull` and `engram update` on it by hand.
- While versions are mixed, don't edit by hand `settings.json`, `release.json`, or the files under `env/`, `guardrails/`, and `holding/` in the vault: the older version doesn't recognize these files and doesn't check them for possible secrets.
- Once the older computer is updated to 2.0.0, the indexes switch to the new rules by themselves and you don't need to do anything; an older computer that hasn't been active for more than 7 days no longer counts. `engram status` shows whether compatibility mode is on and which computers are still on an older version.

See [section 15 of the user guide](user-guide.md#15-updating).

### Is Engram affiliated with Anthropic?

No. Engram is an independently developed third-party tool. Claude and Claude Code are trademarks of Anthropic.

## Data and privacy

### Where do my memories get sent?

Only to **your own private GitHub repo**, `engram-vault` (or the repo you specified when you installed). Engram has no server and collects no data. Conversation transcripts are never synced; read statistics sync only how many times each memory was read. The full list is in the next question.

### What syncs to my private vault, and what stays on this computer?

| Synced to your private vault | Stays on this computer |
| --- | --- |
| Memory files, indexes, the core rules, and Engram's shared settings (for example index layers) | Conversation transcripts (stored by Claude Code itself; Engram reads them only on this computer) |
| Each computer's read counts for each memory over the last 90 days, and hashes of which content versions you've confirmed | Holding area items produced by conversation review (they contain conversation text), and holding area items with a possible secret |
| Environment fingerprints: names, versions, and content hashes only, with no setting values | The exact words you used to correct Claude (only a fixed category and a hash sync, not the words; autopilot's prompts carry only words verified to come from you, never a topic written by the model) |
| The shared environment profile and custom skills (checked for possible secrets first), and each computer's list of items skipped with **Skip here** | All the recall, guardrail, and search hit records, and the weekly digest |
| Guardrail rules | Which environment settings, skills, and guardrail rules you've approved on this computer |
| Holding area items without conversation text | Backups from before environment settings were applied, tidy-up records, and the local secret store (secrets autopilot moved out) |
| Release information (which version, and where the version tag points; used for automatic updates) | The context recall index (`~/.engram/local/cache/`) |
| Each computer's autopilot state (the switch, and which version of each scope was tidied) and the changes you've undone | Each autopilot run's record |

A memory file with a possible secret is never pushed. The environment profile, custom skills, guardrail rules, and holding area items are checked before they're written to the vault, and any that seem to contain a secret are rejected (holding area items are kept on this computer instead), so they never end up anywhere that syncs.

### Does the environment check read my setting values?

Almost none. The environment check records only names, versions, content hashes, counts, and timings. It never reads the values of environment variables, and for `settings.json` it records which keys exist plus just three values (the first 80 characters of each hook's command, with your home folder replaced by `~` and possible secrets masked; which plugins are enabled; and the transcript retention days); the environment fingerprint that does sync to the vault goes through a possible-secret check once more before it's written. To work out hook timings and plugin use, it scans the last 30 days of conversation files on this computer and takes only the counts: it doesn't record or sync conversation content. If you don't need it, turn it off under **Settings › Environment › Environment check**.

### Can context recall bring other projects' memories into this conversation?

No. Context recall looks only in global memories, this computer's machine memories, and the current project's memories, and brings up at most 3 each time. The search runs on your computer and makes no AI call. To turn it off, go to **Settings › Context recall & index** (it can't be turned off while index layers are on). To see experience from other projects, use `/engram:recall`.

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

### Could a tidy-up mess up my memories?

No. `/engram:tidy` only reads memories and creates a tidy-up record (the skill pre-allows only those commands): Claude saves its suggestions and the revised content as a tidy-up record, and the memories themselves stay as they are. Nothing runs until you decide on each item under **Tidy-up** in the dashboard and paste `/engram:tidy-apply` back into Claude Code. Accepted items are written exactly as you saw them on the page, never regenerated. A backup is made first, memories that changed after the suggestion are never overwritten, and every item can be undone from the results page.

### Does conversation review send my conversations anywhere?

Your conversations aren't synced, and they aren't uploaded to GitHub. When you type `/engram:dream`, Engram turns the conversations that haven't been reviewed into compact text on this computer (possible secrets are masked first) and puts it in `~/.engram/local/dream/`. Your own Claude Code reads and analyzes it, and, as in any conversation, that uses your Claude quota; the text is deleted as soon as the tidy-up record is created (or after 14 days if the run is never finished). Nothing is changed during the analysis, and the suggestions are carried out only after you decide on them on the Tidy-up page.

### How much quota does conversation review use?

One analysis subagent (Sonnet) reads each piece of conversation text in full (a very long conversation is split into several), so usage grows with how long and how many the conversations are. A run reviews 20 conversations by default (change it with `--sessions`, up to 100); when there are many or they're long, use `/engram:dream --sessions 5` to review the oldest few first and leave the rest for next time.

### Could autopilot mess up my memories?

Autopilot doesn't ask you to confirm each change, so code and a second AI review do the checking instead: the AI only returns decisions and can't write files; rewrites, merges, archives, and anything written to scopes loaded in every conversation need the reviewer's approval; anything that looks like injected instructions always goes to review; conversation review writes to global or machine scopes only with something you said yourself as evidence; at most 30 memories changed per run, and memories are archived, never deleted. From 2.0 it also doesn't split memories or cut their text to make them shorter (a rewrite that makes the text much shorter always goes to the reviewer). Every change is backed up first and can be undone one by one or a whole run at a time on the **Autopilot** page; a kind of change you undo in two different runs is paused automatically, and you can resume it in one click. Suggestions the reviewer didn't approve don't disappear: they're saved in the **Holding area** for you to decide (see "What is the holding area, and do I need to deal with it?" below).

### How much quota does autopilot use, and what does it send?

It calls Claude with the Claude Code sign-in on your computer and sends the memories and conversation text being judged (possible secrets are masked on your computer first), just like when you type `/engram:tidy` or `/engram:dream` yourself. It doesn't load your CLAUDE.md or settings and doesn't save a transcript. There's no extra charge on a subscription, but it uses quota: the monthly cap per computer defaults to about US$200 at API list prices (pick a common amount or set your own from 1 to 1000 on the **Autopilot** page, or run `engram autopilot budget <dollars>`). There's no per-run money cap, so a run can use whatever is left this month; it stops when this month's budget is used up or at Claude's usage limit. It runs only after the computer has been idle for 20+ minutes so it doesn't compete with you.

### If two computers both have autopilot on, will they edit against each other?

From 1.6.0 every computer is equal: each one tidies the shared memories (global, core rules, project memories) and resolves sync conflicts. Each run syncs first to get the other computer's changes; which version of each scope was tidied is recorded in your vault and synced, and a scope another computer already tidied that hasn't changed since is skipped. So the same memories aren't tidied twice, and two computers don't take turns changing the same ones. If two computers happen to change the same memory at once, syncing turns it into a conflict that the next run merges, and neither side's content is lost. Machine memories are tidied only by their own computer. Keep every computer on the same version: a computer that is too old can't see the other computers' tidy-up records and may tidy the same memories again.

### Where did autopilot move my secrets?

To the local secret store on this computer, `~/.engram/local/secrets/`, encrypted with Windows DPAPI so only this Windows user on this computer can decrypt it. It is never synced. The memory now says where the secret is stored and how to get it: `engram secret get <name>` retrieves it and `engram secret list` lists them. After reinstalling Windows the old values can't be decrypted (the encryption is tied to this user on this computer): `engram secret check` shows which ones, and `engram secret delete <name>` removes the ones you can't recover; until then conversation review stops exporting so no value can leak.

### Why does "Waiting for your review" appear in the inbox?

Claude wrote to a global memory, a machine memory, or the core rules on its own. These load in every conversation and affect every project, so you're asked to look at the changes and confirm, edit, or go back. Anything you changed in the dashboard, accepted as suggested on the Tidy-up page, or agreed to write with `/engram:save` isn't asked about again; content Claude rewrote for an **Adjust per note** item is still listed for review. If you don't need it, you can turn it off on the Settings page. Note that "isn't asked about again" doesn't mean "is your preference"; see "Why didn't autopilot follow a preference I saved?" below.

### How are read statistics calculated?

Engram looks through this computer's conversations to find which memories Claude read (with the Read tool, with `engram memory show`, or by reading the file in a terminal). A memory read more than once in the same conversation on the same day counts once. The counting happens on this computer and uses no Claude quota; once a day, the last 90 days' read counts are synced, so the counts from both computers are added together.

### Does the memory pane send my memories anywhere?

No. The memory pane reads files on your computer and lists them; it makes no AI calls, uses no quota, and connects to nothing.

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

Each time, Claude first reads only a very short index, and reads the full text only when it's needed. Engram keeps the global and machine indexes short: when there isn't room, pinned memories and your corrections and preferences always stay in the index, and memories that don't fit are still findable with `engram search` and may be brought up by context recall when they're relevant. When a project's index reaches 80% of the load limit, Engram automatically shortens each line, and only if it still doesn't fit does it leave lines out by importance (with a note saying "N more not listed"). These two new rules take effect only once every computer is on 2.0.0.

### How do I know which memories Claude read this time?

Open the memory pane: select **◆ Engram** at the bottom of Claude Code, or type `/engram-memories`. The pane has two parts, **Loaded at start** and **Read during the conversation**, and every row says whether Claude saw the full text, only titles, or a search snippet. An index loaded at start only tells Claude which memories exist; a memory's content shows up under **Read during the conversation** only after Claude reads it. See [section 4 of the user guide](user-guide.md#4-the-memory-pane-which-memories-this-conversation-read).

### Why do you recommend setting Claude Code's default permission mode to auto?

It works without it: opening Claude Code from the project root is completely normal. When the mode is set to auto (or bypassPermissions), Engram additionally creates a memory link so that opening Claude Code from a subfolder can read and write the same set of memories too.

### Why didn't autopilot follow a preference I saved?

Autopilot follows only the preferences **you confirmed yourself**, plus whatever was there when you installed. It looks at the core rules and at the global `feedback` and `user` memories. Anything written by a command run inside a Claude Code conversation (including `/engram:save`, `/engram:tidy-apply`, handling conflicts with `/engram:inbox`, and `engram remember --reviewed`, `engram holding adopt`, or `engram import apply` run in a conversation) is always recorded as "confirmed on your behalf by Claude", and together with content autopilot confirmed for you, it doesn't automatically become its rules: what's written in a conversation can be steered by instructions slipped into it, so it needs your own nod. The same command counts as confirmed by you only when you run it in a terminal you opened yourself (not a Claude Code conversation).

To make one count: open the **Autopilot** page of the dashboard, find the item under **Not adopted yet** in **Preferences autopilot follows**, and select **This is my preference** (when there are several, you can use **Confirm all**). The **Followed when judging** list shows everything it follows now. You can also run `engram autopilot preferences` in your own terminal. If an item says it didn't fit in the preference block, there are too many preferences and the length limit was exceeded; make the content shorter. The same block also has a list of candidates: other memories that are used often but that you haven't confirmed yourself (for example global reference memories and this computer's machine memories). Confirming them doesn't make them preferences autopilot follows; it lets memory graduation write them into the core rules or turn them into guardrail rules later.

### What is the holding area, and do I need to deal with it?

The holding area keeps suggestions autopilot wanted to make but didn't carry out: the reviewer didn't approve them, they were outside what that run could handle, or they're a version that was sent back. The full content and evidence are kept. You don't need to empty it: the holding area isn't memory, doesn't appear in the index or in searches, and doesn't affect what Claude reads. When you want to look, open the **Holding area** page of the dashboard (or run `engram holding`). After looking, you can **Apply** an item (it's written into memory, backed up first, and undoable) or mark it **Not needed** (the same proposal isn't sent for review again for 90 days). Items the reviewer didn't approve, or that were outside that run's scope, are also reviewed again by autopilot in the next few runs, up to twice (items that synced in from another computer aren't reviewed again by this one; they're left to you). Items applied or marked not needed for more than 90 days are cleared automatically.

### A guardrail blocked a command I wanted to run. What now?

1. **Read the explanation first.** Claude receives a message that starts with `[Engram guardrail]` (in Chinese, `[Engram 護欄]`; the language is the one chosen in the memory pane, then Claude Code's `language` setting, then the system locale, and English when none of them is set) explaining why that way of writing it goes wrong, and the right way to write it. Claude usually rewrites the command and sends it again by itself.
2. **If you're sure the block was wrong:** ask Claude to send the same command again unchanged, and it will be let through for the rest of that conversation. When the second try succeeds, Engram lowers that rule to "hint only" on this computer, and it comes back automatically after 14 days. (One kind of rule guards against problems that go wrong quietly without any error, so a successful second try doesn't prove the block was wrong; those rules are never lowered automatically, and it's up to you whether to adjust them.)
3. **If you don't want this rule to block you again:** go to **Environment › Guardrails** and disable that rule on this computer (your other computers aren't affected), or go to **Settings › Guardrails** and change it to **Hint only** or **Off**.
4. **To find out which rule it was:** use **Try it** under **Environment › Guardrails**. Paste the command and it lists the rules it matches (it only matches and never runs the command).

If guardrails themselves break or time out, the command is sent as usual and nothing gets stuck.

### Why do I have to approve settings that synced from another computer?

Environment settings, custom skills, and "block" guardrail rules take effect directly on this computer once applied, and never ask you again. So anything that synced from another computer applies only after you've read its full content on this computer and pressed **Approve**; if the content changes later, it needs approval again. Approval can only be given in the dashboard (**Environment › Settings sync** and **Environment › Guardrails**) or in your own terminal (`engram env approve`, `engram guardrails approve <rule id>`); running it inside a Claude Code conversation is refused, so the AI can't approve something for you and then apply it itself. Settings you haven't approved are only listed under **Waiting for approval on this computer** and are never applied.

### Could automatic updates install a broken version, and how do I turn them off?

Automatic updates are guarded at every step. They accept only the repository you installed from, with a version tag where the tag points to exactly the release that was published. This computer's Engram folder must be a clean git copy, and only "forward" updates are accepted. It backs up before updating, runs a check afterwards, and confirms that the new version's agent can start; if any step fails, it goes back to the previous version automatically and notifies you, and the same release isn't tried again. An install from a ZIP (not a git copy) or a development install is never updated automatically.

To turn them off, switch off **Settings › Automatic updates** in the dashboard, and from then on update by hand with `git pull` and `engram update` as before. To find out why this computer didn't update, look at **Last check** in the same section, which gives the reason.

### Where did my project go?

It may have gone dormant. A project goes dormant when no computer has a folder bound to it and there has been no sign of any conversation for 90 days. The **Projects** page then shows only **Active** projects by default, and dormant ones are under **Dormant**; autopilot and the tidy-up checks no longer handle it. Its memories are fully kept and still searchable, and it wakes up by itself when you open Claude Code again in that project's folder.

### The inbox says two projects may be the same one. Should I merge them?

Merge them only if you're sure they're the same project. The basis for the suggestion is written on the card: when the git remotes are exactly the same, it's most likely the same project; when only some remotes or only the root commit match, it's most likely a fork or a shared template, not the same project. A merge moves one project's memories into the other. You can undo it from the change history under **Devices & sync**, but undoing restores only the vault and this computer's binding, so check your other computers yourself. Autopilot doesn't handle these suggestions and leaves the decision to you.

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
| The memory pane or **◆ Engram** at the bottom doesn't appear | Type `/engram-memories` to open it (it opens by itself only in the fullscreen layout with a terminal at least 144 columns wide). If you just updated Engram, run `/reload-plugins` in the open conversation. If it's still missing, run `claude update`: the pane needs a Claude Code version that supports plugin panes (tested on 2.1.329 and 2.1.330; earlier versions weren't tested) |
| Context recall brought up nothing, or guardrails didn't block a command | Both work through the plugin's mod. First run `/reload-plugins` in the open conversation. When your Claude Code version doesn't support plugin panes, context recall is taken over by a fallback command hook (same result), but guardrails can't block commands and only list reminders at the start of the conversation. Also make sure **Context recall** and **Guardrails** haven't been turned off on the Settings page |
| Automatic update didn't update | **Last check** under **Settings › Automatic updates** gives the reason. Common ones: installed from a ZIP (not a git copy), the Engram folder has uncommitted changes, a conversation is running (it tries again later), or this computer is already on the latest version |
| **Environment › Differences** says **No computers to compare yet** | At least two computers need to be updated to 2.0.0 and to each complete one environment check (it runs by itself every day at 10:00, or run `engram env`) |
| Sync is stuck, and you get a `同步已連續失敗` ("sync has failed repeatedly") notification | Open **Devices & sync** in the dashboard to see why. Engram diagnoses it by itself: when a held-back file (a possible secret) blocks a merge, it backs the file up, moves it aside, merges, and puts it back, and the other computer's version goes into the conflicts area; your computer's version is never thrown away. If you see a possible-secret card, redact or remove the secret as the card says and syncing resumes |
| `engram status` says the indexes are in compatibility mode | The vault has a computer that was used in the last 7 days and runs a version below 2.0.0 (the status lists which ones). Update those computers to 2.0.0 (`git pull`, `engram update`) and the indexes switch back by themselves; nothing else to do. An old computer that is no longer used stops counting after 7 days without activity |
| Autopilot stopped | The top of the **Autopilot** page gives the reason: the usage limit (it continues by itself), your Claude Code sign-in has expired (run `claude auth login` in a terminal, or type `/login` in Claude Code), or Claude is briefly busy (it tries again by itself) |
| Clicking **◆ Engram** does nothing | Claude Code's regular screen (with `CLAUDE_CODE_NO_FLICKER=0` set, or inside tmux) doesn't receive mouse clicks. Use `/engram-memories`, or remove that variable and run outside tmux to get the default fullscreen layout |
| You want the detailed logs | `%USERPROFILE%\.engram\local\logs\` (you can paste it straight into File Explorer's address bar) |

Still stuck? Please report it on [GitHub Issues](https://github.com/Sen-CaPoo/engram/issues) and include the results of `engram doctor` (make sure it contains no personal information before you paste it).
