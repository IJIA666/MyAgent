"""
阶段一练习：用 OpenAI SDK 调用 DeepSeek API

目的：
1. 对比手动 requests 版本（01_raw_request.py），理解 SDK 封装了什么
2. 体会 SDK 在类型提示、错误处理、代码简洁性上的优势
3. 代码逻辑完全一致，只是调用方式不同——底层发的 JSON 是一样的

使用前：
1. 安装依赖：uv add openai
2. 配置环境变量 DEEPSEEK_API_KEY
3. 运行：uv run python 02_sdk_request.py
"""

import os
from openai import OpenAI


# ============================================================
# 配置
# ============================================================

API_KEY = os.getenv("DEEPSEEK_API_KEY")
if not API_KEY:
    raise RuntimeError("未找到环境变量 DEEPSEEK_API_KEY")

# SDK 封装点 1：不需要手动拼 headers 和 URL，初始化客户端即可
# 只需改 base_url，就能用同一个 SDK 调用 DeepSeek、Ollama、OpenRouter 等
client = OpenAI(
    api_key=API_KEY,
    base_url="https://api.deepseek.com"
)


# ============================================================
# 单轮对话
# ============================================================

def single_turn():
    print("=" * 60)
    print("单轮对话（SDK 版本）")
    print("=" * 60)

    # SDK 封装点 2：不需要手动构造 JSON 和发 HTTP 请求
    # 方法名直接对应 API 端点：chat.completions.create → POST /chat/completions
    response = client.chat.completions.create(
        model="deepseek-v4-flash",
        messages=[
            {"role": "system", "content": "你是一个简洁的助手，回答控制在两句话以内。"},
            {"role": "user", "content": "什么是 API？"}
        ],
        max_tokens=200
    )

    # SDK 封装点 3：响应是对象而非 dict
    # 手动版：response_json["choices"][0]["message"]["content"]
    # SDK 版：response.choices[0].message.content
    # IDE 可以自动补全，写错字段名会有提示
    choice = response.choices[0]

    print(f"\n模型回复：{choice.message.content}")
    print(f"停止原因：{choice.finish_reason}")
    print(f"Token 用量：输入 {response.usage.prompt_tokens}，"
          f"输出 {response.usage.completion_tokens}，"
          f"总计 {response.usage.total_tokens}")


# ============================================================
# 多轮对话
# ============================================================

def multi_turn():
    """
    和手动版的逻辑完全一致：
    1. 维护 messages 列表
    2. 每轮追加用户输入
    3. 发送完整历史
    4. 追加模型回复
    唯一的区别是调用方式更简洁。
    """

    print("\n" + "=" * 60)
    print("多轮对话（SDK 版本）")
    print("=" * 60)

    messages = [
        {"role": "system", "content": "你是一个简洁的技术助手，回答控制在两句话以内。"}
    ]

    user_inputs = [
        "什么是 Agent？",
        "它和普通 Chatbot 有什么区别？",
        "举个具体例子？",
    ]

    for i, user_input in enumerate(user_inputs, 1):
        print(f"\n--- 第 {i} 轮 ---")
        print(f"用户：{user_input}")

        # 追加用户消息
        messages.append({"role": "user", "content": user_input})

        # SDK 调用——和单轮一样，只是 messages 列表更长了
        response = client.chat.completions.create(
            model="deepseek-v4-flash",
            messages=messages,
            max_tokens=300
        )

        assistant_message = response.choices[0].message

        print(f"助手：{assistant_message.content}")
        print(f"  [消息数: {len(messages)} | "
              f"Token: 输入 {response.usage.prompt_tokens}, "
              f"输出 {response.usage.completion_tokens}]")

        # SDK 封装点 4：追加回复时需要转成 dict
        # SDK 返回的是对象，messages 列表需要 dict 格式
        messages.append({
            "role": assistant_message.role,
            "content": assistant_message.content
        })

    # 打印最终历史
    print(f"\n--- 最终 messages 列表（共 {len(messages)} 条）---")
    for msg in messages:
        content = msg["content"][:50] + "..." if len(msg["content"]) > 50 else msg["content"]
        print(f"  [{msg['role']}] {content}")


# ============================================================
# SDK vs 手动请求 对比总结
# ============================================================

def print_comparison():
    print("\n" + "=" * 60)
    print("SDK vs 手动请求 对比")
    print("=" * 60)
    print("""
┌──────────────┬──────────────────────┬──────────────────────┐
│     维度     │     手动 requests    │      OpenAI SDK      │
├──────────────┼──────────────────────┼──────────────────────┤
│ 认证         │ 手动拼 Authorization │ 传入 api_key 即可    │
│ 请求构造     │ 手动构造 JSON        │ 方法参数直接传       │
│ 响应解析     │ dict，靠字符串索引   │ 对象，IDE 自动补全   │
│ 错误处理     │ 自己判断 HTTP 状态码 │ 抛出具体异常类型     │
│ 重试机制     │ 无                   │ 内置指数退避         │
│ 流式响应     │ 自己解析 SSE         │ stream=True 直接迭代 │
│ 底层本质     │ 这就是底层           │ 封装了左边这些       │
└──────────────┴──────────────────────┴──────────────────────┘

结论：SDK 不改变 API 的本质，只是让调用更方便。
底层发出的 JSON 请求和收到的 JSON 响应，和手动版完全一样。
""")


# ============================================================
# 入口
# ============================================================

if __name__ == "__main__":
    print("LLM API SDK 调用练习")
    print(f"API Key：{API_KEY[:8]}...（已隐藏）\n")

    single_turn()
    multi_turn()
    print_comparison()
