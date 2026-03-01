import { useEffect, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";

interface ComposerProps {
  sessionKey: string | null;
  disabled: boolean;
  onSubmit: (prompt: string) => Promise<void> | void;
}

export default function Composer({
  sessionKey,
  disabled,
  onSubmit
}: ComposerProps) {
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setDraft("");
  }, [sessionKey]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = draft.trim();
    if (disabled || prompt.length === 0) {
      return;
    }

    setDraft("");
    void onSubmit(prompt);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      const prompt = draft.trim();
      if (!disabled && prompt.length > 0) {
        setDraft("");
        void onSubmit(prompt);
      }
    }
  };

  return (
    <form className="composer" onSubmit={(event) => void submit(event)}>
      <textarea
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => void handleKeyDown(event)}
        placeholder="Continue this session..."
        rows={3}
      />
      <div className="composer__actions">
        <p>Send with Ctrl/Cmd + Enter</p>
        <button type="submit" disabled={disabled || draft.trim().length === 0}>
          Send
        </button>
      </div>
    </form>
  );
}
