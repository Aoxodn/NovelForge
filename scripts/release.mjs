/**
 * 一键打包：构建 Tauri NSIS 安装包，并把安装程序复制到根目录 releases/。
 *
 * 用法：npm run dist
 *
 * Tauri 默认把安装包埋在 src-tauri/target/release/bundle/nsis/ 里，
 * 此脚本在构建完成后自动把它拷到项目根目录的 releases/，方便取用。
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

console.log(`▶ 打包 NovelForge v${version}（含前端构建 + Rust release 编译，首次较慢）...`);
execSync('npx tauri build', { cwd: root, stdio: 'inherit' });

const src = join(
  root,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis',
  `NovelForge_${version}_x64-setup.exe`,
);
if (!existsSync(src)) {
  console.error(`✘ 未找到安装包：${src}`);
  process.exit(1);
}

const releasesDir = join(root, 'releases');
mkdirSync(releasesDir, { recursive: true });
const dest = join(releasesDir, `NovelForge_${version}_x64-setup.exe`);
copyFileSync(src, dest);

console.log('──────────────────────────────');
console.log(`✔ 打包完成，安装包在：${dest}`);
