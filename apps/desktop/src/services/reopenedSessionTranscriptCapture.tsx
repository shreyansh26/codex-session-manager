import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import ChatPanel from "../components/ChatPanel";
import type {
  SessionCostDisplay,
  SessionSummary,
  ThreadHydrationState
} from "../domain/types";
import {
  buildExpandedVisibleWindow,
  buildRenderedTranscriptSnapshot,
  deriveVisibleWindowSnapshotFromDom,
  extractRenderedTranscriptDomEntries,
  type RenderedTranscriptSnapshot,
  type RenderedTranscriptPhase,
  type ReopenedSessionTranscriptCapture
} from "./renderedTranscriptSnapshot";

const EMPTY_COST_DISPLAY: SessionCostDisplay = {
  costAvailable: false
};

const toElement = (value: Element | null): HTMLElement | null =>
  value instanceof HTMLElement ? value : null;

const renderSyntheticSnapshot = (params: {
  session: SessionSummary;
  messages: Parameters<typeof buildExpandedVisibleWindow>[0];
  hydrationState: ThreadHydrationState;
  phase: RenderedTranscriptPhase;
  mode: "mounted-visible" | "expanded-full";
  costDisplay?: SessionCostDisplay;
}): RenderedTranscriptSnapshot => {
  const container = document.createElement("div");
  container.setAttribute("data-transcript-capture-root", `${params.phase}-${params.mode}`);
  document.body.appendChild(container);
  const root = createRoot(container);
  const windowOverride =
    params.mode === "expanded-full"
      ? buildExpandedVisibleWindow(params.messages)
      : undefined;

  try {
    flushSync(() => {
      root.render(
        <ChatPanel
          session={params.session}
          messages={params.messages}
          costDisplay={params.costDisplay ?? EMPTY_COST_DISPLAY}
          hydrationState={params.hydrationState}
          windowOverride={windowOverride}
        />
      );
    });

    const domEntries = extractRenderedTranscriptDomEntries(container);
    return buildRenderedTranscriptSnapshot({
      session: params.session,
      phase: params.phase,
      mode: params.mode,
      messages: params.messages,
      visibleWindow: deriveVisibleWindowSnapshotFromDom({
        messages: params.messages,
        domEntries
      }),
      domEntries
    });
  } finally {
    root.unmount();
    container.remove();
  }
};

export const captureTranscriptPhase = async (params: {
  session: SessionSummary;
  messages: Parameters<typeof buildExpandedVisibleWindow>[0];
  hydrationState: ThreadHydrationState;
  phase: RenderedTranscriptPhase;
  mountedRoot?: ParentNode | null;
  costDisplay?: SessionCostDisplay;
}): Promise<ReopenedSessionTranscriptCapture["captures"][number]> => {
  const mountedRoot = params.mountedRoot ?? null;
  const mountedDomEntries =
    mountedRoot === null ? [] : extractRenderedTranscriptDomEntries(mountedRoot);
  const mountedVisible =
    mountedDomEntries.length > 0
      ? buildRenderedTranscriptSnapshot({
          session: params.session,
          phase: params.phase,
          mode: "mounted-visible",
          messages: params.messages,
          visibleWindow: deriveVisibleWindowSnapshotFromDom({
            messages: params.messages,
            domEntries: mountedDomEntries
          }),
          domEntries: mountedDomEntries
        })
      : renderSyntheticSnapshot({
          session: params.session,
          messages: params.messages,
          hydrationState: params.hydrationState,
          phase: params.phase,
          mode: "mounted-visible",
          costDisplay: params.costDisplay
        });

  const expandedFull = renderSyntheticSnapshot({
    session: params.session,
    messages: params.messages,
    hydrationState: params.hydrationState,
    phase: params.phase,
    mode: "expanded-full",
    costDisplay: params.costDisplay
  });

  return {
    phase: params.phase,
    mountedVisible,
    expandedFull
  };
};

export const captureSelectedSessionTranscript = async (params: {
  session: SessionSummary;
  messages: Parameters<typeof buildExpandedVisibleWindow>[0];
  hydrationState: ThreadHydrationState;
  mountedRoot?: ParentNode | null;
  costDisplay?: SessionCostDisplay;
  phase: RenderedTranscriptPhase;
}): Promise<ReopenedSessionTranscriptCapture> => {
  const capture = await captureTranscriptPhase(params);
  return {
    sessionKey: params.session.key,
    threadId: params.session.threadId,
    deviceId: params.session.deviceId,
    captures: [capture]
  };
};

export const findMountedChatPanelRoot = (): HTMLElement | null =>
  toElement(document.querySelector(".chat-panel"));
