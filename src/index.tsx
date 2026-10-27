/*
 * Vencord userplugin: adminPing
 * 频道管理员消息提醒 —— 指定的人/管理员发消息时：系统通知 + 应用内提示 + 记录到桌面 HTML
 *
 * 本地自用插件，不随 Vencord 上游发布。
 */

import { DataStore } from "@api/index";
import type { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message } from "@vencord/discord-types";
import {
    ChannelStore,
    GuildMemberStore,
    GuildRoleStore,
    GuildStore,
    IconUtils,
    Menu,
    NavigationRouter,
    PermissionsBits,
    SelectedChannelStore,
    showToast,
    UserGuildSettingsStore,
    UserStore
} from "@webpack/common";

import { exportUserDigest } from "./digest";

const logger = new Logger("AdminPing");
const Native = VencordNative.pluginHelpers.AdminPing as PluginNative<typeof import("./native")>;

const RECORDS_KEY = "AdminPing_records";
const MAX_RECORDS = 2000;
const DEFAULT_FILE = "Discord-管理员消息记录.html";

interface Record {
    t: number;          // 时间戳
    author: string;     // 显示名
    authorId: string;
    guild: string;
    channel: string;
    content: string;
    link: string;
}

const settings = definePluginSettings({
    userIds: {
        type: OptionType.STRING,
        description: "★ 只提醒这些用户 ID（逗号或换行分隔）。填了它就只认这些人，不再看角色/权限；留空则按下面的规则判断",
        default: "",
        multiline: true
    },
    roleIds: {
        type: OptionType.STRING,
        description: "只认这些角色 ID（逗号或换行分隔）。留空 = 按权限判断（服务器所有者 / 管理员 / 管理服务器 / 管理消息）",
        default: "",
        multiline: true
    },
    channelIds: {
        type: OptionType.STRING,
        description: "只监听这些频道 ID（逗号或换行分隔）。留空 = 所有频道",
        default: "",
        multiline: true
    },
    desktopNotify: {
        type: OptionType.BOOLEAN,
        description: "发系统通知（macOS 通知中心）",
        default: true
    },
    inAppToast: {
        type: OptionType.BOOLEAN,
        description: "在 Discord 里弹一条提示（窗口在前台时也能看到）",
        default: true
    },
    skipIfViewing: {
        type: OptionType.BOOLEAN,
        description: "正在看这个频道且窗口在前台时跳过提醒",
        default: true
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "忽略机器人发的消息",
        default: true
    },
    skipMuted: {
        type: OptionType.BOOLEAN,
        description: "跳过已静音的频道",
        default: false
    },
    saveToDesktop: {
        type: OptionType.BOOLEAN,
        description: "把记录写成 HTML 文件保存到桌面（每次触发都会更新）",
        default: true
    },
    recordFileName: {
        type: OptionType.STRING,
        description: "桌面上的文件名",
        default: DEFAULT_FILE
    },
    digestHours: {
        type: OptionType.NUMBER,
        description: "右键「整理此人发言」时回溯多少小时（增量模式下仅首次生效）",
        default: 24
    },
    digestIncremental: {
        type: OptionType.BOOLEAN,
        description: "增量模式：只整理「上次整理之后」的发言，避免相邻两次大面积重叠",
        default: false
    }
});

function parseIds(raw: string | undefined): string[] {
    return (raw ?? "")
        .split(/[,\s]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

/** 这条消息的作者是不是「要提醒的人」 */
function isAdminMessage(message: Message): boolean {
    const guildId = (message as any).guild_id;
    if (!guildId) return false; // 私信没有管理员概念

    // 0) 用户白名单 —— 填了它就只认这些人，直接放行，不再看角色/权限
    const onlyUsers = parseIds(settings.store.userIds);
    if (onlyUsers.length) return onlyUsers.includes(message.author.id);

    const member = GuildMemberStore.getMember(guildId, message.author.id);
    if (!member) return false;
    const roles: string[] = (member as any).roles ?? [];

    // 1) 显式指定角色 ID —— 命中即算
    const wanted = parseIds(settings.store.roleIds);
    if (wanted.length) return roles.some(r => wanted.includes(r));

    // 2) 按权限判断
    const guild: any = GuildStore.getGuild(guildId);
    if (guild && guild.ownerId === message.author.id) return true;

    const bits =
        PermissionsBits.ADMINISTRATOR |
        PermissionsBits.MANAGE_GUILD |
        PermissionsBits.MANAGE_MESSAGES;

    return roles.some(roleId => {
        const role: any = GuildRoleStore.getRole(guildId, roleId);
        if (!role?.permissions) return false;
        try {
            return (role.permissions & bits) !== 0n;
        } catch {
            return false;
        }
    });
}

function preview(message: Message): string {
    const content = (message.content ?? "").trim();
    if (content) return content.length > 180 ? content.slice(0, 180) + "…" : content;
    if ((message as any).attachments?.length) return "[附件]";
    if ((message as any).embeds?.length) return "[嵌入内容]";
    return "[无文本]";
}

// ── 记录 ────────────────────────────────────────────────────────────

let records: Record[] = [];
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function esc(s: unknown): string {
    return String(s ?? "").replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any
    )[c]);
}

