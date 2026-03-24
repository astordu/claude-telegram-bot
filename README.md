# 口袋里的codex、claude

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bun](https://img.shields.io/badge/Bun-1.0+-black.svg)](https://bun.sh/)

**通过 Telegram，随时随地调用 Claude Code 和 Codex CLI，打造你的口袋 AI 助手。**

![Demo](assets/yanshi.gif)

** 看不清, 可以看视频教程: ** https://www.bilibili.com/video/BV1LLQqBbEqV/?vd_source=9e67f3c6b2536721700cabd17dcc4170

---

## 关于作者 - 雷哥

- 各个视频媒体号: 雷哥AI
- 🌐 网站：[leigeai.com](https://leigeai.com/)
- 💬 微信：`leigeaicom`
- 🏘️ 社群：[知识星球 · 探索使用AI通向自由之路](https://wx.zsxq.com/group/28882285418421)



---
## 快速启动

### 1. 创建 Bot

1. 在 Telegram 打开 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot` 并按提示操作
3. ... (看我的演示视频就可以)


### 2. 配置内容

启动程序后, 填写配置就可以:
就两个配置:
bot token 和 你自己的userid (看我的演示视频就可以)

### 3. 绑定工作区

启动 Bot 后，创建群组, 把bot拉入进来,然后把你本地的目录把你本地的目录绑定上:

```
/bind /你的项目路径
```

### 可以使用了

直接使用就可以在telegram上和claude/codex对话了。

---

## Bot 命令

| 命令 | 说明 |
| --- | --- |
| `/new` | 开始新会话 |
| `/bind <路径>` | 将当前会话绑定到工作区目录（管理员专用） |



## License

MIT

---

## 致谢

本项目 fork 自 [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot)，一个将 Claude Code 与 Telegram 连接起来的优秀开源项目。非常感谢原作者及所有贡献者打下的坚实基础——核心消息处理、流式输出、语音转录、MCP 工具集成和个人助手模式均源自上游项目。

原项目是使用claude sdk的，但是我给他改成了全都使用CLI，更方便的无缝的集成到我们自己电脑的。AI coding agent。 