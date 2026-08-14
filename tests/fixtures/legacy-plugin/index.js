/**
 * 旧版 activate(context) 契约插件
 */
export default {
  activate(ctx) {
    ctx.toolRegistry.add({
      name: "legacy_plugin_tool",
      description: "test tool from legacy-plugin (activate contract)",
      inputSchema: {},
      handler: async () => ({ ok: true }),
    });
  },
};
