"use client";

import { Loader2 } from "lucide-react";
import {
  createContext,
  useActionState,
  useContext,
  useEffect,
  useRef,
  startTransition,
  type ComponentProps,
  type FormEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/result";
import { Button, type ButtonSize, type ButtonVariant } from "./button";
import { Callout } from "./card";
import { Field, Input, Select, Textarea } from "./form";

type FormAction = (previous: ActionResult | null, formData: FormData) => Promise<ActionResult>;

interface FormState {
  state: ActionResult | null;
  pending: boolean;
}

const FormContext = createContext<FormState>({ state: null, pending: false });

export function useFormState(): FormState {
  return useContext(FormContext);
}

export function useFieldError(name: string): string | null {
  const { state } = useContext(FormContext);
  return state && !state.ok ? (state.fieldErrors?.[name] ?? null) : null;
}

/**
 * A form bound to a server action. Entered values are kept when the action reports a problem
 * (the browser's automatic reset is bypassed), field errors are shown next to their fields and
 * the outcome is announced with a toast.
 */
export function ActionForm({
  action,
  children,
  className,
  onSuccess,
  resetOnSuccess = false,
  toastOnSuccess = true,
}: {
  action: FormAction;
  children: ReactNode;
  className?: string;
  onSuccess?: (result: ActionResult) => void;
  resetOnSuccess?: boolean;
  toastOnSuccess?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const handled = useRef<ActionResult | null>(null);
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
  }, [onSuccess]);

  useEffect(() => {
    if (!state || handled.current === state) return;
    handled.current = state;
    if (state.ok) {
      if (toastOnSuccess && state.message) toast.success(state.message);
      if (resetOnSuccess) ref.current?.reset();
      onSuccessRef.current?.(state);
    } else if (!state.fieldErrors || Object.keys(state.fieldErrors).length === 0) {
      toast.error(state.message);
    } else {
      // Move focus to the first field with a problem.
      const first = Object.keys(state.fieldErrors)[0];
      const field = first ? ref.current?.querySelector<HTMLElement>(`[name="${first}"]`) : null;
      field?.focus();
    }
  }, [state, resetOnSuccess, toastOnSuccess]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    startTransition(() => formAction(data));
  };

  return (
    <form ref={ref} onSubmit={onSubmit} className={className} noValidate>
      <FormContext.Provider value={{ state, pending }}>{children}</FormContext.Provider>
    </form>
  );
}

/** Shows an action's error (when it is not tied to a field) inside the form. */
export function FormError() {
  const { state } = useContext(FormContext);
  if (!state || state.ok) return null;
  const hasFieldErrors = state.fieldErrors && Object.keys(state.fieldErrors).length > 0;
  return (
    <Callout tone="bad" role="alert">
      {hasFieldErrors ? "Check the highlighted fields." : state.message}
    </Callout>
  );
}

export function FormSubmit({
  children,
  variant = "primary",
  size = "md",
  className,
  disabled,
}: {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  disabled?: boolean;
}) {
  const { pending } = useContext(FormContext);
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      className={className}
      disabled={pending || disabled}
      aria-busy={pending}
    >
      {pending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
      {children}
    </Button>
  );
}

interface BaseFieldProps {
  name: string;
  label: ReactNode;
  hint?: ReactNode;
  optional?: boolean;
  fieldClassName?: string;
}

function describedBy(name: string, hint: ReactNode, error: string | null): string | undefined {
  if (error) return `${name}-error`;
  return hint ? `${name}-hint` : undefined;
}

export function TextField({
  name,
  label,
  hint,
  optional,
  fieldClassName,
  id,
  ...props
}: BaseFieldProps & Omit<ComponentProps<"input">, "name">) {
  const error = useFieldError(name);
  const fieldId = id ?? name;
  return (
    <Field
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      optional={optional}
      className={fieldClassName}
    >
      <Input
        id={fieldId}
        name={name}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(fieldId, hint, error)}
        {...props}
      />
    </Field>
  );
}

export function TextareaField({
  name,
  label,
  hint,
  optional,
  fieldClassName,
  id,
  ...props
}: BaseFieldProps & Omit<ComponentProps<"textarea">, "name">) {
  const error = useFieldError(name);
  const fieldId = id ?? name;
  return (
    <Field
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      optional={optional}
      className={fieldClassName}
    >
      <Textarea
        id={fieldId}
        name={name}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(fieldId, hint, error)}
        {...props}
      />
    </Field>
  );
}

export function SelectField({
  name,
  label,
  hint,
  optional,
  fieldClassName,
  id,
  children,
  ...props
}: BaseFieldProps & Omit<ComponentProps<"select">, "name">) {
  const error = useFieldError(name);
  const fieldId = id ?? name;
  return (
    <Field
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      optional={optional}
      className={fieldClassName}
    >
      <Select
        id={fieldId}
        name={name}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(fieldId, hint, error)}
        {...props}
      >
        {children}
      </Select>
    </Field>
  );
}
