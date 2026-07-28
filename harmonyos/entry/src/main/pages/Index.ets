// Index.ets —— Axiom Agent 鸿蒙 WebView 壳应用主页面
// 通过 WebView 加载 Axiom Agent Web 前端，提供原生化体验。

import webview from '@ohos.web.webview';
import { common } from '@ohos.app.ability.UIAbility';

// 默认服务器地址占位符：实际值从 string.json 资源读取（便于构建期切换环境）
const DEFAULT_SERVER_URL: string = 'http://192.168.0.22:18789';

@Entry
@Component
struct Index {
  // Web 控制器：用于历史导航、刷新等运行期控制
  private webController: webview.WebviewController = new webview.WebviewController();

  // 是否正在加载页面（用于控制 loading 指示器显隐）
  @State isLoading: boolean = true;

  // 当前加载的 URL（启动时取自字符串资源，便于无需改代码即可切换服务器）
  @State serverUrl: string = DEFAULT_SERVER_URL;

  /**
   * 应用进入前台并完成 UI 初始化后调用。
   * 此处从资源读取服务器地址，避免硬编码。
   */
  aboutToAppear(): void {
    try {
      // 优先从字符串资源读取 server_url，便于多环境构建
      const urlFromRes: Resource = $r('app.string.server_url');
      const ctx: common.UIAbilityContext = getContext(this) as common.UIAbilityContext;
      const resolved: string = ctx.resourceManager.getStringSync(urlFromRes.id);
      if (resolved && resolved.length > 0) {
        this.serverUrl = resolved;
      }
    } catch (e) {
      // 资源读取失败时回退到代码内默认值，保证可用
      console.warn(`[Index] 读取 server_url 资源失败，使用默认地址: ${e}`);
    }
  }

  /**
   * 系统返回键处理：若 WebView 历史可后退则后退，否则交还系统退出。
   * 通过 onBackPress 返回 true 拦截系统返回事件。
   */
  onBackPress(): boolean {
    try {
      if (this.webController.accessBackward()) {
        this.webController.backward();
        return true; // 拦截事件，由 WebView 内部后退
      }
    } catch (e) {
      console.warn(`[Index] 返回键处理异常: ${e}`);
    }
    return false; // 不拦截：交还系统，默认退出应用
  }

  build(): void {
    Column() {
      // 主体 WebView：全屏铺满
      Web({ src: this.serverUrl, controller: this.webController })
        .domStorageAccess(true)          // 启用 DOM Storage（localStorage），Web 前端依赖此存储会话与偏好
        .databaseAccess(true)            // 启用 Web SQL Database 访问
        .javaScriptAccess(true)          // 启用 JavaScript 执行
        .fileAccess(true)                // 允许通过 file:// 访问本地文件
        .onlineImageAccess(true)         // 允许加载在线图片资源
        .imageAccess(true)               // 允许图片访问
        .mixedMode(MixedMode.All)        // 允许 HTTPS 页面加载 HTTP 资源（开发环境常用）
        .zoomAccess(false)               // 禁止手势缩放，保持 App 化体验
        .width('100%')
        .height('100%')
        .layoutWeight(1)
        // 控制器就绪：保存引用，便于后续调用
        .onControllerAttached(() => {
          console.info('[Index] Web 控制器已就绪');
        })
        // 页面开始加载：显示 loading 指示器
        .onPageBegin(() => {
          this.isLoading = true;
        })
        // 页面结束加载：隐藏 loading 指示器
        .onPageEnd(() => {
          this.isLoading = false;
        })
        // 加载出错：隐藏 loading，输出错误日志便于排查
        .onErrorReceive((event) => {
          this.isLoading = false;
          if (event && event.error) {
            console.error(`[Index] 页面加载错误: code=${event.error.errorcode}, desc=${event.error.description}`);
          }
        })

      // 顶部 Loading 条：加载中时显示，加载完成自动隐藏
      if (this.isLoading) {
        LoadingProgress()
          .width(40)
          .height(40)
          .margin({ top: 12, bottom: 12 })
          .color('#007DFF')
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFFFFF')
  }
}
