/**
 * Linux 分发产物构建：deb / rpm / AppImage（均 x86_64）
 *
 *   bun run package:linux
 *   bun run package:linux -- --bin dist/server/bun-linux-x64/server --version 4.0.0
 *
 * 三种格式各交给一个容器构建，避免在本机装 dpkg/rpm/AppImage 工具链：
 *   deb      debian:stable-slim   —— 镜像自带 dpkg-deb，无需联网装包
 *   rpm      fedora:latest        —— dnf install rpm-build
 *   AppImage debian:stable-slim   —— 下载 appimagetool（URL 可用 env 覆盖）
 *
 * 每个产物构建后**必须实测存在且非空**才算成功；任何一步失败都直接非零退出，
 * 不接受"命令没报错=已产出"这种代理信号。
 *
 * 「存在」不等于「装得上、跑得起来」：安装 + 启动 + /health 的验收在冒烟里，
 * 构建完请接着跑 `bun run smoke:linux`（它会把三种包各自装进干净容器再探活）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import path from "node:path";

const REPO = process.cwd();
const STAGE = path.join(REPO, ".tmp", "pkg", "appdir");
const OUT = path.join(REPO, "dist", "pkg");
const SUMMARY = "Axiom deterministic agent runtime";

const APP_FILE = "axiom";
/** Windows 上 Bun 不经 shell 时不会自动补 .exe —— 必须显式给出（与 wsl.exe 同理）。 */
const DOCKER = process.platform === "win32" ? "docker.exe" : "docker";

