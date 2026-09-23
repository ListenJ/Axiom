# ADR-009：分发格式矩阵（deb / rpm / AppImage / Windows x64+x86）

- 日期：2026-09-23 ｜ 状态：**已采纳，deb/rpm/AppImage/win-x64 均已实测「装得上 + 起得来」**；验证口径在第二轮被推翻重写，见文末更正节 ｜ 决策人：项目经理（用户）
- 背景：用户要求可分发形态为 —— Windows exe **32/64 位**、Linux **deb / rpm / AppImage（64 位）**；mac 无机器故暂不分发。本 ADR 记录实测约束与由此确定的构建路径，避免下一位重复踩坑。

## 实测约束（全部为本机当场跑出来的，不是文献结论）

| # | 事实 | 证据 |
|---|---|---|
| 1 | **Bun 没有 32 位 Windows 编译目标** | `bun build --compile --target=bun-win32-x86` → `error: Unsupported target "x86" in "bun-win32-x86"` |
| 2 | **Go 可以出 32 位 Windows** | `CGO_ENABLED=0 GOOS=windows GOARCH=386 go build ./cmd/pcdad` → exit 0，产出 15,054,336 B `pcdad.exe` |
| 3 | **bun 交叉编译 linux 在这台机器上不可用** | `--platform=linux` → `Failed to extract executable for 'bun-linux-x64-v1.3.14'`；加 `HTTPS_PROXY` 后同样失败 ⇒ 不是网络单点问题 |
| 4 | 容器内原生编译可绕过 #3 | `docker run … oven/bun:1.3.14 bun build src/main.ts --compile` → `[3.127s] compile dist/bun/linux/x64/axiom-server`，105,199,744 B |
| 5 | Git Bash 会篡改容器参数里的绝对路径 | `-w /app` 被改成 `C:/Program Files/Git/app` → docker 报 working directory invalid；须 `MSYS_NO_PATHCONV=1`。**边界已实测**：该改写只发生在经 Git Bash 的调用上 —— `linux-bundles.ts`/`smoke-linux.ts` 用 `Bun.spawn` 直接给 argv，不经 shell，实测带 Windows 绝对路径的 `-v D:\…\appdir:/stage` 正常挂载并构建成功。⇒ 这个前缀是**人手敲 docker 时的前置**，不是脚本缺陷；脚本内自检已判定为不需要（为不会发生的路径加检查属规则 1 禁止的投机防御） |
| 6 | Bun 在 Windows 不经 shell 时不补 `.exe` | 探测 `["docker", …]` 恒失败；`docker.exe` 才可（`wsl.exe` 同理，故 Laya 链路一直是通的） |
| 7 | `{{.ServerVersion}}` 只属于 `docker info` | `docker version -f '{{.ServerVersion}}'` → `can't evaluate field … in type system.versionInfo` |
| 8 | appimagetool 有三个硬依赖 | 缺 `file` → `file command is missing but required`；`.desktop` 只在 `usr/share/applications/` 下 → `Desktop file not found`；desktop 无 `Icon=` 或根目录无 `<name>.png` → `Icon entry not found in desktop file`。⇒ 容器需装 `file`（`squashfs-tools` 供解包核验），且 `.desktop` 与 `axiom.png` 都要在 AppDir 根 |
| 9 | **rpm 的 `%files` 写 `/usr` 会做出一个装不上的包** | 该行让包声明 `/usr`、`/usr/bin`、`/usr/share`、`/usr/share/applications`、`/usr/share/icons` 五个目录的所有权，`rpm -ivh` 逐条报 `file /usr from install of axiom-… conflicts with file from package filesystem-…` 并拒绝安装；而同一时刻 `rpm -qlp` 看着完全正常（它确实把这 11 条列出来了，只是列出来不等于读的人能认出那是冲突源） |
| 10 | **deb 的 control 里缩进的 ` Depends:` 不是依赖声明** | deb822 中 Description 是多行字段，其后任何缩进行都成为它的续行 ⇒ 实测 `dpkg-deb -f … Depends` 为空串，`dpkg -s` 把 ` Depends: ca-certificates` 显示在 Description 体内 |
| 11 | 非特权容器里没有 FUSE，`.AppImage` 不能直接执行 | 冒烟统一走 `--appimage-extract` 解包后执行 `AppRun`；这条路径同样验证了 AppRun → `usr/bin/axiom` 的接线，且不依赖宿主机 fuse |

