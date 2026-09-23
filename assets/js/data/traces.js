/* ============================================================
   实验室一 / 二共用的 Agent 定义与执行轨迹
   ------------------------------------------------------------
   两条轨迹都刻意选用 Agent 工程里最容易讲错的两件事：
     trace-1  正常多轮调用 —— 讲清「循环」「划痕板累积」「谁在执行工具」
     trace-2  工具报错后的自我修正 —— 讲清「校验必须由代码做」

   数据全部是预置的：这是纯静态站点，页面上不会真的去调模型。
   每一条 Observation 都标注了「由宿主程序产生」，而不是模型写的 ——
   这是 ReAct 里最常被理解错的一环。
   ============================================================ */

/** 这个 Agent 的工具集。实验室二会直接用它算「工具定义占多少预算」 */
export const TOOLS = [
  {
    name: 'get_order',
    description: '按订单号查询订单的状态、商品明细、金额与收货地址。只返回当前用户可见的字段。',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: '订单号，形如 A-2041' }
      },
      required: ['order_id']
    }
  },
  {
    name: 'get_shipment',
    description: '查询订单对应的物流轨迹，包含承运商、运单号与最近若干条节点事件。',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: '订单号，形如 A-2041' }
      },
      required: ['order_id']
    }
  },
  {
    name: 'calc_refund',
    description: '按平台退款规则计算某笔订单的可退金额。不做任何实际退款动作，只做试算。',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: '订单号，形如 A-2041' },
        reason: {
          type: 'string',
          enum: ['未收到货', '商品破损', '七天无理由', '拍错/不想要'],
          description: '申请退款的原因，必须是枚举值之一'
        }
      },
      required: ['order_id', 'reason']
    }
  },
  {
    name: 'list_orders',
    description: '列出某个用户指定时间范围内的订单。范围只接受固定的几档枚举值。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: '用户标识，形如 u-7781' },
        range: {
          type: 'string',
          enum: ['7d', '30d', '90d'],
          description: '时间范围档位，只接受 7d / 30d / 90d'
        }
      },
      required: ['user_id', 'range']
    }
  }
];

const SYSTEM_PROMPT = [
  '你是一个电商售后助理。你只能依据工具返回的事实回答，不得凭记忆推测订单状态、金额或时效。',
  '',
  '工作方式：',
  '1. 先判断还缺哪些事实，再用工具获取；不要一次把所有工具都调一遍。',
  '2. 每次只调用一个工具，拿到结果后再决定下一步。',
  '3. 工具返回错误时，读懂错误信息并修正参数重试；连续两次失败就如实告知用户。',
  '4. 事实齐备后直接给出结论，不要复述工具原始字段。',
  '',
  '回答要求：涉及金额必须给出具体数字；涉及时效必须给出时间范围；不要承诺规则之外的赔偿。'
].join('\n');

/* ============================================================
   轨迹一：正常的多轮调用
   ============================================================ */

const traceNormal = {
  id: 'trace-refund',
  title: '订单延误与退款咨询',
  badge: '正常路径',
  userMessage: '你好，我 9 月中旬下的单，订单号 A-2041。到现在还没收到，物流也不动了。如果我不想等了，能退多少钱？',
  systemPrompt: SYSTEM_PROMPT,
  tools: TOOLS,
  steps: [
    {
      kind: 'tool',
      modelOutput: [
        'Thought: 客户给了订单号 A-2041，但没说订单状态。我先查订单，确认它是否已发货、金额多少，再决定要不要看物流。',
        'Action: get_order',
        'Action Input: {"order_id": "A-2041"}'
      ].join('\n'),
      action: { name: 'get_order', args: { order_id: 'A-2041' } },
      observation: {
        order_id: 'A-2041',
        status: '已发货',
        amount: 328.0,
        currency: 'CNY',
        items: [
          { sku: 'KB-87', name: '机械键盘 87 键', qty: 1, price: 299.0 },
          { sku: 'MP-12', name: '加大鼠标垫', qty: 1, price: 29.0 }
        ],
        paid_at: '2026-09-14T10:22:31+08:00',
        address: '浙江省杭州市西湖区****'
      },
      note: '订单已发货、金额 328 元。下一步应该查物流 —— 但这一步模型并不知道物流卡在哪，所以还不能回答「什么时候到」。'
    },
    {
      kind: 'tool',
      modelOutput: [
        'Thought: 订单 9 月 14 日就发货了，客户到现在没收到。我缺的是「货走到哪了」，查物流轨迹。',
        'Action: get_shipment',
        'Action Input: {"order_id": "A-2041"}'
      ].join('\n'),
      action: { name: 'get_shipment', args: { order_id: 'A-2041' } },
      observation: {
        carrier: '顺丰速运',
        tracking_no: 'SF1234567890123',
        events: [
          { time: '2026-09-14 19:03', text: '杭州仓 已揽收' },
          { time: '2026-09-16 08:12', text: '杭州转运中心 已到达' },
          { time: '2026-09-18 09:41', text: '杭州转运中心 中转滞留，等待下次发运' }
        ],
        last_update: '2026-09-18 09:41',
        stale_days: 5
      },
      note: '物流在转运中心滞留 5 天。到这里模型才第一次知道「为什么不动的」—— 注意这个事实完全来自工具，不是模型推断出来的。'
    },
    {
      kind: 'tool',
      modelOutput: [
        'Thought: 物流异常原因清楚了。客户还问了「能退多少」，退款金额有平台规则，我不能凭记忆报价，用试算工具拿准确数字。',
        'Action: calc_refund',
        'Action Input: {"order_id": "A-2041", "reason": "未收到货"}'
      ].join('\n'),
      action: { name: 'calc_refund', args: { order_id: 'A-2041', reason: '未收到货' } },
      observation: {
        refundable: 328.0,
        shipping_fee: 0,
        rule: '未签收：全额退款（含运费）',
        need_return: false,
        eta: '3-5 个工作日'
      },
      note: '「能退多少钱」这个问题的答案只能来自规则引擎。让模型自己算，它会给你一个听起来很合理的错误数字。'
    },
    {
      kind: 'final',
      modelOutput: [
        'Thought: 事实齐了 —— 订单状态、物流异常原因、可退金额都有依据，可以作答。',
        'Final Answer: 您的订单 A-2041（机械键盘 + 加大鼠标垫，共 328.00 元）9 月 14 日已从杭州发出，顺丰单号 SF1234567890123。物流显示 9 月 18 日起在杭州转运中心滞留，此后 5 天没有新进展。如果不想继续等待，可以申请全额退款 328.00 元（尚未签收，含运费），无需寄回商品，预计 3~5 个工作日到账。需要我现在帮您提交退款申请吗？'
      ].join('\n'),
      answer: '您的订单 A-2041（机械键盘 + 加大鼠标垫，共 328.00 元）9 月 14 日已从杭州发出，顺丰单号 SF1234567890123。物流显示 9 月 18 日起在杭州转运中心滞留，此后 5 天没有新进展。如果不想继续等待，可以申请全额退款 328.00 元（尚未签收，含运费），无需寄回商品，预计 3~5 个工作日到账。需要我现在帮您提交退款申请吗？',
      note: '回答里的每个数字都能追溯到某一次工具返回。这正是「有依据」和「听起来对」的区别。'
    }
  ],
  takeaway: [
    '循环的终止条件是模型自己输出 Final Answer，而不是调用次数用尽。',
    'Observation 由宿主程序执行工具后写入，**不是模型生成的** —— 模型只提出调用请求。',
    '划痕板（Thought / Action / Observation）会随每轮对话不断累积，这是上下文膨胀的主要来源。'
  ]
};