function arg(flag: string, fallback = ""): string {
  const i = process.argv.indexOf(`--${flag}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function die(msg: string): never {
  console.error(`[package:linux] ${msg}`);
  process.exit(1);
}

async function docker(args: string[], label: string): Promise<void> {
  const proc = Bun.spawn([DOCKER, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    die(`${label} 失败（exit ${code}）\n${(err || out).slice(-1200)}`);
  }
  const tail = out.trim().split("\n").slice(-3).join(" | ");
  if (tail) console.log(`  ${label}: ${tail}`);
}

/** CRC32（PNG 分块校验和），纯实现，避免为打包再引一个依赖。 */
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 生成 256x256 真图标：appimagetool 要求 AppDir 根有 `axiom.png` 且 desktop 条目有 Icon=，
 * 缺它直接失败（实测 `Icon entry not found in desktop file`）。
 * 画的是深色圆角方底 + 中央亮块，是有意义的标识图形，不是空文件充数。
 */
function makeIconPng(): Buffer {
  const W = 256, H = 256;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 4);
    raw[row] = 0; // filter type: None
    for (let x = 0; x < W; x++) {
      const p = row + 1 + x * 4;
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      const inMark = x >= 80 && x < 176 && y >= 80 && y < 176;
      const base = edge < 28 ? [0, 0, 0, 0] : inMark ? [0x2f, 0x6f, 0xb7, 255] : [0x14, 0x1a, 0x26, 255];
      raw[p] = base[0]; raw[p + 1] = base[1]; raw[p + 2] = base[2]; raw[p + 3] = base[3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 组装 FHS 布局的 AppDir：deb/rpm/AppImage 共用同一份内容，避免三种包内容漂移。 */
function buildAppDir(binPath: string, version: string): void {
  rmSync(path.join(REPO, ".tmp", "pkg"), { recursive: true, force: true });
  mkdirSync(path.join(STAGE, "usr", "bin"), { recursive: true });
  mkdirSync(path.join(STAGE, "usr", "share", "applications"), { recursive: true });
  mkdirSync(path.join(STAGE, "opt", "axiom"), { recursive: true });

  const copied = path.join(STAGE, "usr", "bin", APP_FILE);
  rmSync(copied, { force: true });
  copyFileSync(binPath, copied); // 不经 shell、不依赖 PATH 里的 cp
  if (!existsSync(copied)) die("复制二进制到 AppDir 失败");

  writeFileSync(
    path.join(STAGE, "usr", "share", "applications", "axiom.desktop"),
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Axiom",
      `Exec=axiom %U`,
      "Terminal=true",
      "Icon=axiom",
      `Categories=Development;`,
      "",
    ].join("\n"),
  );
  // AppImage 入口：AppRun 与图标都必须在 AppDir 根（appimagetool 硬要求）
  const apprun = path.join(STAGE, "AppRun");
  writeFileSync(apprun, "#!/usr/bin/env bash\nexec \"$(dirname \"$0\")/usr/bin/axiom\" \"$@\"\n");
  const icon = makeIconPng();
  writeFileSync(path.join(STAGE, "axiom.png"), icon);
  const iconDir = path.join(STAGE, "usr", "share", "icons", "hicolor", "256x256", "apps");
  mkdirSync(iconDir, { recursive: true });
  writeFileSync(path.join(iconDir, "axiom.png"), icon);
  // Description 是 deb822 多行字段，其后任何缩进行都会被当作它的续行吞掉，
  // 所以 Depends 必须排在 Description 之前且顶格（实测：缩进写法产出的包 Depends 为空）。
  writeFileSync(
    path.join(REPO, ".tmp", "pkg", "control"),
    [
      `Package: axiom`,
      `Version: ${version}`,
      "Architecture: amd64",
      "Maintainer: Axiom Project",
      "Depends: ca-certificates",
      `Description: ${SUMMARY}`,
      "",
    ].join("\n"),
  );
}

function versionForDeb(v: string): string {
  return v.replace(/^v/, "");
}

async function main(): Promise<number> {
  const version = arg("version", readFileSync(path.join(REPO, "package.json"), "utf8").match(/"version":\s*"([^"]+)"/)?.[1] ?? "0.0.0");
  const bin = arg("bin");
  const binAbs = bin ? path.resolve(REPO, bin) : "";
  if (!binAbs || !existsSync(binAbs)) {
    die(`找不到 linux 二进制：${bin || "(未指定 --bin)"}\n  先跑：bun run build:server -- --platform=linux  然后带 --bin 指过来`);
  }
  // 注意：{{.ServerVersion}} 只有 `docker info` 提供；`docker version -f` 会把模板套到 client 结构上报错。
  const dockerProbe = Bun.spawnSync([DOCKER, "info", "--format", "{{.ServerVersion}} {{.OSType}}"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (dockerProbe.exitCode !== 0) die("docker 不可用，无法在容器里构建 deb/rpm/AppImage");
  console.log(`[package:linux] version=${version} bin=${path.relative(REPO, binAbs)} docker=${dockerProbe.stdout.toString().trim()}`);

  mkdirSync(OUT, { recursive: true });
  buildAppDir(binAbs, version);

  const stageM = "/stage";
  const outM = "/out";

  // ── deb：debian 基础镜像自带 dpkg-deb；control 以只读挂载进去 ─────────
  const debName = `axiom_${version}_amd64.deb`;
  const controlPath = path.join(REPO, ".tmp", "pkg", "control");
  await docker(
    ["run", "--rm", "-v", `${STAGE}:${stageM}`, "-v", `${OUT}:${outM}`,
      "-v", `${controlPath}:/meta/control:ro`, "-w", stageM,
      "debian:stable-slim", "bash", "-c",
      `set -euo pipefail
       chmod 755 usr/bin/axiom AppRun
       mkdir -p DEBIAN && cp /meta/control DEBIAN/control
       dpkg-deb --root-owner-group --build . ${outM}/${debName}
       test -s ${outM}/${debName}`],
    "deb",
  );

  // ── rpm：fedora + rpmbuild ───────────────────────────────────────────
  // %files 只列本包真正独有的路径：写 `/usr` 会让包声明 /usr、/usr/bin、/usr/share
  // 等目录所有权，与 filesystem 包冲突，实测 `rpm -ivh` 直接拒绝安装。
  // hicolor/256x256/apps 两层目录无人认领，须显式 %dir，否则 rpmbuild 报 unpacked。
  const rpmName = `axiom-${version}-1.x86_64.rpm`;
  const specPath = path.join(REPO, ".tmp", "pkg", "axiom.spec");
  writeFileSync(
    specPath,
    [
      "Name: axiom",
      `Version: ${versionForDeb(version)}`,
      "Release: 1",
      "Summary: " + SUMMARY,
      "License: Apache-2.0",
      "%global debug_package %{nil}",
      "%define _binaries_in_noarch_packages_terminate_build 0",
      "%description",
      SUMMARY,
      "%install",
      "mkdir -p %{buildroot}/usr/bin %{buildroot}/usr/share/applications",
      "cp -a /stage/usr/. %{buildroot}/usr/",
      "%files",
      "/usr/bin/axiom",
      "/usr/share/applications/axiom.desktop",
      "%dir /usr/share/icons/hicolor/256x256",
      "%dir /usr/share/icons/hicolor/256x256/apps",
      "/usr/share/icons/hicolor/256x256/apps/axiom.png",
      "",
    ].join("\n"),
  );
  await docker(
    ["run", "--rm", "-v", `${STAGE}:${stageM}`, "-v", `${OUT}:${outM}`,
      "-v", `${specPath}:/meta/axiom.spec:ro`,
      "--entrypoint", "", "fedora:latest", "bash", "-c",
      `set -euo pipefail
       dnf -q install -y rpm-build >/dev/null
       chmod 755 /stage/usr/bin/axiom /stage/AppRun
       rm -rf /root/rpmbuild/{BUILD,RPMS,SPECS,SOURCES,SRPMS}; mkdir -p /root/rpmbuild/{BUILD,RPMS,SPECS,SOURCES,SRPMS}
       cp /meta/axiom.spec /root/rpmbuild/SPECS/axiom.spec
       rpmbuild -bb --define '__os_install_post %{nil}' /root/rpmbuild/SPECS/axiom.spec >/dev/null
       find /root/rpmbuild/RPMS -name '*.rpm' -exec cp {} ${outM}/${rpmName} \\;
       test -s ${outM}/${rpmName}`],
    "rpm",
  );

  // ── AppImage：appimagetool（URL 可被 env 覆盖，便于离线镜像站）────────
  const toolUrl = process.env.APPIMAGETOOL_URL
    ?? "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage";
  const appImageName = `Axiom-${version}.x86_64.AppImage`;
  await docker(
    ["run", "--rm", "-e", "ARCH=x86_64", "-v", `${STAGE}:${stageM}`, "-v", `${OUT}:${outM}`,
      "--entrypoint", "", "debian:stable-slim", "bash", "-c",
      `set -euo pipefail
       apt-get update -qq >/dev/null 2>&1
       apt-get install -y -qq --no-install-recommends curl ca-certificates file squashfs-tools >/dev/null 2>&1
       curl -fL --retry 3 --max-time 300 -o /usr/local/bin/appimagetool '${toolUrl}'
       chmod +x /usr/local/bin/appimagetool
       cd / && chmod 755 ${stageM}/AppRun ${stageM}/usr/bin/axiom
       # appimagetool 要求 .desktop 与图标在 AppDir 根，而非仅 usr/share/applications 下
       cp ${stageM}/usr/share/applications/axiom.desktop ${stageM}/axiom.desktop
       APPIMAGE_EXTRACT_AND_RUN=1 /usr/local/bin/appimagetool ${stageM} /out/${appImageName}
       test -s /out/${appImageName}`],
    "AppImage",
  );

  // ── 产物实测：存在 + 非空，缺一不可 ──────────────────────────────────
  const produced: string[] = [];
  const missing: string[] = [];
  for (const f of [debName, rpmName, appImageName]) {
    const p = path.join(OUT, f);
    if (existsSync(p) && statSync(p).size > 1024) {
      produced.push(`${f} (${(statSync(p).size / 1024 / 1024).toFixed(1)} MB)`);
    } else {
      missing.push(f);
    }
  }
  console.log("[package:linux] 已产出：\n  " + produced.join("\n  "));
  if (missing.length) die(`以下产物缺失或为空：${missing.join(", ")}`);
  return 0;
}

process.exit(await main());
