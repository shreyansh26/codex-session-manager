import { useEffect, useMemo, useRef, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import Composer from "./components/Composer";
import Sidebar from "./components/Sidebar";
import {
  MODEL_CATALOG,
  getSupportedThinkingEfforts,
  getThinkingEffortLabel,
  resolveComposerModel,
  resolveSupportedModelId,
  resolveThinkingEffortForModel
} from "./domain/modelCatalog";
import type {
  ChatMessage,
  SearchSessionHit,
  SessionCostDisplay,
  ThreadHydrationState
} from "./domain/types";
import { shutdownRpcClients, useAppStore } from "./state/useAppStore";
import { shallow } from "zustand/shallow";

const REFRESH_INTERVAL_MS = 20_000;
const SIDEBAR_MIN_WIDTH_PX = 280;
const SIDEBAR_MAX_RATIO = 0.62;
const SEARCH_DEBOUNCE_MS = 170;
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_SEARCH_RESULTS: SearchSessionHit[] = [];
const DEFAULT_THREAD_HYDRATION_STATE: ThreadHydrationState = {
  baseLoading: false,
  baseLoaded: false,
  toolHistoryLoading: false
};
const SEARCH_IDLE_STATE = {
  searchResults: EMPTY_SEARCH_RESULTS,
  searchTotalHits: 0,
  searchLoading: false,
  searchHydrating: false,
  searchHydratedCount: 0,
  searchHydrationTotal: 0,
  searchError: null as string | null
};

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
  const [searchQueryText, setSearchQueryText] = useState("");
  const [searchDeviceScope, setSearchDeviceScope] = useState("__all__");
  const [searchResultsCollapsed, setSearchResultsCollapsed] = useState(false);

  const loading = useAppStore((state) => state.loading);
  const devices = useAppStore((state) => state.devices);
  const sessions = useAppStore((state) => state.sessions);
  const selectedSession = useAppStore((state) => {
    const selectedSessionKey = state.selectedSessionKey;
    if (!selectedSessionKey) {
      return null;
    }
    return state.sessions.find((session) => session.key === selectedSessionKey) ?? null;
  });
  const selectedSessionKey = selectedSession?.key ?? null;
  const messages = useAppStore((state) => {
    const key = state.selectedSessionKey;
    return key ? state.messagesBySession[key] ?? EMPTY_MESSAGES : EMPTY_MESSAGES;
  });
  const selectedThreadHydration = useAppStore((state) => {
    const key = state.selectedSessionKey;
    return key
      ? state.threadHydrationBySession[key] ?? DEFAULT_THREAD_HYDRATION_STATE
      : DEFAULT_THREAD_HYDRATION_STATE;
  });
  const selectedModel = useAppStore((state) =>
    pickThreadScopedValue(
      state.modelBySession,
      state.selectedSessionKey,
      selectedSession?.threadId
    )
  );
  const selectedTokenUsage = useAppStore((state) =>
    pickThreadScopedValue(
      state.tokenUsageBySession,
      state.selectedSessionKey,
      selectedSession?.threadId
    )
  );
  const selectedUsdCost = useAppStore((state) =>
    pickThreadScopedValue(
      state.costUsdBySession,
      state.selectedSessionKey,
      selectedSession?.threadId
    )
  );
  const availableModelsByDevice = useAppStore((state) => state.availableModelsByDevice);
  const selectedComposerPreference = useAppStore((state) => {
    const key = state.selectedSessionKey;
    return key ? state.composerPrefsBySession[key] : undefined;
  });
  const searchState = useAppStore(
    (state) =>
      searchQueryText.trim().length > 0
        ? {
            searchResults: state.searchResults,
            searchTotalHits: state.searchTotalHits,
            searchLoading: state.searchLoading,
            searchHydrating: state.searchHydrating,
            searchHydratedCount: state.searchHydratedCount,
            searchHydrationTotal: state.searchHydrationTotal,
            searchError: state.searchError
          }
        : SEARCH_IDLE_STATE,
    shallow
  );
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
  const setComposerModel = useAppStore((state) => state.setComposerModel);
  const setComposerThinkingEffort = useAppStore(
    (state) => state.setComposerThinkingEffort
  );
  const runChatSearch = useAppStore((state) => state.runChatSearch);
  const clearChatSearch = useAppStore((state) => state.clearChatSearch);

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

  useEffect(() => {
    const trimmedQuery = searchQueryText.trim();
    if (trimmedQuery.length === 0) {
      setSearchResultsCollapsed(false);
      clearChatSearch();
      return;
    }

    setSearchResultsCollapsed(false);
    const deviceScope = searchDeviceScope === "__all__" ? null : searchDeviceScope;
    const timer = window.setTimeout(() => {
      void runChatSearch(trimmedQuery, deviceScope);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchDeviceScope, searchQueryText, runChatSearch, clearChatSearch]);

  const costDisplay: SessionCostDisplay = useMemo(() => {
    if (!selectedSessionKey) {
      return { costAvailable: false };
    }

    return {
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(selectedTokenUsage ? { tokenUsage: selectedTokenUsage } : {}),
      ...(typeof selectedUsdCost === "number" ? { usdCost: selectedUsdCost } : {}),
      costAvailable: typeof selectedUsdCost === "number"
    };
  }, [
    selectedSessionKey,
    selectedModel,
    selectedTokenUsage,
    selectedUsdCost
  ]);

  const composerSelection = useMemo(() => {
    if (!selectedSessionKey) {
      const fallbackModel = resolveComposerModel(undefined);
      return {
        model: fallbackModel,
        thinkingEffort: resolveThinkingEffortForModel(fallbackModel, undefined)
      };
    }

    const currentPreference = selectedComposerPreference;
    const model = resolveComposerModel(currentPreference?.model);
    const thinkingEffort = resolveThinkingEffortForModel(
      model,
      currentPreference?.thinkingEffort
    );
    return { model, thinkingEffort };
  }, [selectedSessionKey, selectedComposerPreference]);

  const modelOptions = useMemo(() => {
    const rawAvailable =
      selectedSession ? availableModelsByDevice[selectedSession.deviceId] : undefined;
    const availabilityKnown = Array.isArray(rawAvailable);
    const available = new Set(
      (rawAvailable ?? [])
        .map((modelId) => resolveSupportedModelId(modelId))
        .filter((modelId): modelId is string => modelId !== null)
    );

    return MODEL_CATALOG.map((entry) => {
      const disabled = availabilityKnown && !available.has(entry.id);
      return {
        value: entry.id,
        label: disabled ? `${entry.label} (Unavailable)` : entry.label,
        disabled
      };
    });
  }, [selectedSession, availableModelsByDevice]);

  const thinkingOptions = useMemo(
    () =>
      getSupportedThinkingEfforts(composerSelection.model).map((effort) => ({
        value: effort,
        label: getThinkingEffortLabel(effort)
      })),
    [composerSelection.model]
  );

  const searchScopeOptions = useMemo(
    () =>
      devices.map((device) => ({
        value: device.id,
        label: device.name
      })),
    [devices]
  );

  const openSearchSession = (sessionHit: SearchSessionHit): void => {
    void selectSession(sessionHit.sessionKey)
      .then(() => {
        setSearchResultsCollapsed(true);
      })
      .catch(() => {
        // Session select errors are surfaced through global banner in store.
      });
  };

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
          <div className="workspace__search">
            <input
              type="search"
              value={searchQueryText}
              placeholder="Search across all chat messages..."
              onChange={(event) => setSearchQueryText(event.target.value)}
              aria-label="Search chats"
            />
            <select
              value={searchDeviceScope}
              onChange={(event) => setSearchDeviceScope(event.target.value)}
              aria-label="Search scope device"
            >
              <option value="__all__">All devices</option>
              {searchScopeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button type="button" onClick={() => void refreshSessions()} disabled={loading}>
            Refresh all
          </button>
        </header>

        {globalError ? (
          <p className="workspace__banner workspace__banner--error" onClick={clearError}>
            {globalError}
          </p>
        ) : null}

        {searchQueryText.trim().length > 0 && !searchResultsCollapsed ? (
          <section className="workspace__search-results">
            <div className="workspace__search-results-meta">
              <p>
                {searchState.searchLoading
                  ? "Searching..."
                  : `${searchState.searchTotalHits} match${searchState.searchTotalHits === 1 ? "" : "es"}`}
              </p>
              {!searchState.searchLoading && searchState.searchResults.length > 0 ? (
                <p>Showing top {searchState.searchResults.length} session matches</p>
              ) : null}
              {searchState.searchHydrating ? (
                <p>
                  Hydrating sessions {searchState.searchHydratedCount}/
                  {searchState.searchHydrationTotal || "?"}
                </p>
              ) : null}
              {searchState.searchError ? (
                <p className="workspace__search-results-error">{searchState.searchError}</p>
              ) : null}
            </div>

            {searchState.searchResults.length === 0 && !searchState.searchLoading ? (
              <p className="workspace__search-results-empty">
                No high-confidence matches found.
              </p>
            ) : (
              <ul className="workspace__search-group-list">
                {searchState.searchResults.map((sessionHit) => (
                  <li key={sessionHit.sessionKey} className="workspace__search-group">
                    <button
                      type="button"
                      className="workspace__search-session"
                      onClick={() => openSearchSession(sessionHit)}
                    >
                      <div className="workspace__search-group-header">
                        <div>
                          <h4>{sessionHit.sessionTitle}</h4>
                          <p>
                            {sessionHit.deviceLabel} · {sessionHit.deviceAddress}
                          </p>
                        </div>
                        <span>
                          {sessionHit.hitCount} hit
                          {sessionHit.hitCount === 1 ? "" : "s"} · score{" "}
                          {sessionHit.maxScore.toFixed(2)}
                        </span>
                      </div>
                      <div>
                        <p className="workspace__search-session-meta">
                          Last active: {new Date(sessionHit.updatedAt).toLocaleString()}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <ChatPanel
          session={selectedSession}
          messages={messages}
          costDisplay={costDisplay}
          hydrationState={selectedThreadHydration}
        />
        <Composer
          sessionKey={selectedSessionKey}
          disabled={loading || selectedSessionKey === null}
          focusToken={composerFocusToken}
          model={composerSelection.model}
          thinkingEffort={composerSelection.thinkingEffort}
          modelOptions={modelOptions}
          thinkingOptions={thinkingOptions}
          onModelChange={(model) => {
            if (!selectedSessionKey) {
              return;
            }
            setComposerModel(selectedSessionKey, model);
          }}
          onThinkingEffortChange={(thinkingEffort) => {
            if (!selectedSessionKey) {
              return;
            }
            setComposerThinkingEffort(selectedSessionKey, thinkingEffort);
          }}
          onSubmit={submitComposer}
        />
      </main>
    </div>
  );
}
