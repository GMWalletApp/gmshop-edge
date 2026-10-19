# 代理管理（GMShop → agent-shop）

老板在 `/admin/agents` 查看代理销售、已交开通费、返还、排行榜审核和待打款。
仅启用的 `root` / `admin` 用户可用，读取需 `operations:read`，修改还需
`operations:update`。界面和代理中心读取同一份上游规则，不另写一套规则。
新增内部利润口径：显示「我们赚了」，而非代理加价利润；每档同时核对拿货门槛和我们利润是否覆盖累计返还。

## 密钥与操作边界

Worker secret 名为 **`AGENT_SHOP_PROGRAM_TOKEN`**，对应 agent-shop 的
`reseller.program.internal_api_token`。仅服务端请求固定地址
`https://lsrai.shop/api/internal/reseller-program/`，缺失密钥时拒绝请求。
Bun 运行时支持同名注入。密钥只通过 Agent Switch 及部署环境的密钥注入流程配置，
不写 Wrangler vars、项目 `.env`、文档、源码或日志。本次不配真实密钥、不部署。

修改已交开通费必须填原因，操作者由服务端按登录用户生成
`gmshop:<用户 id>`，上游审计记录旧值、新值、操作者和原因。
「记录已打款」必须填支付宝交易号；请先核对实际转账，它只登记结果，不发起转账。
商城新分站订单履约发送订单真实 `paid_minor` 对应的精确小数字符串 `paidAmount`，
不以当前标价替代实付金额，API 代理订单不写开通费。

## 验证与回滚

运行代理管理相关安全/UI 测试、代理开通集成测试、类型检查和 Worker 构建。
不做真实支付、邮件、Telegram 测试。撤销本 PR 即可移除入口和调用，无 GMShop
数据库迁移；保留未使用的 Worker secret 也不影响旧版运行。


## 2026-10-18 追加批准

- 返还从 **2026-10-19 00:00 北京时间** 与开通时间较晚者计 90 天，保留 7 天补发宽限；新订单必须仍在原窗口内。月度销售与月榜不改（首月月榜保留 10 月 18 日起）。达门槛但利润不够显示「已达门槛，等利润覆盖」及差额，自动每日重查。
- 配套返还专用 SMTP 20 秒拨号/整连接期限，卡住也不中断后续代理，其他邮件通道保持原默认。
- 返还入账邮件默认开启，仅发已入账代理，专用 no-reply@lsrai.shop 通道；发送失败不回滚/阻塞入账，重复任务不再发同一笔邮件；不承诺进程崩溃情况下邮件必达。
- 代理端不暴露我们利润/缺口/成本原因，仅追加「返还以实际结算为准，达标后自动到账」。

### 只读利润接口

`POST /api/internal/agent-program/order-profit`，body 为 `{downstream_order_nos: [...]}`，0–500 个本地下游单号（空数组只读健康检查）；D1 内部再分批避免绑定参数超限。bearer Worker secret **`AGENT_PROGRAM_PROFIT_TOKEN`**（Bun 同名绑定）与 agent-shop 环境变量 **`RESELLER_PROGRAM_PROFIT_API_TOKEN`** 配对。缺失即401，hash恒时比较，返回 no-store；只声明名称，不配置/读取真实值。

精确映射：lsrai `orders.id`（父单若拆分则取 `orders.parent_id` 下叶子子单）→ `procurement_orders.local_order_id`；`connection_id → site_connections.id` 识别 GMShop。传 `procurement_orders.local_order_no = orders.order_no`，查询本端 `supplier_api_orders.downstream_order_no → shop_order_id → shop_orders.id → shop_order_items.order_id`。调用方再验返回 `supplier_api_order_id = procurement_orders.upstream_order_no`（即 `supplier_api_orders.id`，供应商 API UUID；不同于用于成本关联的 `shop_orders.id`；也不是本地数字 external reference ID）。跨账号同名下游单不合并，视为映射不明。

