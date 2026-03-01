import { useEffect, useRef } from "react";
import type { ChatMessage, SessionSummary, TurnStatus } from "../domain/types";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface ChatPanelProps {
  session: SessionSummary | null;
  messages: ChatMessage[];
  turnStatus: TurnStatus;
}

const statusText = (status: TurnStatus): string => {
  if (status === "running") {
    return "Running";
  }
  if (status === "completed") {
    return "Completed";
  }
  if (status === "failed") {
    return "Failed";
  }
  return "Idle";
};

const formatFullTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Last updated: unavailable";
  }

  return `Last updated: ${date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  })}`;
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

export default function ChatPanel({
  session,
  messages,
  turnStatus
}: ChatPanelProps) {
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
          <p className="chat-panel__updated-at">
            {formatFullTimestamp(session.updatedAt)}
          </p>
          <p className="chat-panel__address">{session.deviceAddress}</p>
        </div>
        <span className={`turn-pill turn-pill--${turnStatus}`}>
          {statusText(turnStatus)}
        </span>
      </header>

      <ol className="chat-panel__timeline">
        {messages.length === 0 ? (
          <li className="chat-panel__no-messages">No messages loaded yet.</li>
        ) : null}

        {messages.map((message) => (
          <li
            key={message.id}
            className={`bubble bubble--${message.role} ${
              message.eventType === "reasoning" && message.role !== "user"
                ? "bubble--reasoning"
                : message.eventType === "activity" && message.role !== "user"
                  ? "bubble--activity"
                  : ""
            }`}
          >
            <p className="bubble__role">{messageLabel(message)}</p>
            <ReactMarkdown className="bubble__markdown" remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </li>
        ))}
      </ol>
    </section>
  );
}
