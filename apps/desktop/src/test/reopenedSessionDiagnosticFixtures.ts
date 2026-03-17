import type { ChatMessage, SessionSummary } from "../domain/types";

const SESSION_KEY = "device-real::thread-real-reopen-rollout-tail";
const toIsoWithSecondOffset = (baseIso: string, offsetSeconds: number): string =>
  new Date(Date.parse(baseIso) + offsetSeconds * 1_000).toISOString();

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
    content: "**Preparing to verify model name via official sources**\n**Updating default model to GPT-5.1**"
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

const POST_HYDRATION_PARSE_LOSS_SESSION_KEY =
  "device-real::thread-post-hydration-parse-loss";

const buildPostHydrationMessage = (
  partial: Partial<ChatMessage>
): ChatMessage => ({
  id: "post-hydration-id",
  key: POST_HYDRATION_PARSE_LOSS_SESSION_KEY,
  threadId: "thread-post-hydration-parse-loss",
  deviceId: "device-real",
  role: "assistant",
  content: "placeholder",
  createdAt: "2026-03-17T17:03:00.000Z",
  ...partial
});

export const postHydrationParseLossSession: SessionSummary = {
  key: POST_HYDRATION_PARSE_LOSS_SESSION_KEY,
  threadId: "thread-post-hydration-parse-loss",
  deviceId: "device-real",
  deviceLabel: "Local Device",
  deviceAddress: "127.0.0.1",
  title: "Historical post-hydration parse-loss regression",
  preview: "",
  updatedAt: "2026-03-17T17:03:00.000Z",
  cwd: "/Users/demo/codex-app",
  folderName: "codex-app"
};

export const postHydrationParseLossBaseMessages: ChatMessage[] = [
  buildPostHydrationMessage({
    id: "item-313",
    role: "user",
    chronologySource: "turn",
    timelineOrder: 313,
    createdAt: "2026-03-17T17:02:50.000Z",
    content:
      "Figure out the issue. Plan deeply. Use $swarm-planner to identify the issue in both apps and fix it."
  }),
  buildPostHydrationMessage({
    id: "item-314",
    role: "assistant",
    chronologySource: "turn",
    timelineOrder: 314,
    createdAt: "2026-03-17T17:02:58.000Z",
    content:
      "I have enough evidence now: base-loaded is coherent, and the regression appears immediately after rollout hydration."
  }),
  buildPostHydrationMessage({
    id: "call-critical-post-hydration",
    role: "tool",
    chronologySource: "turn",
    eventType: "tool_call",
    timelineOrder: 315,
    createdAt: "2026-03-17T17:03:05.000Z",
    content: "Tool: exec_command\\n\\nInput:\\ncat diagnostics/summary.json",
    toolCall: {
      name: "exec_command",
      input: "cat diagnostics/summary.json",
      output: "rollout hydration regressed ordering",
      status: "completed"
    }
  }),
  buildPostHydrationMessage({
    id: "item-315",
    role: "assistant",
    chronologySource: "turn",
    timelineOrder: 316,
    createdAt: "2026-03-17T17:03:12.000Z",
    content:
      "The captured summary confirms parse-loss after hydration, not a live ordering defect."
  })
];

export const postHydrationParseLossRolloutAppliedMessages: ChatMessage[] = [
  buildPostHydrationMessage({
    id: "message-rollout-r1",
    role: "assistant",
    chronologySource: "rollout",
    eventType: "reasoning",
    timelineOrder: 0,
    createdAt: "2026-03-17T17:02:57.000Z",
    content: "**Inspecting chronology capture evidence**"
  }),
  buildPostHydrationMessage({
    id: "message-rollout-r2",
    role: "assistant",
    chronologySource: "rollout",
    timelineOrder: 1,
    createdAt: "2026-03-17T17:03:02.000Z",
    content:
      "I can reproduce the degradation: tool calls and user anchors disappear after rollout hydration."
  }),
  buildPostHydrationMessage({
    id: "message-rollout-r3",
    role: "assistant",
    chronologySource: "rollout",
    timelineOrder: 2,
    createdAt: "2026-03-17T17:03:10.000Z",
    content:
      "Next I’m freezing failing regressions before changing the parser or merge path."
  })
];

