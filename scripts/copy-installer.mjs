/**
 * 打包后把安装包复制到 releases/（npm run release 的收尾步骤）。
 * Tauri 的 bundle 输出目录固定在 target/release/bundle，无法配置，
 * 统一由本脚本归集到项目根的 releases/ 目录。
 */
import { mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const bundleDir = 'src-tauri/target/release/bundle/nsis';
const outDir = 'releases';

mkdirSync(outDir, { recursive: true });
let n = 0;
for (const f of readdirSync(bundleDir)) {
  if (f.endsWith('-setup.exe')) {
    copyFileSync(join(bundleDir, f), join(outDir, f));
    console.log('releases/' + f);
    n += 1;
  }
}
console.log(`已归集 ${n} 个安装包到 releases/`);
