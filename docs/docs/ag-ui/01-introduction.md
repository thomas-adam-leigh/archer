---
url: https://docs.ag-ui.com/introduction
---

# The Agent–User Interaction (AG-UI) Protocol

AG-UI is an **open**, **lightweight**, **event-based** protocol that standardizes how AI agents connect to user-facing applications.

AG-UI is designed to be the general-purpose, bi-directional connection between a user-facing application and any agentic backend.

Built for simplicity and flexibility, it standardizes how agent state, UI intents, and user interactions flow between your model/agent runtime and user-facing frontend applications—to allow application developers to ship reliable, debuggable, user‑friendly agentic features fast while focusing on application needs and avoiding complex ad-hoc wiring.

***

## Agentic Protocols

> **Note:** **Confused about "A2UI" and "AG-UI"?** That's understandable! Despite the naming similarities, they are quite different and work well together. A2UI is a [generative UI specification](./concepts/generative-ui-specs) - allowing agents to deliver UI widgets, where AG-UI is the Agent↔User Interaction protocol - which connects an agentic frontend to any agentic backend. [Learn more](https://copilotkit.ai/ag-ui-and-a2ui)

AG-UI is one of three prominent open [agentic protocols](./agentic-protocols).

| **Layer**                    | **Protocol / Example**                           | **Purpose**                                                                                                                                |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Agent ↔ User Interaction** | **AG-UI (Agent–User Interaction Protocol)** | The open, event-based standard that connects agents to user-facing applications — enabling real-time, multimodal, interactive experiences. |
| **Agent ↔ Tools & Data**     | **MCP  (Model Context Protocol)**           | Open standard (originated by Anthropic) that lets agents securely connect to external systems — tools, workflows, and data sources.        |
| **Agent ↔ Agent**            | **A2A (Agent to Agent)**                    | Open standard (originated by Google) which defines how agents coordinate and share work across distributed agentic systems.                |

***

## Building blocks (today & upcoming)

- **Streaming chat** — Live token and event streaming for responsive multi turn sessions, with cancel and resume.
- **Multimodality** — Typed attachments and real time media (files, images, audio, transcripts); supports voice, previews, annotations, provenance.
- **Generative UI, static** — Render model output as stable, typed components under app control.
- **Generative UI, declarative** — Small declarative language for constrained yet open-ended agent UIs; agents propose trees and constraints, the app validates and mounts.
- **Shared state** — (Read-only & read-write). Typed store shared between agent and app, with streamed event-sourced diffs and conflict resolution for snappy collaboration.
- **Thinking steps** — Visualize intermediate reasoning from traces and tool events; no raw chain of thought.
- **Frontend tool calls** — Typed handoffs from agent to frontend-executed actions, and back.
- **Backend tool rendering** — Visualize backend tool outputs in app and chat, emit side effects as first-class events.
- **Interrupts (human in the loop)** — Pause, approve, edit, retry, or escalate mid flow without losing state.
- **Sub-agents and composition** — Nested delegation with scoped state, tracing, and cancellation.
- **Agent steering** — Dynamically redirect agent execution with real-time user input to guide behavior and outcomes.
- **Tool output streaming** — Stream tool results and logs so UIs can render long-running effects in real time.
- **Custom events** — Open-ended data exchange for needs not covered by the protocol.

***

## Why Agentic Apps need AG-UI

Agentic applications break the simple request/response model that dominated frontend-backend development in the pre-agentic era: a client makes a request, the server returns data, the client renders it, and the interaction ends.

#### The requirements of user‑facing agents

While agents are just software, they exhibit characteristics that make them challenging to serve behind traditional REST/GraphQL APIs:

* Agents are **long‑running** and **stream** intermediate work—often across multi‑turn sessions.
* Agents are **nondeterministic** and can **control application UI nondeterministically**.
* Agents simultanously mix **structured + unstructured IO** (e.g. text & voice, alongside tool calls and state updates).
* Agents need user-interactive **composition**: e.g. they may call sub‑agents, often recursively.
* And more...

AG-UI is an event-based protocol that enables dynamic communication between agentic frontends and backends. It builds on top of the foundational protocols of the web (HTTP, WebSockets) as an abstraction layer designed for the agentic age—bridging the gap between traditional client-server architectures and the dynamic, stateful nature of AI agents.

***

## AG-UI in Action

