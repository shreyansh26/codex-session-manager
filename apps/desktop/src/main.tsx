import React from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";
import App from "./App";
import {
  findLatestRolloutPathForThread,
  readRolloutTimelineMessages
} from "./services/codexApi";
import {
  captureTranscriptPhase,
  findMountedChatPanelRoot
} from "./services/reopenedSessionTranscriptCapture";
import { enrichReopenedSessionTranscriptCapture } from "./services/renderedTranscriptSnapshot";
import { debugPersistArtifact } from "./services/tauriBridge";
import { useAppStore } from "./state/useAppStore";
import "./styles/globals.css";
import "./styles/app.css";

const EMPTY_COST_DISPLAY = {
  costAvailable: false
} as const;
const DEV_CAPTURE_SESSION_KEY = import.meta.env.DEV
  ? import.meta.env.VITE_REOPEN_CAPTURE_SESSION_KEY?.trim()
  : "";
const DEV_CAPTURE_FILE_NAME = import.meta.env.DEV
  ? import.meta.env.VITE_REOPEN_CAPTURE_FILE_NAME?.trim()
  : "";

type HistoricalTranscriptCaptureResult = {
  capture: Awaited<ReturnType<typeof captureHistoricalSessionTranscript>>;
  persistedPath?: string;
};

declare global {
  interface Window {
    __CODEX_DEV__?: {
      captureHistoricalSessionTranscript: (
        sessionKey: string,
        options?: { persistFileName?: string }
      ) => Promise<HistoricalTranscriptCaptureResult>;
      lastHistoricalTranscriptCapture?: HistoricalTranscriptCaptureResult;
      lastHistoricalTranscriptCaptureError?: string;
    };
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

const waitForCondition = async (
  predicate: () => boolean,
  errorMessage: string,
  timeoutMs = 10_000,
  pollMs = 50
): Promise<void> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(pollMs);
  }
  throw new Error(errorMessage);
};

const waitForSelectedSessionMounted = async (sessionKey: string): Promise<void> => {
  await waitForCondition(
    () => {
      const state = useAppStore.getState();
      return state.selectedSessionKey === sessionKey && findMountedChatPanelRoot() !== null;
    },
    `Selected session ${sessionKey} did not mount in the renderer.`
  );
};

const waitForSessionAvailable = async (sessionKey: string): Promise<void> => {
  await waitForCondition(
    () => {
      const state = useAppStore.getState();
      return (
        state.sessions.some((session) => session.key === sessionKey) &&
        !state.initializing
      );
    },
    `Session ${sessionKey} did not appear in the renderer state.`
  );
};

const resolveRequestedSessionKey = async (sessionSelector: string): Promise<string> => {
  if (sessionSelector !== "__first__") {
    await waitForSessionAvailable(sessionSelector);
    return sessionSelector;
  }

  await waitForCondition(
    () => {
      const state = useAppStore.getState();
      return state.sessions.length > 0 && !state.initializing;
    },
    "No sessions were available for __first__ transcript capture."
  );

  const sessionKey = useAppStore.getState().sessions[0]?.key;
  if (!sessionKey) {
    throw new Error("No sessions were available for __first__ transcript capture.");
  }
  return sessionKey;
};

const waitForThreadHydration = async (
  sessionKey: string,
  timeoutMs = 10_000
): Promise<void> => {
  await waitForCondition(
    () => {
      const state = useAppStore.getState();
      const hydration = state.threadHydrationBySession[sessionKey];
      return (
        state.selectedSessionKey === sessionKey &&
        Boolean(hydration?.baseLoaded) &&
        !hydration?.baseLoading &&
        !hydration?.toolHistoryLoading
      );
    },
    `Thread hydration did not settle for ${sessionKey}.`,
    timeoutMs
  );
};

