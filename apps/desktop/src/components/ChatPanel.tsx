import { memo, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  SessionCostDisplay,
  SessionSummary,
  ThreadHydrationState
} from "../domain/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getMessageWindowKey, resolveVisibleMessageWindow } from "./chatWindow";

interface ChatPanelProps {
  session: SessionSummary | null;
  messages: ChatMessage[];
  costDisplay: SessionCostDisplay;
  hydrationState: ThreadHydrationState;
  scrollToMessageId?: string | null;
  onScrollToMessageHandled?: (messageId: string) => void;
}

const numberFormatter = new Intl.NumberFormat("en-US");
const INITIAL_VISIBLE_MESSAGE_COUNT = 40;
const VISIBLE_MESSAGE_PAGE_SIZE = 40;
const TOOL_OUTPUT_PREVIEW_MAX_CHARS = 4_000;

const formatFullTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "unavailable";
  }

  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  });
};

const formatTokenUsage = (costDisplay: SessionCostDisplay): string => {
  if (!costDisplay.tokenUsage) {
    return "Tokens: unavailable";
  }

  const usage = costDisplay.tokenUsage.total;
  return `Tokens: ${numberFormatter.format(usage.totalTokens)} (in ${numberFormatter.format(usage.inputTokens)}, cached ${numberFormatter.format(usage.cachedInputTokens)}, out ${numberFormatter.format(usage.outputTokens)})`;
};

const formatUsdCost = (value: number): string => {
  if (value >= 1) {
    return value.toFixed(2);
  }
  if (value >= 0.01) {
    return value.toFixed(4);
  }
  return value.toFixed(6);
};

const formatCost = (costDisplay: SessionCostDisplay): string => {
  if (!costDisplay.costAvailable || typeof costDisplay.usdCost !== "number") {
    return "Cost: unavailable";
  }
  return `Cost: $${formatUsdCost(costDisplay.usdCost)}`;
};

const messageLabel = (message: ChatMessage): string => {
  if (message.role === "user") {
    return "user";
  }
  if (message.eventType === "tool_call") {
    return "Tool Call";
  }
  if (message.eventType === "reasoning") {
    return "Reasoning";
  }
  if (message.eventType === "activity") {
    return "Activity";
  }
  return message.role;
};

const hasTextContent = (value: string): boolean => value.trim().length > 0;

const isToolCallMessage = (message: ChatMessage): boolean =>
  message.eventType === "tool_call" && Boolean(message.toolCall);

const formatToolStatus = (message: ChatMessage): string | null => {
  const status = message.toolCall?.status;
  if (!status) {
    return null;
  }
  if (status === "running") {
    return "running";
  }
  if (status === "completed") {
    return "completed";
  }
  if (status === "failed") {
    return "failed";
  }
  return status;
};

const shouldCollapseToolOutput = (output: string): boolean =>
  output.length > TOOL_OUTPUT_PREVIEW_MAX_CHARS || output.split("\n").length > 80;

