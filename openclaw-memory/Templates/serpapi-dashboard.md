---
title: SerpAPI 搜索仪表盘
type: dashboard
created: 2026-05-26
tags: [dashboard, serpapi, search]
---

# 🔍 SerpAPI 搜索仪表盘

> 本仪表盘使用 Obsidian Dataview 插件动态汇总所有 SerpAPI 搜索结果。
> 安装 Dataview 插件后即可自动渲染。

---

## 📊 统计概览

```dataviewjs
const pages = dv.pages('"03-Resources/search-results"').where(p => p.type == "serpapi-search-result");
const total = pages.length;
const today = pages.where(p => p.created && p.created.startsWith(dv.date("now").toFormat("yyyy-MM-dd"))).length;
const thisWeek = pages.where(p => p.created && dv.date(p.created) > dv.date("now") - dur(7, "days")).length;

dv.table(
  ["指标", "数值"],
  [
    ["总搜索记录", total],
    ["今日", today],
    ["本周", thisWeek],
    ["知识图谱命中", pages.where(p => p.tags && p.tags.includes("knowledge-graph")).length],
  ]
);
```

---

## 🕐 最近搜索

```dataview
TABLE
  title AS "查询",
  created AS "时间",
  source AS "搜索链接",
  tags AS "标签"
FROM "03-Resources/search-results"
WHERE type = "serpapi-search-result"
SORT created DESC
LIMIT 20
```

---

## 🏷️ 按标签分布

```dataviewjs
const pages = dv.pages('"03-Resources/search-results"').where(p => p.type == "serpapi-search-result");
const tagCounts = {};
pages.forEach(p => {
  if (p.tags) {
    p.tags.forEach(t => {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    });
  }
});
const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
dv.table(["标签", "数量"], sorted);
```

---

## 🔗 知识图谱记录

```dataview
TABLE
  title AS "查询",
  created AS "时间",
  source AS "来源"
FROM "03-Resources/search-results"
WHERE type = "serpapi-search-result" AND contains(tags, "knowledge-graph")
SORT created DESC
LIMIT 10
```

---

## 📈 本周搜索趋势

```dataviewjs
const pages = dv.pages('"03-Resources/search-results"').where(p => p.type == "serpapi-search-result");
const byDay = {};
pages.forEach(p => {
  if (p.created) {
    const day = dv.date(p.created).toFormat("yyyy-MM-dd");
    byDay[day] = (byDay[day] || 0) + 1;
  }
});
const sortedDays = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-14);
dv.table(["日期", "搜索次数"], sortedDays);
```

---

> 💡 **提示**: 将此文件复制到 `02-Areas/` 或 `03-Resources/` 下作为固定仪表盘使用。
