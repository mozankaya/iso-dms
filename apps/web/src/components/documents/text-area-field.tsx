import { Label } from "@/components/ui/label";

/** A labelled text box for the short free text the dialogs ask for (a summary, a comment, a reason). */
export function TextAreaField({
  id,
  label,
  hint,
  value,
  onChange,
  invalid,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        maxLength={2000}
        placeholder={hint}
        aria-invalid={invalid ? true : undefined}
        className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm placeholder:text-muted focus-visible:outline-2 focus-visible:outline-primary aria-invalid:border-destructive"
      />
    </div>
  );
}