function ChatPanel({
  session,
  messages,
  costDisplay,
  hydrationState,
  scrollToMessageId,
  onScrollToMessageHandled
}: ChatPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const messageRefs = useRef(new Map<string, HTMLElement>());
  const stickToBottomRef = useRef(true);
  const prependAnchorOffsetRef = useRef<number | null>(null);
  const previousMessageCountRef = useRef(messages.length);
  const [visibleMessageCount, setVisibleMessageCount] = useState(
    INITIAL_VISIBLE_MESSAGE_COUNT
  );
  const [visibleStartMessageKey, setVisibleStartMessageKey] = useState<string | null>(null);
  const [expandedToolOutputs, setExpandedToolOutputs] = useState<Record<string, boolean>>({});

  const { hiddenMessageCount, startIndex, visibleMessages } = useMemo(
    () =>
      resolveVisibleMessageWindow({
        messages,
        visibleMessageCount,
        anchorMessageKey: visibleStartMessageKey
      }),
    [messages, visibleMessageCount, visibleStartMessageKey]
  );

  useEffect(() => {
    stickToBottomRef.current = true;
    prependAnchorOffsetRef.current = null;
    previousMessageCountRef.current = messages.length;
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGE_COUNT);
    setVisibleStartMessageKey(null);
    setExpandedToolOutputs({});
    messageRefs.current.clear();
  }, [session?.key]);

  useEffect(() => {
    const nextAnchorKey = visibleMessages[0]
      ? getMessageWindowKey(visibleMessages[0])
      : null;
    if (nextAnchorKey === visibleStartMessageKey) {
      return;
    }
    setVisibleStartMessageKey(nextAnchorKey);
  }, [visibleMessages, visibleStartMessageKey]);

  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    previousMessageCountRef.current = messages.length;

    if (messages.length <= previousCount) {
      return;
    }

    if (!stickToBottomRef.current) {
      return;
    }

    const delta = messages.length - previousCount;
    setVisibleMessageCount((current) => Math.min(messages.length, current + delta));
  }, [messages.length]);

  useEffect(() => {
    if (!scrollToMessageId) {
      return;
    }

    const targetIndex = messages.findIndex((message) => message.id === scrollToMessageId);
    if (targetIndex === -1) {
      return;
    }

    const minimumVisibleCount = messages.length - targetIndex;
    if (minimumVisibleCount <= visibleMessageCount) {
      return;
    }

    setVisibleMessageCount(
      Math.min(
        messages.length,
        Math.max(minimumVisibleCount, visibleMessageCount + VISIBLE_MESSAGE_PAGE_SIZE)
      )
    );
  }, [messages, scrollToMessageId, visibleMessageCount]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    const syncStickToBottom = (): void => {
      const distanceFromBottom =
        panel.scrollHeight - panel.scrollTop - panel.clientHeight;
      stickToBottomRef.current = distanceFromBottom <= 96;
    };

    syncStickToBottom();
    panel.addEventListener("scroll", syncStickToBottom);
    return () => {
      panel.removeEventListener("scroll", syncStickToBottom);
    };
  }, [session?.key]);

  useEffect(() => {
    const anchorOffset = prependAnchorOffsetRef.current;
    if (anchorOffset === null) {
      return;
    }

    const panel = panelRef.current;
    if (!panel) {
      prependAnchorOffsetRef.current = null;
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      panel.scrollTop = Math.max(0, panel.scrollHeight - anchorOffset);
      prependAnchorOffsetRef.current = null;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [visibleMessageCount]);

  useEffect(() => {
    if (scrollToMessageId) {
      return;
    }
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    if (!stickToBottomRef.current) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      panel.scrollTop = panel.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [scrollToMessageId, session?.key, visibleMessages.length]);

  useEffect(() => {
    if (!scrollToMessageId) {
      return;
    }

    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const targetMessage =
        visibleMessages.find((message) => message.id === scrollToMessageId) ?? null;
      if (!targetMessage) {
        return;
      }

      const target =
        messageRefs.current.get(getMessageWindowKey(targetMessage)) ?? null;
      if (!target) {
        return;
      }

      target.scrollIntoView({
        block: "center",
        behavior: "smooth"
      });
      target.classList.add("bubble--search-target");
      window.setTimeout(() => {
        target.classList.remove("bubble--search-target");
      }, 1300);
      onScrollToMessageHandled?.(scrollToMessageId);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [visibleMessages, onScrollToMessageHandled, scrollToMessageId, session?.key]);

  if (!session) {
    return (
      <section className="chat-panel chat-panel--empty">
        <h2>Select a session</h2>
        <p>Pick one conversation from the sidebar to inspect or continue it.</p>
      </section>
    );
  }

  return (
    <section ref={panelRef} className="chat-panel">
      <header className="chat-panel__header">
        <div>
          <p className="chat-panel__eyebrow">{session.deviceLabel}</p>
          <h2>{session.title}</h2>
          <p className="chat-panel__meta">
            {`Last updated: ${formatFullTimestamp(session.updatedAt)} · ${formatTokenUsage(
              costDisplay
            )} · ${formatCost(costDisplay)}`}
          </p>
          {hydrationState.baseLoading ? (
            <p className="chat-panel__meta">Loading live thread history...</p>
          ) : hydrationState.toolHistoryLoading ? (
            <p className="chat-panel__meta">Hydrating tool history...</p>
          ) : null}
          <p className="chat-panel__address">{session.deviceAddress}</p>
        </div>
      </header>

      <ol className="chat-panel__timeline">
        {hiddenMessageCount > 0 ? (
          <li className="chat-panel__history-controls">
            <button
              type="button"
              className="chat-panel__history-button"
              onClick={() => {
                const panel = panelRef.current;
                if (panel) {
                  prependAnchorOffsetRef.current = panel.scrollHeight - panel.scrollTop;
                }
                const nextStartIndex = Math.max(0, startIndex - VISIBLE_MESSAGE_PAGE_SIZE);
                const nextAnchor = messages[nextStartIndex];
                if (!nextAnchor) {
                  return;
                }
                setVisibleStartMessageKey(getMessageWindowKey(nextAnchor));
                setVisibleMessageCount((current) =>
                  Math.min(messages.length, current + VISIBLE_MESSAGE_PAGE_SIZE)
                );
              }}
            >
              Load {Math.min(VISIBLE_MESSAGE_PAGE_SIZE, hiddenMessageCount)} older message
              {hiddenMessageCount === 1 ? "" : "s"}
            </button>
            <p className="chat-panel__history-meta">
              Showing latest {visibleMessages.length} of {messages.length} messages
            </p>
          </li>
        ) : null}

        {messages.length === 0 ? (
          <li className="chat-panel__no-messages">No messages loaded yet.</li>
        ) : null}

        {visibleMessages.map((message) => {
          const renderKey = getMessageWindowKey(message);
          return (
            <li
              key={renderKey}
              data-message-id={message.id}
              ref={(element) => {
                if (!element) {
                  messageRefs.current.delete(renderKey);
                  return;
                }
                messageRefs.current.set(renderKey, element);
              }}
              className={`bubble bubble--${message.role} ${
                isToolCallMessage(message)
                  ? "bubble--tool-call"
                  : message.eventType === "reasoning" && message.role !== "user"
                  ? "bubble--reasoning"
                  : message.eventType === "activity" && message.role !== "user"
                    ? "bubble--activity"
                    : ""
              }`}
            >
              <p className="bubble__role">{messageLabel(message)}</p>
              {isToolCallMessage(message) ? (
                <div className="bubble__tool-card">
                  <div className="bubble__tool-header">
                    <p className="bubble__tool-name">{message.toolCall?.name ?? "tool"}</p>
                    {formatToolStatus(message) ? (
                      <span
                        className={`bubble__tool-status bubble__tool-status--${message.toolCall?.status ?? "unknown"}`}
                      >
                        {formatToolStatus(message)}
                      </span>
                    ) : null}
                  </div>
                  {message.toolCall?.input ? (
                    <section className="bubble__tool-section">
                      <p className="bubble__tool-section-label">Input</p>
                      <pre className="bubble__tool-code">
                        <code>{message.toolCall.input}</code>
                      </pre>
                    </section>
                  ) : null}
                  {message.toolCall?.output ? (
                    <section className="bubble__tool-section">
                      <p className="bubble__tool-section-label">Output</p>
                      <pre className="bubble__tool-code bubble__tool-code--output">
                        <code>
                          {shouldCollapseToolOutput(message.toolCall.output) &&
                          !expandedToolOutputs[renderKey]
                            ? `${message.toolCall.output.slice(0, TOOL_OUTPUT_PREVIEW_MAX_CHARS)}\n\n… output truncated`
                            : message.toolCall.output}
                        </code>
                      </pre>
                      {shouldCollapseToolOutput(message.toolCall.output) ? (
                        <button
                          type="button"
                          className="bubble__tool-toggle"
                          onClick={() =>
                            setExpandedToolOutputs((current) => ({
                              ...current,
                              [renderKey]: !current[renderKey]
                            }))
                          }
                        >
                          {expandedToolOutputs[renderKey]
                            ? "Show less output"
                            : "Show full output"}
                        </button>
                      ) : null}
                    </section>
                  ) : message.toolCall?.status === "running" ? (
                    <p className="bubble__tool-pending">Waiting for output...</p>
                  ) : null}
                </div>
              ) : hasTextContent(message.content) ? (
                <ReactMarkdown className="bubble__markdown" remarkPlugins={[remarkGfm]}>
                  {message.content}
                </ReactMarkdown>
              ) : null}
              {message.images && message.images.length > 0 ? (
                <div className="bubble__images">
                  {message.images.map((image, imageIndex) => (
                    <img
                      key={`${image.id}-${imageIndex}`}
                      className="bubble__image"
                      src={image.url}
                      alt={image.fileName ?? `Image attachment ${imageIndex + 1}`}
                      loading="lazy"
                    />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default memo(ChatPanel);
