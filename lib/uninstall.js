/**
 * dsh-backup-migrator / lib/uninstall.js
 *
 * 「卸载本插件」= 把它从真装进去的那个 DSH profile 里干净摘掉。摘三样：
 * profile/package.json 的 dsh.profile.bundles 条目、dependencies 条目、node_modules 里的包目录。
 * 规划与改写是纯函数，落盘单独一层——这样自检不用真的动 .dsh。
 *
 * 为什么不做成 npm/pnpm uninstall：宿主不提供 dsh CLI，profile 里的 pnpm 要用 Electron-as-Node
 * 启动，而且卸载的失败模式（删掉别人共享的 store、漏掉 bundles 条目）比手写这三步危险得多。
 */

import {
  copyFileSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PLUGIN, dataRootOf } from "./backup.js";

/** 装了本插件的 profile（可能不止一个：desktop 与别的 profile 各装过一份）。 */
export function findProfiles(root = dataRootOf()) {
  const base = join(root, "profiles");
  if (!existsSync(base)) return [];
  const found = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const dir = join(base, entry.name);
    const file = join(dir, "package.json");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8");
      const pkg = JSON.parse(text);
      const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
      if (!bundles.includes(PLUGIN) && !Object.hasOwn(pkg?.dependencies ?? {}, PLUGIN)) continue;
      found.push({ profile: entry.name, dir, file, pkg, text });
    } catch {
      /* package.json 坏了不是我们要卸的对象，跳过 */
    }
  }
  return found;
}

/** 生成改写后的 package.json 文本（不碰磁盘，可单测）。 */
export function planUninstall(profile) {
  const pkg = JSON.parse(JSON.stringify(profile.pkg));
  const bundles = pkg?.dsh?.profile?.bundles;
  if (Array.isArray(bundles)) pkg.dsh.profile.bundles = bundles.filter((name) => name !== PLUGIN);
  if (pkg.dependencies != null && Object.hasOwn(pkg.dependencies, PLUGIN)) delete pkg.dependencies[PLUGIN];
  return {
    file: profile.file,
    before: profile.text,
    after: JSON.stringify(pkg, null, 2) + "\n",
    moduleDir: join(profile.dir, "node_modules", PLUGIN),
  };
}

/**
 * 删包目录：先 lstat 判链接，是链接/junction 就只删链接本身。
 * 本机踩过事故：对含 junction 的目录递归删会顺穿进去，把目标目录里的内容一起删掉。
 */
export function removeModule(dir) {
  if (!existsSync(dir)) return false;
  if (lstatSync(dir).isSymbolicLink()) unlinkSync(dir);
  else rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 落盘：先留一份 package.json 备份，再改写，最后删包目录。任一步失败都带着步骤名抛。 */
export function uninstallProfile(profile, stampText) {
  const plan = planUninstall(profile);
  const backup = plan.file + ".bak-" + stampText;
  copyFileSync(plan.file, backup);
  writeFileSync(plan.file, plan.after, "utf8");
  let removed = false;
  try {
    removed = removeModule(plan.moduleDir);
  } catch (error) {
    throw new Error("package.json 已改好（备份在 " + backup + "），但删包目录失败："
      + String(error?.message ?? error) + "。重启 DSH 前请手动删除 " + plan.moduleDir);
  }
  return { profile: profile.profile, packageJson: plan.file, backup, moduleDir: plan.moduleDir, removed };
}
