"use client";

import { FEEDBACK_MAX_LENGTH, FEEDBACK_MIN_LENGTH } from "@iso-dms/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api/client";
import { sendFeedback } from "@/lib/api/endpoints";
import { errorMessage, tr } from "@/lib/i18n/tr";

const t = tr.feedback;

/**
 * "Geri Bildirim" on the page of a document in force (PROJECT.md 9, screen 4): anybody who sees the document may
 * tell the quality management what is missing, wrong or could be better. Sending is final (the message becomes a
 * record), so the form only says it was received.
 */
export function FeedbackForm({ documentId }: { documentId: string }) {
  const queryClient = useQueryClient();
  const messageId = useId();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const send = useMutation({ mutationFn: (text: string) => sendFeedback(documentId, text) });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSent(false);
    const text = message.trim();
    if (text.length < FEEDBACK_MIN_LENGTH) {
      setError(t.tooShort(FEEDBACK_MIN_LENGTH));
      return;
    }

    setError(null);
    try {
      await send.mutateAsync(text);
    } catch (caught) {
      setError(caught instanceof ApiError ? errorMessage(caught) : tr.errors.NETWORK);
      return;
    }
    setMessage("");
    setSent(true);
    // The quality managers' counter and the history of the document know one more entry
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["feedback"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] }),
      queryClient.invalidateQueries({ queryKey: ["audit-logs"] }),
    ]);
  }

  return (
    <section aria-labelledby="feedback-heading" className="space-y-3">
      <h2 id="feedback-heading" className="text-lg font-semibold">
        {t.title}
      </h2>
      <Card className="p-5">
        <form onSubmit={submit} className="space-y-3" noValidate>
          <p className="text-sm text-muted">{t.sectionHint}</p>
          <div className="space-y-1.5">
            <Label htmlFor={messageId}>{t.label}</Label>
            <textarea
              id={messageId}
              value={message}
              onChange={(event) => {
                setMessage(event.target.value);
                setSent(false);
              }}
              rows={3}
              maxLength={FEEDBACK_MAX_LENGTH}
              placeholder={t.placeholder}
              aria-invalid={error === t.tooShort(FEEDBACK_MIN_LENGTH) ? true : undefined}
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-primary aria-invalid:border-destructive"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {sent && (
            <p role="status" className="text-sm text-emerald-700">
              {t.sent}
            </p>
          )}

          <Button type="submit" disabled={send.isPending}>
            {send.isPending ? t.submitting : t.submit}
          </Button>
        </form>
      </Card>
    </section>
  );
}
