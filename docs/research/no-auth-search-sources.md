# 免 Key / 免登录 程序化检索数据源清单

> 核实方式：全部条目均由本机 HTTP 客户端（curl / Python requests，浏览器 UA）**实际请求探测**，记录真实 HTTP 状态码、Content-Type、响应体大小与响应片段。未逐字核验的限额数值已标注 `需实测确认`。
> 探测时间：2026-09-14（UTC）。探测出口为**数据中心/VPS IP**，因此 HTML 类引擎的封锁结论偏保守（住宅 IP 可能更宽松）；RSS/JSON API 类结论与出口 IP 关系不大。

---

## 1. 通用网页搜索

| id | name | type | endpoint | auth | lang/region | rate_limit | reliability | parse_hint | tos_note |
|---|---|---|---|---|---|---|---|---|---|
| `ddg_html` | DuckDuckGo HTML | html_scrape | 先 `GET https://duckduckgo.com/` 取 cookie，再 `POST https://html.duckduckgo.com/html/` body=`q={query}`，带 `Referer: https://duckduckgo.com/` | none | global / en / zh-CN | unknown；实测裸 GET/POST 返回 **202 挑战页**，bootstrap 后正常 | medium | HTML：`a.result__a`（标题+href）、`.result__snippet`、`.result__url`；实测解析出 10 条真实结果 | robots.txt 禁止 `/html/` 自动化抓取，仅限低并发个人研究用途，务必缓存 |
| `ddg_lite` | DuckDuckGo Lite | html_scrape | `https://lite.duckduckgo.com/lite/?q={query}`（POST 同理，需 bootstrap） | none | global | unknown | medium | 极简表格 HTML，`a.result-link` + 相邻 td 摘要；比 /html/ 更省流量 | 同 `ddg_html`，同属被 robots 限制的抓取面 |
| `bing_web` | Bing 网页 | html_scrape | `https://www.bing.com/search?q={query}&ensearch=1` | none | global（本机 302 → `cn.bing.com`） | 建议 ≥1.5s/次 | medium | HTML：`li.b_algo h2 a`、`.b_caption p`；`ensearch=1` 可显著改善英文结果 | Bing robots 允许 /search 但限制频次，勿并发抓取 |
| `bing_rss` | Bing RSS | rss | `https://www.bing.com/search?q={query}&format=rss` | none | global | unknown | medium-high | 标准 RSS：`channel/item/title`、`/link`、`/description`；实测 4.2KB 干净 XML | 与 `bing_web` 同源，成本极低，建议优先 |
| `brave_web` | Brave Search | html_scrape | `https://search.brave.com/search?q={query}&source=web` | none | global | 实测按 8s 间隔仍频繁 **429** | low | HTML 结果块内 `.snippet`；SvelteKit 结构随版本变动，需 fixture 测试 | 反自动化强，**不建议作主力**，仅作偶发补充 |
| `marginalia` | Marginalia Search | html_scrape | `https://marginalia-search.com/search?query={query}` | none | en（独立非商业小站索引） | unknown；`old-search.marginalia.nu` 返回 "Wait For A Moment" 限流页 | medium | HTML：`#results` 内结果条目链接 + 描述 | 个人运营的小引擎，须极低并发；`search.marginalia.nu` 已 301 至新域名 |
| `mwmbl` | Mwmbl | json_api | `https://mwmbl.org/api/v1/search/?s={query}` | none | en | unknown | medium | JSON 数组：`[].url`、`[].title[].value`、`[].extract[].value` | **必须发 `Accept-Encoding: identity`**：服务端 gzip 头损坏，默认解压会报 ContentDecodingError；开源众包索引 |
| `wiby` | Wiby | html_scrape | `https://wiby.me/?q={query}` | none | en | unknown | low-medium | HTML 结果列表 `<a>` + 描述文本 | 复古小站索引，覆盖面窄，仅作长尾补充 |
| `so360` | 360 搜索 | html_scrape | `https://www.so.com/s?q={query}` | none | zh-CN | unknown，建议 ≥3s | medium | HTML：`.res-list` / `h3 a`；移动版 `https://m.so.com/s?q={query}` 结构更简单 | 实测直连 200（354KB），有反爬但当前可用，需限速 |
| `sogou` | 搜狗 | html_scrape | `https://www.sogou.com/web?query={query}` | none | zh-CN | 建议 ≥3s；配合首页 cookie bootstrap 更稳 | medium | HTML：`.vrwrap h3 a`、`.str_info`；结果链接可能是 `sogou.com/link?url=` 跳转需还原 | 偶发反爬/空结果，需 cookie 引导 + 熔断冷却 |
| `baidu_http` | 百度（HTTP 入口） | html_scrape | `http://www.baidu.com/s?wd={query}` | none | zh-CN | 建议 ≥6s | low-medium | HTML：`#content_left .result h3 a` + 摘要 | **HTTPS 入口实测直接跳「百度安全验证」**，仅 HTTP 入口可用；极不稳定，默认降权 |
| `bing_cn` | Bing 中国 | html_scrape | `https://cn.bing.com/search?q={query}` | none | zh-CN | 同 `bing_web` | medium | 同 `bing_web` | 中文场景可替代百度，风险远低于百度 |
| `bili_search` | 哔哩哔哩搜索 API | json_api | `https://api.bilibili.com/x/web-interface/search/all/v2?keyword={query}` | none | zh-CN | unknown | medium | JSON：`data.result[]`，按 `result_type` 分组（video/media_bangumi…） | 实测匿名 200（34KB 真实结果）；需带浏览器 UA + `Referer: https://www.bilibili.com/` |
| `toutiao_search` | 头条搜索 | html_scrape | `https://so.toutiao.com/search?keyword={query}` | none | zh-CN | unknown | low | 1.79MB HTML，JS 重，需自定义选择器（**结果选择器需实测确认**） | 页面体积大、结构不稳，仅作补充 |

