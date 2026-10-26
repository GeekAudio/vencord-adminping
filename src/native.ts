/*
 * Vencord userplugin: adminPing (native)
 * 主进程侧：把记录写成 HTML 文件到桌面
 */

import { app } from "electron";
import { writeFile } from "fs/promises";
import { basename, join } from "path";

/** 只允许纯文件名，防止路径穿越 */
function safeName(name: string) {
    const base = basename(name || "Discord-管理员消息记录.html").replace(/[/\\:*?"<>|]/g, "_");
    return base.endsWith(".html") || base.endsWith(".htm") ? base : base + ".html";
}

export async function writeRecordFile(_, html: string, fileName: string) {
    const desktop = app.getPath("desktop");
    const target = join(desktop, safeName(fileName));
    await writeFile(target, html, "utf8");
    return target;
}

export async function getDesktopPath(_) {
    return app.getPath("desktop");
}
