import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { MAX_ACTION_ERROR_CHARS, type ActionError } from "@engineroom/protocol";
import { clearActionErrors, deleteActionError, listActionErrors, saveActionError } from "./api.ts";
import { errorSummary, message } from "./format.ts";

interface Notice {
  id: string;
  action: string;
  summary: string;
}

interface ErrorApi {
  errors: ActionError[];
  report: (action: string, error: unknown) => void;
  refresh: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
}

const ErrorContext = createContext<ErrorApi | null>(null);

export function ErrorProvider({ children }: { children: ReactNode }) {
  const [errors, setErrors] = useState<ActionError[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);

  const refresh = useCallback(async () => {
    setErrors(await listActionErrors());
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const report = useCallback((action: string, error: unknown) => {
    const text = (typeof error === "string" ? error : message(error)).replace(/\0/g, "").trim() || "request failed";
    const notice = { id: crypto.randomUUID(), action, summary: errorSummary(text) };
    setNotices((current) => [...current, notice].slice(-3));
    const stored = text.length > MAX_ACTION_ERROR_CHARS ? text.slice(0, MAX_ACTION_ERROR_CHARS) : text;
    void saveActionError(action, stored).then((saved) => {
      setErrors((current) => [saved, ...current.filter((item) => item.id !== saved.id)].slice(0, 200));
    }).catch(() => undefined);
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteActionError(id);
    setErrors((current) => current.filter((item) => item.id !== id));
  }, []);

  const clear = useCallback(async () => {
    await clearActionErrors();
    setErrors([]);
  }, []);

  const api = useMemo<ErrorApi>(() => ({ errors, report, refresh, remove, clear }), [errors, report, refresh, remove, clear]);

  return (
    <ErrorContext.Provider value={api}>
      {children}
      {notices.length > 0 && (
        <div className="error-stack" aria-live="polite">
          {notices.map((notice) => (
            <div className="error-popup" role="alert" key={notice.id}>
              <p><strong>{notice.action}</strong></p>
              <p className="muted">{notice.summary}</p>
              <div className="actions">
                <button className="ghost" type="button" onClick={() => dismiss(notice.id)}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </ErrorContext.Provider>
  );
}

export function useErrors(): ErrorApi {
  const api = useContext(ErrorContext);
  if (!api) throw new Error("error log is unavailable");
  return api;
}

export function useReportError(): (action: string, error: unknown) => void {
  return useErrors().report;
}
