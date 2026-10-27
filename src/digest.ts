/*
 * Vencord userplugin: adminPing / digest
 * 遍历指定用户最近 N 小时在服务器里的发言，连带把「他引用/回复的那条消息」一起整理成 HTML
 *
 * 实现要点：
 * - 不靠监听消息流（那样只能拿到程序运行期间的消息），走 Discord 搜索接口
 *   GET /guilds/{guild}/messages/search?author_id=&min_id=
 * - 搜索结果是分组（命中 + 上下文），要挑出 hit 那条
 * - 搜索结果里的消息**不带 guild_id**，必须用发起搜索时已知的 guildId 补上，
 *   否则跳转链接会变成 channels/undefined/...
 * - 引用内容优先用响应里的 referenced_message，其次 MessageStore 缓存，最后单独请求；
 *   单独请求必须带重试 + 退避，否则连续十几个请求会撞 429，全部拿不到
 */

import { Logger } from "@utils/Logger";
import { PluginNative } from "@utils/types";
import {
    ChannelStore,
    GuildMemberStore,
    GuildStore,
    MessageStore,
    RestAPI,
    SnowflakeUtils,
    showToast
} from "@webpack/common";

const logger = new Logger("AdminPing/Digest");
const Native = VencordNative.pluginHelpers.AdminPing as PluginNative<typeof import("./native")>;

const PAGE_SIZE = 25;
const MAX_PAGES_PER_GUILD = 20;   // 每服务器最多 500 条（原来 6 页/150 条，容易截断）
const MAX_GUILDS = 40;
const SEARCH_DELAY_MS = 350;      // 搜索页之间
const REF_DELAY_MS = 260;         // 逐条补引用之间
const RETRY_TIMES = 4;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export interface DigestItem {
    id: string;
    t: number;
    guild: string;
    channel: string;
    channelId: string;
    guildId: string;
    content: string;
    attachments: number;
    link: string;
    ref?: { author: string; content: string; link?: string; };
}

function isRateLimit(msg: string) {
    return /429|rate.?limit|too many requests/i.test(msg);
}

/** 把 RestAPI 抛出来的各种东西（字符串 / Error / {status, body}）都转成人能看的文本 */
function errInfo(e: any): { status?: number; text: string; } {
    if (e == null) return { text: "null" };
    if (typeof e === "string") return { status: undefined, text: e };
    if (typeof e === "number") return { status: e, text: String(e) };

    const status: number | undefined = e.status ?? e.statusCode ?? e.code;
    let body = "";
    try {
        body = typeof e.body === "string" ? e.body : JSON.stringify(e.body ?? "");
    } catch { body = "<unserializable>"; }

    const parts = [
        status != null ? `status=${status}` : "",
        e.message ? `msg=${e.message}` : "",
        body && body !== '""' ? `body=${body.slice(0, 180)}` : "",
        Object.keys(e).length ? `keys=${Object.keys(e).join(",")}` : ""
    ].filter(Boolean);

    return { status, text: parts.join(" ") || String(e) };
}

/** 带重试与退避的 GET，专治 429 */
async function getWithRetry(url: string, query?: Record<string, any>): Promise<any> {
    for (let attempt = 0; attempt < RETRY_TIMES; attempt++) {
        try {
            const res: any = await (RestAPI.get as any)({
                url,
                ...(query ? { query } : {}),
                retryOnRateLimit: true
            });

            if (res?.status === 429) {
                await sleep(1200 * (attempt + 1));
                continue;
            }
            return res;
        } catch (e: any) {
            const info = errInfo(e);
            logger.warn(`请求失败(${attempt + 1}/${RETRY_TIMES}) ${url} :: ${info.text.slice(0, 200)}`);

            const rateLimited = info.status === 429 || isRateLimit(info.text);
            if (rateLimited && attempt < RETRY_TIMES - 1) {
                await sleep(1200 * (attempt + 1));
                continue;
            }
            // 404/403 之类的确定失败，把状态码带出去，别重试
            const err: any = new Error(info.text);
            err.status = info.status;
            throw err;
        }
    }
    return { status: 0, body: null };
}

function esc(s: unknown): string {
    return String(s ?? "").replace(/[&<>"']/g, c => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as any
    )[c]);
}

