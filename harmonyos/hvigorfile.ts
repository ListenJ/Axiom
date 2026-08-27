// hvigorfile.ts —— 鸿蒙 hvigor 构建脚本入口
// 使用 hvigor 驱动的标准构建流程，无需自定义 task。

import { appTasks } from '@ohos/hvigor-ohos-plugin';

export default {
  system: appTasks,
};