---

## 2. RSS / 新闻

| id | name | type | endpoint | auth | lang/region | rate_limit | reliability | parse_hint | tos_note |
|---|---|---|---|---|---|---|---|---|---|
| `gnews_search` | Google News 搜索 RSS | rss | `https://news.google.com/rss/search?q={query}&hl={hl}&gl={gl}&ceid={gl}:{hl}`（如 `hl=en-US&gl=US&ceid=US:en`；中文 `hl=zh-CN&gl=CN&ceid=CN:zh-Hans`） | none | global（实测 en 138KB / zh 94KB） | unknown | high | RSS：`item/title`、`/link`、`/pubDate`、`/source`；链接为 `news.google.com/rss/articles/...` 需二次跳转 | 公开 RSS，非官方 API；勿高频轮询，建议 15–30 分钟缓存 |
| `gnews_topic` | Google News 头条 RSS | rss | `https://news.google.com/rss?hl={hl}&gl={gl}&ceid={gl}:{hl}` | none | global / 分语种 | unknown | high | 同上 | 同上 |
| `yahoo_news_rss` | Yahoo News 搜索 RSS | rss | `https://news.yahoo.com/rss/search?p={query}` | none | en-US | unknown | medium | RSS `item/title`、`/link`、`/pubDate` | 公开 RSS；Yahoo 近年多次调整该路径，需健康检查兜底 |
| `hnrss` | Hacker News RSS (hnrss.org) | rss | `https://hnrss.org/newest?q={query}&count={n}` | none | en | unknown | medium | RSS `item/title`、`/link`、`/description`（含评论数） | 第三方对 HN 的封装，非官方；请勿高频 |
| `gdelt_doc` | GDELT 2.0 DOC API | dataset_api | `https://api.gdeltproject.org/api/v2/doc/doc?query={query}&mode=artlist&format=json&maxrecords={n}` | none | global（多语种新闻，实测返回越南语等） | unknown | high | JSON：`articles[].url / .title / .seendate / .domain / .language` | 学术/公共数据项目，明确开放；TV 端点 `api/v2/tv/tv` 必须带 `station=` 参数（否则报错） |
| `bbc_rss` | BBC News RSS | rss | `https://feeds.bbci.co.uk/news/rss.xml` | none | en-GB | unknown | high | RSS `item/title`、`/link`、`/description`、`media:thumbnail` | 官方公开 RSS；仅订阅，勿全文再分发 |
| `nyt_rss` | NYT RSS | rss | `https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml` | none | en-US | unknown | medium-high | RSS + `media:*` 命名空间 | 官方公开 RSS；正文版权受限 |
| `sspai_rss` | 少数派 | rss | `https://sspai.com/feed` | none | zh-CN | unknown | medium | RSS `item/title`、`/link`、`/description` | 官方 RSS，仅摘要 |
| `solidot_rss` | 奇客 Solidot | rss | `https://www.solidot.org/index.rss` | none | zh-CN | unknown | medium-high | RSS `item/title`、`/link`、`/description` | 官方 RSS；CC 类授权，注意署名 |
| `people_rss` | 人民网时政 | rss | `http://www.people.com.cn/rss/politics.xml` | none | zh-CN | unknown | medium | RSS；**响应为 GBK 编码**（实测 UTF-8 解码乱码），需 `r.encoding='gbk'` | 公开 RSS；仅标题/摘要 |
| `xinhua_rss` | 新华网时政 | rss | `http://www.xinhuanet.com/politics/news_politics.xml` | none | zh-CN | unknown | medium | RSS `item/title`、`/link`、`/description`（实测 114KB 正常 UTF-8） | 公开 RSS；仅摘要 |
| `cnbeta_rss` | cnBeta | rss | `https://www.cnbeta.com.tw/backend.php` | none | zh-CN | unknown | medium | RSS `item/title`、`/link`、`/description` | 公开 RSS；转载内容版权归原站 |
| `reddit_rss` | Reddit 版块 RSS | rss | `https://www.reddit.com/r/{sub}/.rss`（搜索用 `https://www.reddit.com/search.rss?q={query}`，**需实测确认**） | none | en / global | unknown | medium | Atom：`entry/title`、`entry/link@href`、`entry/content` | **JSON 端点 `.json` 实测 403**，`.rss` 可用（63KB Atom）；Reddit 限制自动化，须低并发 |
| `lobsters_rss` | Lobsters RSS | rss | `https://lobste.rs/rss`、`https://lobste.rs/t/{tag}.rss` | none | en | unknown | medium | RSS `item/title`、`/link`、`/description` | 官方公开 feed，明确面向公共订阅 |