## 决定

1. **32 位 Windows 只对 Go 服务承诺**。`GO_PLATFORMS` 增加 `{ os: "windows", arch: "386" }`；TS 应用本体的 32 位 Windows **不做**，因为运行时不提供该目标（约束 #1）。发布说明必须写清这条边界，不允许沉默降级。
2. **Linux 二进制走容器原生编译**，不用 bun 的交叉下载（约束 #3/#4）——与 `.ci/run.sh` 已有的 `oven/bun:1` 模式一致，顺带把"CI 用的 bun 版本 == 打包用版本"钉死（本机 `1.3.14` 恰等 `ci.yml` 的 `BUN_VERSION`）。
3. **deb / rpm / AppImage 共用同一份 AppDir 树**（`scripts/package/linux-bundles.ts` 的 `buildAppDir`），三种包不允许各自组装内容 —— 否则包之间会漂移。
4. **产物验收的判据是「装进干净容器 + 真启动 + 探活」，不是「文件存在」也不是「文件清单看着对」**：
   - 构建侧（`scripts/package/linux-bundles.ts`）断言每个产物存在且 >1KB；
   - 验收侧（`scripts/package/smoke-linux.ts`，`bun run smoke:linux`）把 deb 用 `apt-get install` 装进 `debian:stable-slim`、rpm 用 `rpm -ivh` 装进 `fedora:latest`、AppImage 解包后跑 `AppRun`，各自启动 `/usr/bin/axiom` 并轮询 `GET /health` 直到 200 且响应体含 `status:"ok"`；
   - 冒烟还直接断言两处包元数据：deb 的 `Depends` 字段确实生效、rpm 的文件清单里不含任何系统目录。
   这条是约束 #9/#10 逼出来的：原口径（`dpkg-deb -c` / `rpm -qlp` 看内容）放过这两种坏包。
5. **`package:linux` 之后必须接 `smoke:linux` 才算分发就绪**，构建脚本头部注释同样写了这条衔接。
6. **macOS 保留构建能力但不进发布矩阵**：`PLATFORM_TARGETS` 里 darwin 条目不删（删了会连带砍掉本地开发与未来可能），只是在分发清单里排除。

## 后果

- (+) 一条命令产出三种 Linux 包；工具链全部在容器里，本机不装 dpkg/rpm/AppImage 套件。
- (+) 踩坑成本被固化成代码与本文，不再靠人记。
- (-) 打包依赖 Docker 与镜像可达性（`oven/bun:1.3.14`、`debian:stable-slim`、`fedora:latest`）；离线环境需先预热镜像。
- (-) 绑定 Windows mount 后包内目录模式继承为 `drwxrwxrwx`（`dpkg-deb -c` 可见），二进制位已用容器内 `chmod 755` 修正为 `-rwxr-xr-x root/root`，但**目录位仍偏松**，属已知待修的美观问题（不影响功能，登记以免被当成已完美）。
- (-) AppImage 依赖从 GitHub 下载 `appimagetool` 的 continuous 构建（实测拿到的是 `build <local dev build> built on 2023-03-08`），版本不可钉；URL 已可经 `APPIMAGETOOL_URL` 指向内部镜像。
- (-) **冒烟需要外网**：`debian:stable-slim` 不带 curl、`fedora:latest` 的 curl 也要现装，且 deb 的 `apt-get install ./file.deb` 会从归档解析 `Depends`。离线环境得先预热带 curl 的基础镜像。
- (-) **三种包都不含 Rust 侧载**，冒烟日志逐字为 `[NativeBridge] Binary not found: ./native/target/release/axiom-local`。本机 `native/target/release/` 下只有 Windows 形态产物（`axiom_local.pdb` 等），没有 Linux 构建物，所以包内没有可打进的东西。当前后果是**功能降级而非启动失败**：`initNativeBridge` 打 WARN 后返回 false，服务器照常起、`/health` 照常 200，但 O(1) 路由与 native 检索不可用。要交付带 native 的分发包，前置条件是先在 `oven/bun` 之外起一个 Rust 工具链镜像产出 `axiom-local`，这属于新的构建面，本 ADR 不承诺。
- (-) `axiom` 这个入口是 `src/main.ts` 编译出的 **HTTP 服务器**（矩阵 target=server），它收任意参数都不解析、直接起服务并常驻。实测 `axiom --version` 会挂住不退出 —— 这不是 bug，但意味着包内没有 CLI 形态入口；`axiom-cli`（`src/cli.ts`）目前不进这三种包。

