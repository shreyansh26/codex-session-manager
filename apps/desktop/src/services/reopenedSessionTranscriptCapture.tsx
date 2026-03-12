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
  type RenderedTranscriptPhase,
  type ReopenedSessionTranscriptCapture
} from "./renderedTranscriptSnapshot";

const EMPTY_COST_DISPLAY: SessionCostDisplay = {
  costAvailable: false
};

const toElement = (value: Element | null): HTMLElement | null =>
  value instanceof HTMLElement ? value : null;

export const captureTranscriptPhase = async (params: {
  session: SessionSummary;
  messages: Parameters<typeof buildExpandedVisibleWindow>[0];
  hydrationState: ThreadHydrationState;
  phase: RenderedTranscriptPhase;
  mountedRoot?: ParentNode | null;
  costDisplay?: SessionCostDisplay;
}): Promise<ReopenedSessionTranscriptCapture["captures"][number]> => {
  const mountedRoot = params.mountedRoot ?? document;
  const mountedDomEntries = extractRenderedTranscriptDomEntries(mountedRoot);
  const mountedVisibleWindow = deriveVisibleWindowSnapshotFromDom({
    messages: params.messages,
    domEntries: mountedDomEntries
  });
  const mountedVisible = buildRenderedTranscriptSnapshot({
    session: params.session,
    phase: params.phase,
    mode: "mounted-visible",
    messages: params.messages,
    visibleWindow: mountedVisibleWindow,
    domEntries: mountedDomEntries
  });

  const expandedContainer = document.createElement("div");
  expandedContainer.setAttribute("data-transcript-capture-root", params.phase);
  document.body.appendChild(expandedContainer);
  const expandedRoot = createRoot(expandedContainer);
  try {
    flushSync(() => {
      expandedRoot.render(
        <ChatPanel
          session={params.session}
          messages={params.messages}
          costDisplay={params.costDisplay ?? EMPTY_COST_DISPLAY}
          hydrationState={params.hydrationState}
          windowOverride={buildExpandedVisibleWindow(params.messages)}
        />
      );
    });

    const expandedDomEntries = extractRenderedTranscriptDomEntries(expandedContainer);
    const expandedFull = buildRenderedTranscriptSnapshot({
      session: params.session,
      phase: params.phase,
      mode: "expanded-full",
      messages: params.messages,
      visibleWindow: deriveVisibleWindowSnapshotFromDom({
        messages: params.messages,
        domEntries: expandedDomEntries
      }),
      domEntries: expandedDomEntries
    });

    return {
      phase: params.phase,
      mountedVisible,
      expandedFull
    };
  } finally {
    expandedRoot.unmount();
    expandedContainer.remove();
  }
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
