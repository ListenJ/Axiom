# 商业搜索 API 免费额度调研（2026-09 快照）

> **核查时间**：2026-09-13 ~ 2026-09-14 UTC
> **核查方式**：直接抓取官方定价页 / 官方文档页 / 官方公告页；Jina 两项做了真实 HTTP 请求实测。
> **纪律**：本表所有 `free_tier` 数字均来自下列官方页面。**未在本次抓取中直接确认的字段一律写 `需核实`**，不做推断填充。
> 本次调研因时间到点中止，第三批（抓取类 / LLM 类 / 国内厂商）尚未完成，见文末「未完成清单」。

---

## 一、已核实：2026 年当前有效的免费额度

| id | name | free_tier | requires_card | signup_url | docs_url | endpoint | auth_style | env_var | best_for | lang_zh | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `tavily` | Tavily | **1,000 API credits / 月**（"Researcher" 免费计划；官方 FAQ 明确"每月 1 日重置"） | **no**（页面原文 "No credit card required"） | https://www.tavily.com/ | https://docs.tavily.com/ `需核实` | `需核实` | `需核实` | `TAVILY_API_KEY` | AI Agent 的通用网页检索 + 正文提取，英文/技术类内容 | 未知 | 免费额度**每月循环**，非一次性。PAYG $0.008/credit。另有"学生免费"。额度耗尽后请求会停止直到重置。[src](https://www.tavily.com/pricing) |
| `exa` | Exa（原 Metaphor） | **注册送 $20 credits + 每月 $10 credits**（Starter 免费计划；官方称 "over $120 in credits per year"） | **no**（页面原文 "No payment method required"） | https://exa.ai/ | https://docs.exa.ai/ `需核实` | `需核实` | `需核实` | `EXA_API_KEY` | 语义/神经检索、学术 + 公司 + 人物专门索引 | 未知 | 额度为**美元计费**而非次数。Search $7/1k requests → $10/月约≈1,428 次（**推算，官方未这样表述**）。10 QPS，50 Agent 并发。Contents $1/1k pages。[src](https://exa.ai/pricing) |
| `brave` | Brave Search API | **每月 $5 credits**，自动抵扣到账户（官方标注 "with $5 in free monthly credits"） | `需核实`（页面未明说） | https://brave.com/search/api/ | https://api.search.brave.com/app/documentation `需核实` | **`https://api.search.brave.com/res/v1/web/search`** ✅官方代码示例 | **`X-Subscription-Token` header** ✅官方代码示例 | `BRAVE_SEARCH_API_KEY` | 独立索引、低延迟、RAG 管线的性价比之选 | 未知 | Search $5/1k → $5/月 ≈ 1,000 次/月（**推算**）。Search 50 QPS；Answers $4/1k + $5/M tokens，2 QPS。额度每月自动应用。[src](https://brave.com/search/api/) |
| `serper` | Serper.dev | **2,500 次免费查询**（首页横幅，**一次性**） | **no**（首页原文 "No credit card required"） | https://serper.dev/ | https://serper.dev/ `需核实` | `需核实` | `需核实` | `SERPER_API_KEY` | 便宜的 Google SERP 结构化 JSON | 未知 | 非订阅：充值制。$50 → 50k credits（$1.00/1k），credits **6 个月有效**。官方自述比 SerpAPI / Bright Data 便宜最多 10 倍。[src](https://serper.dev/) |
| `serpapi` | SerpAPI | **250 次搜索 / 月**（Free 计划，$0/month） | `需核实` | https://serpapi.com/ | https://serpapi.com/search-api | `需核实` | `需核实`（通常为 query param） | `SERPAPI_API_KEY` | 引擎覆盖最广的托管 SERP（含 Baidu / Yandex 等） | 未知（含 Baidu 引擎，未核实） | Free 计划吞吐 50 次/小时。**只对成功搜索计费**，缓存/报错/失败不计。7 天内且用量 <20% 可全额退款。[src](https://serpapi.com/pricing) |
| `searchapi` | SearchApi.io | **注册送 100 次免费请求**（**一次性**） | **no**（页脚原文 "No credit card required"） | https://www.searchapi.io/ | https://www.searchapi.io/docs `需核实` | `需核实` | `需核实` | `SEARCHAPI_API_KEY` | 多引擎 SERP + Google AI Mode / AI Overview 字段 | 未知 | 起步 $40/月 = 10k 次（$4/1k）；量大到 $5,000/月（$1/1k）。**每小时最多只能用掉计划额度的 20%**。[src](https://www.searchapi.io/pricing) |
| `zenserp` | Zenserp | **50 次搜索 / 月**（Free 计划，$0/mo） | `需核实` | https://zenserp.com/pricing/ | https://zenserp.com/documentation/ `需核实` | `需核实` | `需核实` | `ZENSERP_API_KEY` | 小量 SERP 抓取，带 AI Overview 字段 | 未知 | 免费额度**每月循环**。付费 Small $49.99/mo = 25,000 次。只对成功响应计费；标准计划建议 ≤400 并发。APILayer 旗下产品。[src](https://zenserp.com/pricing/) |
| `firecrawl` | Firecrawl | **1,000 credits / 月**（Free 计划，**每月刷新**；官方换算 "500 searches or 1,000 pages scraped"） | **no**（官方原文 "No cost, no card, no hassle" / "no credit card required"） | https://www.firecrawl.dev/ | https://docs.firecrawl.dev/ `需核实` | `需核实` | `需核实`（通常 Bearer） | `FIRECRAWL_API_KEY` | 搜索 + 抓取 + 爬取一体，直接产出 LLM-ready markdown | 未知 | 计费：1 credit = 基础抓取 1 页；**search 每 10 条结果 2 credits**。失败抓取不计费（但 403/404 仍计 1 credit）。Free 计划 /crawl 限 2 次/分钟。有独立的 Developer Index。[src](https://www.firecrawl.dev/pricing) |

