"""
阶段一练习：手动 HTTP 请求调用 LLM API

目的：
1. 看清完整的 JSON 请求和响应结构，和笔记中的格式一一对应
2. 理解 API 无状态的本质——每次请求必须发送完整的对话历史
3. 理解多轮对话是靠代码维护 messages 列表实现的

使用前：
1. 配置环境变量 DEEPSEEK_API_KEY（DeepSeek 平台获取）
2. 安装依赖：uv add requests
3. 运行：uv run python 01_raw_request.py
"""

import os
import json
import requests


# ============================================================
# 配置
# ============================================================

# 从环境变量读取 API Key，不硬编码
API_KEY = os.getenv("DEEPSEEK_API_KEY")
if not API_KEY:
    raise RuntimeError(
        "未找到环境变量 DEEPSEEK_API_KEY，请先配置：\n"
        "  Windows PowerShell: $env:DEEPSEEK_API_KEY = 'sk-xxx'\n"
        "  或在系统环境变量中添加"
    )

# DeepSeek 兼容 OpenAI 格式，端点和 OpenAI 一样是 /chat/completions
BASE_URL = "https://api.deepseek.com"
ENDPOINT = f"{BASE_URL}/chat/completions"

# 请求头：认证 + 内容类型
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}


# ============================================================
# 单轮对话：最基本的一次请求
# ============================================================

def single_turn():
    """发送一次请求，展示完整的请求和响应 JSON"""

    print("=" * 60)
    print("单轮对话：一次请求，一次响应")
    print("=" * 60)

    # 构造请求体——和笔记中 OpenAI 格式的请求结构完全一致
    request_body = {
        "model": "deepseek-v4-flash",       # 选择模型
        "messages": [                    # 对话历史
            {
                "role": "system",        # 系统指令：告诉模型它是谁
                "content": "你是一个简洁的助手，回答控制在两句话以内。"
            },
            {
                "role": "user",          # 用户的输入
                "content": "什么是 API？"
            }
        ],
        "max_tokens": 200                # 限制回复长度
    }

    # 打印完整的请求 JSON，方便对照笔记
    print("\n>>> 发送的请求体：")
    print(json.dumps(request_body, indent=2, ensure_ascii=False))

    # 发送 HTTP POST 请求
    response = requests.post(ENDPOINT, headers=HEADERS, json=request_body)

    # 检查 HTTP 状态码
    if response.status_code != 200:
        print(f"\n请求失败，HTTP 状态码：{response.status_code}")
        print(response.text)
        return

    # 解析响应 JSON
    response_json = response.json()

    # 打印完整的响应 JSON——和笔记中 OpenAI 格式的响应结构一一对应
    print("\n<<< 收到的响应体：")
    print(json.dumps(response_json, indent=2, ensure_ascii=False))

    # 提取关键字段
    message = response_json["choices"][0]["message"]    # 模型的回复
    finish_reason = response_json["choices"][0]["finish_reason"]  # 停止原因
    usage = response_json["usage"]  # Token 用量

    print("\n--- 解析结果 ---")
    print(f"模型回复：{message['content']}")
    print(f"停止原因：{finish_reason}")
    print(f"Token 用量：输入 {usage['prompt_tokens']}，输出 {usage['completion_tokens']}，总计 {usage['total_tokens']}")


# ============================================================
# 多轮对话：手动维护 messages 列表
# ============================================================

def multi_turn():
    """
    多轮对话演示。

    核心认知：API 是无状态的。
    模型不记得之前说过什么，每次请求必须把完整的历史消息列表发过去。
    "多轮对话"完全靠你的代码维护 messages 列表来实现。
    """

    print("\n" + "=" * 60)
    print("多轮对话：代码维护 messages 列表")
    print("=" * 60)

    # 初始化对话历史，只有系统指令
    messages = [
        {
            "role": "system",
            "content": "你是一个简洁的技术助手，回答控制在两句话以内。"
        }
    ]

    # 预设的用户输入序列，模拟多轮对话
    user_inputs = [
        "什么是 Agent？",
        "它和普通 Chatbot 有什么区别？",     # 这个问题依赖上一轮的上下文
        "举个具体例子？",                    # 这个问题更依赖前面的上下文
    ]

    for i, user_input in enumerate(user_inputs, 1):
        print(f"\n--- 第 {i} 轮 ---")
        print(f"用户：{user_input}")

        # 步骤 1：将用户的新消息追加到历史列表
        messages.append({"role": "user", "content": user_input})

        # 步骤 2：将完整的历史列表发送给模型
        request_body = {
            "model": "deepseek-v4-flash",
            "messages": messages,          # 每次都发送完整历史
            "max_tokens": 300
        }

        # 打印当前发送了多少条消息，观察列表增长
        print(f"  [发送了 {len(messages)} 条消息给模型]")

        response = requests.post(ENDPOINT, headers=HEADERS, json=request_body)

        if response.status_code != 200:
            print(f"  请求失败：{response.status_code} {response.text}")
            return

        response_json = response.json()

        # 提取模型回复
        assistant_message = response_json["choices"][0]["message"]
        usage = response_json["usage"]

        print(f"助手：{assistant_message['content']}")
        print(f"  [Token 用量：输入 {usage['prompt_tokens']}，输出 {usage['completion_tokens']}]")

        # 步骤 3：将模型的回复也追加到历史列表
        # 这样下一轮请求时，模型就能"看到"自己之前说过什么
        messages.append(assistant_message)

    # 对话结束后，打印最终的完整 messages 列表
    print("\n--- 最终的 messages 列表（共 {} 条）---".format(len(messages)))
    for msg in messages:
        role = msg["role"]
        content = msg["content"][:50] + "..." if len(msg["content"]) > 50 else msg["content"]
        print(f"  [{role}] {content}")

    print("\n关键观察：")
    print("1. 每一轮的 prompt_tokens 都在增长——因为每次都要发送完整历史")
    print("2. 模型能'记住'之前的对话——不是因为它有记忆，而是你把历史都发过去了")
    print("3. 这就是为什么长对话会越来越贵、越来越慢")


# ============================================================
# 入口
# ============================================================

if __name__ == "__main__":
    print("LLM API 手动请求练习")
    print(f"端点：{ENDPOINT}")
    print(f"API Key：{API_KEY[:8]}...（已隐藏）")

    # 先运行单轮对话
    single_turn()

    # 再运行多轮对话
    multi_turn()
