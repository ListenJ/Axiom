/**
 * 旧版 activate(context) 契约插件
 */
export default {
  activate(ctx) {
    ctx.toolRegistry.add({
      name: "legacy_plugin_tool",
      description: "test tool from legacy-plugin (activate contract)",
      inputSchema: {},
      // I1 对旧契约同样生效：activate 里命令式注册也必须声明能力
      capability: ["internal"],
      handler: async () => ({ ok: true }),
    });
  },
};