---

## 3. 百科 / 知识

| id | name | type | endpoint | auth | lang/region | rate_limit | reliability | parse_hint | tos_note |
|---|---|---|---|---|---|---|---|---|---|
| `wikipedia_api` | MediaWiki 搜索 API | json_api | `https://{lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch={query}&format=json&srlimit={n}` | none | 300+ 语种（实测 en 12KB / zh 3KB） | 实测 zh 端点偶发 **429**，需退避 | high | JSON：`query.search[].title`、`.snippet`（含 `<span class="searchmatch">`）、`.pageid`；拼 URL 用 `https://{lang}.wikipedia.org/wiki/{title}` | Wikimedia 官方 API，要求合理 UA 与限速；禁止高频批量 |
| `wikipedia_opensearch` | MediaWiki Opensearch | opensearch | `https://{lang}.wikipedia.org/w/api.php?action=opensearch&search={query}&limit={n}&format=json` | none | 多语种 | 同上 | high | JSON 四元数组 `[query, [titles], [descriptions], [urls]]`，适合做查询建议/实体补全 | 同 `wikipedia_api` |
| `wikipedia_rest` | Wikipedia REST 摘要 | json_api | `https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}` | none | 多语种 | 同上 | high | JSON：`.extract`、`.description`、`.content_urls` | 官方 REST；适合做结果富化（摘要卡片） |
| `wikidata_api` | Wikidata 实体搜索 | json_api | `https://www.wikidata.org/w/api.php?action=wbsearchentities&search={query}&language={lang}&format=json&limit={n}` | none | 多语种 | 同上 | high | JSON：`search[].id`（QID）、`.label`、`.description`、`.concepturi` | 官方 API；CC0 数据 |
| `wikidata_sparql` | Wikidata SPARQL | dataset_api | `https://query.wikidata.org/sparql?query={sparql}&format=json` | none | global | 官方建议带 `User-Agent`；重查询易超时 | high | JSON：`results.bindings[]`（SPARQL 1.1 JSON 标准） | 官方端点，要求标识性 UA；禁止大范围无界查询 |
| `dbpedia_lookup` | DBpedia Lookup | json_api | `https://lookup.dbpedia.org/api/search?query={query}&format=json` | none | en（多语种子集） | unknown | medium | JSON：`docs[].resource[]`、`.label[]`、`.redirectlabel[]`、`.refCount[]`（实测 106KB） | DBpedia 公共端点，学术用途；无 SLA |

---

## 4. 学术 / 文献

