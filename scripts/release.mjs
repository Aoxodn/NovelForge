/**
 * 一键打包：构建 Tauri 安装包，并把安装程序复制到根目录 releases/。
 *
 * 用法：npm run dist
 *
 * 跨平台（审查跨平台项）：按当前操作系统选择对应产物——
 *   Windows → bundle/nsis/*-setup.exe（或 msi）
 *   macOS   → bundle/macos/*.dmg
 *   Linux   → bundle/{deb,appimage}/*
 * 可用 `npm run dist -- --bundles nsis` 覆盖安装包格式。
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// 允许把 Tauri CLI 的打包参数（例如 --bundles nsis）原样透传。
const passthrough = process.argv.slice(2).join(' ');

console.log(`▶ 打包 NovelForge v${version}（平台：${process.platform}，首次较慢）...`);
execSync(`npx tauri build ${passthrough}`.trim(), { cwd: root, stdio: 'inherit' });

const bundleDir = join(root, 'src-tauri', 'target', 'release', 'bundle');

/** 在 bundle 目录下递归查找本平台安装产物 */
function findArtifact() {
  const candidates = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else {
        const ext = extname(name).toLowerCase();
        if (process.platform === 'win32' && (ext === '.exe' || ext === '.msi') && !name.endsWith('.pdb'))
          candidates.push(full);
        else if (process.platform === 'darwin' && (ext === '.dmg' || ext === '.app'))
          candidates.push(full);
        else if (process.platform === 'linux' && (ext === '.deb' || ext === '.rpm' || ext === '.AppImage' || name.endsWith('.AppImage')))
          candidates.push(full);
      }
    }
  };
  walk(bundleDir);
  // 取最新修改的一个
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

const src = findArtifact();
if (!src) {
  console.error(`✘ 未在 ${bundleDir} 找到 ${process.platform} 的安装产物`);
  process.exit(1);
}

const releasesDir = join(root, 'releases');
mkdirSync(releasesDir, { recursive: true });
const dest = join(releasesDir, `${src.split(/[\\/]/).pop()}`);
copyFileSync(src, dest);

console.log('──────────────────────────────');
console.log(`✔ 打包完成，安装包在：${dest}`);