/* ============================================================
   轨迹二：工具报错后的自我修正
   ============================================================ */

const traceRetry = {
  id: 'trace-retry',
  title: '参数非法与自我修正',
  badge: '错误恢复',
  userMessage: '帮我把 u-7781 最近 30 天的订单导一份出来。',
  systemPrompt: SYSTEM_PROMPT,
  tools: TOOLS,
  steps: [
    {
      kind: 'tool',
      modelOutput: [
        'Thought: 需要列出该用户近 30 天的订单。范围参数用 30days 应该比较直白。',
        'Action: list_orders',
        'Action Input: {"user_id": "u-7781", "range": "30days"}'
      ].join('\n'),
      action: { name: 'list_orders', args: { user_id: 'u-7781', range: '30days' } },
      observation: {
        error: 'invalid_argument',
        message: 'range 只接受 7d / 30d / 90d，收到 "30days"',
        allowed: ['7d', '30d', '90d'],
        hint: '请改用枚举值之一'
      },
      isError: true,
      note: '参数校验发生在代码里，错误以结构化形式返回。如果只靠提示词约束，模型编出 30days 这种值几乎是必然的 —— 而且没有任何东西会拦住它。'
    },
    {
      kind: 'tool',
      modelOutput: [
        'Thought: 参数写错了，工具明确告诉我合法值是 7d / 30d / 90d。改成 30d 重试，不需要问用户。',
        'Action: list_orders',
        'Action Input: {"user_id": "u-7781", "range": "30d"}'
      ].join('\n'),
      action: { name: 'list_orders', args: { user_id: 'u-7781', range: '30d' } },
      observation: {
        user_id: 'u-7781',
        range: '30d',
        count: 3,
        orders: [
          { order_id: 'A-2041', amount: 328.0, status: '已发货', paid_at: '2026-09-14' },
          { order_id: 'A-1975', amount: 89.0, status: '已完成', paid_at: '2026-09-03' },
          { order_id: 'A-1902', amount: 1299.0, status: '已完成', paid_at: '2026-08-28' }
        ]
      },
      note: '错误信息本身就是修复指令。这就是为什么错误要写得具体 —— 「参数错误」四个字对模型没用，「只接受 7d / 30d / 90d」它就能自己改对。'
    },
    {
      kind: 'final',
      modelOutput: [
        'Thought: 拿到 3 笔订单，信息足够，直接整理输出。',
        'Final Answer: u-7781 近 30 天共 3 笔订单：A-2041（328.00 元，已发货，09-14）、A-1975（89.00 元，已完成，09-03）、A-1902（1299.00 元，已完成，08-28）。合计 1716.00 元。需要我按金额或时间排序再导一次吗？'
      ].join('\n'),
      answer: 'u-7781 近 30 天共 3 笔订单：A-2041（328.00 元，已发货，09-14）、A-1975（89.00 元，已完成，09-03）、A-1902（1299.00 元，已完成，08-28）。合计 1716.00 元。需要我按金额或时间排序再导一次吗？',
      note: '整个恢复过程没有惊动用户 —— 一次参数错误被消化在循环内部。这是 ReAct 相比「一次生成」最实际的收益。'
    }
  ],
  takeaway: [
    '工具返回结构化错误，比抛异常或返回空值有用得多：模型需要「怎么改」而不只是「失败了」。',
    '修正发生在循环内部，用户无感 —— 这是多轮循环相对单次生成最实际的收益。',
    '就算加了校验，也要假设模型会出错：合法值列表同时出现在 schema 和错误信息里，双保险。'
  ]
};

export const TRACES = [traceNormal, traceRetry];

/** 轨迹一的系统提示词，实验室二也会用到 */
export const AGENT_SYSTEM_PROMPT = SYSTEM_PROMPT;
