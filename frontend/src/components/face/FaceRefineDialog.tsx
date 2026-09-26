import clsx from "clsx";
import { AlertTriangle, ChevronRight, ImagePlus, ScanFace, Sparkles, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, urls } from "../../api/client";
import type { CropBox, Estimate, FaceDefaults, Upload } from "../../api/types";
import { uploadFiles } from "../../lib/actions";
import { estimateBasis, fmtEstimate, fmtSeconds } from "../../lib/format";
import { useAssistant } from "../../store/assistant";
import { useLibrary } from "../../store/library";
import { useUI } from "../../store/ui";
import { Button, Dialog, SectionTitle, Select, Spinner } from "../ui";
import { EditPromptButton } from "../assistant/EditPromptButton";
import { stripFence } from "../generate/PromptEditor";
import { CropEditor } from "./CropEditor";

// H3FaceTrackCrop "select" modes that need no extra coordinates
export const FACE_SELECT = [
  { value: "largest_face", label: "Самое крупное" },
  { value: "centre_most", label: "Ближе к центру кадра" },
  { value: "left_most", label: "Левее всех" },
  { value: "right_most", label: "Правее всех" },
  { value: "top_most", label: "Выше всех" },
  { value: "bottom_most", label: "Ниже всех" },
  { value: "smallest_face", label: "Самое мелкое" },
  { value: "detector_score", label: "Самое чёткое для детектора" },
];

/**
 * MiniMax_H3_FaceRefine_Best on a clip. Everything is pre-filled (whose face, the close-up crop,
 * a close-up prompt, workflow strength); the user usually just presses the button.
 */
export function FaceRefineDialog() {
  const state = useUI((s) => s.faceDialog);
  const close = () => useUI.getState().openFaceDialog(null);
  return (
    <Dialog open={state !== null} onOpenChange={(o) => !o && close()} title="Улучшить лицо" wide>
      {state && <FaceForm key={`${state.assetId}-${state.fromGenerationId ?? ""}`} assetId={state.assetId} fromGenerationId={state.fromGenerationId} onDone={close} />}
    </Dialog>
  );
}