| id | name | type | endpoint | auth | lang/region | rate_limit | reliability | parse_hint | tos_note |
|---|---|---|---|---|---|---|---|---|---|
| `crossref` | Crossref Works | json_api | `https://api.crossref.org/works?query={query}&rows={n}` | none | global | 建议加 `mailto={email}` 进 polite pool | high | JSON：`message.items[]`，取 `.DOI`、`.title[]`、`.author[]`、`.issued` | 官方开放 API；强烈建议带 `mailto` 表明身份，勿滥用 |
| `openalex` | OpenAlex | json_api | `https://api.openalex.org/works?search={query}&per-page={n}` | none | global | 建议 `mailto=`；官方限 10 req/s（需实测确认） | high | JSON：`results[]`，取 `.doi`、`.title`、`.publication_year`、`.cited_by_count`；`meta.count` 为总数 | 官方开放数据（CC0）；带 `mailto` 进 polite pool |
| `pubmed_eutils` | NCBI E-utilities | json_api | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term={query}&retmode=json&retmax={n}` | none | en（生物医学） | 无 key 限 3 req/s（需实测确认）；建议加 `tool=`/`email=` | high | JSON：`esearchresult.idlist[]` 得 PMID，再调 `efetch.fcgi`/`esummary.fcgi` 取详情 | NCBI 官方；无 key 严格限速，超限封 IP |
| `europepmc` | Europe PMC | json_api | `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query={query}&format=json&pageSize={n}` | none | global（生命科学） | unknown | high | JSON：`resultList.result[]`，取 `.title`、`.doi`、`.pmid`、`.authorString`；支持 `cursorMark` 深翻页 | EMBL-EBI 官方；开放使用，需限速 |
| `doaj` | DOAJ Articles | json_api | `https://doaj.org/api/search/articles/{query}` | none | global（开放获取期刊） | unknown | medium-high | JSON：`results[].bibjson`，取 `.title`、`.identifier[]`、`.author[]`、`.year` | 官方开放 API；仅 OA 内容 |
| `hal` | HAL（法国开放存档） | json_api | `https://api.archives-ouvertes.fr/search/?q={query}&wt=json&rows={n}` | none | fr / en / 多语种 | unknown | medium-high | JSON：`response.docs[]`，取 `.title_s[]`、`.doiId_s`、`.uri_s` | 官方开放 API；学术用途 |
| `openaire` | OpenAIRE | json_api | `https://api.openaire.eu/search/publications?title={query}&format=json&size={n}` | none | global | unknown | medium | JSON（XML→JSON 映射）：`response.results.result[]`，字段名带 `$` 包装层 | 欧盟官方开放数据；结构较啰嗦 |
| `datacite` | DataCite DOIs | json_api | `https://api.datacite.org/dois?query={query}&page[size]={n}` | none | global（数据集/软件 DOI） | unknown | medium-high | JSON:API 风格：`data[].attributes`，取 `.doi`、`.titles`、`.creators` | 官方开放 API；CC0 元数据 |
| `core_anon` | CORE v3 | json_api | `https://api.core.ac.uk/v3/search/works?q={query}&limit={n}` | none | global（开放获取全文库） | unknown；**匿名可用已实测两次**（1.71M hits） | medium | JSON：`results[]`，取 `.title`、`.doi`、`.authors[].name`、`.downloadUrl` | 文档宣称需 API Key，但实测匿名可用；随时可能收紧，建议监控并限速 |
| `arxiv_api` | arXiv API | dataset_api | `http://export.arxiv.org/api/query?search_query=all:{query}&max_results={n}` | none | en（预印本） | **实测 429 "Rate exceeded."**，官方要求 ≥3s/次 | medium | Atom XML：`entry/title`、`entry/link@href`、`entry/summary`、`entry/published` | 官方 API，明确要求慢速轮询；务必节流+重试退避 |
| `unpaywall` | Unpaywall | json_api | `https://api.unpaywall.org/v2/{doi}?email={your_email}` | none | global | unknown | medium | JSON：`.is_oa`、`.best_oa_location.url_for_pdf` | **必须传真实邮箱**：实测假邮箱返回 422 并明确要求用本人邮箱；无 key 但强身份约束 |

---

## 5. 代码 / 技术社区

