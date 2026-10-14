// Copies the portable build output into dist/ with a versioned name.
// Usage: node scripts/collect-portable.mjs linux|windows
import { copyFileSync, mkdirSync, readFileSync, chmodSync } from "node:fs";

const { productName, version } = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const release = "src-tauri/target";

const sources = {
  linux: [`${release}/release/bundle/appimage/${productName}_${version}_amd64.AppImage`, `${productName}_${version}_amd64.AppImage`],
  windows: [`${release}/x86_64-pc-windows-msvc/release/isolatum.exe`, `${productName}_${version}_x64_portable.exe`],
};

const [src, name] = sources[process.argv[2]] ?? [];
if (!src) {
  console.error("usage: collect-portable.mjs linux|windows");
  process.exit(1);
}

mkdirSync("dist", { recursive: true });
copyFileSync(src, `dist/${name}`);
chmodSync(`dist/${name}`, 0o755);
console.log(`Portable build: dist/${name}`);