每单返回 `revenue_minor/true_cost_minor/profit_minor` 整数十进制字符串及 `cost_known`。收入取已付 `shop_orders.paid_minor`；商品成本复用经营周报 `itemCostSql`：优先已 supplied 的供应商订单总成本（缺失才回退商品快照），否则取已分配 reserved/delivered 库存成本合计（无成本才回退商品快照）。快照为单价 × quantity，实际总成本不再乘数量。复用 pricing guard 的因子解析及 `realCostMinor`，将成本合计乘 `pricing.cost_factors` 中对应供应商因子 × 固定 1.01，再向上取分。供应商取已履约 `stock_entries.procurement_source`，并补充已供货 `supplier_orders.binding_snapshot_json.normalizedApiOrigin` 的爱搜来源；无法确定用最高因子。零/缺成本、无项、无单、歧义或非 CNY/两位币种均返回利润0占位并标未知，agent-shop 必须按该计数订单净收入全额亏损计，真实亏损保留负数。本接口不写数据、不采购、不发通知、不新增定时器。

agent-shop 只扣父子单退款对应的平台收入，不缩减全部已发生成本；利润契约未暴露已确认供应商成本回收，因此不假设回收。未知成本或映射缺失计数单按净收入全损计；先读完整轮所有批次再入账（纯本地订单也做空批次健康检查）。缺 token、API 故障或返回不完整整轮零返还；持久日claim保证老板通知每天一次，入队失败可重试。内部 agents/detail 提供 `our_profit_in_window`（故障为null）、各档 `guard_state/profit_gap` 和未知订单ID/原因、`unknown_profit_order_count`、`unknown_profit_assumed_loss`（假定亏损正金额），在「我们赚了」旁展示。

本轮仅本地迁移后的 D1/SQLite、synthetic HTTP、fake mailer 验证；未访问生产、未枚举真实不可映射订单、未做线上联合/邮件验证。GMShop无迁移；agent-shop沿用AutoMigrate新增小型每日通知防重表。

管理 API 传输使用 `redirect: "manual"`，所有 3xx/非2xx 均失败，不转发凭据至重定向目标。代理 overview 无 reseller profile 即 403，在计算排名之前拒绝；仅返回本人排名/金额，不返回第三名差额。老板内部榜单保持不变。


## 老板面板明细

完整邮箱和支付宝账户仅在内部 owner API 和 root/admin 面板显示，代理端 API 不变。
域名在表格称呼下紧凑展示、详情完整列出，包含全部绑定域名、二级/独立类型及状态。

表格「我们赚了」改用 `our_profit_month`，详情增加本月/上月
`our_profit_month/our_profit_last_month`。月份与销售选择器一致，按北京时间已付款父单
及快照统计，包含未交付、全额退款单，不含代理主站自购。收入减退款收入，再减全部
已发生成本；未知成本或映射按净收入全损计，并标单数。所有代理、月份、返还窗口
合并去重查成本，每批不超 500；失败显示「暂时取不到」而不是 0。
不增加全历史成本扫描，详情仅本月和上月。原 `our_profit_in_window` 仍在返还区
显示「返还期内我们赚了」，档位风控未变。

待打款显示完整账户、代理称呼/邮箱、北京时间申请日期及时间。同一代理的多笔申请
可逐笔填写同一支付宝交易号，保留原有 pending 锁、会话 operator、审计及幂等；
不会实际发起付款。需配套 agent-shop 新接口（email、payout_alipay_account、
结构化 domains、两个月利润及提现 account/email）。本轮未部署、读生产、付款或发送。

## 老板读取时效

代理、榜单、待提现、规则四个查询并行；SSR 预取只等待代理列表，标签内容打开才挂载。
后台刷新保留原结果，标明实际显示月份、北京时间快照时间和「更新中」；「刷新」绕过
Worker 缓存。客户端数据 60 秒内视为新鲜，内存保留 30 分钟，不写本地持久存储。

每次服务端读取仍先检查 owner/admin 权限。列表、详情、榜单、规则复用现有 KV/runtime
缓存，最长 60 秒；提现列表及修改响应不缓存。键包含端点、查询、凭据作用域与 D1
权威版本。修改开通费、审核榜单、记录打款均轮换版本；修改未结束时绕过缓存，旧请求
晚回填也不能复活修改前版本。缓存故障直接读源站；最终版本写入失败或修改进程中断时，
宁可停用缓存也不信任过期金额，不新增财务自动重试。

agent-shop 另按单号缓存已交付/完成且已知成本的 GMShop 利润 5 分钟，上限 10,000 单；
Worker「刷新」不绕过此成本缓存，但本地退款每次重算，返还任务始终实时查利润。
端点计时日志只包含路由模板及 `duration_ms` 等元数据，不含凭据、查询值、客户资料或金额正文。
