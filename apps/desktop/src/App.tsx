import { useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import Composer from "./components/Composer";
import Sidebar from "./components/Sidebar";
import type { SessionCostDisplay } from "./domain/types";
import { shutdownRpcClients, useAppStore } from "./state/useAppStore";

const REFRESH_INTERVAL_MS = 20_000;
const SIDEBAR_MIN_WIDTH_PX = 280;
const SIDEBAR_MAX_RATIO = 0.62;

const clampSidebarWidth = (requested: number, shellWidth: number): number => {
  const maxWidth = Math.max(SIDEBAR_MIN_WIDTH_PX, Math.floor(shellWidth * SIDEBAR_MAX_RATIO));
  return Math.min(Math.max(requested, SIDEBAR_MIN_WIDTH_PX), maxWidth);
};

const pickThreadScopedValue = <T,>(
  values: Record<string, T>,
  selectedSessionKey: string | null,
  threadId: string | undefined
): T | undefined => {
  if (selectedSessionKey) {
    const direct = values[selectedSessionKey];
    if (direct !== undefined) {
      return direct;
    }
  }

  if (!threadId) {
    return undefined;
  }

  for (const [key, value] of Object.entries(values)) {
    if (key.endsWith(`::${threadId}`)) {
      return value;
    }
  }

  return undefined;
};

export default function App() {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(360);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [composerFocusToken, setComposerFocusToken] = useState(0);

  const loading = useAppStore((state) => state.loading);
  const devices = useAppStore((state) => state.devices);
  const sessions = useAppStore((state) => state.sessions);
  const selectedSessionKey = useAppStore((state) => state.selectedSessionKey);
  const messagesBySession = useAppStore((state) => state.messagesBySession);
  const tokenUsageBySession = useAppStore((state) => state.tokenUsageBySession);
  const modelBySession = useAppStore((state) => state.modelBySession);
  const costUsdBySession = useAppStore((state) => state.costUsdBySession);
  const globalError = useAppStore((state) => state.globalError);

  const initialize = useAppStore((state) => state.initialize);
  const clearError = useAppStore((state) => state.clearError);
  const selectSession = useAppStore((state) => state.selectSession);
  const submitComposer = useAppStore((state) => state.submitComposer);
  const addSsh = useAppStore((state) => state.addSsh);
  const browseDeviceDirectories = useAppStore(
    (state) => state.browseDeviceDirectories
  );
  const connect = useAppStore((state) => state.connect);
  const disconnect = useAppStore((state) => state.disconnect);
  const remove = useAppStore((state) => state.remove);
  const refreshDeviceSessions = useAppStore((state) => state.refreshDeviceSessions);
  const refreshSessions = useAppStore((state) => state.refreshSessions);
  const startNewSession = useAppStore((state) => state.startNewSession);

  useEffect(() => {
    void initialize();
    return () => {
      shutdownRpcClients();
    };
  }, [initialize]);

  useEffect(() => {
    const timer = setInterval(() => {
      void refreshSessions();
    }, REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(timer);
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (!resizingSidebar) {
      return;
    }

    const onPointerMove = (event: PointerEvent): void => {
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
        return;
      }

      const shellRect = shellRef.current?.getBoundingClientRect();
      if (!shellRect) {
        return;
      }

      const nextWidth = clampSidebarWidth(event.clientX - shellRect.left, shellRect.width);
      setSidebarWidth(nextWidth);
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
        return;
      }

      activePointerIdRef.current = null;
      setResizingSidebar(false);
    };

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [resizingSidebar]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.key === selectedSessionKey) ?? null,
    [sessions, selectedSessionKey]
  );

  const messages = selectedSessionKey ? messagesBySession[selectedSessionKey] ?? [] : [];
  const costDisplay: SessionCostDisplay = useMemo(() => {
    if (!selectedSessionKey) {
      return { costAvailable: false };
    }

    const threadId = selectedSession?.threadId;
    const model = pickThreadScopedValue(modelBySession, selectedSessionKey, threadId);
    const tokenUsage = pickThreadScopedValue(
      tokenUsageBySession,
      selectedSessionKey,
      threadId
    );
    const usdCost = pickThreadScopedValue(costUsdBySession, selectedSessionKey, threadId);
    return {
      ...(model ? { model } : {}),
      ...(tokenUsage ? { tokenUsage } : {}),
      ...(typeof usdCost === "number" ? { usdCost } : {}),
      costAvailable: typeof usdCost === "number"
    };
  }, [
    selectedSession,
    selectedSessionKey,
    modelBySession,
    tokenUsageBySession,
    costUsdBySession
  ]);

  return (
    <div className={`app-shell ${resizingSidebar ? "app-shell--resizing" : ""}`} ref={shellRef}>
      <div className="app-shell__sidebar-pane" style={{ width: `${sidebarWidth}px` }}>
        <Sidebar
          devices={devices}
          sessions={sessions}
          selectedSessionKey={selectedSessionKey}
          loading={loading}
          onSelectSession={(sessionKey) => {
            void selectSession(sessionKey);
          }}
          onAddSsh={(request) => {
            void addSsh(request);
          }}
          onConnect={(deviceId) => {
            void connect(deviceId);
          }}
          onDisconnect={(deviceId) => {
            void disconnect(deviceId);
          }}
          onRemove={(deviceId) => {
            void remove(deviceId);
          }}
          onRefreshDevice={(deviceId) => {
            void refreshDeviceSessions(deviceId);
          }}
          onBrowseDirectories={(deviceId, cwd) =>
            browseDeviceDirectories(deviceId, cwd)
          }
          onStartNewSession={async (deviceId, cwd) => {
            const sessionKey = await startNewSession({ deviceId, cwd });
            if (sessionKey) {
              setComposerFocusToken((previous) => previous + 1);
            }
          }}
        />
      </div>

      <div
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        className="app-shell__splitter"
        onPointerDown={(event) => {
          if (window.matchMedia("(max-width: 980px)").matches) {
            return;
          }
          event.preventDefault();
          activePointerIdRef.current = event.pointerId;
          setResizingSidebar(true);
        }}
      />

      <main className="workspace">
        <header className="workspace__topbar">
          <h3>Unified Codex Sessions</h3>
          <button type="button" onClick={() => void refreshSessions()} disabled={loading}>
            Refresh all
          </button>
        </header>

        {globalError ? (
          <p className="workspace__banner workspace__banner--error" onClick={clearError}>
            {globalError}
          </p>
        ) : null}

        <ChatPanel session={selectedSession} messages={messages} costDisplay={costDisplay} />
        <Composer
          sessionKey={selectedSessionKey}
          disabled={loading || selectedSessionKey === null}
          focusToken={composerFocusToken}
          onSubmit={submitComposer}
        />
      </main>
    </div>
  );
}
