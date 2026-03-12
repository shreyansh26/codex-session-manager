import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ChatPanel from "../components/ChatPanel";
import type {
  ChatMessage,
  SessionCostDisplay,
  SessionSummary,
  ThreadHydrationState
} from "../domain/types";
import {
  buildExpandedVisibleWindow,
  buildRenderedTranscriptSnapshot,
  buildVisibleWindowSnapshot,
  deriveVisibleWindowSnapshotFromDom,
  findDuplicateWindowKeys,
  summarizeRoleRuns,
  toRenderedTranscriptStoreEntries,
  type RenderedTranscriptDomEntry
} from "../services/renderedTranscriptSnapshot";
import { __TEST_ONLY__ as codexApiTest } from "../services/codexApi";
import { __TEST_ONLY__ as storeTest } from "../state/useAppStore";
import {
  chronologyReplayFixtureById,
  existingSessionChronologyFixture
} from "./chronologyReplayFixtures";
import { applyChronologyReplayFixture } from "./chronologyReplayHarness";
import {
  historicalReopenRolloutRepairBaseMessages,
  historicalReopenRolloutRepairExpectedBrokenOrder,
  historicalReopenRolloutRepairExpectedFixedOrder,
  historicalReopenRolloutRepairRolloutMessages,
  historicalReopenRolloutRepairSession
} from "./reopenedSessionDiagnosticFixtures";

const DEFAULT_COST_DISPLAY: SessionCostDisplay = {
  costAvailable: false
};

const DEFAULT_HYDRATION_STATE: ThreadHydrationState = {
  baseLoading: false,
  baseLoaded: true,
  toolHistoryLoading: false
};

const buildMessage = (partial: Partial<ChatMessage>): ChatMessage => ({
  id: "message-id",
  key: "device-1::thread-1",
  threadId: "thread-1",
  deviceId: "device-1",
  role: "assistant",
  content: "hello",
  createdAt: "2026-03-12T10:00:00.000Z",
  ...partial
});

const buildSession = (messages: ChatMessage[]): SessionSummary => ({
  key: messages[0]?.key ?? "device-1::thread-1",
  threadId: messages[0]?.threadId ?? "thread-1",
  deviceId: messages[0]?.deviceId ?? "device-1",
  deviceLabel: "Local Device",
  deviceAddress: "127.0.0.1",
  title: "Snapshot test",
  preview: "",
  updatedAt: messages.at(-1)?.createdAt ?? "2026-03-12T10:00:00.000Z"
});

const renderedEntryFromStore = (
  entry: ReturnType<typeof toRenderedTranscriptStoreEntries>[number],
  domIndex: number
): RenderedTranscriptDomEntry => ({
  domIndex,
  renderKey: entry.renderKey,
  id: entry.id,
  role: entry.role,
  eventType: entry.eventType,
  label: entry.label,
  textPreview: entry.contentPreview,
  toolName: entry.toolName,
  toolStatus: entry.toolStatus
});