| id | name | type | endpoint | auth | lang/region | rate_limit | reliability | parse_hint | tos_note |
|---|---|---|---|---|---|---|---|---|---|
| `github_search` | GitHub 仓库搜索 | json_api | `https://api.github.com/search/repositories?q={query}&per_page={n}` | none | global | 匿名可用；官方文档约 10 req/min（精确值**需实测确认**） | high | JSON：`items[]`，取 `.full_name`、`.html_url`、`.description`、`.stargazers_count`、`.language` | GitHub 官方 API；匿名限额低，超限 403，建议缓存 1h |
| `gitlab_search` | GitLab 项目搜索 | json_api | `https://gitlab.com/api/v4/projects?search={query}&per_page={n}` | none | global | unknown，匿名受 IP 限流 | medium-high | JSON 数组：`[].path_with_namespace`、`.name`、`.description`、`.web_url`（实测 3KB） | GitLab 官方 API；匿名可用但限流，勿并发 |
| `stackexchange` | StackExchange API | json_api | `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q={query}&site={site}&pagesize={n}` | none | en（`site=stackoverflow` 等） | 匿名日配额 300（需实测确认）；响应带 `quota_remaining` | high | JSON：`items[]`，取 `.title`、`.link`、`.score`、`.is_answered`、`.tags[]`；注意响应 gzip | 官方 API；配额透明，超限需 key |
| `hn_algolia` | HN Search (Algolia) | json_api | `https://hn.algolia.com/api/v1/search?query={query}&hitsPerPage={n}`；按时间序用 `search_by_date` | none | en | unknown | high | JSON：`hits[]`，取 `.title`、`.url`、`.objectID`、`.points`、`.created_at`；评论跳 `news.ycombinator.com/item?id={objectID}` | Algolia 为 HN 提供的公共索引，长期免费开放 |
| `hn_firebase` | HN Firebase API | json_api | `https://hacker-news.firebaseio.com/v0/topstories.json`（再取 `.../v0/item/{id}.json`） | none | en | unknown | high | 顶层为 id 数组；item JSON 含 `.title`、`.url`、`.score`、`.by`、`.time` | 官方只读 API；无查询能力，仅榜单/条目拉取 |
| `lobsters_json` | Lobsters Feed JSON | json_api | `https://lobste.rs/hottest.json`、`https://lobste.rs/newest.json`、`https://lobste.rs/t/{tag}.json` | none | en | unknown | medium | JSON 数组：`[].short_id`、`.title`、`.url`、`.score`、`.tags[]`、`.created_at`（实测 11–18KB） | **无查询型搜索 API**：`/search.json?q=` 实测 400 "Unpermitted query or form parameter"，只能按榜单/标签拉取 |

---

## 6. 图书 / 数据集 / 通用工具

| id | name | type | endpoint | auth | lang/region | rate_limit | reliability | parse_hint | tos_note |
|---|---|---|---|---|---|---|---|---|---|
| `openlibrary` | OpenLibrary 搜索 | json_api | `https://openlibrary.org/search.json?q={query}&limit={n}` | none | global（图书元数据） | unknown | high | JSON：`docs[]`，取 `.title`、`.author_name[]`、`.first_publish_year`、`.key`（拼 `https://openlibrary.org{key}`） | Internet Archive 官方开放 API；元数据开放 |
| `internet_archive` | Internet Archive 高级搜索 | dataset_api | `https://archive.org/advancedsearch.php?q={query}&output=json&rows={n}` | none | global | unknown | medium-high | JSON：`response.docs[]`，取 `.identifier`、`.title`、`.mediatype`；`responseHeader` 含查询回显 | IA 官方 API；注意部分馆藏受版权限制 |
| `wayback_cdx` | Wayback CDX | dataset_api | `http://web.archive.org/cdx/search/cdx?url={url}&output=json&limit={n}` | none | global（网页历史） | unknown | high | JSON 二维数组，首行为表头：`urlkey,timestamp,original,mimetype,statuscode,digest,length` | IA 官方；适合做存证/历史快照，勿批量爬取 |
| `commoncrawl` | Common Crawl 索引 | dataset_api | `https://index.commoncrawl.org/{crawl-id}-index?url={url}&output=json`（如 `CC-MAIN-2024-10-index`） | none | global | unknown | medium | NDJSON（`text/x-ndjson`）：逐行 `{urlkey,timestamp,url,mime,status,digest,length,offset,filename}` | 官方开放数据；抓取正文需自行按 offset 取 WARC |
| `nominatim` | Nominatim (OSM) | json_api | `https://nominatim.openstreetmap.org/search?q={query}&format=json&limit={n}` | none | global（地理） | 官方 ≤1 req/s（需实测确认） | high | JSON 数组：`[].lat`、`.lon`、`.display_name`、`.osm_type`、`.osm_id` | OSM 官方；**必须带标识性 UA**，严格 1 req/s，禁止批量地理编码 |
| `openverse` | Openverse | json_api | `https://api.openverse.org/v1/images/?q={query}&page_size={n}` | none | global（CC 媒体） | 匿名有限额（精确值**需实测确认**） | medium | JSON：`results[]`，取 `.title`、`.url`、`.creator`、`.license`、`.foreign_landing_url` | WordPress 基金会开放 API；仅 CC 授权内容，需遵守署名 |
| `npm_search` | npm Registry 搜索 | json_api | `https://registry.npmjs.org/-/v1/search?text={query}&size={n}` | none | global（JS 包） | unknown | high | JSON：`objects[].package`，取 `.name`、`.version`、`.description`、`.links` | npm 官方 registry，公开只读 |
| `pypi_json` | PyPI JSON API | json_api | `https://pypi.org/pypi/{package}/json` | none | global（Python 包） | unknown | high | JSON：`.info`（summary/version/home_page）、`.releases` | PyPI 官方；按包名精确查，无全文搜索 |
| `crates_io` | crates.io 搜索 | json_api | `https://crates.io/api/v1/crates?q={query}&per_page={n}` | none | global（Rust 包） | unknown | medium-high | JSON：`crates[]`，取 `.name`、`.description`、`.max_version`、`.downloads` | crates.io 官方；要求标识性 UA |
| `devto` | DEV Community | json_api | `https://dev.to/api/articles?per_page={n}`（标签用 `&tag={tag}`） | none | en（技术博客） | unknown | medium | JSON 数组：`[].title`、`.url`、`.description`、`.tag_list`、`.published_at` | dev.to 官方公开 API；无关键词搜索参数（仅 tag/top），**查询能力需实测确认** |
| `searxng_registry` | searx.space 实例注册表 | dataset_api | `https://searx.space/data/instances.json` | none | global | unknown | high | JSON：`instances["https://x/"]`，含 `.http.status_code/.grade`、`.version`、`.timing.search.success_percentage`、`.network_type`；实测 92 个实例 | searx.space 为社区公共监控站点，用于**发现与健康筛选**，非搜索本身 |

