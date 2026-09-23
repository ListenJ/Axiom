# ADR-009：分发格式矩阵（deb / rpm / AppImage / Windows x64+x86）

- 日期：2026-09-23 ｜ 状态：**已采纳，deb/rpm/win-x64 已实测产出**；AppImage 结果见文末 ｜ 决策人：项目经理（用户）
- 背景：用户要求可分发形态为 —— Windows exe **32/64 位**、Linux **deb / rpm / AppImage（64 位）**；mac 无机器故暂不分发。本 ADR 记录实测约束与由此确定的构建路径，避免下一位重复踩坑。

## 实测约束（全部为本机当场跑出来的，不是文献结论）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **Bun 没有 32 位 Windows 编译目标** | `bun build --compile --target=bun-win32-x86` → `error: Unsupported target "x86" in "bun-win32-x86"` |
| 2 | **Go 可以出 32 位 Windows** | `CGO_ENABLED=0 GOOS=windows GOARCH=386 go build ./cmd/pcdad` → exit 0，产出 15,054,336 B `pcdad.exe` |
| 3 | **bun 交叉编译 linux 在这台机器上不可用** | `--platform=linux` → `Failed to extract executable for 'bun-linux-x64-v1.3.14'`；加 `HTTPS_PROXY` 后同样失败 ⇒ 不是网络单点问题 |
| 4 | 容器内原生编译可绕过 #3 | `docker run … oven/bun:1.3.14 bun build src/main.ts --compile` → `[3.127s] compile dist/bun/linux/x64/axiom-server`，105,199,744 B |
| 5 | Git Bash 会篡改容器参数里的绝对路径 | `-w /app` 被改成 `C:/Program Files/Git/app` → docker 报 working directory invalid；须 `MSYS_NO_PATHCONV=1` |
| 6 | Bun 在 Windows 不经 shell 时不补 `.exe` | 探测 `["docker", …]` 恒失败；`docker.exe` 才可（`wsl.exe` 同理，故 Laya 链路一直是通的） |
| 7 | `{{.ServerVersion}}` 只属于 `docker info` | `docker version -f '{{.ServerVersion}}'` → `can't evaluate field … in type system.versionInfo` |
| 8 | appimagetool 有三个硬依赖 | 缺 `file` → `file command is missing but required`；`.desktop` 只在 `usr/share/applications/` 下 → `Desktop file not found`；desktop 无 `Icon=` 或根目录无 `<name>.png` → `Icon entry not found in desktop file`。⇒ 容器需装 `file`（`squashfs-tools` 供解包核验），且 `.desktop` 与 `axiom.png` 都要在 AppDir 根 |

## 决定

1. **32 位 Windows 只对 Go 服务承诺**。`GO_PLATFORMS` 增加 `{ os: "windows", arch: "386" }`；TS 应用本体的 32 位 Windows **不做**，因为运行时不提供该目标（约束 #1）。发布说明必须写清这条边界，不允许沉默降级。
2. **Linux 二进制走容器原生编译**，不用 bun 的交叉下载（约束 #3/#4）——与 `.ci/run.sh` 已有的 `oven/bun:1` 模式一致，顺带把"CI 用的 bun 版本 == 打包用版本"钉死（本机 `1.3.14` 恰等 `ci.yml` 的 `BUN_VERSION`）。
3. **deb / rpm / AppImage 共用同一份 AppDir 树**（`scripts/package/linux-bundles.ts` 的 `buildAppDir`），三种包不允许各自组装内容 —— 否则包之间会漂移。
4. **产物必须拆开验证，不接受"命令没报错=已产出"**：脚本对每个产物断言存在且 >1KB；核验时用 `dpkg-deb -c` / `rpm -qlp` 看内容与权限位。
5. **macOS 保留构建能力但不进发布矩阵**：`PLATFORM_TARGETS` 里 darwin 条目不删（删了会连带砍掉本地开发与未来可能），只是在分发清单里排除。

## 后果

- (+) 一条命令产出三种 Linux 包；工具链全部在容器里，本机不装 dpkg/rpm/AppImage 套件。
- (+) 踩坑成本被固化成代码与本文，不再靠人记。
- (-) 打包依赖 Docker 与镜像可达性（`oven/bun:1.3.14`、`debian:stable-slim`、`fedora:latest`）；离线环境需先预热镜像。
- (-) 绑定 Windows mount 后包内目录模式继承为 `drwxrwxrwx`（`dpkg-deb -c` 可见），二进制位已用容器内 `chmod 755` 修正为 `-rwxr-xr-x root/root`，但**目录位仍偏松**，属已知待修的美观问题（不影响功能，登记以免被当成已完美）。
- (-) AppImage 依赖从 GitHub 下载 `appimagetool` 的 continuous 构建（实测拿到的是 `build <local dev build> built on 2023-03-08`），版本不可钉；URL 已可经 `APPIMAGETOOL_URL` 指向内部镜像。

## 实测产出（version 4.0.0，bin=dist/bun/linux/x64/axiom-server）

| 产物 | 大小 | 内容核验 |
|---|---|---|
| `dist/pkg/axiom_4.0.0_amd64.deb` | 26,639,984 B | `dpkg-deb -c`：`-rwxr-xr-x root/root ./usr/bin/axiom`(105,199,744) + `./usr/share/applications/axiom.desktop`；`Package=axiom Version=4.0.0 Architecture=amd64` |
| `dist/pkg/axiom-4.0.0-1.x86_64.rpm` | 28,495,129 B | `rpm -qlp`：`/usr/bin/axiom`、`/usr/share/applications/axiom.desktop`、`/usr/share/icons/hicolor/256x256/apps/axiom.png`；`Name=axiom Version=4.0.0 Release=1 Arch=x86_64` |
| `dist/bun/windows/x64/axiom-server.exe` | 已产出 | `bun run scripts/build/matrix.ts --target=server --platform=windows` ✓，并生成 `dist/CHECKSUMS.txt` |
| Windows 32 位（Go 服务） | 已验证可编 | 约束 #2；矩阵已加 `windows/386` 目标 |
| `dist/pkg/Axiom-4.0.0.x86_64.AppImage` | 38,425,792 B | **已实测**：容器内 `--appimage-extract` 解包后 `AppRun` 可执行(62 B)、`usr/bin/axiom` 105,199,744 B 且 `file` 判为 `ELF 64-bit LSB executable, x86-64`、`axiom.desktop` 在根。前两轮分别因缺 `file`、`.desktop` 不在 AppDir 根、缺图标而失败，按约束 #8