const decodeEntities = (value: string): string =>
  value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const stripMarkup = (value: string): string =>
  decodeEntities(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

const readAttribute = (source: string, name: string): string | null => {
  const match = source.match(new RegExp(`${name}=\"([^\"]*)\"`, "i"));
  return match?.[1] ?? null;
};

const renderChatPanelEntries = (params: {
  session: SessionSummary;
  messages: ChatMessage[];
  expanded?: boolean;
}): RenderedTranscriptDomEntry[] => {
  const markup = renderToStaticMarkup(
    <ChatPanel
      session={params.session}
      messages={params.messages}
      costDisplay={DEFAULT_COST_DISPLAY}
      hydrationState={DEFAULT_HYDRATION_STATE}
      {...(params.expanded
        ? { windowOverride: buildExpandedVisibleWindow(params.messages) }
        : {})}
    />
  );

  const entries: RenderedTranscriptDomEntry[] = [];
  const matcher = /<li\b([^>]*)>([\s\S]*?)<\/li>/g;
  let match: RegExpExecArray | null = null;
  while ((match = matcher.exec(markup)) !== null) {
    const attributes = match[1];
    const id = readAttribute(attributes, "data-message-id");
    const renderKey = readAttribute(attributes, "data-message-key");
    const role = readAttribute(attributes, "data-message-role");
    const label = readAttribute(attributes, "data-message-label");
    if (
      !id ||
      !renderKey ||
      !label ||
      (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool")
    ) {
      continue;
    }

    entries.push({
      domIndex: entries.length,
      renderKey,
      id,
      role,
      eventType: readAttribute(attributes, "data-event-type"),
      label,
      textPreview: stripMarkup(match[2]),
      toolName: readAttribute(attributes, "data-tool-name"),
      toolStatus: readAttribute(attributes, "data-tool-status")
    });
  }

  return entries;
};

describe("renderedTranscriptSnapshot helpers", () => {
  it("records duplicate window keys for ambiguous non-tool history entries", () => {
    const messages = [
      buildMessage({
        id: "item-1",
        role: "assistant",
        content: "First assistant copy"
      }),
      buildMessage({
        id: "item-1",
        role: "assistant",
        content: "Second assistant copy",
        createdAt: "2026-03-12T10:00:01.000Z"
      })
    ];

    expect(findDuplicateWindowKeys(messages)).toEqual([
      {
        renderKey: "item-1::assistant::",
        positions: [0, 1]
      }
    ]);
  });

  it("builds visible-window metadata from the same helper used by ChatPanel", () => {
    const messages = [
      buildMessage({
        id: "older-user",
        role: "user",
        content: "Earlier prompt"
      }),
      buildMessage({
        id: "tool-1",
        role: "tool",
        eventType: "tool_call",
        createdAt: "2026-03-12T10:00:01.000Z",
        content: "Tool: exec_command",
        toolCall: {
          name: "exec_command",
          input: "pwd",
          status: "completed"
        }
      }),
      buildMessage({
        id: "assistant-1",
        role: "assistant",
        createdAt: "2026-03-12T10:00:02.000Z",
        content: "Latest answer"
      })
    ];

    const visibleWindow = buildVisibleWindowSnapshot({
      messages,
      visibleMessageCount: 2,
      anchorMessageKey: null
    });

    expect(visibleWindow).toEqual({
      hiddenMessageCount: 0,
      startIndex: 0,
      anchorMessageKey: null,
      visibleRenderKeys: [
        "older-user::user::",
        "tool-1::tool::tool_call::2026-03-12T10:00:01.000Z",
        "assistant-1::assistant::"
      ]
    });
  });

  it("captures expanded ChatPanel DOM order, labels, and diffs", () => {
    const messages = [
      buildMessage({
        id: "user-1",
        role: "user",
        content: "Inspect the reopened session ordering."
      }),
      buildMessage({
        id: "tool-1",
        role: "tool",
        eventType: "tool_call",
        createdAt: "2026-03-12T10:00:01.000Z",
        content: "Tool: exec_command",
        toolCall: {
          name: "exec_command",
          input: "pwd",
          output: "/Users/demo/project",
          status: "completed"
        }
      }),
      buildMessage({
        id: "assistant-1",
        role: "assistant",
        createdAt: "2026-03-12T10:00:02.000Z",
        chronologySource: "rollout",
        timelineOrder: 2,
        content: "I found the ordering issue."
      })
    ];

    const session = buildSession(messages);
    const domEntries = renderChatPanelEntries({
      session,
      messages,
      expanded: true
    });
    const snapshot = buildRenderedTranscriptSnapshot({
      session,
      phase: "rollout-idle",
      mode: "expanded-full",
      messages,
      visibleWindow: buildVisibleWindowSnapshot({
        messages,
        visibleMessageCount: messages.length,
        anchorMessageKey: null
      }),
      domEntries
    });

    expect(toRenderedTranscriptStoreEntries(messages).map((entry) => entry.renderKey)).toEqual([
      "user-1::user::",
      "tool-1::tool::tool_call::2026-03-12T10:00:01.000Z",
      "assistant-1::assistant::"
    ]);
    expect(domEntries.map((entry) => entry.renderKey)).toEqual([
      "user-1::user::",
      "tool-1::tool::tool_call::2026-03-12T10:00:01.000Z",
      "assistant-1::assistant::"
    ]);
    expect(domEntries[1]).toMatchObject({
      role: "tool",
      label: "Tool Call",
      toolName: "exec_command",
      toolStatus: "completed"
    });
    expect(snapshot.storeVsDom.firstMismatchIndex).toBeNull();
    expect(snapshot.duplicateWindowKeys).toEqual([]);
    expect(summarizeRoleRuns(domEntries)).toEqual([
      { role: "user", startIndex: 0, length: 1 },
      { role: "tool", startIndex: 1, length: 1 },
      { role: "assistant", startIndex: 2, length: 1 }
    ]);
  });

  it("captures reopened historical fixtures with canonical expanded DOM order", () => {
    const messages = codexApiTest.parseMessagesFromThread(
      "device-1",
      existingSessionChronologyFixture.threadId,
      existingSessionChronologyFixture.threadReadSnapshot
    );
    const session = buildSession(messages);
    const snapshot = buildRenderedTranscriptSnapshot({
      session,
      phase: "rollout-idle",
      mode: "expanded-full",
      messages,
      visibleWindow: buildVisibleWindowSnapshot({
        messages,
        visibleMessageCount: messages.length,
        anchorMessageKey: null
      }),
      domEntries: renderChatPanelEntries({
        session,
        messages,
        expanded: true
      })
    });

    expect(
      snapshot.domEntries.map(
        (entry: RenderedTranscriptDomEntry) => `${entry.role}:${entry.id}`
      )
    ).toEqual(existingSessionChronologyFixture.expectedNumericSnapshotOrder);
    expect(snapshot.storeVsDom.firstMismatchIndex).toBeNull();
  });

  it("keeps mounted-visible order as an order-preserving slice of expanded DOM order", () => {
    const messages = [
      buildMessage({
        id: "older-1",
        role: "user",
        content: "Older user"
      }),
      buildMessage({
        id: "older-2",
        role: "assistant",
        createdAt: "2026-03-12T10:00:01.000Z",
        content: "Older assistant"
      }),
      buildMessage({
        id: "current-user",
        role: "user",
        createdAt: "2026-03-12T10:01:00.000Z",
        content: "Current user"
      }),
      buildMessage({
        id: "current-tool",
        role: "tool",
        eventType: "tool_call",
        createdAt: "2026-03-12T10:01:01.000Z",
        content: "Tool: exec_command",
        toolCall: {
          name: "exec_command",
          input: "pwd",
          output: "/Users/demo/project",
          status: "completed"
        }
      }),
      ...Array.from({ length: 40 }, (_, index) =>
        buildMessage({
          id: `current-assistant-${index + 1}`,
          role: "assistant",
          createdAt: `2026-03-12T10:01:${String(index + 2).padStart(2, "0")}.000Z`,
          content: `Current assistant ${index + 1}`
        })
      )
    ];

    const session = buildSession(messages);
    const mountedDomEntries = renderChatPanelEntries({
      session,
      messages
    });
    const mountedSnapshot = buildRenderedTranscriptSnapshot({
      session,
      phase: "base-loaded",
      mode: "mounted-visible",
      messages,
      visibleWindow: deriveVisibleWindowSnapshotFromDom({
        messages,
        domEntries: mountedDomEntries
      }),
      domEntries: mountedDomEntries
    });
    const expandedEntries = renderChatPanelEntries({
      session,
      messages,
      expanded: true
    });

    expect(
      expandedEntries.map((entry: RenderedTranscriptDomEntry) => entry.renderKey)
    ).toEqual(
      expect.arrayContaining(
        mountedSnapshot.domEntries.map(
          (entry: RenderedTranscriptDomEntry) => entry.renderKey
        )
      )
    );
    expect(
      expandedEntries
        .map((entry: RenderedTranscriptDomEntry) => entry.renderKey)
        .slice(-mountedSnapshot.domEntries.length)
    ).toEqual(
      mountedSnapshot.domEntries.map(
        (entry: RenderedTranscriptDomEntry) => entry.renderKey
      )
    );
  });

  it("reports an explicit mismatch artifact when the rendered order is scrambled", () => {
    const messages = [
      buildMessage({
        id: "user-1",
        role: "user",
        content: "First"
      }),
      buildMessage({
        id: "assistant-1",
        role: "assistant",
        createdAt: "2026-03-12T10:00:01.000Z",
        content: "Second"
      }),
      buildMessage({
        id: "tool-1",
        role: "tool",
        eventType: "tool_call",
        createdAt: "2026-03-12T10:00:02.000Z",
        content: "Tool: exec_command",
        toolCall: {
          name: "exec_command",
          input: "pwd",
          status: "completed"
        }
      })
    ];

    const storeEntries = toRenderedTranscriptStoreEntries(messages);
    const snapshot = buildRenderedTranscriptSnapshot({
      session: buildSession(messages),
      phase: "rollout-idle",
      mode: "expanded-full",
      messages,
      visibleWindow: buildVisibleWindowSnapshot({
        messages,
        visibleMessageCount: messages.length,
        anchorMessageKey: null
      }),
      domEntries: [
        renderedEntryFromStore(storeEntries[1], 0),
        renderedEntryFromStore(storeEntries[0], 1),
        renderedEntryFromStore(storeEntries[2], 2)
      ]
    });

    expect(snapshot.storeVsDom.firstMismatchIndex).toBe(0);
    expect(snapshot.storeVsDom.actualOrder).not.toEqual(snapshot.storeVsDom.expectedOrder);
  });

  it("renders repaired rollout chronology without leaving stale turn-reasoning blocks at the tail", () => {
    const merged = storeTest.mergeRolloutEnrichmentMessages(
      historicalReopenRolloutRepairBaseMessages,
      historicalReopenRolloutRepairRolloutMessages
    );
    const domEntries = renderChatPanelEntries({
      session: historicalReopenRolloutRepairSession,
      messages: merged,
      expanded: true
    });
    const snapshot = buildRenderedTranscriptSnapshot({
      session: historicalReopenRolloutRepairSession,
      phase: "rollout-idle",
      mode: "expanded-full",
      messages: merged,
      visibleWindow: deriveVisibleWindowSnapshotFromDom({
        messages: merged,
        domEntries
      }),
      domEntries
    });

    expect(
      snapshot.domEntries.map(
        (entry: RenderedTranscriptDomEntry) => `${entry.role}:${entry.id}`
      )
    ).toEqual(historicalReopenRolloutRepairExpectedFixedOrder);
    expect(
      snapshot.domEntries.map(
        (entry: RenderedTranscriptDomEntry) => `${entry.role}:${entry.id}`
      )
    ).not.toEqual(historicalReopenRolloutRepairExpectedBrokenOrder);
  });

  it("keeps the live-only chronology path stable after the reopen repair", () => {
    const fixture = chronologyReplayFixtureById["reused-call-id-across-turns"];
    const messages = applyChronologyReplayFixture(fixture);
    const session = buildSession(messages);
    const domEntries = renderChatPanelEntries({
      session,
      messages,
      expanded: true
    });
    const snapshot = buildRenderedTranscriptSnapshot({
      session,
      phase: "rollout-idle",
      mode: "expanded-full",
      messages,
      visibleWindow: deriveVisibleWindowSnapshotFromDom({
        messages,
        domEntries
      }),
      domEntries
    });

    expect(
      snapshot.domEntries.map(
        (entry: RenderedTranscriptDomEntry) => `${entry.role}:${entry.id}`
      )
    ).toEqual(fixture.expectedOrder);
    expect(snapshot.storeVsDom.firstMismatchIndex).toBeNull();
  });
});