function fmtTime(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function buildHtml(recs: Record[]): string {
    const now = fmtTime(Date.now());
    const rows = recs.map((r, i) => `
    <tr>
      <td class="idx">${recs.length - i}</td>
      <td class="time">${esc(fmtTime(r.t))}</td>
      <td class="author">
        <a href="https://discord.com/users/${esc(r.authorId)}" target="_blank" rel="noreferrer">${esc(r.author)}</a>
      </td>
      <td class="where">${esc(r.guild)}${r.channel ? ` · #${esc(r.channel)}` : ""}</td>
      <td class="content"><a class="msg" href="${esc(r.link)}" target="_blank" rel="noreferrer">${esc(r.content).replace(/\n/g, "<br>")}</a></td>
    </tr>`).join("");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Discord 管理员消息记录</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --line: #e3e6ea;
    --text: #1f2328; --muted: #6b7280; --accent: #4f46e5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 64px;
    background: var(--bg); color: var(--text);
    font: 14px/1.6 -apple-system, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif;
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  header { margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0 0 6px; letter-spacing: -.01em; }
  .meta { color: var(--muted); font-size: 13px; }
  .meta b { color: var(--text); font-weight: 600; }
  .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    overflow: hidden; box-shadow: 0 1px 2px rgba(16,24,40,.04);
  }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    position: sticky; top: 0; z-index: 1;
    background: #fafbfc; color: var(--muted);
    font-size: 12px; font-weight: 600; text-align: left; letter-spacing: .02em;
    padding: 10px 14px; border-bottom: 1px solid var(--line);
  }
  tbody td { padding: 11px 14px; border-bottom: 1px solid #f0f2f4; vertical-align: top; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: #fafbff; }
  .idx { width: 44px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .time { width: 160px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .author { width: 160px; font-weight: 600; white-space: nowrap; }
  .where { width: 220px; color: var(--muted); }
  .content { word-break: break-word; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a.msg { color: var(--text); }
  a.msg:hover { color: var(--accent); }
  .empty { padding: 48px; text-align: center; color: var(--muted); }
  footer { margin-top: 18px; color: var(--muted); font-size: 12px; }
  code { background: #eef0f3; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Discord 管理员消息记录</h1>
    <div class="meta">
      共 <b>${recs.length}</b> 条 · 最新在上 · 本页生成于 <b>${now}</b>
    </div>
  </header>
  <div class="card">
    ${recs.length
            ? `<table>
      <thead>
        <tr><th>#</th><th>时间</th><th>作者</th><th>位置</th><th>内容</th></tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`
            : `<div class="empty">还没有记录。等目标用户发一条消息就会出现在这里。</div>`}
  </div>
  <footer>
    由 Vencord 插件 <code>AdminPing</code> 自动生成 · 最多保留最近 ${MAX_RECORDS} 条
  </footer>
</div>
</body>
</html>`;
}

function scheduleWrite() {
    if (!settings.store.saveToDesktop) return;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(async () => {
        writeTimer = null;
        try {
            const path = await Native.writeRecordFile(
                buildHtml(records),
                settings.store.recordFileName || DEFAULT_FILE
            );
            logger.info("记录已写入", path);
        } catch (e) {
            logger.error("写记录文件失败:", e);
        }
    }, 1500);
}

async function loadRecords() {
    try {
        const saved = await DataStore.get<Record[]>(RECORDS_KEY);
        if (Array.isArray(saved)) records = saved;
        logger.info(`载入历史记录 ${records.length} 条`);
    } catch (e) {
        logger.error("读取历史记录失败:", e);
    }
}

async function persist() {
    try {
        await DataStore.set(RECORDS_KEY, records);
    } catch (e) {
        logger.error("保存历史记录失败:", e);
    }
}

// ── 24 小时发言整理（右键用户触发）─────────────────────────────────

const LAST_DIGEST_KEY = "AdminPing_lastDigestAt";

let digestRunning = false;

function currentHours(): number {
    const h = Number(settings.store.digestHours);
    return Math.max(1, Math.min(720, Number.isFinite(h) ? h : 24));
}

async function runDigest(user: any) {
    if (digestRunning) {
        showToast("正在整理中，请稍等…");
        return;
    }
    digestRunning = true;
    const hours = currentHours();
    const name: string = user.globalName ?? user.username ?? user.id;
    const incremental = !!settings.store.digestIncremental;

    try {
        let sinceTs: number | undefined;
        if (incremental) {
            try {
                const last = await DataStore.get<number>(LAST_DIGEST_KEY);
                if (typeof last === "number" && last > 0) {
                    sinceTs = last;
                    const d = new Date(last);
                    showToast(`增量模式：从 ${d.toLocaleString()} 开始整理 ${name} 的发言…`);
                } else {
                    showToast(`增量模式首次运行，先按最近 ${hours} 小时整理 ${name} 的发言…`);
                }
            } catch { /* 读不到就当首次 */ }
        } else {
            showToast(`开始整理 ${name} 最近 ${hours} 小时的发言…（要遍历服务器，可能要等十几秒）`);
        }

        const r = await exportUserDigest({ id: user.id, name }, hours, undefined, sinceTs);

        // 记下本次的结束时间，作为下次增量起点
        try {
            await DataStore.set(LAST_DIGEST_KEY, r.endTs);
        } catch (e) {
            logger.warn("保存增量起点失败:", e);
        }

        showToast(`✅ 整理完成：${r.count} 条，其中 ${r.quoted} 条带引用 → 已存到桌面`);
    } catch (e) {
        logger.error("整理失败:", e);
        showToast("❌ 整理失败，详情见 Discord 日志");
    } finally {
        digestRunning = false;
    }
}

async function resetDigestBaseline() {
    try {
        await DataStore.set(LAST_DIGEST_KEY, 0);
        showToast("已重置增量起点，下次整理会按「最近 N 小时」重新开始");
    } catch (e) {
        logger.error("重置增量起点失败:", e);
    }
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: any) => {
    if (!user?.id) return;
    const incremental = !!settings.store.digestIncremental;

    children.push(
        <Menu.MenuItem
            id="vc-adminping-digest"
            label={incremental
                ? "整理此人自上次以来的发言（导出 HTML）"
                : `整理此人最近 ${currentHours()} 小时发言（导出 HTML）`}
            action={() => runDigest(user)}
        />
    );

    if (incremental) {
        children.push(
            <Menu.MenuItem
                id="vc-adminping-digest-reset"
                label="重置增量起点"
                action={() => resetDigestBaseline()}
            />
        );
    }
};

// ── 插件 ────────────────────────────────────────────────────────────

export default definePlugin({
    name: "AdminPing",
    description: "指定的人/管理员发消息时提醒你，并记录到桌面 HTML",
    authors: [{ name: "geek (local)", id: 0n }],
    tags: ["Notifications", "Utility"],
    settings,

    contextMenus: {
        "user-context": userContextPatch
    },

    start() {
        loadRecords().then(() => {
            // 启动时先写一份，保证桌面文件存在且是最新的
            if (settings.store.saveToDesktop) scheduleWrite();
        });
        logger.info("AdminPing 已启动（管理员消息提醒生效）");
    },

    flux: {
        MESSAGE_CREATE({ message, optimistic }: { message: Message; optimistic: boolean; }) {
            try {
                if (optimistic) return;
                if (!message?.author) return;
                if (message.author.id === UserStore.getCurrentUser()?.id) return;
                if (settings.store.ignoreBots && message.author.bot) return;

                const guildId: string | undefined = (message as any).guild_id;
                if (!guildId) return;

                const onlyChannels = parseIds(settings.store.channelIds);
                if (onlyChannels.length && !onlyChannels.includes(message.channel_id)) return;

                if (settings.store.skipMuted) {
                    try {
                        if (UserGuildSettingsStore.isChannelMuted(guildId, message.channel_id)) return;
                    } catch { /* 老版本没有这个方法，忽略 */ }
                }

                if (settings.store.skipIfViewing) {
                    const focused = typeof document !== "undefined" && document.hasFocus();
                    if (focused && SelectedChannelStore.getChannelId() === message.channel_id) return;
                }

                if (!isAdminMessage(message)) return;

                const who = (message.author as any).globalName ?? message.author.username;
                const text = preview(message);
                const guild: any = GuildStore.getGuild(guildId);
                const channel: any = ChannelStore.getChannel(message.channel_id);
                const link = `https://discord.com/channels/${guildId}/${message.channel_id}/${message.id}`;

                // 提醒里只放作者，不带「（管理员）」和服务器/频道
                if (settings.store.desktopNotify) {
                    showNotification({
                        title: who,
                        body: text,
                        image: IconUtils.getUserAvatarURL(message.author as any, true),
                        onClick: () => NavigationRouter.transitionTo(
                            `/channels/${guildId}/${message.channel_id}/${message.id}`
                        )
                    });
                }

                if (settings.store.inAppToast) {
                    showToast(`🔔 ${who}：${text}`);
                }

                // 记录（内容不截断，完整保留）
                records.unshift({
                    t: message.timestamp ? new Date(message.timestamp).getTime() : Date.now(),
                    author: who,
                    authorId: message.author.id,
                    guild: guild?.name ?? "",
                    channel: channel?.name ?? "",
                    content: (message.content ?? "").trim() || preview(message),
                    link
                });
                if (records.length > MAX_RECORDS) records.length = MAX_RECORDS;

                persist();
                scheduleWrite();
            } catch (e) {
                logger.error("处理消息时出错:", e);
            }
        }
    }
});