---

## 7. 已实测**不可用**（省时间清单，别浪费配额）

| 目标 | 实测结果 | 结论 |
|---|---|---|
| Startpage（`/do/search`、`/sp/search`） | 302 → `/sp/captcha-block` | 反爬，不可程序化 |
| Mojeek（HTML） | **403** "your network appears to be sending automated queries" | 明确反自动化；`fmt=rss`/`fmt=json` 实测返回 HTML 而非 RSS/JSON |
| Mojeek 官方 API | 文档要求注册账号 + API key（`mojeek.com/support/api/search/quickstart.html`） | 有 key 才能用，非本任务范围 |
| Yandex（`yandex.com/search`） | 302 → `/showcaptcha` | 反爬 |
| Ecosia | **403** "Ecosia Firewall" | 反爬 |
| Qwant（页面 + `api.qwant.com/v3/search/web`） | 页面 200 但为 JS SPA；API **403** "enable JS and disable any ad blocker" | 不可用 |
| Presearch | 403 Cloudflare "Just a moment..." | 不可用 |
| Yep（页面 + `api.yep.com/fs/2/search`） | 403 Cloudflare | 不可用 |
| Stract（`stract.com`） | 首页 200 但无表单/API 链接；`/search`、`/search/`、`/web`、`/beta/search`、`/api/v1/search` 全部 **404** | 搜索入口未找到，需实测确认新路径 |
| Right Dao | **503 service unavailable**（两次） | 服务不可用 |
| Teclis | 400，要求 `cf-turnstile-response` 验证码 | 不可用 |
| Gigablast | SSL 握手失败；维基百科/rip.so 确认 2023-04 已下线 | **已停运** |
| 神马 `m.sm.cn`、夸克 `quark.sm.cn` | 返回 `_____tmd_____/punish` 反爬页 | 不可用 |
| 微博 `s.weibo.com` | "Sina Visitor System" | 需登录 |
| 知乎（`/search` 403；`api/v4/search_v3` 400） | 需签名/登录 | 不可用 |
| 百度 HTTPS / 百度新闻 / 百度学术 | "百度安全验证" | 仅 HTTP 首页入口可用（见 `baidu_http`） |
| 新浪搜索 `search.sina.com.cn` | 435B JS 空壳 | 不可用 |
| 豆瓣 `www.douban.com/j/search` | **403** `{"r":1,"code":403}` | 不可用 |
| Bing News RSS（`bing.com/news/search?format=rss`，含 `format=RSS`/`setmkt`/`FORM=EWRE` 变体） | 四种变体全部返回 **HTML**，非 RSS | 该 RSS 入口已失效 |
| Reddit `search.json` | **403** | 用 `.rss` 替代 |
| Google Books API | **429** "Quota exceeded ... per day"（匿名项目配额） | 匿名基本不可用，需 key |
| Semantic Scholar Graph API | **429** "apply for a key for higher rate limits" | 匿名基本不可用，需 key |
| Zenodo API | **403 Forbidden** | 需 access token |
| dblp（`dblp.org` 与 `dblp.uni-trier.de`） | 200 但为 **Anubis 反爬** "Making sure you're not a bot!" | 需工作量证明，不可直接调用 |
| GitHub Code Search | **401** "Requires authentication" | 需登录；Repositories 搜索匿名可用 |
| `api.marginalia.nu` | Read timeout | 需实测确认是否仍开放 |
| `rsshub.app`（公共实例） | 403 Cloudflare | 公共实例不可用，需自建 |
| 4get.ca API | **401** 缺 `pass` cookie | 需 cookie，不可用 |
| librey.org / search.albony.xyz | SSL 握手失败 | 不可用 |
| Reuters RSS | 404 | 该路径已失效 |
| 36kr `/feed`、机器之心 `/rss` | 返回 HTML 而非 RSS | 该路径非 feed |
| Lobsters `/search.json?q=` | 400 "Unpermitted query or form parameter" | 无查询 API |
| searx.be | Read timeout | 不稳定 |

