/**
 * dsh-backup-migrator / lib/cloud.js
 *
 * 云端备份 = WebDAV。理由：内置 fetch 加 PROPFIND/PUT/GET 就能覆盖坚果云、Nextcloud、群晖、
 * Alist 这些真在用的服务，零依赖、零 SDK；S3/OSS/SFTP 三个后端不做——一个实现不需要工厂。
 * 只做「把本地备份推到云端 / 从云端拉回来」两件事，不做双向同步（同步要合并策略，那是另一个产品）。
 *
 * fetchImpl 可注入，自检里用假 fetch 验证 URL 与请求头，不需要真连网。
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

export const CLOUD_BACKUP_NAME = /^dsh-backup-.+\.(zip|tar\.gz)$/i;

/** 归一化配置；地址空 = 没开云端，直接抛（调用方都从 UI 来，报错比静默强）。 */
export function cloudOf(options = {}) {
  const base = String(options.cloudUrl ?? "").trim().replace(/\/+$/, "");
  if (base === "") throw new Error("请先填写 WebDAV 地址（例如 https://dav.jianguoyun.com/dav/）");
  return {
    base,
    dir: String(options.cloudDir ?? "").trim().replace(/^\/+|\/+$/g, ""),
    user: String(options.cloudUser ?? ""),
    pass: String(options.cloudPass ?? ""),
  };
}

/** 拼远端 URL。目录与文件名都做 percent-encoding（中文备份名不会 400）。 */
export function remoteUrl(cloud, name = "") {
  const parts = [cloud.base];
  if (cloud.dir !== "") parts.push(...cloud.dir.split("/").map(encodeURIComponent));
  if (name !== "") parts.push(encodeURIComponent(name));
  return parts.join("/");
}

export function authHeaders(cloud) {
  const head = { accept: "*/*" };
  if (cloud.user !== "" || cloud.pass !== "") {
    head.authorization = "Basic " + Buffer.from(cloud.user + ":" + cloud.pass, "utf8").toString("base64");
  }
  return head;
}

/**
 * 极简 PROPFIND 解析：只认标签名，不认命名空间前缀（D: / d: / lp1: 各家不同）。
 * 目录自身与子目录跳过，只看文件。
 */
export function parsePropfind(xml, selfName = "") {
  const out = [];
  const blocks = String(xml ?? "").split(/<(?<!\/)(?:\w+:)?response[\s>]/i).slice(1);
  for (const block of blocks) {
    const href = /<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i.exec(block)?.[1]?.trim() ?? "";
    if (href === "" || href.endsWith("/")) continue; // 目录
    const name = decodeURIComponent(href.split("/").filter(Boolean).pop() ?? "");
    if (name === "" || name === selfName) continue;
    const raw = /<(?:\w+:)?getcontentlength[^>]*>(\d+)</i.exec(block)?.[1];
    out.push({
      name,
      bytes: raw === undefined ? 0 : Number(raw),
      modified: /<(?:\w+:)?getlastmodified[^>]*>([^<]*)</i.exec(block)?.[1] ?? "",
    });
  }
  return out;
}

/** 列远端目录里的备份文件（调用方自己再按名字过滤）。 */
export async function cloudList(options, fetchImpl = fetch) {
  const cloud = cloudOf(options);
  const res = await fetchImpl(remoteUrl(cloud) + "/", {
    method: "PROPFIND",
    headers: { ...authHeaders(cloud), depth: "1", "content-type": "application/xml; charset=utf-8" },
  });
  if (!res.ok) throw new Error("云端列目录失败：" + res.status + " " + (res.statusText ?? ""));
  const rows = parsePropfind(await res.text(), cloud.dir.split("/").pop() ?? "");
  const seen = new Set();
  return rows.filter((row) => !seen.has(row.name) && seen.add(row.name));
}

/** 把本地备份推到云端（同名覆盖：云端那份就是这份的副本，不需要第二个名字）。 */
export async function cloudUpload(options, file, name, fetchImpl = fetch) {
  const cloud = cloudOf(options);
  const bytes = statSync(file).size;
  const res = await fetchImpl(remoteUrl(cloud, name), {
    method: "PUT",
    headers: {
      ...authHeaders(cloud),
      "content-type": "application/octet-stream",
      "content-length": String(bytes),
    },
    body: createReadStream(file),
    // undici 要求流式 body 显式声明 duplex，否则直接 TypeError。
    duplex: "half",
  });
  if (!res.ok) throw new Error("上传失败：" + res.status + " " + (res.statusText ?? ""));
  return { name, bytes };
}

/** 从云端拉一份到本地备份目录。撞名不覆盖，加序号——覆盖掉本地唯一一份备份是不可逆的。 */
export async function cloudDownload(options, name, destDir, fetchImpl = fetch) {
  const cloud = cloudOf(options);
  const res = await fetchImpl(remoteUrl(cloud, name), { headers: authHeaders(cloud) });
  if (!res.ok) throw new Error("下载失败：" + res.status + " " + (res.statusText ?? ""));
  mkdirSync(destDir, { recursive: true });
  const ext = /\.(zip|tar\.gz)$/i.exec(name)?.[0] ?? "";
  const stem = ext === "" ? name : name.slice(0, -ext.length);
  let final = name;
  for (let n = 2; existsSync(join(destDir, final)); n += 1) final = stem + "-" + n + ext;
  const file = join(destDir, final);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  return { file, name: final, bytes: statSync(file).size };
}