> **Info:** You can see demo apps of the AG-UI features with the framework of your choice, with preview, code, and walkthrough docs in the [AG-UI Dojo](https://dojo.ag-ui.com/)

***

## Supported Integrations

AG-UI was born from CopilotKit's initial **partnership** with LangGraph and CrewAI - and brings the incredibly popular agent-user-interactivity infrastructure to the wider agentic ecosystem.

**1st party** = the platforms that have AG‑UI built in and provide documentation for guidance.

### Direct to LLM

| Framework     | Status    | AG-UI Resources                                  |
| :------------ | --------- | ------------------------------------------------ |
| Direct to LLM | Supported | [Docs](https://docs.copilotkit.ai/direct-to-llm) |

### Agent Framework - Partnerships

| Framework                                        | Status    | AG-UI Resources                                                                                                       |
| :----------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| [LangGraph](https://www.langchain.com/langgraph) | Supported | [Docs](https://docs.copilotkit.ai/langgraph/), [Demos](https://dojo.ag-ui.com/langgraph-fastapi/feature/shared_state) |
| [CrewAI](https://crewai.com/)                    | Supported | [Docs](https://docs.copilotkit.ai/crewai-flows), [Demos](https://dojo.ag-ui.com/crewai/feature/shared_state)          |

### Agent Framework - 1st Party

| Framework                                                                                                                  | Status      | AG-UI Resources                                                                                                                                     |
| :------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Microsoft Agent Framework](https://azure.microsoft.com/en-us/blog/introducing-microsoft-agent-framework/)                 | Supported   | [Docs](https://docs.copilotkit.ai/microsoft-agent-framework), [Demos](https://dojo.ag-ui.com/microsoft-agent-framework-dotnet/feature/shared_state) |
| [Google ADK](https://google.github.io/adk-docs/get-started/)                                                               | Supported   | [Docs](https://docs.copilotkit.ai/adk), [Demos](https://dojo.ag-ui.com/adk-middleware/feature/shared_state?openCopilot=true)                        |
| [AWS Strands Agents](https://github.com/strands-agents/sdk-python)                                                         | Supported   | [Docs](https://docs.copilotkit.ai/aws-strands), [Demos](https://dojo.ag-ui.com/aws-strands/feature/shared_state)                                    |
| [AWS Bedrock AgentCore](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui-protocol-contract.html) | Supported   | [Docs](https://github.com/awslabs/fullstack-solution-template-for-agentcore)                                                                        |
| [Mastra](https://mastra.ai/)                                                                                               | Supported   | [Docs](https://docs.copilotkit.ai/mastra/), [Demos](https://dojo.ag-ui.com/mastra/feature/tool_based_generative_ui)                                 |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai)                                                                     | Supported   | [Docs](https://docs.copilotkit.ai/pydantic-ai/), [Demos](https://dojo.ag-ui.com/pydantic-ai/feature/shared_state)                                   |
| [Agno](https://github.com/agno-agi/agno)                                                                                   | Supported   | [Docs](https://docs.copilotkit.ai/agno/), [Demos](https://dojo.ag-ui.com/agno/feature/tool_based_generative_ui)                                     |
| [LlamaIndex](https://github.com/run-llama/llama_index)                                                                     | Supported   | [Docs](https://docs.copilotkit.ai/llamaindex/), [Demos](https://dojo.ag-ui.com/llamaindex/feature/shared_state)                                     |
| [AG2](https://ag2.ai/)                                                                                                     | Supported   | [Docs](https://docs.copilotkit.ai/ag2/) [Demos](https://dojo.ag-ui.com/ag2/feature/shared_state)                                                    |
| [AWS Bedrock Agents](https://aws.amazon.com/bedrock/agents/)                                                               | In Progress | –                                                                                                                                                   |

### Agent Framework - Community

| Framework                                                          | Status      | AG-UI Resources |
| :----------------------------------------------------------------- | ----------- | --------------- |
| [OpenAI Agent SDK](https://openai.github.io/openai-agents-python/) | In Progress | –               |
| [Cloudflare Agents](https://developers.cloudflare.com/agents/)     | In Progress | –               |

### Agent Interaction Protocols

| Protocol                                    | Status    | AG-UI Resources                                 | Integrations |
| :------------------------------------------ | --------- | ----------------------------------------------- | ------------ |
| [A2A Middleware](https://a2a-protocol.org/) | Supported | [Docs](https://docs.copilotkit.ai/a2a-protocol) | Partnership  |

### Infrastructure / Deployment

| Platform                                                              | Status    | AG-UI Resources                                                                         | Integrations |
| :-------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------- | ------------ |
| [Amazon Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/) | Supported | [Docs](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html) | 1st Party    |

### Specification (standard)

| Framework                                                | Status    | AG-UI Resources                                                                                                                                |
| :------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [Oracle Agent Spec](http://oracle.github.io/agent-spec/) | Supported | [Docs](https://go.copilotkit.ai/copilotkit-oracle-docs), [Demos](https://dojo.ag-ui.com/agent-spec-langgraph/feature/tool_based_generative_ui) |

### SDKs

| SDK          | Status      | AG-UI Resources                                                                                              | Integrations |
| :----------- | ----------- | ------------------------------------------------------------------------------------------------------------ | ------------ |
| [Kotlin]()   | Supported   | [Getting Started](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/sdk/kotlin/overview.mdx)            | Community    |
| [Golang]()   | Supported   | [Getting Started](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/sdk/go/overview.mdx)                | Community    |
| [Dart]()     | Supported   | [Getting Started](https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/community/dart)                     | Community    |
| [Java]()     | Supported   | [Getting Started](https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/sdk/java/overview.mdx)              | Community    |
| [Rust]()     | Supported   | [Getting Started](https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/community/rust/crates/ag-ui-client) | Community    |
| [.NET]()     | In Progress | [PR](https://github.com/ag-ui-protocol/ag-ui/pull/38)                                                        | Community    |
| [Nim]()      | In Progress | [PR](https://github.com/ag-ui-protocol/ag-ui/pull/29)                                                        | Community    |
| [Flowise]()  | In Progress | [GitHub Source](https://github.com/ag-ui-protocol/ag-ui/issues/367)                                          | Community    |
| [Langflow]() | In Progress | [GitHub Source](https://github.com/ag-ui-protocol/ag-ui/issues/366)                                          | Community    |

### Clients

| Client                                                 | Status      | AG-UI Resources                                                               | Integrations |
| :----------------------------------------------------- | ----------- | ----------------------------------------------------------------------------- | ------------ |
| [CopilotKit](https://github.com/CopilotKit/CopilotKit) | Supported   | [Getting Started](https://docs.copilotkit.ai/direct-to-llm/guides/quickstart) | 1st Party    |
| [Terminal + Agent]()                                   | Supported   | [Getting Started](https://docs.ag-ui.com/quickstart/clients)                  | Community    |
| [React Native](https://reactnative.dev/)               | Help Wanted | [GitHub Source](https://github.com/ag-ui-protocol/ag-ui/issues/510)           | Community    |

***

## Quick Start

Choose the path that fits your needs:

- [Build agentic applications](/quickstart/applications) — Build agentic applications powered by AG-UI compatible agents.

- [Build new AG-UI integrations](/quickstart/introduction) — Build integrations for new agent frameworks, custom in-house solutions, or use AG-UI without any agent framework.

- [Build AG-UI compatible clients](/quickstart/clients) — Build new clients for AG-UI-compatible agents (web, mobile, slack, messaging, etc.)

## Explore AG-UI

Dive deeper into AG-UI's core concepts and capabilities:

- [Core architecture](/concepts/architecture) — Understand how AG-UI connects agents, protocols, and front-ends

- [Events](/concepts/events) — Learn about AG-UI's event-driven protocol

## Resources

Explore guides, tools, and integrations to help you build, optimize, and extend
your AG-UI implementation. These resources cover everything from practical
development workflows to debugging techniques.

- [Developing with Cursor](/tutorials/cursor) — Use Cursor to build AG-UI implementations faster

- [Troubleshooting AG-UI](/tutorials/debugging) — Fix common issues when working with AG-UI servers and clients

## Contributing

Want to contribute? Check out our
[Contributing Guide](/development/contributing) to learn how you can help
improve AG-UI.

## Support and Feedback

Here's how to get help or provide feedback:

* For bug reports and feature requests related to the AG-UI specification, SDKs,
  or documentation (open source), please
  [create a GitHub issue](https://github.com/ag-ui-protocol/ag-ui/issues)
* For discussions or Q\&A about AG-UI, please join the [Discord community](https://discord.gg/Jd3FzfdJa8)