function fmtTime(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function bodyOf(msg: any): string {
    const c = (msg?.content ?? "").trim();
    if (c) return c;
    if (msg?.attachments?.length) return `[附件 ×${msg.attachments.length}]`;
    if (msg?.embeds?.length) return "[嵌入内容]";
    if (msg?.sticker_items?.length) return "[表情贴纸]";
    return "[无文本]";
}

/** 拉一个服务器的搜索结果（顺带把 guildId 挂上） */
async function searchGuild(guildId: string, userId: string, minId: string): Promise<any[]> {
    const hits: any[] = [];
    let offset = 0;

    for (let page = 0; page < MAX_PAGES_PER_GUILD; page++) {
        let res: any;
        try {
            res = await getWithRetry(`/guilds/${guildId}/messages/search`, {
                author_id: userId,
                min_id: minId,
                limit: PAGE_SIZE,
                offset
            });
        } catch (e) {
            logger.warn("搜索失败", guildId, e);
            break;
        }

        const body = res?.body;
        if (res?.status !== 200 || !Array.isArray(body?.messages) || body.messages.length === 0) break;

        for (const group of body.messages) {
            if (!Array.isArray(group)) continue;
            const hit = group.find((m: any) => m?.hit) ?? group[0];
            if (hit?.id) hits.push({ ...hit, __guildId: guildId });
        }

        offset += PAGE_SIZE;
        if (offset >= (body.total_results ?? 0)) break;
        await sleep(SEARCH_DELAY_MS);
    }

    return hits;
}

/** 解析引用/回复的目标消息 */
async function resolveRef(msg: any, guildId: string): Promise<DigestItem["ref"]> {
    const ref = msg?.message_reference;
    if (!ref?.message_id) return undefined;

    const refChannelId: string = ref.channel_id ?? msg.channel_id;

    const build = (m: any) => ({
        author: (m.author?.globalName ?? m.author?.username ?? "未知") as string,
        content: bodyOf(m),
        link: m.id ? `https://discord.com/channels/${guildId}/${refChannelId}/${m.id}` : undefined
    });

    // 1) 响应里自带
    if (msg.referenced_message) return build(msg.referenced_message);

    // 2) 本地缓存
    try {
        const cached = MessageStore.getMessage(refChannelId, ref.message_id);
        if (cached) return build(cached);
    } catch { /* ignore */ }

    // 3) 兜底：拉这个 id 周围的消息再挑出来。
    //    注意：单条接口 GET /channels/{cid}/messages/{mid} 对用户账号恒返回
    //    403 「只有机器人可使用此端点」(code 20002)，所以直接用 around，别浪费请求。
    let status: number | undefined;
    try {
        await sleep(REF_DELAY_MS);
        const res = await getWithRetry(`/channels/${refChannelId}/messages`, { around: ref.message_id, limit: 5 });
        const list: any[] = Array.isArray(res?.body) ? res.body : [];
        const found = list.find(m => m?.id === ref.message_id);
        if (found) return build(found);
        status = res?.status;
        logger.warn(`引用 around 没找到 ${ref.message_id}（拿到 ${list.length} 条）status=${status}`);
    } catch (e: any) {
        status = e?.status;
        logger.warn(`引用 around 异常 ${ref.message_id} :: ${errInfo(e).text.slice(0, 160)}`);
    }

    return {
        author: "（原消息不可见）",
        content: status ? `可能已被删除，或你没有该频道的权限（HTTP ${status}）` : "可能已被删除，或你没有该频道的权限"
    };
}

function buildDigestHtml(user: { name: string; id: string; }, items: DigestItem[], hours: number): string {
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
    const quoted = items.filter(i => i.ref).length;

    const rows = items.map((it, i) => `
    <article class="item">
      <div class="head">
        <span class="idx">${items.length - i}</span>
        <time>${esc(fmtTime(it.t))}</time>
        <a class="where" href="https://discord.com/channels/${esc(it.guildId)}/${esc(it.channelId)}" target="_blank" rel="noreferrer">${esc(it.guild)} · #${esc(it.channel)}</a>
        <a class="jump" href="${esc(it.link)}" target="_blank" rel="noreferrer">跳转 ↗</a>
      </div>
      ${it.ref ? `<blockquote class="quote">
        <span class="quote-mark">↩</span>
        <span class="quote-author">${esc(it.ref.author)}</span>
        <span class="quote-text">${esc(it.ref.content).replace(/\n/g, "<br>")}</span>
      </blockquote>` : ""}
      <div class="body">${esc(it.content).replace(/\n/g, "<br>")}</div>
    </article>`).join("");

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(user.name)} · 最近 ${hours} 小时发言整理</title>
<style>
  :root { --bg:#f6f7f9; --panel:#fff; --line:#e3e6ea; --text:#1f2328; --muted:#6b7280; --accent:#4f46e5; --quote:#f3f4f8; }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 24px 64px; background:var(--bg); color:var(--text);
         font:14px/1.65 -apple-system,"SF Pro Text","PingFang SC","Helvetica Neue",sans-serif; }
  .wrap { max-width: 900px; margin: 0 auto; }
  header { margin-bottom: 22px; }
  h1 { font-size: 22px; margin: 0 0 8px; letter-spacing: -.01em; }
  .meta { color: var(--muted); font-size: 13px; }
  .meta b { color: var(--text); font-weight: 600; }
  .stat { display:flex; gap:22px; margin-top:12px; }
  .stat div { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 16px; }
  .stat span { display:block; font-size:12px; color:var(--muted); }
  .stat b { font-size:18px; }
  .item { background:var(--panel); border:1px solid var(--line); border-radius:12px;
          padding:14px 16px; margin-bottom:12px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .head { display:flex; align-items:center; gap:10px; font-size:12px; color:var(--muted); margin-bottom:8px; }
  .idx { min-width:26px; font-variant-numeric: tabular-nums; }
  time { font-variant-numeric: tabular-nums; }
  .where { color:var(--muted); text-decoration:none; }
  .where:hover { color:var(--accent); }
  .jump { margin-left:auto; color:var(--accent); text-decoration:none; }
  .jump:hover { text-decoration:underline; }
  .quote { margin:0 0 10px; padding:9px 12px; background:var(--quote);
           border-left:3px solid #c7cbd6; border-radius:0 8px 8px 0; font-size:13px; color:#3f4550; }
  .quote-mark { color:#9aa0ac; margin-right:6px; }
  .quote-author { font-weight:600; margin-right:6px; }
  .quote-text { color:#5b616b; }
  .body { white-space:normal; word-break:break-word; }
  .empty { background:var(--panel); border:1px solid var(--line); border-radius:12px;
           padding:48px; text-align:center; color:var(--muted); }
  footer { margin-top:20px; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${esc(user.name)} · 最近 ${hours} 小时发言整理</h1>
    <div class="meta">统计区间：<b>${esc(fmtTime(Date.now() - hours * 3600_000))}</b> ~ <b>${stamp}</b> · 生成于 <b>${stamp}</b></div>
    <div class="stat">
      <div><span>发言条数</span><b>${items.length}</b></div>
      <div><span>带引用的</span><b>${quoted}</b></div>
      <div><span>涉及频道</span><b>${new Set(items.map(i => i.channelId)).size}</b></div>
    </div>
  </header>
  ${items.length ? rows : `<div class="empty">最近 ${hours} 小时没有找到这个人的发言。</div>`}
  <footer>由 Vencord 插件 <code>AdminPing</code> 生成 · 数据来自 Discord 搜索接口，只包含你可见的频道</footer>
</div>
</body>
</html>`;
}

/**
 * 主入口：遍历该用户最近 N 小时的发言并导出 HTML 到桌面
 */
export async function exportUserDigest(
    user: { id: string; name: string; },
    hours = 24,
    onlyGuildId?: string
) {
    const minId = SnowflakeUtils.fromTimestamp(Date.now() - hours * 3600_000);
    const guilds = Object.values(GuildStore.getGuilds() ?? {}) as any[];

    const targets = guilds
        .filter(g => !onlyGuildId || g.id === onlyGuildId)
        .filter(g => {
            try {
                return GuildMemberStore.isMember(g.id, user.id);
            } catch {
                return true;
            }
        })
        .slice(0, MAX_GUILDS);

    logger.info(`开始整理 ${user.name}（${user.id}）最近 ${hours} 小时，候选服务器 ${targets.length} 个`);

    const all: any[] = [];
    for (let i = 0; i < targets.length; i++) {
        const g = targets[i];
        showToast(`正在整理… ${i + 1}/${targets.length} · ${g.name ?? g.id}`);
        try {
            const hits = await searchGuild(g.id, user.id, minId);
            all.push(...hits);
        } catch (e) {
            logger.warn("跳过服务器", g.name, e);
        }
        await sleep(SEARCH_DELAY_MS);
    }

    const seen = new Set<string>();
    const uniq = all.filter(m => {
        if (!m?.id || seen.has(m.id)) return false;
        seen.add(m.id);
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
        return ts >= Date.now() - hours * 3600_000;
    }).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    logger.info(`搜索命中 ${all.length} 条，去重过滤后 ${uniq.length} 条`);

    const items: DigestItem[] = [];
    for (let i = 0; i < uniq.length; i++) {
        const m = uniq[i];
        const gid: string = m.__guildId ?? m.guild_id ?? "";
        const guild: any = GuildStore.getGuild(gid);
        const channel: any = ChannelStore.getChannel(m.channel_id);

        if (i % 25 === 0) showToast(`正在补引用… ${i + 1}/${uniq.length}`);

        items.push({
            id: m.id,
            t: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
            guild: guild?.name ?? "",
            channel: channel?.name ?? "",
            channelId: m.channel_id,
            guildId: gid,
            content: bodyOf(m),
            attachments: m.attachments?.length ?? 0,
            link: `https://discord.com/channels/${gid}/${m.channel_id}/${m.id}`,
            ref: await resolveRef(m, gid)
        });
    }

    const html = buildDigestHtml(user, items, hours);
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const fileName = `Discord-发言整理-${user.name}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.html`;

    const path = await Native.writeRecordFile(html, fileName);
    logger.info(`整理完成，已写入 ${path}`);
    return { count: items.length, quoted: items.filter(i => i.ref).length, path };
}
