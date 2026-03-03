use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use strsim::normalized_levenshtein;
use thiserror::Error;

const SEARCH_INDEX_VERSION: u32 = 1;
const DEFAULT_THRESHOLD: f64 = 0.90;
const DEFAULT_MAX_SESSIONS: usize = 10;
const MIN_FUZZY_QUERY_CHARS: usize = 4;
const MAX_WINDOW_TOKEN_SCAN: usize = 220;

#[derive(Debug, Clone, Default)]
pub struct SearchIndex {
    sessions: HashMap<String, SessionEntry>,
    indexed_message_count: usize,
    last_updated_at_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct SessionEntry {
    session_key: String,
    thread_id: String,
    device_id: String,
    session_title: String,
    device_label: String,
    device_address: String,
    updated_at: String,
    messages: HashMap<String, IndexedMessage>,
}

#[derive(Debug, Clone)]
struct IndexedMessage {
    message_id: String,
    role: String,
    content: String,
    content_normalized: String,
    tokens: Vec<String>,
    token_set: HashSet<String>,
    created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexThreadPayload {
    pub session_key: String,
    pub thread_id: String,
    pub device_id: String,
    pub session_title: String,
    pub device_label: String,
    pub device_address: String,
    pub updated_at: String,
    pub messages: Vec<SearchIndexMessagePayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexMessagePayload {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexRemoveDeviceRequest {
    pub device_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryRequest {
    pub query: String,
    pub device_id: Option<String>,
    pub threshold: Option<f64>,
    pub max_sessions: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQueryResponse {
    pub query: String,
    pub total_hits: usize,
    pub session_hits: Vec<SearchSessionHit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSessionHit {
    pub session_key: String,
    pub thread_id: String,
    pub device_id: String,
    pub session_title: String,
    pub device_label: String,
    pub device_address: String,
    pub updated_at: String,
    pub max_score: f64,
    pub hit_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchBootstrapStatus {
    pub indexed_sessions: usize,
    pub indexed_messages: usize,
    pub last_updated_at_ms: Option<u64>,
}

#[derive(Debug, Error)]
pub enum SearchIndexStorageError {
    #[error("{0}")]
    Io(io::Error),
    #[error("{0}")]
    Parse(serde_json::Error),
}

impl SearchIndex {
    pub fn load_from_path(path: &Path) -> Result<Self, SearchIndexStorageError> {
        if !path.exists() {
            return Ok(Self::default());
        }

        let content = fs::read_to_string(path).map_err(SearchIndexStorageError::Io)?;
        let persisted = serde_json::from_str::<PersistedSearchIndex>(&content)
            .map_err(SearchIndexStorageError::Parse)?;

        let mut sessions = HashMap::new();
        let mut indexed_message_count = 0usize;
        for persisted_session in persisted.sessions {
            let mut messages = HashMap::new();
            for message in persisted_session.messages {
                if message.message_id.trim().is_empty() {
                    continue;
                }
                let normalized = normalize_for_search(&message.content);
                let tokens = tokenize(&normalized);
                let token_set = tokens.iter().cloned().collect::<HashSet<_>>();
                messages.insert(
                    message.message_id.clone(),
                    IndexedMessage {
                        message_id: message.message_id,
                        role: message.role,
                        content: message.content,
                        content_normalized: normalized,
                        tokens,
                        token_set,
                        created_at: message.created_at,
                    },
                );
            }

            indexed_message_count += messages.len();
            sessions.insert(
                persisted_session.session_key.clone(),
                SessionEntry {
                    session_key: persisted_session.session_key,
                    thread_id: persisted_session.thread_id,
                    device_id: persisted_session.device_id,
                    session_title: persisted_session.session_title,
                    device_label: persisted_session.device_label,
                    device_address: persisted_session.device_address,
                    updated_at: persisted_session.updated_at,
                    messages,
                },
            );
        }

        Ok(Self {
            sessions,
            indexed_message_count,
            last_updated_at_ms: persisted.last_updated_at_ms,
        })
    }

    pub fn persist_to_path(&self, path: &Path) -> Result<(), SearchIndexStorageError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(SearchIndexStorageError::Io)?;
        }

        let payload = self.to_persisted();
        let serialized = serde_json::to_string(&payload).map_err(SearchIndexStorageError::Parse)?;
        fs::write(path, serialized).map_err(SearchIndexStorageError::Io)?;
        Ok(())
    }

    pub fn upsert_thread(&mut self, payload: SearchIndexThreadPayload) {
        if payload.session_key.trim().is_empty() {
            return;
        }

        let previous_count = self
            .sessions
            .get(&payload.session_key)
            .map(|entry| entry.messages.len())
            .unwrap_or(0);

        let mut messages = HashMap::new();
        for message in payload.messages {
            if message.id.trim().is_empty() {
                continue;
            }

            let normalized = normalize_for_search(&message.content);
            let tokens = tokenize(&normalized);
            let token_set = tokens.iter().cloned().collect::<HashSet<_>>();
            messages.insert(
                message.id.clone(),
                IndexedMessage {
                    message_id: message.id,
                    role: message.role,
                    content: message.content,
                    content_normalized: normalized,
                    tokens,
                    token_set,
                    created_at: message.created_at.clone(),
                },
            );
        }

        self.indexed_message_count = self
            .indexed_message_count
            .saturating_sub(previous_count)
            .saturating_add(messages.len());

        self.sessions.insert(
            payload.session_key.clone(),
            SessionEntry {
                session_key: payload.session_key,
                thread_id: payload.thread_id,
                device_id: payload.device_id,
                session_title: payload.session_title,
                device_label: payload.device_label,
                device_address: payload.device_address,
                updated_at: payload.updated_at,
                messages,
            },
        );
        self.last_updated_at_ms = Some(now_ms());
    }

    pub fn remove_device(&mut self, device_id: &str) -> usize {
        let keys_to_remove = self
            .sessions
            .iter()
            .filter(|(_, session)| session.device_id == device_id)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();

        let mut removed_sessions = 0usize;
        for session_key in keys_to_remove {
            if let Some(removed) = self.sessions.remove(&session_key) {
                self.indexed_message_count = self
                    .indexed_message_count
                    .saturating_sub(removed.messages.len());
                removed_sessions += 1;
            }
        }

        if removed_sessions > 0 {
            self.last_updated_at_ms = Some(now_ms());
        }

        removed_sessions
    }

    pub fn query(&self, request: SearchQueryRequest) -> SearchQueryResponse {
        let trimmed_query = request.query.trim().to_owned();
        if trimmed_query.is_empty() {
            return SearchQueryResponse {
                query: trimmed_query,
                total_hits: 0,
                session_hits: Vec::new(),
            };
        }

        let normalized_query = normalize_for_search(&trimmed_query);
        if normalized_query.is_empty() {
            return SearchQueryResponse {
                query: trimmed_query,
                total_hits: 0,
                session_hits: Vec::new(),
            };
        }

        let query_tokens = tokenize(&normalized_query);
        let query_token_set = query_tokens.iter().cloned().collect::<HashSet<_>>();
        let threshold = request
            .threshold
            .unwrap_or(DEFAULT_THRESHOLD)
            .clamp(0.0, 1.0);
        let max_sessions = request
            .max_sessions
            .unwrap_or(DEFAULT_MAX_SESSIONS)
            .clamp(1, 120);
        let short_query = normalized_query.chars().count() < MIN_FUZZY_QUERY_CHARS;

        let mut grouped_hits = HashMap::<String, SearchSessionHit>::new();
        let mut total_hits = 0usize;
        for session in self.sessions.values() {
            if let Some(scope_device_id) = request.device_id.as_deref() {
                if session.device_id != scope_device_id {
                    continue;
                }
            }

            for message in session.messages.values() {
                let Some(score) = score_message(
                    &normalized_query,
                    &query_token_set,
                    query_tokens.len(),
                    short_query,
                    message,
                    threshold,
                ) else {
                    continue;
                };

                total_hits += 1;
                if let Some(group) = grouped_hits.get_mut(&session.session_key) {
                    group.max_score = group.max_score.max(score);
                    group.hit_count += 1;
                    continue;
                }

                grouped_hits.insert(
                    session.session_key.clone(),
                    SearchSessionHit {
                        session_key: session.session_key.clone(),
                        thread_id: session.thread_id.clone(),
                        device_id: session.device_id.clone(),
                        session_title: session.session_title.clone(),
                        device_label: session.device_label.clone(),
                        device_address: session.device_address.clone(),
                        updated_at: session.updated_at.clone(),
                        max_score: score,
                        hit_count: 1,
                    },
                );
            }
        }

        let mut session_hits = grouped_hits.into_values().collect::<Vec<_>>();
        session_hits.sort_by(|a, b| {
            b.max_score
                .partial_cmp(&a.max_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.hit_count.cmp(&a.hit_count))
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        session_hits.truncate(max_sessions);

        SearchQueryResponse {
            query: trimmed_query,
            total_hits,
            session_hits,
        }
    }

    pub fn bootstrap_status(&self) -> SearchBootstrapStatus {
        SearchBootstrapStatus {
            indexed_sessions: self.sessions.len(),
            indexed_messages: self.indexed_message_count,
            last_updated_at_ms: self.last_updated_at_ms,
        }
    }

    fn to_persisted(&self) -> PersistedSearchIndex {
        let mut sessions = self.sessions.values().cloned().collect::<Vec<_>>();
        sessions.sort_by(|a, b| {
            a.session_key
                .cmp(&b.session_key)
                .then(a.thread_id.cmp(&b.thread_id))
        });

        PersistedSearchIndex {
            version: SEARCH_INDEX_VERSION,
            last_updated_at_ms: self.last_updated_at_ms,
            sessions: sessions
                .into_iter()
                .map(|session| {
                    let mut messages = session.messages.values().cloned().collect::<Vec<_>>();
                    messages.sort_by(|a, b| {
                        a.created_at
                            .cmp(&b.created_at)
                            .then(a.message_id.cmp(&b.message_id))
                    });

                    PersistedSessionEntry {
                        session_key: session.session_key,
                        thread_id: session.thread_id,
                        device_id: session.device_id,
                        session_title: session.session_title,
                        device_label: session.device_label,
                        device_address: session.device_address,
                        updated_at: session.updated_at,
                        messages: messages
                            .into_iter()
                            .map(|message| PersistedMessageEntry {
                                message_id: message.message_id,
                                role: message.role,
                                content: message.content,
                                created_at: message.created_at,
                            })
                            .collect(),
                    }
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSearchIndex {
    version: u32,
    last_updated_at_ms: Option<u64>,
    sessions: Vec<PersistedSessionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSessionEntry {
    session_key: String,
    thread_id: String,
    device_id: String,
    session_title: String,
    device_label: String,
    device_address: String,
    updated_at: String,
    messages: Vec<PersistedMessageEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedMessageEntry {
    message_id: String,
    role: String,
    content: String,
    created_at: String,
}

fn normalize_for_search(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_alphanumeric() {
            normalized.extend(character.to_lowercase());
        } else if character.is_whitespace() {
            normalized.push(' ');
        }
    }

    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn tokenize(value: &str) -> Vec<String> {
    value
        .split_whitespace()
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect()
}

fn min_token_overlap(query_token_count: usize) -> usize {
    if query_token_count <= 1 {
        1
    } else if query_token_count <= 3 {
        2
    } else {
        ((query_token_count * 60) + 99) / 100
    }
}

fn score_message(
    normalized_query: &str,
    query_token_set: &HashSet<String>,
    query_token_count: usize,
    short_query: bool,
    message: &IndexedMessage,
    threshold: f64,
) -> Option<f64> {
    if normalized_query.is_empty() || message.content_normalized.is_empty() {
        return None;
    }

    let contains = message.content_normalized.contains(normalized_query);
    if short_query && !contains {
        return None;
    }

    if !contains {
        let overlap = query_token_set
            .iter()
            .filter(|token| message.token_set.contains(*token))
            .count();
        if overlap < min_token_overlap(query_token_count) {
            return None;
        }
    }

    let mut score = if contains {
        1.0
    } else {
        normalized_levenshtein(normalized_query, &message.content_normalized)
    };

    if !contains {
        score = score.max(best_window_similarity(
            normalized_query,
            query_token_count,
            &message.tokens,
        ));
    }

    if score >= threshold {
        Some(score)
    } else {
        None
    }
}

fn best_window_similarity(
    normalized_query: &str,
    query_token_count: usize,
    message_tokens: &[String],
) -> f64 {
    if message_tokens.is_empty() {
        return 0.0;
    }

    let token_scan_limit = message_tokens.len().min(MAX_WINDOW_TOKEN_SCAN);
    if token_scan_limit == 0 {
        return 0.0;
    }

    let target_tokens = query_token_count.max(1);
    let min_window = target_tokens.saturating_sub(1).max(1);
    let max_window = (target_tokens + 2).min(token_scan_limit);

    let mut best = 0.0;
    for window_size in min_window..=max_window {
        if window_size > token_scan_limit {
            break;
        }
        for start in 0..=(token_scan_limit - window_size) {
            let candidate = message_tokens[start..start + window_size].join(" ");
            let score = normalized_levenshtein(normalized_query, &candidate);
            if score > best {
                best = score;
                if best >= 0.999 {
                    return best;
                }
            }
        }
    }

    best
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        SearchIndex, SearchIndexMessagePayload, SearchIndexThreadPayload, SearchQueryRequest,
    };

    fn make_thread_payload(
        session_key: &str,
        thread_id: &str,
        device_id: &str,
        message_id: &str,
        message_content: &str,
    ) -> SearchIndexThreadPayload {
        SearchIndexThreadPayload {
            session_key: session_key.to_owned(),
            thread_id: thread_id.to_owned(),
            device_id: device_id.to_owned(),
            session_title: "Session title".to_owned(),
            device_label: format!("device-{device_id}"),
            device_address: format!("{device_id}.example"),
            updated_at: "2026-03-03T00:00:00.000Z".to_owned(),
            messages: vec![SearchIndexMessagePayload {
                id: message_id.to_owned(),
                role: "assistant".to_owned(),
                content: message_content.to_owned(),
                created_at: "2026-03-03T00:00:00.000Z".to_owned(),
            }],
        }
    }

    #[test]
    fn query_matches_typo_with_high_similarity() {
        let mut index = SearchIndex::default();
        index.upsert_thread(make_thread_payload(
            "device-a::thread-1",
            "thread-1",
            "device-a",
            "message-1",
            "Please check deployment status for production",
        ));

        let response = index.query(SearchQueryRequest {
            query: "deploymment status for production".to_owned(),
            device_id: None,
            threshold: Some(0.9),
            max_sessions: Some(10),
        });

        assert_eq!(response.total_hits, 1);
        assert_eq!(response.session_hits.len(), 1);
        assert_eq!(response.session_hits[0].hit_count, 1);
    }

    #[test]
    fn query_rejects_low_similarity_false_positive() {
        let mut index = SearchIndex::default();
        index.upsert_thread(make_thread_payload(
            "device-a::thread-1",
            "thread-1",
            "device-a",
            "message-1",
            "Please check deployment status for production",
        ));

        let response = index.query(SearchQueryRequest {
            query: "grocery shopping list for weekend".to_owned(),
            device_id: None,
            threshold: Some(0.9),
            max_sessions: Some(10),
        });

        assert_eq!(response.total_hits, 0);
        assert!(response.session_hits.is_empty());
    }

    #[test]
    fn query_filters_to_specific_device() {
        let mut index = SearchIndex::default();
        index.upsert_thread(make_thread_payload(
            "device-a::thread-1",
            "thread-1",
            "device-a",
            "message-1",
            "release checklist in progress",
        ));
        index.upsert_thread(make_thread_payload(
            "device-b::thread-2",
            "thread-2",
            "device-b",
            "message-2",
            "release checklist in progress",
        ));

        let response = index.query(SearchQueryRequest {
            query: "release checklist".to_owned(),
            device_id: Some("device-b".to_owned()),
            threshold: Some(0.9),
            max_sessions: Some(10),
        });

        assert_eq!(response.total_hits, 1);
        assert_eq!(response.session_hits.len(), 1);
        assert_eq!(response.session_hits[0].device_id, "device-b");
    }

    #[test]
    fn remove_device_clears_its_sessions() {
        let mut index = SearchIndex::default();
        index.upsert_thread(make_thread_payload(
            "device-a::thread-1",
            "thread-1",
            "device-a",
            "message-1",
            "release checklist in progress",
        ));
        index.upsert_thread(make_thread_payload(
            "device-b::thread-2",
            "thread-2",
            "device-b",
            "message-2",
            "release checklist in progress",
        ));

        let removed = index.remove_device("device-a");
        assert_eq!(removed, 1);

        let response = index.query(SearchQueryRequest {
            query: "release checklist".to_owned(),
            device_id: None,
            threshold: Some(0.9),
            max_sessions: Some(10),
        });

        assert_eq!(response.total_hits, 1);
        assert_eq!(response.session_hits[0].device_id, "device-b");
    }
}