---

## 8. SearXNG 公共实例清单

**注册表**：`https://searx.space/data/instances.json`（实测 200，92 个实例，含 HTTP 评分、版本、搜索成功率、`network_type`）——这是筛选实例的权威活数据，建议集成时每小时拉一次做健康排序。

**`format=json` 实测结论**：从注册表中筛出 76 个 `http.status_code==200` 且 `network_type==normal` 的实例，逐个**串行**（间隔 1.5s）请求 `/search?q=python+asyncio&format=json`：

| 类别 | 数量 | 说明 |
|---|---|---|
| ✅ **JSON 返回有效结果** | **2** | `https://search.mectov.my.id`（grade A+，成功率 100%，2026.9.11）、`https://sx.xo.st`（grade A+，成功率 100%，2026.9.13） |
| 返回 HTML（Bot 墙） | 13 | Anubis「Making sure you're not a bot!」、Cloudflare、Substation「Security check」、「Checking your browser…」 |
| 429 / 403 / 503 | 41 | 限流或封禁（串行 1.5s 间隔下仍如此） |
| 网络错误 | 2 | TLS 超时 / 读取超时 |

> 注：该轮扫描在进行到约 58/76 时被中断，但结论分布已很明确。**不要把公共实例当稳定 JSON 后端**。

**根因（已核实为设计行为）**：SearXNG 的 `format=json` 必须在实例 `settings.yml` 的 `search.formats` 中显式启用，否则**按设计返回 403**，不会回退（见官方 Search API 文档 `docs.searxng.org/dev/search_api.html`，以及 GitHub issue #5677 / discussion #3542）。因此「公共实例能开 JSON」是少数派。

**自建实例的相对优势**：
1. 可自行在 `search.formats` 打开 `json`，彻底摆脱 403；
2. 不受他人限流/Cloudflare/Anubis 影响，稳定性与延迟可控；
3. 可自选 engines 组合（含中文引擎），并对上游做统一限速与缓存；
4. 无第三方 ToS 风险，schema 固定为 SearXNG 版本对应的 JSON 结构（`results[].url/title/content/engine/score`），不会随实例改版漂移；
5. 可挂代理池规避单个出口 IP 被封。

**兜底策略建议**：公共实例只做「尽力而为」的第三层兜底，先探测 `format=json` 是否可用再入库；主力应为本清单第 1–6 节的直连 API/RSS。

---

## 9. 风险与合规

**明确反自动化 / 易被封（建议不集成或仅极低频）**
- **Mojeek**：403 文案直接点名「automated queries」——条款立场明确，不要绕过。
- **Startpage / Yandex / Ecosia / Presearch / Yep / Qwant**：验证码或 WAF 拦截，绕过属规避技术保护措施。
- **百度**：HTTPS 入口直接安全验证；HTTP 入口可用但极不稳定，建议默认关闭、仅作最后兜底，且 ≥6s/次。
- **DuckDuckGo**：`robots.txt` 明确禁止 `/html/` 与 `/lite/` 的自动化访问。技术上可 bootstrap 成功，但**合规上属灰色**——若用于产品化分发，应优先自建 SearXNG 或改用有明确授权的 API。
- **微博 / 知乎 / 豆瓣**：需登录或明确 403，跳过。
- **Reddit / dblp**：分别用 `.rss`、放弃；dblp 的 Anubis 是有意为之的机器人门槛，不要做 PoW 绕过。