## 实测产出（version 4.0.0，bin=dist/bun/linux/x64/axiom-server；下表为修复约束 #9/#10 后的重建结果）

| 产物 | 大小 | 安装 + 运行时核验 |
|---|---|---|
| `dist/pkg/axiom_4.0.0_amd64.deb` | 26,640,924 B | `apt-get install` 进 `debian:stable-slim` 成功；`dpkg -s axiom` 的 `Depends: ca-certificates` 顶格生效；启动后 `GET /health` 在 2 次轮询内返回 **200** 且 `status:"ok"` |
| `dist/pkg/axiom-4.0.0-1.x86_64.rpm` | 28,491,464 B | `rpm -ivh` 进 `fedora:latest` 成功（`rpm -q axiom` → `axiom-4.0.0-1.x86_64`）；`rpm -ql axiom` 只有 5 条：`/usr/bin/axiom`、`/usr/share/applications/axiom.desktop`、两条 hicolor 目录、`axiom.png`，无系统目录所有权；`GET /health` **200** |
| `dist/pkg/Axiom-4.0.0.x86_64.AppImage` | 38,425,792 B | `--appimage-extract` 解包后 `AppRun` 与 `usr/bin/axiom` 均在位且可执行（`file` 判为 `ELF 64-bit LSB executable, x86-64`，105,199,744 B）；执行 `./AppRun` 后 `GET /health` **200** |
| `dist/bun/windows/x64/axiom-server.exe` | 110,041,088 B | **已实测运行**：`sha256sum` 与 `dist/CHECKSUMS.txt` 逐字一致；在空目录里以默认 env 直跑该 exe，`GET /health` 在 2 次轮询内返 **200** 且响应体含 `status:"ok"`，工作目录自建 `data/`、`plugins/`。仍是**裸执行**而非安装包冒烟（Windows 侧无包格式），且未验卸载/服务注册（本就不提供） |
| Windows 32 位（Go 服务） | 已验证可编 | 约束 #2；矩阵已加 `windows/386` 目标 |

> **Windows 与 Linux 包的一个实测行为差异**（登记以免被当成等价产物）：同一个 `main.ts` 编译出的入口，Windows exe 启动日志为 `[Edition] Detected: cloud`，而 Linux 容器内为 `[Edition] Detected: local` + `[NativeBridge] Binary not found: ./native/target/release/axiom-local`。差异来自 `native/target/release/` 在 Windows 上有构建物、在容器里没有 ⇒ **三种 Linux 包实际跑的是不带动画核的降级形态**。`detectEdition` 的这一分支目前不受任何测试覆盖（本轮未补，属 D 组之外的事）。

一次跑齐三种 Linux 格式的验收命令（本轮 `3/3 通过`）：

```bash
bun run package:linux -- --bin dist/bun/linux/x64/axiom-server
bun run smoke:linux            # 或 --only=deb|rpm|appimage 单跑
```

> **第二轮更正记录**：本 ADR 初版的「实测产出」表用 `dpkg-deb -c` 与 `rpm -qlp` 的文件清单作证据，并据此把 deb/rpm 记为「已实测」。该证据**不足以支撑那个结论** —— 它验的是"包里有这些文件"，用户要的是"能分发"。真实情况是当时那两个包都不可用：rpm 装不上（约束 #9），deb 的依赖声明是空的（约束 #10）。初版 rpm 那一行还只抄了 `rpm -qlp` 输出里的 3 个文件、把同时列出的 5 个目录条目省掉了，正好省掉了暴露缺陷的那部分。此处不改写历史表，改为在本节说明，并把判据换成上表的安装 + 探活口径（决定 #4）。