---

## 二、已停服 / 已取消免费额度（**不要集成**）

| id | name | 状态 | 关键事实（官方原文） | 来源 |
|---|---|---|---|---|
| `bing_web_search` | **Bing Web Search API / Bing Search APIs** | ❌ **2025-08-11 已退役** | "Bing Search APIs will be retired on **August 11, 2025**. Any existing instances of Bing Search APIs will be **decommissioned completely**, and the product will no longer be available to be used or **new customer signup**." 官方指定迁移路径：Azure AI Agents 的 **Grounding with Bing Search** | [Microsoft Lifecycle 公告](https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement)（页面 last updated 2025-05-16） |
| `google_cse_json` | **Google Programmable Search Engine (CSE) JSON API** | ⚠️ **2027-01-01 停服，且已对新客户关闭** | 官方原文：**"The following pricing applies only to existing Custom Search JSON API customers until the service discontinuation on January 1, 2027. This API is not available for new customers."** 100 次/天免费 + $5/1000 超额（上限 10k/天）**仅对存量客户有效** | [Google Custom Search JSON API Overview](https://developers.google.com/custom-search/v1/overview) |
| `metaphor` | **Metaphor** | ⚠️ 品牌已并入 **Exa** | 同上表 `exa` 条目；请直接用 `exa` 的 key 与额度，不要再按 Metaphor 集成 | [exa.ai/pricing](https://exa.ai/pricing) |
| `duckduckgo_api` | **DuckDuckGo 官方 Web Search API** | ⚠️ **不存在官方通用 Web Search API** | `https://duckduckgo.com/api` 实测只返回 "DuckDuckGo" 一个词，无 API 产品页；官方 Help Pages 未列出任何 Web Search API 产品。**DuckDuckGo 从未提供过公开的通用网页搜索 API**（既非"已停止免费"，而是从来没有）。仅存在 Instant Answer API（非网页检索）。 | [duckduckgo.com/api](https://duckduckgo.com/api)（实测）、[Help Pages](https://duckduckgo.com/duckduckgo-help-pages/) |

> ⚠️ **对原任务假设的两处修正**：
> 1. "Google CSE JSON API 100 次/天免费" —— **对新项目已不可用**，2027-01-01 全面停服。自建池不应把它作为可选项。
> 2. "Bing Web Search API 是否已停售" —— **确认已于 2025-08-11 退役并完全下线**，含存量实例。唯一官方后继是 Azure AI Agents 的 Grounding with Bing Search（按 Azure AI 计费，非独立搜索 API）。

---

## 三、Jina Reader (`r.jina.ai`) 与 `s.jina.ai` 免费额度现状

**结论：两者不再是对等的"免费"。`r.jina.ai` 仍可无 Key 免费使用；`s.jina.ai` 现在必须带 API Key。**

### 3.1 实测结果（2026-09-14 UTC，无 Key 直接请求）

```
GET https://r.jina.ai/https://example.com   → HTTP 200，正常返回 markdown 正文
GET https://s.jina.ai/test%20query          → HTTP 401
  {"code":401,"name":"AuthenticationRequiredError","status":40103,
   "message":"Authentication is required to use this endpoint.
              Please provide a valid API key via Authorization header."}
```

### 3.2 官方速率限制表（jina.ai/reader/，2026-09-14 抓取）

| 产品 | Endpoint | 无 API Key | 免费 Key | Paid Key | Premium Key | 计费方式 |
|---|---|---|---|---|---|---|
| Reader API（读网页） | `https://r.jina.ai` | **20 RPM** | 500 RPM | 500 RPM | 5,000 RPM | 按**输出** token 计 |
| Reader API（搜索） | `https://s.jina.ai` | 100 RPM（表内标注，**与实测 401 冲突**） | **100 RPM** | — | 1,000 RPM | 每请求**固定 ≥10,000 tokens** |
| Embedding API | `https://api.jina.ai/v1/embeddings` | 100 RPM / 100k TPM | 500 RPM / 2M TPM | — | 5,000 RPM / 50M TPM | 按输入大小 |
| Reranker API | `https://api.jina.ai/v1/rerank` | 100 RPM / 100k TPM | 500 RPM / 2M TPM | — | 5,000 RPM / 50M TPM | 按输入大小 |

### 3.3 免费额度

- **注册即送：每个新 API Key 自带 10M 免费 tokens**（官方原文 "Every new API key comes with **10M free tokens**!"；FAQ 亦确认 "New users get an auto-generated API key with free tokens usable across any of our models. Once the free tokens are consumed, you can purchase additional tokens"）。
- **推算（非官方表述）**：`s.jina.ai` 每次请求固定 ≥10,000 tokens → 10M ≈ **约 1,000 次搜索**。
- **`r.jina.ai` 基础用法官方原文"免费"**："Reader is free for basic usage: prepend 'https://r.jina.ai/' to your URL. Supplying an API key raises the rate limit and charges tokens based on content length."
- 计费模型自 2025-05-06 起为新版（官方 info 提示）。

### 3.4 对自建池的建议

- `r.jina.ai` 可作为**零 Key 兜底正文提取器**（20 RPM/IP，够轻量用）。注意：默认 `X-Engine` 走无头浏览器；重复请求 5 分钟内走缓存。
- `s.jina.ai` **必须配置 Key**，不要再按"免 Key 搜索"集成；按 10,000 tokens/次估算成本。

来源：[jina.ai/reader/](https://jina.ai/reader/)（官方页面，2026-09-14 抓取）+ 上述实测。

---

## 四、给自建池的优先级建议（按「免费额度 / 中文效果 / 接入成本」）

> **必须先说明的方法论限制**：本轮调研在时间到点前**未能核实任何一个服务的中文检索效果**（`lang_zh` 全部为"未知"），也**未能完成国内厂商（博查/智谱/百度/阿里/腾讯/火山/秘塔）的核实**。因此下面的排序**只按"免费额度 × 接入成本"两项打分**，中文效果一栏请视为空白待补。若你的主要场景是中文检索，**这份前 5 只能当"英文兜底池"**，国内厂商必须另行调研。

| 排名 | 服务 | 免费额度（已核实） | 接入成本 | 理由 |
|---|---|---|---|---|
| **1** | **Tavily** | 1,000 credits/**月**（循环） | 低（REST，AI 场景专用） | 唯一官方明说"无需绑卡 + 每月循环 1,000 次"的搜索 API；额度语义与"搜索次数"最接近，不会因 credits 换算失控。**首选默认 provider**。[src](https://www.tavily.com/pricing) |
| **2** | **Brave Search API** | $5 credits/**月**（循环，≈1,000 次） | 低（endpoint 与鉴权头已被官方示例确认） | 每月自动到账，独立索引（不依赖 Google/Bing），50 QPS 吞吐最高，$5/1k 单价便宜。**最适合作为主力通用检索**。缺点：已用额度是美元计价，池里要自己做金额→次数换算。[src](https://brave.com/search/api/) |
| **3** | **Exa** | $20 注册 + $10/**月**（循环，≈1,428 次） | 中 | 循环额度最大（$120/年），且是**语义检索**，与关键词型 provider 互补，能提升池的召回多样性。代价：美元计价 + 需要处理 Search/Contents/Agent 多端点计费。[src](https://exa.ai/pricing) |
| **4** | **Firecrawl** | 1,000 credits/**月**（循环） | 中 | 它不是纯 SERP，而是"搜索 + 正文抓取"一体，能补上其他 provider 只给 URL/snippet 的短板。Free 每月刷新且明确无需绑卡。注意 search 每 10 条结果吃 2 credits。[src](https://www.firecrawl.dev/pricing) |
| **5** | **Serper.dev** | 2,500 次（**一次性**） | 低 | 单次性但量大、明确无需绑卡，是**冷启动/压测**的最佳一次性补充；后续按量充值单价 $1/1k 也是全表最低档。适合做"额度耗尽后的廉价兜底"。[src](https://serper.dev/) |

**次选（按需加入）**：
- `serpapi` —— 250 次/月循环，但引擎覆盖最广；若池需要 Baidu/Yandex 等非 Google 引擎，它的价值高于免费额度本身。
- `zenserp` —— 50 次/月，额度小，仅适合作为第 6~8 顺位冗余。
- `searchapi` —— 只有一次性 100 次，且每小时限用 20%，不适合作为主力，适合做 AI Overview 字段的专项补充。
- `jina_r.jina.ai` —— **零 Key 免费**，直接作为正文提取兜底层。

**明确不要集成**：`bing_web_search`（已退役）、`google_cse_json`（新客户已关闭，2027-01-01 停服）、`duckduckgo_api`（不存在官方 Web Search API）、`metaphor`（请用 exa）。

---

## 五、未完成清单（本次未核实，字段请填 `需核实`，勿凭记忆填充）

以下服务**本次未能抓取官方页面**，因此在报告中没有给出任何数字。每一行附上待核查的官方 URL：

### 抓取/SERP 类（子代理已中止，未回报）
| id | 待核查官方页 |
|---|---|
| `scrapingbee` | https://www.scrapingbee.com/pricing/ |
| `scraperapi` | https://www.scraperapi.com/pricing/ |
| `brightdata_serp` | https://brightdata.com/pricing/serp |
| `oxylabs_serp` | https://oxylabs.io/products/scraper-api/serp |
| `zenrows` | https://www.zenrows.com/pricing |
| `apify` | https://apify.com/pricing |
| `scrapingdog` | https://www.scrapingdog.com/pricing/ |
| `serply` | https://serply.io/pricing |

### LLM 问答/检索类（子代理已中止，仅回报一条）
| id | 待核查官方页 | 已知线索 |
|---|---|---|
| `you_com` | https://docs.you.com/ | **2026 年是否仍有免费额度存疑，必须核实** |
| `perplexity` | https://docs.perplexity.ai/getting-started/pricing | 需核实是否有免费额度 |
| `kagi` | https://help.kagi.com/kagi/api/search.html | 子代理中止前回报："**Kagi pricing confirmed ($12/1k, no free tier listed)**"——**未经我二次核实，请按 `需核实` 处理**；若属实则 Kagi 无免费额度且需付费订阅 |
| `andi` | https://andisearch.com/ | 是否公开 API 存疑 |
| `linkup` | https://www.linkup.so/pricing | — |
| `valyu` | https://www.valyu.ai/ | — |
| `parallel_ai` | https://parallel.ai/pricing | — |
| `gemini_grounding` | https://ai.google.dev/gemini-api/docs/pricing | Gemini API + Google Search grounding 免费额度需核实 |

### 国内厂商（**完全未核实**，子代理已中止）
| id | 待核查官方页 |
|---|---|
| `bocha` | https://open.bochaai.com/ |
| `zhipu` | https://open.bigmodel.cn/pricing |
| `baidu_qianfan` | https://cloud.baidu.com/doc/qianfan/index.html |
| `aliyun_bailian` | https://bailian.console.aliyun.com/ |
| `tencent_hunyuan` | https://cloud.tencent.com/document/product/1729 |
| `volcengine` | https://www.volcengine.com/docs/82379 |
| `metaso` | https://metaso.cn/ |
| `minimax` / `moonshot_kimi` / `xfyun` | 各自的开放平台定价页 |

### 另一个未核实项
| id | 待核查官方页 | 说明 |
|---|---|---|
| `yandex_search_api` | https://aistudio.yandex.ru/en/docs/search-api/pricing | **文档已从 `yandex.cloud/en/docs/search-api/pricing` 301 迁移到 `aistudio.yandex.ru`**。本机网络访问该域被 CAPTCHA 拦截（`/tmgrdfrend/showcaptchafast`），**无法核实**。仅从搜索引擎摘要看到 "$3.99999936 日间同步 / $0.24999996 日间延迟" 这类片段——**非官方页面直读，不予采信**。官方 GitHub 仓库 `yandex-cloud/docs` 中的 `en/_includes/search-api-limits.md` 已核实配额：同步 10,000 次/小时、10 次/秒；延迟 35,000 次/小时；生成式回答 1,000 次/小时；单次最多返回 250 条。**免费额度：需核实**。 |

---

## 六、来源清单（本次实际成功抓取）

| URL | 结果 |
|---|---|
| https://www.tavily.com/pricing | ✅ 200 |
| https://exa.ai/pricing | ✅ 200 |
| https://brave.com/search/api/ | ✅ 200 |
| https://serper.dev/ | ✅ 200 |
| https://serpapi.com/pricing | ✅ 200 |
| https://www.searchapi.io/pricing | ✅ 200 |
| https://zenserp.com/pricing/ | ✅ 200 |
| https://www.firecrawl.dev/pricing | ✅ 200 |
| https://jina.ai/reader/ | ✅ 200 |
| https://developers.google.com/custom-search/v1/overview | ✅ 200 |
| https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement | ✅ 200 |
| https://learn.microsoft.com/en-us/bing/search-apis/bing-web-search/overview | ✅ 200（**该页仍在，且未提退役**，但 Lifecycle 公告为准；页面 last updated 2025-05-07） |
| https://duckduckgo.com/api | ✅ 200（空页，仅 "DuckDuckGo"） |
| https://raw.githubusercontent.com/yandex-cloud/docs/master/en/_includes/search-api-limits.md | ✅ 200（配额） |
| https://aistudio.yandex.ru/en/docs/search-api/pricing | ❌ CAPTCHA 拦截 |
| https://yandex.cloud/en/docs/search-api/pricing | ❌ 301 → 上述地址 |
| https://r.jina.ai/ | ❌ 403（curl 被反爬），但页面主体已由 https://jina.ai/reader/ 覆盖 |
| https://jina.ai/pricing/ | ❌ 404（该路径不存在） |
| https://jina.ai/search/ | ❌ 404 |

**未核实即未采用**：所有 `需核实` 字段、Kagi 的 $12/1k、Yandex 的 $3.99 单价，均**未**写入正式结论。