export const postHydrationParseLossExpectedCanonicalOrder = [
  "user:item-313",
  "assistant:item-314",
  "tool:call-critical-post-hydration",
  "assistant:item-315"
];

export const postHydrationParseLossExpectedAppliedOrder = [
  "assistant:message-rollout-r1",
  "assistant:message-rollout-r2",
  "assistant:message-rollout-r3"
];

export const responseItemClassifierFixture = {
  rolloutTimeline: [
    {
      kind: "message",
      id: "response-item-wrapper",
      role: "user",
      content:
        "# AGENTS.md instructions for /Users/shreyansh/Projects/codex-app-vibe-code\\n\\n<environment_context>...</environment_context>",
      createdAt: "2026-03-17T17:02:47.000Z",
      order: 0,
      sourceType: "response_item"
    },
    {
      kind: "message",
      id: "response-item-visible-user",
      role: "user",
      content:
        "Nope same issue. It appears fixed as soon as I open the app, then the order turns bad again.",
      createdAt: "2026-03-17T17:02:48.000Z",
      order: 1,
      sourceType: "response_item"
    },
    {
      kind: "message",
      id: "response-item-assistant",
      role: "assistant",
      content:
        "I’m adding failing-first regressions now so the parser change is forced by tests.",
      createdAt: "2026-03-17T17:02:50.000Z",
      order: 2,
      sourceType: "response_item"
    }
  ],
  expectedVisibleRoleIdOrder: [
    "user:response-item-visible-user",
    "assistant:response-item-assistant"
  ]
} as const;

export const longSessionRolloutTruncationFixture = (() => {
  const threadId = "thread-rollout-truncation-over-300";
  const rolloutPath = "/tmp/history/session-rollout.jsonl";

  const threadReadResult = {
    thread: {
      id: threadId,
      title: "Long historical session truncation regression",
      preview: "Post-hydration ordering drift",
      updatedAt: "2026-03-17T17:05:00.000Z",
      cwd: "/Users/demo/codex-app",
      path: rolloutPath,
      turns: [
        {
          createdAt: "2026-03-17T17:04:00.000Z",
          messages: [
            {
              id: "critical-user",
              role: "user",
              content:
                "The app still regresses after hydration. Preserve this user/tool/assistant block."
            },
            {
              id: "critical-tool",
              role: "tool",
              eventType: "tool_call",
              content: "Tool: exec_command\\n\\nInput:\\ncat diagnostics/summary.json",
              toolCall: {
                name: "exec_command",
                input: "cat diagnostics/summary.json",
                output: "regression present",
                status: "completed"
              }
            },
            {
              id: "critical-assistant",
              role: "assistant",
              content:
                "Captured. I’m preserving this interleaving in the regression fixture."
            }
          ]
        }
      ]
    }
  };

  const fullRolloutTimeline = [
    {
      kind: "message",
      id: "critical-user",
      role: "user",
      content:
        "The app still regresses after hydration. Preserve this user/tool/assistant block.",
      createdAt: "2026-03-17T17:04:00.000Z",
      order: 0,
      sourceType: "event_msg"
    },
    {
      kind: "tool",
      id: "critical-tool",
      name: "exec_command",
      input: "cat diagnostics/summary.json",
      output: "regression present",
      status: "completed",
      createdAt: "2026-03-17T17:04:01.000Z",
      order: 1
    },
    ...Array.from({ length: 300 }, (_, index) => ({
      kind: "message",
      id: `rollout-assistant-${index + 1}`,
      role: "assistant",
      content: `Rollout assistant entry ${index + 1}`,
      createdAt: toIsoWithSecondOffset("2026-03-17T17:04:02.000Z", index),
      order: index + 2,
      sourceType: "response_item"
    }))
  ];

  return {
    threadId,
    rolloutPath,
    threadReadResult,
    truncatedRolloutTimeline: fullRolloutTimeline.slice(-300),
    expectedCriticalInterleaving: [
      "user:critical-user",
      "tool:critical-tool",
      "assistant:critical-assistant"
    ]
  } as const;
})();