function FaceForm({ assetId, fromGenerationId, onDone }: { assetId: number; fromGenerationId?: number; onDone: () => void }) {
  const fromGen = useLibrary((s) => (fromGenerationId ? s.generations[fromGenerationId] : undefined));
  const [defaults, setDefaults] = useState<FaceDefaults | null>(null);
  const [identity, setIdentity] = useState<Upload | null>(null);
  const [crop, setCrop] = useState<CropBox | null>(null);
  const [prompt, setPrompt] = useState("");
  const [denoise, setDenoise] = useState(0.35);
  const [select, setSelect] = useState("largest_face");
  const [editPrompt, setEditPrompt] = useState(false);
  const [aiPrompt, setAiPrompt] = useState<string | null>(null);
  const job = useAssistant((s) => s.job);
  const writing = job?.target === "face";
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .faceDefaults(assetId)
      .then(async (d) => {
        setDefaults(d);
        const p = fromGen?.ui_params;
        const idUpload = p?.identity_upload_id ? await api.uploadInfo(p.identity_upload_id).catch(() => d.identity) : d.identity;
        setIdentity(idUpload);
        setCrop((p?.closeup_crop as CropBox | undefined) ?? d.closeup_crop);
        setPrompt(p?.prompt ?? d.prompt);
        setDenoise(p?.denoise ?? d.presets.find((x) => x.id === "standard")?.denoise ?? 0.35);
        setSelect(p?.select ?? "largest_face");
        api.faceEstimate(assetId).then(setEstimate).catch(() => setEstimate(null));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось открыть клип"));
  }, [assetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const replaceIdentity = async (files: File[]) => {
    const [up] = await uploadFiles(files.filter((f) => f.type.startsWith("image/")));
    if (!up) return;
    setIdentity(up);
    autoCrop(up);
  };

  const autoCrop = async (up: Upload | null = identity) => {
    if (!up) return;
    setDetecting(true);
    try {
      const r = await api.faceDetect(up.id);
      setCrop(r.crop);
      if (!r.found) useUI.getState().toast("Лицо не найдено автоматически — поставьте рамку вручную", "info");
    } finally {
      setDetecting(false);
    }
  };

  const submit = async () => {
    if (!identity) return;
    setBusy(true);
    setError("");
    try {
      const g = await api.faceRefine({
        source_asset_id: assetId,
        identity_upload_id: identity.id,
        closeup_upload_id: null,
        closeup_crop: crop,
        prompt,
        denoise,
        select: select === "largest_face" ? null : select,
        seed: fromGen?.seed ?? null,
        profile_id: null,
      });
      useLibrary.getState().upsertGeneration(g);
      useUI.getState().selectGen(g.id);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && typeof e.detail === "object" && e.detail && (e.detail as { kind?: string }).kind === "missing_file") {
        useUI.getState().toast(e.message, "bad", { label: "Открыть настройки", run: () => useUI.getState().openSettings("engine") });
      }
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!defaults) {
    return (
      <div className="flex h-60 items-center justify-center gap-2 text-muted">
        {error ? <span className="text-bad">{error}</span> : <><Spinner /> Готовлю клип…</>}
      </div>
    );
  }

  const usesTemplate = prompt === defaults.prompt;

  // the local assistant looks at the photo, the close-up crop and a frame of the clip and writes the close-up prompt
  const composeWithAssistant = async () => {
    if (!identity) return;
    setEditPrompt(true);
    const result = await useAssistant.getState().run("face", "/api/assistant/face-prompt", {
      source_asset_id: assetId,
      identity_upload_id: identity.id,
      closeup_crop: crop,
    });
    if (result) {
      setPrompt(result);
      setAiPrompt(result);
    }
  };

  const editWithAssistant = async (instruction: string) => {
    if (!identity) return;
    setEditPrompt(true);
    const before = prompt;
    const result = await useAssistant.getState().run("face", "/api/assistant/edit", {
      prompt,
      instruction,
      face: { source_asset_id: assetId, identity_upload_id: identity.id, closeup_crop: crop },
    });
    if (!result) return;
    setPrompt(result);
    setAiPrompt(result);
    useUI.getState().toast("Промпт исправлен", "ok", { label: "Вернуть как было", run: () => setPrompt(before) });
  };

  return (
    <div className="space-y-5 p-5">
      <p className="-mt-1 text-xs leading-relaxed text-muted">
        Модель находит лицо на каждом кадре, перерисовывает его крупным планом по вашему референсу и аккуратно вклеивает обратно.
        Помогает на общих и дальних планах, где H3 «ломает» мелкие лица. Звук и всё вне лица остаются как были.
      </p>

      {/* source clip */}
      <div className="flex items-center gap-3 rounded-xl border border-line bg-raised/40 p-2.5">
        {defaults.asset.thumb && <img src={urls.assetThumb(defaults.asset.id)} alt="" className="h-12 w-20 rounded object-cover" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px]">{defaults.asset.name}</p>
          <p className="text-[11px] text-faint tabular-nums">
            {defaults.frames} кадров · {fmtSeconds(defaults.frames / 24)}
          </p>
        </div>
      </div>
      {defaults.warnings.map((w) => (
        <p key={w} className="-mt-3 flex items-center gap-1.5 text-xs text-warn">
          <AlertTriangle size={12} /> {w}
        </p>
      ))}

      <div className="grid grid-cols-[180px_1fr] gap-5">
        {/* whose face */}
        <section>
          <SectionTitle>Чьё лицо</SectionTitle>
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => {
            replaceIdentity([...(e.target.files ?? [])]);
            e.target.value = "";
          }} />
          {identity ? (
            <button
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                replaceIdentity([...e.dataTransfer.files]);
              }}
              className="group relative block w-full overflow-hidden rounded-lg ring-1 ring-line hover:ring-accent/60"
              title="Заменить фото"
            >
              <img src={urls.uploadThumb(identity.id)} alt="" className="aspect-square w-full object-cover" />
              <span className="absolute inset-x-0 bottom-0 bg-black/70 py-1 text-center text-[11px] text-white opacity-0 group-hover:opacity-100">Заменить</span>
            </button>
          ) : (
            <button
              onClick={() => fileInput.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                replaceIdentity([...e.dataTransfer.files]);
              }}
              className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-strong px-2 text-center text-xs text-muted hover:border-accent/60"
            >
              <ImagePlus size={18} /> Фото персонажа
            </button>
          )}
          <p className="mt-1.5 text-[11px] leading-snug text-faint">{"<Picture 1>"}: личность и внешность. Лучше тот же реф, что при генерации.</p>
        </section>

        {/* close-up crop */}
        <section>
          <SectionTitle
            right={
              identity && (
                <Button size="sm" variant="ghost" onClick={() => autoCrop()} disabled={detecting}>
                  {detecting ? <Spinner size={12} /> : <ScanFace size={13} />} Найти лицо
                </Button>
              )
            }
          >
            Крупный план лица
          </SectionTitle>
          {identity ? (
            <>
              <CropEditor src={urls.uploadFile(identity.id)} value={crop} onChange={setCrop} />
              <p className="mt-1.5 text-[11px] leading-snug text-faint">
                {"<Picture 2>"}: рамка на лице (глаза, брови, кожа) без лишнего вокруг — черты меньше «гуляют» от кадра к кадру. Тяните рамку или её углы.
              </p>
            </>
          ) : (
            <p className="text-xs text-muted">Сначала выберите фото персонажа</p>
          )}
        </section>
      </div>

      {/* strength */}
      <section>
        <SectionTitle>Сила</SectionTitle>
        <div className="grid grid-cols-3 gap-1.5">
          {defaults.presets.map((p) => (
            <button
              key={p.id}
              onClick={() => setDenoise(p.denoise)}
              className={clsx(
                "rounded-lg border px-3 py-2 text-left transition-colors",
                Math.abs(denoise - p.denoise) < 1e-6 ? "border-accent/60 bg-accent/10" : "border-line hover:bg-hover",
              )}
            >
              <span className="block text-[13px]">{p.label}</span>
              <span className="block text-[11px] text-faint">{p.hint}</span>
            </button>
          ))}
        </div>
      </section>

      {/* only matters with several people in frame; the tracker locks on once and follows that face */}
      <section className="flex items-center justify-between gap-4">
        <div>
          <p className="text-[13px]">Если в кадре несколько лиц</p>
          <p className="text-[11px] text-faint">Какое лицо улучшать. Выбирается один раз и дальше отслеживается</p>
        </div>
        <div className="w-60">
          <Select value={select} onChange={setSelect} options={FACE_SELECT} defaultValue="largest_face" />
        </div>
      </section>

      {/* prompt, folded: it is pre-filled and rarely needs editing */}
      <section>
        <div className="flex items-center gap-2">
          <button onClick={() => setEditPrompt(!editPrompt)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            <ChevronRight size={13} className={clsx("text-faint transition-transform", editPrompt && "rotate-90")} />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">Описание</span>
            <span className="ml-2 truncate text-xs text-muted">
              {writing
                ? job.stage === "loading" ? "загружаю ассистента…" : "ассистент пишет…"
                : aiPrompt !== null && prompt === aiPrompt ? "составлено ассистентом по спецификации"
                : usesTemplate ? "шаблон крупного плана · внешность из исходного клипа"
                : prompt === defaults.source_prompt ? "исходный промпт клипа" : "изменено"}
            </span>
          </button>
          {writing ? (
            <Button size="sm" variant="outline" onClick={() => useAssistant.getState().stop()}>
              <Square size={11} /> Стоп
            </Button>
          ) : (
            <>
            {prompt.trim() && (
              <EditPromptButton onSubmit={editWithAssistant} disabled={!identity || !!job} hint={!identity ? "Сначала выберите фото персонажа" : undefined} />
            )}
            <Button size="sm" variant="ghost" className="text-accent hover:text-accent-strong" onClick={composeWithAssistant}
              disabled={!identity || !!job} title="Ассистент посмотрит на фото, рамку и кадр клипа и напишет промпт крупного плана по спецификации">
              <Sparkles size={13} /> Составить ассистентом
            </Button>
            </>
          )}
        </div>
        {editPrompt && (
          <div className="mt-2">
            <textarea
              value={writing ? stripFence(job.text) : prompt}
              readOnly={writing}
              onChange={(e) => setPrompt(e.target.value)}
              rows={10}
              spellCheck={false}
              className="w-full resize-y rounded-lg border border-line bg-raised p-2.5 font-mono text-[11px] leading-relaxed outline-none focus:border-accent/60"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant={usesTemplate ? "subtle" : "ghost"} onClick={() => setPrompt(defaults.prompt)}>
                Шаблон крупного плана
              </Button>
              {aiPrompt !== null && (
                <Button size="sm" variant={prompt === aiPrompt ? "subtle" : "ghost"} onClick={() => setPrompt(aiPrompt)}>
                  От ассистента
                </Button>
              )}
              {defaults.source_prompt && (
                <Button size="sm" variant={prompt === defaults.source_prompt ? "subtle" : "ghost"} onClick={() => setPrompt(defaults.source_prompt)}>
                  Исходный промпт
                </Button>
              )}
              <span className="text-[11px] text-faint">Модель видит вырезанное крупное лицо, поэтому описание — про крупный план.</span>
            </div>
          </div>
        )}
      </section>

      {error && <p className="text-xs text-bad">{error}</p>}

      <div className="flex items-center justify-end gap-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={onDone}>Отмена</Button>
        <Button variant="primary" size="lg" onClick={submit} disabled={busy || writing || !identity || !prompt.trim()} title={estimateBasis(estimate)}>
          {busy ? <Spinner /> : <Sparkles size={15} />} Улучшить лицо
          {estimate && <span className="font-normal opacity-70">{fmtEstimate(estimate.seconds)}</span>}
        </Button>
      </div>
    </div>
  );
}
