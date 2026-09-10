/**
 * Hook/工具契约测试插件（现代 PluginModule 契约：tools + hooks）
 */
export const hooksLog = [];

export default {
  tools: [
    {
      name: "hook_plugin_ping",
      description: "test tool from hook-plugin",
      inputSchema: {},
      handler: async () => ({ ok: true }),
    },
  ],
  hooks: {
    onEnable: async () => {
      hooksLog.push("enable");
    },
    onDisable: async () => {
      hooksLog.push("disable");
    },
  },
};
