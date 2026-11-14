import { useRef, useState, type FormEvent } from "react";
import * as Schema from "effect/Schema";
import { request, Session, type ApiBody, type SavedSession } from "../lib/api";
import { Modal, Textarea } from "./ui";
import { ArrowUturnLeftIcon } from "@heroicons/react/16/solid";
import { DEFAULT_EFFORT, EffortPicker, ModelPicker } from "./model-select";
import { RepositoryPicker } from "./repositories";
import { AttachButton, AttachmentTray, useAttachmentInput } from "./attachments";
import { imagesBody, type Attachment } from "../lib/images";

/** Create the conversation only on submit; retries reuse both its ID and prompt receipt. */
export function NewSessionComposer({
  initial,
  onClose,
  onImport,
  onSaved,
  onCreated,
}: {
  initial: ApiBody;
  onClose: () => void;
  onImport: () => void;
  onSaved: (session: SavedSession) => void;
  onCreated: (session: SavedSession) => void;
}) {
  const [content, setContent] = useState("");
  const [repository, setRepository] = useState(initial.workspace?.repository ?? "");
  const [ref, setRef] = useState(initial.workspace?.ref ?? "");
  const [model, setModel] = useState(initial.model ?? "");
  const [effort, setEffort] = useState(initial.thinkingLevel ?? DEFAULT_EFFORT);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<SavedSession | null>(null);
  const requestId = useRef<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const input = useAttachmentInput(
    attachments,
    setAttachments,
    setError,
    pending || Boolean(created),
  );

  async function submit(event: FormEvent) {
    event.preventDefault();

    if (pending || input.reading || !content.trim()) return;
    setPending(true);
    setError("");

    try {
      let session = created;

      if (!session) {
        const body: ApiBody = {};

        if (model) body.model = model;
        body.thinkingLevel = effort;

        if (repository) {
          body.workspace = { repository };

          if (ref) body.workspace.ref = ref;

          if (repository === initial.workspace?.repository && initial.workspace.networkHosts)
            body.workspace.networkHosts = initial.workspace.networkHosts;
        }

        const result = Schema.decodeUnknownSync(Schema.fromJsonString(Session))(
          await request("/sessions", body),
        );

        session = {
          ...result,
          title: content.trim().split("\n")[0].slice(0, 80),
          repository,
          ref,
          updatedAt: Date.now(),
        };
        setCreated(session);
        // Keep a recoverable link even if prompt admission fails or the dialog is closed.
        onSaved(session);
      }

      requestId.current ??= crypto.randomUUID();
      await request(`/sessions/${encodeURIComponent(session.id)}/messages`, {
        content: content.trim(),
        requestId: requestId.current,
        ...imagesBody(attachments),
      });
      onCreated(session);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the session.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal title="New session" className="new-session-modal" bare onClose={onClose}>
      <form
        className="new-session-form"
        onSubmit={(event) => void submit(event)}
        onDragOver={input.onDragOver}
        onDrop={input.onDrop}
      >
        <fieldset
          disabled={pending || input.reading || Boolean(created)}
          className="new-session-fields"
        >
          <RepositoryPicker
            compact
            value={repository}
            onChange={(name, branch) => {
              setRepository(name);
              setRef(branch);
            }}
          />
          <label htmlFor="new-session-prompt" className="sr-only">
            Task
          </label>
          <Textarea
            id="new-session-prompt"
            name="content"
            placeholder="What do you want to work on?"
            autoFocus
            required
            maxLength={16384}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            onPaste={input.onPaste}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <AttachmentTray
            attachments={attachments}
            onRemove={(id) => setAttachments(attachments.filter((item) => item.id !== id))}
          />
        </fieldset>
        {error && (
          <p role="alert" className="error-text">
            {error}
            {created ? " Your session is saved. Retry to send this task." : ""}
          </p>
        )}
        <div className="composer-toolbar">
          <div className="composer-tools">
            <AttachButton
              disabled={pending || input.reading || Boolean(created)}
              count={attachments.length}
              onFiles={(files) => void input.add(files)}
            />
            <button type="button" className="ghost-button" disabled={pending} onClick={onImport}>
              Open existing
            </button>
          </div>
          <ModelPicker
            id="new-session-model"
            value={model}
            disabled={pending || Boolean(created)}
            onChange={setModel}
          />
          <EffortPicker
            id="new-session-effort"
            value={effort}
            disabled={pending || Boolean(created)}
            onChange={setEffort}
          />
          <button
            type="submit"
            className="create-button"
            disabled={pending || input.reading || !content.trim()}
            aria-keyshortcuts="Meta+Enter Control+Enter"
          >
            {pending ? "Starting…" : created ? "Retry" : "Create"}
            {!pending && <ArrowUturnLeftIcon className="create-enter" aria-hidden="true" />}
          </button>
        </div>
      </form>
    </Modal>
  );
}
