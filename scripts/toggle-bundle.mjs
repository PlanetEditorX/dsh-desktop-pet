#!/usr/bin/env node
/**
 * dsh-desktop-pet — toggle the bundle registration in a DSH profile.
 *
 * Usage:
 *   node toggle-bundle.mjs <profile> remove|add [--plugin dsh-desktop-pet]
 *
 * Guards: if the profile package.json is invalid JSON, the script refuses to
 * touch it. Writes UTF-8 without BOM (JSON.parse-compatible).
 *
 * This is the emergency switch behind the desktop shortcuts
 * 「桌面宠物-禁用.cmd」 / 「桌面宠物-启用.cmd」: if a plugin change breaks the
 * harness, disable the bundle here, restart the harness, and the app works
 * again even though the broken plugin is still installed.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const PLUGIN = 'dsh-desktop-pet';

function usage() {
  console.error('用法: node toggle-bundle.mjs <profile> remove|add');
  process.exit(2);
}

const [profile, action] = process.argv.slice(2);
if (!profile || !['remove', 'add'].includes(action)) usage();

const file = join(os.homedir(), '.dsh', 'profiles', profile, 'package.json');
if (!existsSync(file)) {
  console.error(`找不到 profile 文件: ${file}`);
  process.exit(1);
}

const raw = readFileSync(file, 'utf8');
if (raw.charCodeAt(0) === 0xfeff) {
  console.error('profile package.json 含 BOM，拒绝修改（请用 write/edit 工具修复后重试）');
  process.exit(1);
}

let pkg;
try {
  pkg = JSON.parse(raw);
} catch (err) {
  console.error(`profile package.json 不是合法 JSON（${err.message}），拒绝修改`);
  process.exit(1);
}

const bundles = Array.isArray(pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles)
  ? pkg.dsh.profile.bundles
  : [];
const has = bundles.includes(PLUGIN);

if (action === 'remove') {
  if (!has) {
    console.log(`${PLUGIN} 不在 bundles 列表（可能已禁用）`);
  } else {
    pkg.dsh.profile.bundles = bundles.filter((b) => b !== PLUGIN);
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    console.log(`已从 ${profile} profile 移除 ${PLUGIN}。`);
    console.log('请重启 DeepSeek Harness 生效（桌面宠物将不再加载）。');
  }
} else {
  if (has) {
    console.log(`${PLUGIN} 已在 bundles 列表`);
  } else {
    pkg.dsh.profile.bundles = [...bundles, PLUGIN];
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    console.log(`已把 ${PLUGIN} 加回 ${profile} profile。`);
    console.log('请重启 DeepSeek Harness 生效（桌面宠物将恢复加载）。');
  }
}

// 校验写回后的文件
try {
  JSON.parse(readFileSync(file, 'utf8'));
  console.log('校验通过：profile package.json 合法。');
} catch (err) {
  console.error(`校验失败：${err.message}`);
  process.exit(1);
}
