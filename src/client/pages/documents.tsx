import { ALLOWED_UPLOAD_TYPES, DOCUMENT_KINDS, PREVIEWABLE_TYPES, type DocumentKind } from "@shared/constants";
import type { DocumentDTO } from "@shared/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, FileText, Pencil, Trash2, Upload } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Field, Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Badge, Card, EmptyState, ErrorState, Skeleton } from "@/components/ui/misc";
import { useToastError } from "@/hooks/useApiError";
import { useLocaleContext } from "@/hooks/useMe";
import { api } from "@/lib/api";
import { formatDate, formatFileSize } from "@/lib/format";
import { PageHeader } from "./system";

export default function DocumentsPage() {
  const { t, lang, tz, me } = useLocaleContext();
  const qc = useQueryClient();
  const onError = useToastError();
  const docs = useQuery({ queryKey: ["documents"], queryFn: () => api.get<{ items: DocumentDTO[] }>("/api/documents") });
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DocumentDTO | null>(null);
  const [preview, setPreview] = React.useState<DocumentDTO | null>(null);
  const [deleting, setDeleting] = React.useState<DocumentDTO | null>(null);
  const enabled = me?.config.uploads_enabled ?? false;
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/documents/${id}`),
    onSuccess: () => {
      toast.success(t("documents.deleted"));
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ["documents"] });
    },
    onError,
  });
  const grouped = DOCUMENT_KINDS.map((k) => ({ kind: k, items: (docs.data?.items ?? []).filter((d) => d.kind === k) })).filter((g) => g.items.length);

  return (
    <div>
      <PageHeader
        title={t("documents.title")}
        subtitle={t("documents.subtitle")}
        actions={
          <Button variant="primary" disabled={!enabled} onClick={() => setUploadOpen(true)}>
            <Upload />
            {t("documents.upload")}
          </Button>
        }
      />
      {!enabled && me ? <p className="mb-4 rounded-md bg-info-soft px-3 py-2 text-xs text-info">{t("documents.disabled")}</p> : null}
      {docs.isError ? (
        <ErrorState message={t("common.loadingFailed")} onRetry={() => docs.refetch()} retryLabel={t("actions.retry")} />
      ) : docs.isLoading ? (
        <Skeleton className="h-48" />
      ) : !docs.data?.items.length ? (
        <Card>
          <EmptyState icon={<FileText />} title={t("documents.empty")} body={t("documents.emptyBody")} />
        </Card>
      ) : (
        <div className="space-y-5">
          {grouped.map((g) => (
            <section key={g.kind}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-4">{t(`documents.kind.${g.kind}`)}</h2>
              <Card className="divide-y divide-line">
                {g.items.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <FileText className="size-5 text-ink-4" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{d.version_name}</p>
                      <p className="truncate text-xs text-ink-3">
                        {d.file_name} · {formatFileSize(d.size_bytes, lang)} · {formatDate(d.created_at, lang, tz)}
                      </p>
                      {d.notes ? <p className="mt-0.5 text-xs text-ink-3">{d.notes}</p> : null}
                    </div>
                    <Badge tone={d.usage_count ? "accent" : "outline"}>{d.usage_count ? t("documents.usedIn", { count: d.usage_count }) : t("documents.unused")}</Badge>
                    <div className="flex gap-1">
                      {PREVIEWABLE_TYPES.includes(d.mime_type) ? (
                        <Button variant="ghost" size="icon" aria-label={t("actions.preview")} onClick={() => setPreview(d)}>
                          <Eye />
                        </Button>
                      ) : null}
                      <Button variant="ghost" size="icon" asChild aria-label={t("actions.download")}>
                        <a href={`/api/documents/${d.id}/content`} download={d.file_name}>
                          <Download />
                        </a>
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={t("actions.edit")} onClick={() => setEditing(d)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon" aria-label={t("actions.delete")} onClick={() => setDeleting(d)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                ))}
              </Card>
            </section>
          ))}
        </div>
      )}
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} maxBytes={me?.config.max_upload_bytes ?? 0} />
      <EditDialog doc={editing} onClose={() => setEditing(null)} />
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent title={preview?.version_name ?? ""} size="xl">
          {preview ? (
            preview.mime_type.startsWith("image/") ? (
              <img src={`/api/documents/${preview.id}/content?disposition=inline`} alt={preview.version_name} className="mx-auto max-h-[70vh]" />
            ) : (
              <iframe title={preview.version_name} src={`/api/documents/${preview.id}/content?disposition=inline`} className="h-[70vh] w-full rounded border border-line" />
            )
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title={t("common.confirmDeleteTitle")} body={t("documents.deleteBody")} onConfirm={() => deleting && del.mutate(deleting.id)} busy={del.isPending} />
    </div>
  );
}

function UploadDialog({ open, onOpenChange, maxBytes }: { open: boolean; onOpenChange: (o: boolean) => void; maxBytes: number }) {
  const { t, lang } = useLocaleContext();
  const qc = useQueryClient();
  const onError = useToastError();
  const [file, setFile] = React.useState<File | null>(null);
  const [kind, setKind] = React.useState<DocumentKind>("resume");
  const [version, setVersion] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (open) {
      setFile(null);
      setVersion("");
      setNotes("");
      setError(null);
    }
  }, [open]);
  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append("file", file!);
      fd.append("kind", kind);
      fd.append("version_name", version);
      if (notes) fd.append("notes", notes);
      return api.upload("/api/documents", fd);
    },
    onSuccess: () => {
      toast.success(t("documents.uploaded"));
      void qc.invalidateQueries({ queryKey: ["documents"] });
      onOpenChange(false);
    },
    onError,
  });
  const pick = (f: File | null) => {
    setError(null);
    if (!f) return setFile(null);
    if (!(f.type in ALLOWED_UPLOAD_TYPES)) return setError(t("errors.unsupported_file_type"));
    if (f.size > maxBytes) return setError(t("errors.file_too_large"));
    setFile(f);
    if (!version) setVersion(f.name.replace(/\.[^.]+$/, ""));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={t("documents.uploadTitle")} size="md">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (file && version) upload.mutate();
          }}
        >
          <Field label={t("documents.file")} htmlFor="doc-file" error={error ?? undefined} hint={t("documents.allowed", { size: formatFileSize(maxBytes, lang) })}>
            <Input id="doc-file" type="file" accept={Object.keys(ALLOWED_UPLOAD_TYPES).join(",")} onChange={(e) => pick(e.target.files?.[0] ?? null)} className="h-auto py-1.5" />
          </Field>
          <Field label={t("documents.kindLabel")} htmlFor="doc-kind">
            <NativeSelect id="doc-kind" value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`documents.kind.${k}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("documents.versionName")} htmlFor="doc-version">
            <Input id="doc-version" value={version} onChange={(e) => setVersion(e.target.value)} placeholder={t("documents.versionPlaceholder")} required maxLength={200} />
          </Field>
          <Field label={t("common.notes")} htmlFor="doc-notes">
            <Textarea id="doc-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("actions.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!file || !version || upload.isPending}>
              {upload.isPending ? t("actions.saving") : t("actions.upload")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({ doc, onClose }: { doc: DocumentDTO | null; onClose: () => void }) {
  const { t } = useLocaleContext();
  const qc = useQueryClient();
  const onError = useToastError();
  const [version, setVersion] = React.useState("");
  const [kind, setKind] = React.useState<string>("resume");
  const [notes, setNotes] = React.useState("");
  React.useEffect(() => {
    if (doc) {
      setVersion(doc.version_name);
      setKind(doc.kind);
      setNotes(doc.notes ?? "");
    }
  }, [doc]);
  const save = useMutation({
    mutationFn: () => api.patch(`/api/documents/${doc!.id}`, { version_name: version, kind, notes: notes || null }),
    onSuccess: () => {
      toast.success(t("documents.updated"));
      void qc.invalidateQueries({ queryKey: ["documents"] });
      onClose();
    },
    onError,
  });
  return (
    <Dialog open={!!doc} onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={t("actions.edit")} size="sm">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label={t("documents.versionName")} htmlFor="ed-version">
            <Input id="ed-version" value={version} onChange={(e) => setVersion(e.target.value)} required />
          </Field>
          <Field label={t("documents.kindLabel")} htmlFor="ed-kind">
            <NativeSelect id="ed-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {DOCUMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`documents.kind.${k}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label={t("common.notes")} htmlFor="ed-notes">
            <Textarea id="ed-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>
              {t("actions.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={save.isPending}>
              {t("actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
