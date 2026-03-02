import { useEffect, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  FormEvent,
  KeyboardEvent
} from "react";
import type { ChatImageAttachment, ComposerSubmission } from "../domain/types";

interface ComposerProps {
  sessionKey: string | null;
  disabled: boolean;
  focusToken?: number;
  onSubmit: (submission: ComposerSubmission) => Promise<void> | void;
}

const makeAttachmentId = (): string =>
  `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") {
        resolve(result);
      } else {
        reject(new Error("Failed to read image data from clipboard."));
      }
    };
    reader.onerror = () => {
      reject(new Error("Unable to read pasted image."));
    };
    reader.readAsDataURL(file);
  });

const toImageAttachment = async (file: File): Promise<ChatImageAttachment | null> => {
  if (!file.type.startsWith("image/")) {
    return null;
  }

  const url = await fileToDataUrl(file);
  return {
    id: makeAttachmentId(),
    url,
    mimeType: file.type,
    fileName: file.name || "pasted-image",
    sizeBytes: Number.isFinite(file.size) ? file.size : undefined
  };
};

const formatSize = (sizeBytes?: number): string => {
  if (!sizeBytes || sizeBytes <= 0) {
    return "";
  }

  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function Composer({
  sessionKey,
  disabled,
  focusToken = 0,
  onSubmit
}: ComposerProps) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatImageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft("");
    setAttachments([]);
  }, [sessionKey]);

  useEffect(() => {
    if (disabled) {
      return;
    }

    textareaRef.current?.focus();
  }, [disabled, focusToken]);

  const submitCurrent = () => {
    const prompt = draft.trim();
    if (disabled || (prompt.length === 0 && attachments.length === 0)) {
      return;
    }

    const submission: ComposerSubmission = {
      prompt,
      images: attachments.map((attachment) => ({ ...attachment }))
    };
    setDraft("");
    setAttachments([]);
    void onSubmit(submission);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitCurrent();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submitCurrent();
    }
  };

  const handlePaste = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const clipboard = event.clipboardData;
    if (!clipboard) {
      return;
    }

    const filesFromItems = clipboard.items
      ? Array.from(clipboard.items)
          .filter((item) => item.type.startsWith("image/"))
          .map((item) => item.getAsFile())
          .filter((file): file is File => file !== null)
      : [];
    const filesFromClipboard = Array.from(clipboard.files ?? []).filter((file) =>
      file.type.startsWith("image/")
    );
    const imageFiles =
      filesFromItems.length > 0 ? filesFromItems : filesFromClipboard;

    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    const next = await Promise.allSettled(
      imageFiles.map((file) => toImageAttachment(file))
    );
    const validAttachments = next
      .filter(
        (
          result
        ): result is PromiseFulfilledResult<ChatImageAttachment | null> =>
          result.status === "fulfilled"
      )
      .map((result) => result.value)
      .filter((attachment): attachment is ChatImageAttachment => attachment !== null);
    if (validAttachments.length === 0) {
      return;
    }

    setAttachments((previous) => [...previous, ...validAttachments]);
  };

  return (
    <form className="composer" onSubmit={(event) => void submit(event)}>
      {attachments.length > 0 ? (
        <ul className="composer__attachments">
          {attachments.map((attachment, index) => (
            <li key={attachment.id} className="composer__attachment">
              <img
                className="composer__attachment-image"
                src={attachment.url}
                alt={`Pasted image ${index + 1}`}
              />
              <div className="composer__attachment-meta">
                <p className="composer__attachment-name">
                  {attachment.fileName ?? `image-${index + 1}`}
                </p>
                <p className="composer__attachment-size">
                  {formatSize(attachment.sizeBytes)}
                </p>
              </div>
              <button
                type="button"
                className="composer__attachment-remove"
                onClick={() =>
                  setAttachments((previous) =>
                    previous.filter((entry) => entry.id !== attachment.id)
                  )
                }
                aria-label={`Remove image ${index + 1}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        ref={textareaRef}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => void handleKeyDown(event)}
        onPaste={(event) => void handlePaste(event)}
        placeholder="Continue this session..."
        rows={3}
      />
      <div className="composer__actions">
        <p>Paste image with Ctrl/Cmd + V. Send with Ctrl/Cmd + Enter.</p>
        <button
          type="submit"
          disabled={disabled || (draft.trim().length === 0 && attachments.length === 0)}
        >
          Send
        </button>
      </div>
    </form>
  );
}
