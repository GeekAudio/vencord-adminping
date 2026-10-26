# AdminPing

A [Vencord](https://github.com/Vendicated/Vencord) userplugin that watches a specific person (or anyone with moderation permissions) in your Discord servers, notifies you when they post, keeps a running HTML log of what they said, and can export their last N hours of messages — **including the messages they replied to / quoted**.

> 一个 Vencord 用户插件：盯住指定的人（或任何有管理权限的人），他发消息就提醒你，同时把内容记录成 HTML；还能右键一键导出此人最近 N 小时的发言，**连带他引用/回复的那条原消息**。

## Features / 功能

| | |
|---|---|
| 🔔 **Notify** | Desktop notification + in-app toast when the target posts. The notification shows **only the author's name** and the message body. |
| 📝 **Record** | Every triggered message is appended to `~/Desktop/Discord-管理员消息记录.html` — self-contained, newest first, up to 2000 entries, survives restarts. |
| 📤 **Digest** | Right-click any user → *整理此人最近 24 小时发言（导出 HTML）*. Walks your servers via the search API and produces a report on your Desktop, with quoted messages inlined. |
| 🎛 **Filters** | Whitelist by user ID / role ID / channel ID, ignore bots, skip muted channels, skip when you're already looking at that channel. |

## Install / 安装

Vencord only builds `userplugins` from source, so you need a source build:

```bash
git clone --depth 1 https://github.com/Vendicated/Vencord.git
cd Vencord
pnpm install
mkdir -p src/userplugins/adminPing
cp /path/to/this/repo/src/* src/userplugins/adminPing/
pnpm build
```

Then point your Discord install at the build (the official installer patches `app.asar`; the built `dist/` is what the patcher loads):

```bash
# macOS / Linux
sh -c "$(curl -sS https://vencord.dev/install.sh)"
# then copy your build into the runtime dir
cp -R dist/* "$HOME/Library/Application Support/Vencord/dist/"   # macOS
```

Restart Discord, open **Settings → Vencord → Plugins**, enable **AdminPing**.

> ⚠️ Turn **off** Vencord's own auto-update (`autoUpdate: false` in `settings.json`), otherwise it replaces `dist/` with the official devbuild and your userplugins disappear.
> ⚠️ Every Discord update wipes the `app.asar` patch — you have to re-patch and re-deploy `dist/` afterwards.

## Settings / 设置

| Setting | Default | Meaning |
|---|---|---|
| `userIds` | *(empty)* | **Only notify for these user IDs.** When set, role/permission checks are skipped entirely. |
| `roleIds` | *(empty)* | Only notify for members holding one of these roles. |
| `channelIds` | *(empty)* | Only watch these channels. Empty = all. |
| `desktopNotify` | `true` | macOS/Linux/Windows notification center. |
| `inAppToast` | `true` | Toast inside Discord (works when the window is focused). |
| `skipIfViewing` | `true` | Skip when that channel is open and the window has focus. |
| `ignoreBots` | `true` | Ignore bot messages. |
| `skipMuted` | `false` | Skip muted channels. |
| `saveToDesktop` | `true` | Write the running HTML log. |
| `recordFileName` | `Discord-管理员消息记录.html` | Log file name (plain name only). |
| `digestHours` | `24` | Look-back window for the right-click digest (1–720). |

### Detection order / 判定顺序

1. `userIds` non-empty → **only** those users pass, no further checks
2. else `roleIds` non-empty → member must hold one of those roles
3. else permission-based → guild owner, or a role with `ADMINISTRATOR` / `MANAGE_GUILD` / `MANAGE_MESSAGES`

## How the digest works / 整理功能的实现

It cannot rely on `MESSAGE_CREATE` — that only sees messages arriving while the client is running. It queries the search endpoint instead:

```
GET /guilds/{guild_id}/messages/search?author_id=<id>&min_id=<snowflake>&limit=25&offset=N
```

Three gotchas worth knowing if you fork this:

1. **Search results are grouped** (the hit plus surrounding context). You must pick the entry with `hit === true`, not `group[0]`.
2. **Search results carry no `guild_id`.** Use the guild id you searched with, or your jump links become `channels/undefined/...`.
3. **Quoted messages need a second request.** The response usually has no `referenced_message`, so you fall back to `MessageStore`, then `GET /channels/{cid}/messages/{mid}`. Fire those without retry/backoff and you'll hit 429 and silently lose every quote.

Rate limiting: 25 per page, up to 20 pages per guild, 350 ms between pages, 260 ms between quote lookups, and 4 retries with exponential backoff on 429.

## Files / 文件

```
src/
├── index.tsx   renderer: detection, notification, log, context menu
├── digest.ts   search walk, quote resolution, report generation
└── native.ts   main process: write the HTML file to the Desktop
```

`native.ts` exists because the Discord renderer has no `fs`. Vencord compiles it into the main-process bundle and exposes it as `VencordNative.pluginHelpers.AdminPing.<fn>`.

## Limitations / 限制

- Only channels **you can read** are included — nothing is bypassed.
- A guild where the target isn't a member (or where search is disabled) is skipped.
- The search API is rate limited; scanning many guilds takes tens of seconds.

## License

GPL-3.0 — same as Vencord, since this is a plugin built against it.