**必须限速的源（实测或官方明确）**
| 源 | 建议 |
|---|---|
| arXiv | 实测 429；≥3s/次，指数退避 |
| Wikipedia / Wikimedia | 实测 zh 端点 429；串行 + 标识性 UA，批量用 `maxlag` |
| Bing 系列 | ≥1.5s/次；RSS 与 HTML 共用同一配额 |
| 搜狗 / 360 | ≥3s/次，配 cookie bootstrap，失败即熔断 |
| 百度 | ≥6s/次，默认降权 |
| Brave | 8s 仍 429；不建议纳入默认池 |
| GitHub / GitLab / StackExchange / Nominatim | 严格配额，必须缓存（1h–24h）；Nominatim 官方 1 req/s |
| NCBI E-utilities | 无 key 3 req/s 且超限封 IP |
| Crossref / OpenAlex | 一律带 `mailto=`，进 polite pool |
| Unpaywall | 必须真实邮箱，否则 422 |

**低并发使用建议**
1. **全局并发 2–4**，单域名同时只允许 **1 个在途请求**（per-host semaphore）。
2. 每域名设置最小间隔（通用 2s / 中文引擎 3–6s / Brave 8s）+ 随机抖动，避免固定节奏。
3. **分层缓存**：聚合结果 5–30 分钟；provider 级 15 分钟–7 天（学术类 3–7 天）；过期缓存作为 `stale=true` 兜底，避免硬打上游。
4. **熔断降级**：连续 3 次失败 → 冷却 5 分钟；HTTP 429/403 → 立即冷却并降权。
5. 始终发送**可识别且真实**的 `User-Agent`（含用途与联系方式），不要伪装成普通用户批量抓取。
6. 只存结果元数据（标题/URL/摘要），**不落地再分发正文全文**；抓正文仅用于本地阅读与摘要。
7. 遵守各站 `robots.txt` 与条款；对明确禁止自动化的源（Mojeek 等）**直接不集成**。
8. HTML 解析器必须配 fixture 回归测试——上游改版是必然事件，解析失败要能降级而不是报错。

---

## 10. 最该优先集成的 5 个

| 优先级 | 数据源 | 理由 |
|---|---|---|
| **1** | `bing_rss` — `https://www.bing.com/search?q={query}&format=rss` | 实测 200 且是**干净 XML**（4KB），零解析负担、零反爬成本、通用覆盖好。性价比最高的第一条腿。 |
| **2** | `ddg_html` — bootstrap + `POST https://html.duckduckgo.com/html/` | 实测 bootstrap 后稳定返回 **10 条真实结果**，`.result__a/.result__snippet` 选择器现成可用，通用网页覆盖最广。唯一注意：robots 层面属灰色，务必低并发 + 缓存。 |
| **3** | `gnews_search` — `https://news.google.com/rss/search?q={query}&hl=..&gl=..&ceid=..` | 实测 en/zh 双语均 200 且是标准 RSS（138KB/94KB），时效性最好，按 `hl/gl/ceid` 直接切中英文区，是新闻时效层的最佳单点。 |
| **4** | `wikipedia_api` + `wikidata_api` — MediaWiki 官方 API | 实测均 200 且 JSON 稳定、多语种、有官方 SLA 预期；百科/实体/定义类查询质量远超 SERP 摘要，且 `opensearch` 还能兼任查询补全。 |
| **5** | `openalex` + `crossref` — `api.openalex.org/works` / `api.crossref.org/works` | 两者实测 200 且 JSON 结构清晰（DOI/标题/年份/被引），完全免 key，学术检索一条腿补齐；加 `mailto` 即进 polite pool，合规成本极低。 |
| **中文补充（强烈建议一并集成）** | `sogou` + `so360` + `baidu_http` | 三大中文引擎实测 `sogou` 200/606KB、`so360` 200/354KB 均返回真实 SERP；`baidu_http` 仅 HTTP 入口可用（HTTPS 走安全验证）。三者互补 + 限速即可覆盖 zh-CN，无需依赖 Bing CN 单点。 |

> 取舍说明：Brave 质量虽好但实测 8s 间隔仍 429，会污染健康度统计，建议不进默认池；公共 SearXNG 实例仅 2/76 支持 `format=json`，只能当第三层兜底——**长期正解是自建一个开了 json 的 SearXNG 作为统一出口**。
