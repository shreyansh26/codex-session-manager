import { useEffect, useRef } from "react";
import type { ChatMessage, SessionCostDisplay, SessionSummary } from "../domain/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatPanelProps {
  session: SessionSummary | null;
  messages: ChatMessage[];
  costDisplay: SessionCostDisplay;
}

const numberFormatter = new Intl.NumberFormat("en-US");

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
  if (message.eventType === "reasoning") {
    return "Reasoning";
  }
  if (message.eventType === "activity") {
    return "Activity";
  }
  return message.role;
};

const hasTextContent = (value: string): boolean => value.trim().length > 0;

export default function ChatPanel({ session, messages, costDisplay }: ChatPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      panel.scrollTop = panel.scrollHeight;
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [session?.key, messages.length]);

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
          <p className="chat-panel__address">{session.deviceAddress}</p>
        </div>
      </header>

      <ol className="chat-panel__timeline">
        {messages.length === 0 ? (
          <li className="chat-panel__no-messages">No messages loaded yet.</li>
        ) : null}

        {messages.map((message, index) => (
          <li
            key={`${message.id}-${message.role}-${message.createdAt}-${index}`}
            className={`bubble bubble--${message.role} ${
              message.eventType === "reasoning" && message.role !== "user"
                ? "bubble--reasoning"
                : message.eventType === "activity" && message.role !== "user"
                  ? "bubble--activity"
                  : ""
            }`}
          >
            <p className="bubble__role">{messageLabel(message)}</p>
            {hasTextContent(message.content) ? (
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
        ))}
      </ol>
    </section>
  );
}
