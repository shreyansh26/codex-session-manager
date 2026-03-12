import type { ChatMessage, SessionSummary } from "../domain/types";

const SESSION_KEY = "device-real::thread-real-reopen-rollout-tail";

const buildMessage = (partial: Partial<ChatMessage>): ChatMessage => ({
  id: "message-id",
  key: SESSION_KEY,
  threadId: "thread-real-reopen-rollout-tail",
  deviceId: "device-real",
  role: "assistant",
  content: "placeholder",
  createdAt: "2026-01-10T16:01:40.000Z",
  ...partial
});

export const historicalReopenRolloutRepairSession: SessionSummary = {
  key: SESSION_KEY,
  threadId: "thread-real-reopen-rollout-tail",
  deviceId: "device-real",
  deviceLabel: "Local Device",
  deviceAddress: "127.0.0.1",
  title: "Historical reopen rollout repair regression",
  preview: "",
  updatedAt: "2026-01-10T16:01:40.000Z",
  cwd: "/Users/demo/track-project",
  folderName: "track-project"
};

export const historicalReopenRolloutRepairBaseMessages: ChatMessage[] = [
  buildMessage({
    id: "item-29",
    role: "user",
    createdAt: "2026-01-10T16:01:40.000Z",
    timelineOrder: 0,
    chronologySource: "turn",
    content: "Use gpt-5.1 for the commit summaries."
  }),
  buildMessage({
    id: "item-30::2026-01-10T16:01:40.000Z",
    role: "system",
    createdAt: "2026-01-10T16:01:40.000Z",
    timelineOrder: 1,
    chronologySource: "turn",
    eventType: "reasoning",
    content:
      "**Planning OpenAI API integration**\n**Updating workflow and README**\n**Verifying integration of OpenAI summarization**"
  }),
  buildMessage({
    id: "item-31",
    role: "assistant",
    createdAt: "2026-01-10T16:01:40.000Z",
    timelineOrder: 2,
    chronologySource: "turn",
    content:
      "Added optional OpenAI summarization per repo; it stays best-effort and will not break the workflow."
  }),
  buildMessage({
    id: "item-32",
    role: "user",
    createdAt: "2026-01-10T16:01:40.000Z",
    timelineOrder: 3,
    chronologySource: "turn",
    content: "Yes - use gpt-5.1"
  }),
  buildMessage({
    id: "item-33::2026-01-10T16:01:40.000Z",
    role: "system",
    createdAt: "2026-01-10T16:01:40.000Z",
    timelineOrder: 4,
    chronologySource: "turn",
    eventType: "reasoning",
    content:
      "**Preparing to verify model name via official sources**\n**Updating default model to GPT-5.1**"
  }),
  buildMessage({
    id: "item-34",
    role: "assistant",
    createdAt: "2026-01-10T16:01:40.000Z",
    timelineOrder: 5,
    chronologySource: "turn",
    content:
      "Updated the default model to `gpt-5.1`.\n\nChanges:\n- `scripts/track_commits.py`\n- `README.md`"
  })
];

export const historicalReopenRolloutRepairRolloutMessages: ChatMessage[] = [
  buildMessage({
    id: "message-verify-openai-summary",
    role: "assistant",
    createdAt: "2026-01-10T16:00:53.703Z",
    timelineOrder: 0,
    chronologySource: "rollout",
    eventType: "reasoning",
    content: "**Verifying integration of OpenAI summarization**"
  }),
  buildMessage({
    id: "message-item-31-rollout",
    role: "assistant",
    createdAt: "2026-01-10T16:00:55.235Z",
    timelineOrder: 1,
    chronologySource: "rollout",
    content:
      "Added optional OpenAI summarization per repo; it stays best-effort and will not break the workflow."
  }),
  buildMessage({
    id: "message-item-32-rollout",
    role: "user",
    createdAt: "2026-01-10T16:01:13.064Z",
    timelineOrder: 2,
    chronologySource: "rollout",
    content: "Yes - use gpt-5.1"
  }),
  buildMessage({
    id: "message-verify-model-name",
    role: "assistant",
    createdAt: "2026-01-10T16:01:20.614Z",
    timelineOrder: 3,
    chronologySource: "rollout",
    eventType: "reasoning",
    content: "**Preparing to verify model name via official sources**"
  }),
  buildMessage({
    id: "web_search-95594b9fbda6d258",
    role: "tool",
    createdAt: "2026-01-10T16:01:29.912Z",
    timelineOrder: 4,
    chronologySource: "rollout",
    eventType: "tool_call",
    content:
      "Tool: web_search\n\nInput:\n{\"query\":\"gpt-5.1 model name\"}\n\nOutput:\nOpenAI model docs",
    toolCall: {
      name: "web_search",
      input: "{\"query\":\"gpt-5.1 model name\"}",
      output: "OpenAI model docs",
      status: "completed"
    }
  }),
  buildMessage({
    id: "message-update-default-model",
    role: "assistant",
    createdAt: "2026-01-10T16:01:30.536Z",
    timelineOrder: 5,
    chronologySource: "rollout",
    eventType: "reasoning",
    content: "**Updating default model to GPT-5.1**"
  }),
  buildMessage({
    id: "call-update-script-model",
    role: "tool",
    createdAt: "2026-01-10T16:01:31.815Z",
    timelineOrder: 6,
    chronologySource: "rollout",
    eventType: "tool_call",
    content: "Tool: apply_patch\n\nInput:\n*** Update File: scripts/track_commits.py",
    toolCall: {
      name: "apply_patch",
      input: "*** Update File: scripts/track_commits.py",
      output: "Success. Updated the default model in the script.",
      status: "completed"
    }
  }),
  buildMessage({
    id: "call-update-readme-model",
    role: "tool",
    createdAt: "2026-01-10T16:01:36.212Z",
    timelineOrder: 7,
    chronologySource: "rollout",
    eventType: "tool_call",
    content: "Tool: apply_patch\n\nInput:\n*** Update File: README.md",
    toolCall: {
      name: "apply_patch",
      input: "*** Update File: README.md",
      output: "Success. Updated the default model in the README.",
      status: "completed"
    }
  }),
  buildMessage({
    id: "message-item-34-rollout",
    role: "assistant",
    createdAt: "2026-01-10T16:01:40.176Z",
    timelineOrder: 8,
    chronologySource: "rollout",
    content:
      "Updated the default model to `gpt-5.1`.\n\nChanges:\n- `scripts/track_commits.py`\n- `README.md`"
  })
];

export const historicalReopenRolloutRepairExpectedBrokenOrder = [
  "user:item-29",
  "assistant:message-verify-openai-summary",
  "assistant:item-31",
  "user:item-32",
  "assistant:message-verify-model-name",
  "tool:web_search-95594b9fbda6d258",
  "assistant:message-update-default-model",
  "tool:call-update-script-model",
  "tool:call-update-readme-model",
  "system:item-30::2026-01-10T16:01:40.000Z",
  "system:item-33::2026-01-10T16:01:40.000Z",
  "assistant:item-34"
];

export const historicalReopenRolloutRepairExpectedFixedOrder = [
  "user:item-29",
  "assistant:message-verify-openai-summary",
  "assistant:message-item-31-rollout",
  "user:item-32",
  "assistant:message-verify-model-name",
  "tool:web_search-95594b9fbda6d258",
  "assistant:message-update-default-model",
  "tool:call-update-script-model",
  "tool:call-update-readme-model",
  "assistant:message-item-34-rollout"
];