const captureHistoricalSessionTranscript = async (sessionSelector: string) => {
  const sessionKey = await resolveRequestedSessionKey(sessionSelector);
  await waitForSessionAvailable(sessionKey);
  const initialState = useAppStore.getState();
  const initialSession = initialState.sessions.find((session) => session.key === sessionKey);
  if (!initialSession) {
    throw new Error(`Unknown session key for transcript capture: ${sessionKey}`);
  }

  flushSync(() => {
    useAppStore.setState({ selectedSessionKey: sessionKey });
  });
  await waitForSelectedSessionMounted(sessionKey);

  await useAppStore.getState().refreshThread(initialSession.deviceId, initialSession.threadId, {
    preserveSummary: true,
    hydrateRollout: false
  });
  await waitForThreadHydration(sessionKey, 30_000);

  const baseState = useAppStore.getState();
  const baseSession = baseState.sessions.find((session) => session.key === sessionKey);
  const baseMessages = baseState.messagesBySession[sessionKey] ?? [];
  const baseHydration =
    baseState.threadHydrationBySession[sessionKey] ?? {
      baseLoading: false,
      baseLoaded: false,
      toolHistoryLoading: false
    };
  const mountedRoot = findMountedChatPanelRoot();
  if (!baseSession || !mountedRoot) {
    throw new Error(`Base-loaded transcript capture failed for ${sessionKey}.`);
  }

  const baseCapture = await captureTranscriptPhase({
    session: baseSession,
    messages: baseMessages,
    hydrationState: baseHydration,
    phase: "base-loaded",
    mountedRoot,
    costDisplay: EMPTY_COST_DISPLAY
  });

  const baseDevice =
    baseState.devices.find((device) => device.id === baseSession.deviceId) ??
    initialState.devices.find((device) => device.id === initialSession.deviceId);
  let rolloutParsedCapture: Awaited<ReturnType<typeof captureTranscriptPhase>> | null = null;

  if (baseDevice) {
    const rolloutPath = await findLatestRolloutPathForThread(
      baseDevice,
      baseSession.threadId
    );
    if (typeof rolloutPath === "string" && rolloutPath.trim().length > 0) {
      const rolloutParsedMessages = await readRolloutTimelineMessages(
        baseDevice,
        baseSession.threadId,
        rolloutPath,
        baseSession.updatedAt
      );
      rolloutParsedCapture = await captureTranscriptPhase({
        session: baseSession,
        messages: rolloutParsedMessages,
        hydrationState: {
          ...baseHydration,
          toolHistoryLoading: true
        },
        phase: "rollout-parsed",
        costDisplay: EMPTY_COST_DISPLAY
      });
    }
  }

  await useAppStore.getState().refreshThread(initialSession.deviceId, initialSession.threadId, {
    preserveSummary: true,
    hydrateRollout: true
  });
  await waitForThreadHydration(sessionKey, 30_000);

  const rolloutState = useAppStore.getState();
  const rolloutSession = rolloutState.sessions.find((session) => session.key === sessionKey);
  const rolloutMessages = rolloutState.messagesBySession[sessionKey] ?? [];
  const rolloutHydration =
    rolloutState.threadHydrationBySession[sessionKey] ?? {
      baseLoading: false,
      baseLoaded: false,
      toolHistoryLoading: false
    };
  const rolloutRoot = findMountedChatPanelRoot();
  if (!rolloutSession || !rolloutRoot) {
    throw new Error(`Rollout-applied transcript capture failed for ${sessionKey}.`);
  }

  const rolloutCapture = await captureTranscriptPhase({
    session: rolloutSession,
    messages: rolloutMessages,
    hydrationState: rolloutHydration,
    phase: "rollout-applied",
    mountedRoot: rolloutRoot,
    costDisplay: EMPTY_COST_DISPLAY
  });

  return enrichReopenedSessionTranscriptCapture({
    sessionKey,
    threadId: rolloutSession.threadId,
    deviceId: rolloutSession.deviceId,
    captures: [
      baseCapture,
      ...(rolloutParsedCapture ? [rolloutParsedCapture] : []),
      rolloutCapture
    ]
  });
};

const buildDefaultCaptureFileName = (sessionKey: string): string =>
  `reopened-session-${sessionKey.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`;

const installDevCaptureLoopback = (): void => {
  if (!import.meta.env.DEV) {
    return;
  }

  window.__CODEX_DEV__ = {
    captureHistoricalSessionTranscript: async (sessionKey, options) => {
      const capture = await captureHistoricalSessionTranscript(sessionKey);
      const persistFileName =
        options?.persistFileName ?? buildDefaultCaptureFileName(sessionKey);
      const persistedPath = await debugPersistArtifact(
        persistFileName,
        JSON.stringify(capture, null, 2)
      );
      const result = {
        capture,
        persistedPath
      };
      if (window.__CODEX_DEV__) {
        window.__CODEX_DEV__.lastHistoricalTranscriptCapture = result;
        delete window.__CODEX_DEV__.lastHistoricalTranscriptCaptureError;
      }
      return result;
    }
  };

  if (!DEV_CAPTURE_SESSION_KEY) {
    return;
  }

  void window.__CODEX_DEV__
    .captureHistoricalSessionTranscript(DEV_CAPTURE_SESSION_KEY, {
      persistFileName:
        DEV_CAPTURE_FILE_NAME || buildDefaultCaptureFileName(DEV_CAPTURE_SESSION_KEY)
    })
    .then((result) => {
      console.info(
        `[tauri-dev-capture] persisted transcript snapshot to ${result.persistedPath ?? "unknown"}`
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (window.__CODEX_DEV__) {
        window.__CODEX_DEV__.lastHistoricalTranscriptCaptureError = message;
      }
      console.error("[tauri-dev-capture] failed", message);
    });
};

installDevCaptureLoopback();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
