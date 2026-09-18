# Axiom Agent 鸿蒙 WebView 壳应用

通过 HarmonyOS WebView 加载 Axiom Agent Web 前端，将其包装为原生应用。

## 目录结构

```
harmonyos/
  AppScope/                         # 应用级配置（bundleName 等）
    app.json5
    resources/base/element/string.json   # 全局 app_name
  entry/
    src/
      main/
        pages/
          Index.ets                 # 主页面（WebView 组件）
        resources/
          base/
            element/
              string.json           # 模块字符串（含 server_url）
              color.json            # 颜色资源
            profile/
              main_pages.json       # 页面路由
            media/                  # 图标资源（见下方"图标说明"）
        module.json5               # 模块配置
      ohosTest/                    # 仪器测试目录
    build-profile.json5            # 模块构建配置
    hvigorfile.ts                  # 模块构建脚本
    oh-package.json5               # 模块包配置
  build-profile.json5              # 项目构建配置
  hvigorfile.ts                    # 项目构建脚本
  oh-package.json5                 # 项目包配置
```

## 环境要求

- **DevEco Studio 5.0+**（下载地址：华为开发者联盟）
- HarmonyOS SDK API 12+（DevEco Studio 内置安装）
- JDK 17+（DevEco Studio 自带）

## 打开与构建

1. 打开 DevEco Studio → `File` → `Open` → 选择 `harmonyos/` 目录。
2. 等待工程同步完成（DevEco 会自动下载 hvigor 与 SDK 依赖）。
3. 连接 HarmonyOS 设备或启动模拟器。
4. 点击 `Run` 按钮（或 `Shift+F10`）编译并安装到设备。

> 若 DevEco Studio 提示缺少 `EntryAbility`，使用 `File → New → Empty Ability` 生成默认 EntryAbility，并在 `module.json5` 的 `abilities[].srcEntry` 指向它。当前模板直接以 `pages/Index.ets` 作为 `srcEntry`，适配简化场景。

## 配置服务器地址

默认加载地址为 `http://${LAN_NODE_N2}:18789`，可通过以下方式修改：

**方式一（推荐）：修改字符串资源**

编辑 `entry/src/main/resources/base/element/string.json`：

```json
{
  "name": "server_url",
  "value": "http://你的服务器地址:端口"
}
```

应用启动时 `Index.ets` 的 `aboutToAppear()` 会读取该资源并作为 WebView 加载地址。

**方式二：修改代码默认值**

编辑 `entry/src/main/pages/Index.ets` 顶部的常量：

```typescript
const DEFAULT_SERVER_URL: string = 'http://你的服务器地址:端口';
```

## 图标说明

`module.json5` 与 `AppScope/app.json5` 引用了 `$media:app_icon`。仓库已内置 1×1 占位图标（保证可构建）：

- `AppScope/resources/base/media/app_icon.png`（应用级图标）
- `entry/src/main/resources/base/media/app_icon.png`（模块级图标）

发布前请替换为正式图标。建议尺寸：1024×1024 PNG，DevEco Studio 会自动生成多分辨率适配文件。

## 网络权限

**`ohos.permission.INTERNET` 已在 `module.json5` 中声明（2026-08-24 审计整改 M-1）——联网类应用的必填项，缺失时真机 WebView 必然加载失败。**

WebView 加载 HTTP 资源默认通过 `mixedMode` 放行混合内容：

## 生成签名 HAP 包

### 1. 创建签名密钥

DevEco Studio → `File` → `Project Structure` → `Signing Configs` → 勾选 `Automatically generate signature`，或手动创建 `.p12` 密钥库与 `.csr` 证书。

### 2. 配置签名

在 `build-profile.json5` 的 `app.signingConfigs` 中填入：

```json5
"signingConfigs": [
  {
    "name": "default",
    "type": "HarmonyOS",
    "material": {
      "certpath": "路径/证书.cer",
      "storePassword": "密钥库密码",
      "keyAlias": "别名",
      "keyPassword": "密钥密码",
      "profile": "路径/Profile.p7b",
      "signAlg": "SHA256withECDSA",
      "storeFile": "路径/密钥库.p12"
    }
  }
]
```

### 3. 构建 Release HAP

菜单栏 `Build` → `Build Hap(s)/APP(s)` → `Build Hap(s)`，或在终端执行：

```bash
hvigorw assembleHap --mode module -p product=default -p buildMode=release
```

生成的 HAP 文件位于 `entry/build/default/outputs/default/`。

### 4. 安装到设备

```bash
hdc install entry/build/default/outputs/default/entry-default-signed.hap
```

## WebView 功能说明

| 功能 | 实现位置 | 说明 |
|------|----------|------|
| JavaScript 执行 | `.javaScriptAccess(true)` | 启用 JS，前端框架必需 |
| DOM Storage | `.domStorageAccess(true)` | 启用 localStorage，存储会话/偏好 |
| 混合内容 | `.mixedMode(MixedMode.All)` | 允许 HTTPS 页面加载 HTTP 资源 |
| 加载指示器 | `@State isLoading` + `LoadingProgress` | 页面加载中显示进度环 |
| 返回键导航 | `onBackPress()` + `accessBackward()` | WebView 历史可后退则后退，否则退出 |
| 错误处理 | `onErrorReceive()` | 加载失败时隐藏指示器并输出日志 |
